import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { assertUniquePaths, pathKey, safeRelativePath } from "../files.mjs";

export const PATH_MAP = ".krkrtools-paths.json";
const FORMAT = "krkrtools-path-map";

export function portableArchivePath(path) {
  return path
    .split("/")
    .map((part) => {
      if (Buffer.byteLength(part.normalize("NFD")) <= 240) return part;
      const extension = extname(part);
      const suffix = extension.length <= 16 ? extension : "";
      let prefix = "";
      for (const character of part.slice(0, part.length - suffix.length)) {
        if (Buffer.byteLength((prefix + character).normalize("NFD")) > 120)
          break;
        prefix += character;
      }
      const hash = createHash("sha256").update(part).digest("hex").slice(0, 24);
      return `${prefix}-${hash}${suffix}`;
    })
    .join("/");
}

export function extractionPaths(entries) {
  const paths = entries.map((entry) => ({
    original: entry.path,
    extracted: portableArchivePath(entry.path),
  }));
  assertUniquePaths(paths.map((item) => item.extracted));
  if (
    paths.some((item) => item.original !== item.extracted) &&
    paths.some((item) => pathKey(item.extracted) === pathKey(PATH_MAP))
  )
    throw new Error(
      `Archive conflicts with the reserved ${PATH_MAP} filename.`,
    );
  return paths;
}

export async function writePathMap(root, paths) {
  const mappings = paths.filter((item) => item.original !== item.extracted);
  if (mappings.length)
    await writeFile(
      join(root, PATH_MAP),
      `${JSON.stringify({ format: FORMAT, version: 1, mappings }, null, 2)}\n`,
      { flag: "wx" },
    );
  return mappings.length;
}

export async function restoreArchivePaths(root, files) {
  const metadata = files.find((file) => file.path === PATH_MAP);
  if (!metadata) return files;
  if ((await lstat(metadata.full)).size > 16 * 1024 * 1024)
    throw new Error("XP3 filename map exceeds 16 MiB.");
  const map = JSON.parse(await readFile(metadata.full, "utf8"));
  if (
    map.format !== FORMAT ||
    map.version !== 1 ||
    !Array.isArray(map.mappings)
  )
    throw new Error(`Invalid ${PATH_MAP} metadata.`);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const replacements = new Map();
  for (const item of map.mappings) {
    if (typeof item.original !== "string" || typeof item.extracted !== "string")
      throw new Error("Invalid XP3 filename mapping.");
    safeRelativePath(item.original);
    safeRelativePath(item.extracted);
    if (
      item.extracted === PATH_MAP ||
      !byPath.has(item.extracted) ||
      replacements.has(item.extracted) ||
      portableArchivePath(item.original) !== item.extracted
    )
      throw new Error("Invalid or missing mapped XP3 asset.");
    replacements.set(item.extracted, item.original);
  }
  const result = files
    .filter((file) => file.path !== PATH_MAP)
    .map((file) => ({
      ...file,
      path: replacements.get(file.path) ?? file.path,
    }));
  assertUniquePaths(result);
  return result;
}
