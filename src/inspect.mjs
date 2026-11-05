import { lstat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { listFiles, requireDirectory } from "./files.mjs";
import { readXp3 } from "./archive/xp3.mjs";
import {
  detectGamePlugins,
  formatPluginDetection,
} from "./inspect/plugins.mjs";
import { classifyGame, formatClassification } from "./inspect/classify.mjs";

export async function inspectPath(
  input,
  { classify = true, detectPlugins = classify } = {},
) {
  const source = resolve(input);
  const details = await lstat(source);
  if (details.isFile()) {
    let archive;
    try {
      archive = await readXp3(source);
    } catch (error) {
      if (
        !classify ||
        extname(source).toLowerCase() !== ".exe" ||
        !/executable has no standard embedded XP3/u.test(error.message)
      )
        throw error;
    }
    const result = archive
      ? { kind: "xp3", ...archive }
      : { kind: "executable", path: source };
    if (classify) {
      const file = { path: basename(source), full: source, size: details.size };
      result.classification = await classifyGame({
        files: [file],
        archives: archive ? [archive] : [],
        executableFiles:
          extname(source).toLowerCase() === ".exe" || archive?.archiveOffset > 0
            ? [file]
            : [],
      });
    }
    if (detectPlugins)
      result.plugins = await detectGamePlugins({
        archives: archive ? [archive] : [],
      });
    return result;
  }
  const root = await requireDirectory(source);
  const files = await listFiles(root);
  const archives = [];
  for (const file of files.filter(
    (file) => extname(file.path).toLowerCase() === ".xp3",
  )) {
    const archive = await readXp3(file.full);
    archives.push({ source: file.path, ...archive });
  }
  const result = {
    kind: "folder",
    path: root,
    files: files.length,
    startupScripts: files
      .filter((file) => /(?:^|\/)startup\.tjs$/iu.test(file.path))
      .map((file) => file.path),
    archives,
  };
  if (classify) result.classification = await classifyGame({ files, archives });
  if (detectPlugins)
    result.plugins = await detectGamePlugins({ files, archives });
  return result;
}

export function formatInspection(result) {
  const archives =
    result.kind === "folder"
      ? result.archives
      : result.kind === "xp3"
        ? [result]
        : [];
  return [
    result.path,
    ...archives.map(
      (archive) =>
        `${archive.source ?? "XP3"}: ${archive.files} files, ${archive.bytes} expanded bytes, ${archive.archiveBytes} archive bytes, ${archive.entries.filter((entry) => entry.protected).length} protected entries`,
    ),
    ...(result.kind === "folder"
      ? [`Loose startup scripts: ${result.startupScripts.join(", ") || "none"}`]
      : []),
    ...(result.classification
      ? formatClassification(result.classification)
      : []),
    ...formatPluginDetection(result.plugins),
  ].join("\n");
}
