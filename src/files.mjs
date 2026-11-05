import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createHash } from "node:crypto";

export function asciiLower(value) {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function safeRelativePath(value) {
  const path = String(value).replaceAll("\\", "/");
  const parts = path.split("/");
  if (
    !path ||
    isAbsolute(path) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\x00-\x1f\x7f:<>"|?*]/u.test(part) ||
        /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    )
  )
    throw new Error(
      `Unsafe or non-portable file path: ${JSON.stringify(value)}`,
    );
  return path;
}

export function pathKey(path) {
  return asciiLower(path.normalize("NFC"));
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function isInside(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

export async function requireDirectory(path) {
  const root = await realpath(resolve(path));
  if (!(await lstat(root)).isDirectory())
    throw new Error(`Not a directory: ${path}`);
  return root;
}

export async function listFiles(root, current = root) {
  const result = [];
  const entries = (await readdir(current, { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic links are not supported: ${full}`);
    if (entry.isDirectory()) result.push(...(await listFiles(root, full)));
    else if (entry.isFile()) {
      const path = safeRelativePath(relative(root, full).split(sep).join("/"));
      result.push({ path, full, size: (await lstat(full)).size });
    } else throw new Error(`Not a regular file: ${full}`);
  }
  return result;
}

export function assertUniquePaths(files) {
  const seen = new Map();
  for (const file of files) {
    const path = typeof file === "string" ? file : file.path;
    const parts = pathKey(path).split("/");
    const key = parts.join("/");
    if (seen.has(key))
      throw new Error(`Conflicting file paths: ${seen.get(key)} and ${path}`);
    seen.set(key, path);
  }
  for (const [key, path] of seen) {
    const parts = key.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(parts.join("/")))
        throw new Error(`File/directory conflict: ${path}`);
    }
  }
}

export async function newStaging(destination, source) {
  const output = resolve(destination);
  let ancestor = dirname(output);
  const missing = [];
  while (!(await exists(ancestor))) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const parent = join(await realpath(ancestor), ...missing);
  const canonical = join(parent, basename(output));
  if (source && isInside(source, canonical))
    throw new Error("Output must be outside the source folder.");
  if (await exists(canonical))
    throw new Error(`Output already exists: ${canonical}`);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, `.${basename(output)}.tmp-`));
  return { output: canonical, staging };
}

export async function publishDirectory(staging, output) {
  // Reserve the destination exclusively. Move prepared entries without ever
  // replacing a pre-existing directory, even if it appeared during conversion.
  await mkdir(output);
  try {
    for (const entry of await readdir(staging))
      await rename(join(staging, entry), join(output, entry));
    await rm(staging, { recursive: true });
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

export async function publishFile(staging, output) {
  // A same-filesystem hard link publishes a finished file without overwriting.
  await link(staging, output);
  await rm(staging);
}

export async function copyAndHash(source, target) {
  await mkdir(dirname(target), { recursive: true });
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(source),
    meter,
    createWriteStream(target, { flags: "wx" }),
  );
  return { bytes: size, sha256: hash.digest("hex") };
}
