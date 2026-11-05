import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertUniquePaths,
  isInside,
  requireDirectory,
  safeRelativePath,
} from "../files.mjs";
import DEFAULT_RUNTIME from "./manifest.json" with { type: "json" };
import { checkUpstreamRuntime } from "./upstream.mjs";

export { DEFAULT_RUNTIME };

export function defaultRuntimeCacheDir({
  env = process.env,
  home = homedir(),
} = {}) {
  return join(
    env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME)
      ? env.XDG_CACHE_HOME
      : join(home, ".cache"),
    "krkrtools",
  );
}

function validateManifest(manifest) {
  if (
    manifest.format !== "krkrtools-runtime" ||
    manifest.version !== 1 ||
    !/^[a-zA-Z0-9_-]{1,96}$/u.test(manifest.id) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 256
  )
    throw new Error("Invalid runtime download manifest.");
  let total = 0;
  for (const file of manifest.files) {
    if (
      safeRelativePath(file.path) !== file.path ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 128 * 1024 ** 2 ||
      (!file.sha256 && !file.gitSha) ||
      (file.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(file.sha256)) ||
      (file.gitSha !== undefined && !/^[a-f0-9]{40}$/u.test(file.gitSha))
    )
      throw new Error("Invalid runtime file manifest.");
    const url = new URL(file.url);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error(
        "Runtime downloads require HTTPS without URL credentials.",
      );
    total += file.bytes;
  }
  if (total > 256 * 1024 ** 2)
    throw new Error("Runtime download exceeds 256 MiB.");
  assertUniquePaths(manifest.files);
}

async function directoryBelow(root, relative) {
  let current = root;
  for (const part of relative.split("/").filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (!(await lstat(current)).isDirectory())
      throw new Error(
        `Cache path must be a directory without symlinks: ${current}`,
      );
  }
  return current;
}

async function cachedFileMatches(root, file) {
  const path = join(root, file.path);
  try {
    // Check parents too. Hashing a path must never follow an unexpected symlink.
    let parent = root;
    for (const part of file.path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      if (!(await lstat(parent)).isDirectory())
        throw new Error(`Invalid runtime cache directory: ${parent}`);
    }
    const details = await lstat(path);
    if (!details.isFile())
      throw new Error(
        `Invalid runtime cache file (symlinks are unsupported): ${path}`,
      );
    if (details.size !== file.bytes) return false;
    const hash = file.sha256 ? createHash("sha256") : null;
    const git = file.gitSha
      ? createHash("sha1").update(`blob ${file.bytes}\0`)
      : null;
    for await (const bytes of createReadStream(path)) {
      hash?.update(bytes);
      git?.update(bytes);
    }
    return (
      (!hash || hash.digest("hex") === file.sha256) &&
      (!git || git.digest("hex") === file.gitSha)
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function downloadFile(root, file, fetchImpl) {
  const parent = file.path.includes("/")
    ? await directoryBelow(root, file.path.split("/").slice(0, -1).join("/"))
    : root;
  const temporary = await mkdtemp(join(parent, ".krkrtools-download-"));
  try {
    const response = await fetchImpl(file.url, {
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const path = join(temporary, "download");
    const output = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    const git = file.gitSha
      ? createHash("sha1").update(`blob ${file.bytes}\0`)
      : null;
    let size = 0;
    try {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > file.bytes)
          throw new Error("Download exceeds its pinned size.");
        hash.update(bytes);
        git?.update(bytes);
        await output.writeFile(bytes);
      }
      const sha256 = hash.digest("hex");
      if (
        size !== file.bytes ||
        (file.sha256 && sha256 !== file.sha256) ||
        (git && git.digest("hex") !== file.gitSha)
      )
        throw new Error(
          "Download size/checksum does not match upstream runtime metadata.",
        );
      await output.sync();
    } finally {
      await output.close();
    }
    // Concurrent invocations may publish the same verified bytes. Each rename
    // publishes a complete file. Partial downloads never become runtime files.
    await rename(path, join(root, file.path));
  } catch (error) {
    throw new Error(
      `Could not download ${file.path}: ${error.message}. Retry, or supply --runtime <built folder>.`,
      { cause: error },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function cachedSelection(base) {
  const path = join(base, ".runtime-latest.json");
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.size > 256 * 1024)
      throw new Error("Invalid cached runtime selection.");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    validateManifest(manifest);
    return manifest;
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_RUNTIME;
    throw new Error(
      `Cannot read the last cached runtime: ${error.message}. Run online to check upstream again.`,
      { cause: error },
    );
  }
}

async function writeJsonAtomically(root, name, value) {
  const temporary = await mkdtemp(join(root, ".krkrtools-download-"));
  try {
    await writeFile(
      join(temporary, "data.json"),
      `${JSON.stringify(value, null, 2)}\n`,
    );
    await rename(join(temporary, "data.json"), join(root, name));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function resolveRuntime({
  runtimeDir,
  cacheDir = defaultRuntimeCacheDir(),
  offline = false,
  excludeRoot,
  onProgress,
  manifest: fixedManifest,
  fetchImpl = globalThis.fetch,
  checkUpstream = checkUpstreamRuntime,
} = {}) {
  if (runtimeDir) {
    try {
      return {
        path: await requireDirectory(runtimeDir),
        source: { type: "local" },
        downloaded: 0,
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      onProgress?.({ type: "missing", path: resolve(runtimeDir) });
    }
  }
  if (fixedManifest) validateManifest(fixedManifest);
  const base = resolve(cacheDir);
  if (excludeRoot) {
    let ancestor = base;
    const missing = [];
    while (true) {
      try {
        const canonical = join(await realpath(ancestor), ...missing);
        if (isInside(excludeRoot, canonical))
          throw new Error(
            "Runtime cache must be outside the game folder. Choose another --cache-dir.",
          );
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || dirname(ancestor) === ancestor)
          throw error;
        missing.unshift(basename(ancestor));
        ancestor = dirname(ancestor);
      }
    }
  }
  let manifest = fixedManifest;
  if (!manifest) {
    if (offline) manifest = await cachedSelection(base);
    else {
      onProgress?.({ type: "upstream-check" });
      manifest = await checkUpstream({ fetchImpl });
      onProgress?.({
        type: "upstream-version",
        id: manifest.id,
        revision: manifest.revision,
      });
    }
  }
  validateManifest(manifest);
  await mkdir(base, { recursive: true });
  const root = await directoryBelow(
    await requireDirectory(base),
    `runtimes/${manifest.id}`,
  );
  const missing = [];
  for (const file of manifest.files)
    if (!(await cachedFileMatches(root, file))) missing.push(file);
  if (missing.length && offline)
    throw new Error(
      `Runtime is not fully cached at ${root}. Run without --offline to download it, or supply --runtime <built folder>.`,
    );
  if (missing.length) {
    onProgress?.({
      type: "download-start",
      path: root,
      files: missing.length,
      bytes: missing.reduce((sum, file) => sum + file.bytes, 0),
    });
    let next = 0,
      completed = 0;
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(3, missing.length) }, async () => {
        while (next < missing.length) {
          const file = missing[next++];
          await downloadFile(root, file, fetchImpl);
          onProgress?.({
            type: "download-file",
            path: file.path,
            completed: ++completed,
            total: missing.length,
          });
        }
      }),
    );
    const failure = workers.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    await writeJsonAtomically(root, ".runtime-source.json", manifest);
  } else onProgress?.({ type: "cache", path: root });
  // Update only after every file is verified. Failed newer downloads leave the
  // last complete selection available for an explicit --offline invocation.
  if (!fixedManifest && !offline)
    await writeJsonAtomically(
      await requireDirectory(base),
      ".runtime-latest.json",
      manifest,
    );
  return {
    path: root,
    source: {
      type: "download",
      id: manifest.id,
      repository: manifest.repository,
      revision: manifest.revision,
    },
    downloaded: missing.length,
    reused: manifest.files.length - missing.length,
    files: manifest.files.map((file) => file.path),
  };
}
