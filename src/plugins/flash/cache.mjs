import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { defaultRuntimeCacheDir } from "../../runtime/cache.mjs";
import { listFiles, requireDirectory } from "../../files.mjs";

const MAX = 64 * 1024 ** 2;
const payloadName = (name) =>
  /^(?:ruffle\.js|core\.ruffle\.[a-f0-9]+\.js|[a-f0-9]+\.wasm|LICENSE_(?:MIT|APACHE))$/u.test(
    name,
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function validateFiles(files) {
  if (
    !files.some((f) => f.path === "ruffle.js") ||
    !files.some((f) => f.path.endsWith(".wasm")) ||
    !files.some((f) => f.path.startsWith("core.ruffle.")) ||
    !files.some((f) => f.path === "LICENSE_MIT") ||
    !files.some((f) => f.path === "LICENSE_APACHE")
  )
    throw new Error(
      "Ruffle folder needs ruffle.js, core chunks, Wasm and both licenses.",
    );
  if (files.length > 32 || files.reduce((n, f) => n + f.bytes, 0) > MAX)
    throw new Error("Ruffle payload exceeds its limits.");
}

export function extractRufflePackage(gzip, integrity) {
  if (
    gzip.length > MAX ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity) ||
    `sha512-${createHash("sha512").update(gzip).digest("base64")}` !== integrity
  )
    throw new Error("Ruffle download checksum mismatch.");
  const tar = gunzipSync(gzip, { maxOutputLength: MAX });
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const string = (a, b) =>
      header.subarray(a, b).toString("utf8").split("\0")[0];
    const octal = (a, b) => {
      const text = string(a, b).trim();
      if (!/^[0-7]+$/u.test(text))
        throw new Error("Invalid Ruffle tar header.");
      return parseInt(text, 8);
    };
    const checksum = octal(148, 156);
    if (
      header.reduce(
        (n, byte, i) => n + (i >= 148 && i < 156 ? 32 : byte),
        0,
      ) !== checksum
    )
      throw new Error("Invalid Ruffle tar checksum.");
    const name = string(0, 100),
      prefix = string(345, 500),
      size = octal(124, 136),
      type = header[156];
    if (
      prefix ||
      !name.startsWith("package/") ||
      name.includes("\\") ||
      name.includes("//") ||
      name.split("/").some((p) => p === ".." || p === ".") ||
      ![0, 48].includes(type) ||
      size > MAX ||
      offset + 512 + size > tar.length
    )
      throw new Error("Unsafe Ruffle package member.");
    const path = name.slice(8);
    if (payloadName(path)) {
      if (files.has(path)) throw new Error("Duplicate Ruffle package member.");
      files.set(
        path,
        Buffer.from(tar.subarray(offset + 512, offset + 512 + size)),
      );
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  validateFiles(
    [...files].map(([path, data]) => ({ path, bytes: data.length })),
  );
  return files;
}

async function fetchBounded(url, fetchImpl, limit) {
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Ruffle download: HTTP ${response.status}`);
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) {
      await response.body.cancel().catch(() => {});
      throw new Error("Ruffle download exceeds its limit.");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function selection(value) {
  if (
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(value?.version) ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value?.integrity)
  )
    throw new Error("Invalid Ruffle package metadata.");
  const url = new URL(value.tarball);
  if (
    url.origin !== "https://registry.npmjs.org" ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/@ruffle-rs/ruffle/-/")
  )
    throw new Error(
      "Ruffle packages must come from the official registry package.",
    );
  return {
    version: value.version,
    integrity: value.integrity,
    tarball: value.tarball,
  };
}
async function localPayload(root) {
  const files = [];
  for (const file of await listFiles(root)) {
    if (!payloadName(file.path)) continue;
    if (file.size > MAX) throw new Error("Ruffle file exceeds its limit.");
    const bytes = await readFile(file.full);
    if (
      !bytes.length ||
      (file.path.endsWith(".wasm") &&
        !bytes
          .subarray(0, 8)
          .equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
    )
      throw new Error(`Invalid Ruffle payload: ${file.path}`);
    files.push({ path: file.path, bytes: file.size, sha256: hash(bytes) });
  }
  validateFiles(files);
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
async function directory(root) {
  await mkdir(root, { recursive: true });
  if (!(await lstat(root)).isDirectory())
    throw new Error("Ruffle cache directory cannot be a symlink.");
  return root;
}
async function jsonFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 65536)
    throw new Error("Invalid Ruffle cache metadata.");
  return JSON.parse(await readFile(path, "utf8"));
}
async function publishJson(root, name, data) {
  const temp = await mkdtemp(join(root, ".download-"));
  try {
    await writeFile(join(temp, "data"), JSON.stringify(data));
    await rename(join(temp, "data"), join(root, name));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function resolveRuffle({
  ruffleDir,
  cacheDir = defaultRuntimeCacheDir(),
  offline = false,
  fetchImpl = fetch,
  onProgress,
} = {}) {
  if (ruffleDir) {
    const path = await requireDirectory(ruffleDir);
    return {
      path,
      files: await localPayload(path),
      source: { type: "local", path },
    };
  }
  const base = await directory(join(await directory(cacheDir), "plugins"));
  const root = await directory(join(base, "ruffle"));
  let chosen;
  if (offline) {
    try {
      chosen = selection(await jsonFile(join(root, "latest.json")));
    } catch (error) {
      throw new Error(
        `No valid offline Ruffle selection. Run online once or supply --ruffle <folder>. ${error.message}`,
      );
    }
  } else {
    onProgress?.({ type: "flash-upstream-check" });
    const latest = JSON.parse(
      (
        await fetchBounded(
          "https://registry.npmjs.org/@ruffle-rs/ruffle/latest",
          fetchImpl,
          256 * 1024,
        )
      ).toString("utf8"),
    );
    chosen = selection({
      version: latest.version,
      integrity: latest.dist?.integrity,
      tarball: latest.dist?.tarball,
    });
  }
  const target = await directory(join(root, chosen.version));
  try {
    const saved = await jsonFile(join(target, "verified.json"));
    if (
      saved.integrity !== chosen.integrity ||
      saved.version !== chosen.version
    )
      throw new Error("Ruffle cache version mismatch.");
    const files = await localPayload(target);
    if (JSON.stringify(files) !== JSON.stringify(saved.files))
      throw new Error("Ruffle cache checksum mismatch.");
    if (!offline) await publishJson(root, "latest.json", chosen);
    onProgress?.({
      type: "flash-cache",
      path: target,
      version: chosen.version,
    });
    return { path: target, files, source: { type: "cache", ...chosen } };
  } catch (error) {
    if (offline)
      throw new Error(`Cannot use cached Ruffle offline: ${error.message}`);
  }
  onProgress?.({ type: "flash-download", version: chosen.version });
  const files = extractRufflePackage(
    await fetchBounded(chosen.tarball, fetchImpl, MAX),
    chosen.integrity,
  );
  const temp = await mkdtemp(join(root, ".download-"));
  try {
    for (const [path, data] of files) await writeFile(join(temp, path), data);
    const hashes = await localPayload(temp);
    for (const file of hashes) {
      try {
        const stat = await lstat(join(target, file.path));
        if (!stat.isFile())
          throw new Error("Ruffle cache file cannot be a symlink.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await rename(join(temp, file.path), join(target, file.path));
    }
    await publishJson(target, "verified.json", { ...chosen, files: hashes });
    await publishJson(root, "latest.json", chosen);
    return {
      path: target,
      files: hashes,
      source: { type: "download", ...chosen },
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
