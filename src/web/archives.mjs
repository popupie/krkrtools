import { assertUniquePaths, pathKey, safeRelativePath } from "../files.mjs";

function ambiguous(files, reason) {
  return new Error(
    `Cannot determine the XP3 archive order: ${reason}. ` +
      `Specify each --archive in load order (base first, patches last). Found: ${files.map((file) => file.path).join(", ")}`,
  );
}

export function selectArchives(files, requested = []) {
  assertUniquePaths(files);
  if (requested.length) {
    const byKey = new Map(files.map((file) => [pathKey(file.path), file]));
    const selected = requested.map((path) => {
      const file = byKey.get(pathKey(safeRelativePath(path)));
      if (!file)
        throw new Error(`Archive was not found in the game folder: ${path}`);
      return file;
    });
    if (new Set(selected.map((file) => file.path)).size !== selected.length)
      throw new Error("An archive was selected more than once.");
    return { files: selected, mode: "explicit", patches: [] };
  }
  if (files.length <= 1) return { files, mode: "automatic", patches: [] };
  const base = files.find((file) => pathKey(file.path) === "data.xp3");
  if (!base)
    throw ambiguous(files, "multiple archives without a root data.xp3");
  const assets = [];
  const patches = [];
  for (const file of files.filter((file) => file !== base)) {
    const name = pathKey(file.path);
    if (name.includes("/"))
      throw ambiguous(files, `nested archive ${file.path}`);
    if (!name.startsWith("patch")) {
      assets.push(file);
      continue;
    }
    const match = /^patch(?:(\d+)|_(\d+))?\.xp3$/u.exec(name);
    if (!match)
      throw ambiguous(files, `nonstandard patch archive ${file.path}`);
    const digits = match[1] ?? match[2] ?? "1";
    const number = BigInt(digits);
    const style = match[2] === undefined ? "classic" : "underscore";
    if (
      number.toString() !== digits ||
      (style === "classic" && match[1] !== undefined && number < 2n)
    )
      throw ambiguous(files, `nonstandard patch number in ${file.path}`);
    patches.push({ file, number, style });
  }
  assets.sort((a, b) =>
    pathKey(a.path) < pathKey(b.path)
      ? -1
      : pathKey(a.path) > pathKey(b.path)
        ? 1
        : 0,
  );
  if (new Set(patches.map((patch) => patch.style)).size > 1)
    throw ambiguous(
      files,
      "mixed patch.xp3 and patch_0.xp3 naming conventions",
    );
  patches.sort((a, b) =>
    a.number < b.number ? -1 : a.number > b.number ? 1 : 0,
  );
  let expected =
    patches[0]?.style === "underscore"
      ? 0n
      : patches[0]?.number === 1n
        ? 1n
        : 2n;
  for (const patch of patches) {
    if (patch.number !== expected++)
      throw ambiguous(files, "a gap in the numbered patch sequence");
  }
  return {
    files: [base, ...assets, ...patches.map((patch) => patch.file)],
    mode: "automatic",
    patches: patches.map((patch) => patch.file.path),
  };
}
