import { lstat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertUniquePaths, newStaging, publishDirectory } from "./files.mjs";
import { DEFAULT_MAX_BYTES, extractXp3To, readXp3 } from "./archive/xp3.mjs";
import { inspectPath } from "./inspect.mjs";

export async function unpackXp3(archivePath, outputPath, options = {}) {
  const archive = await readXp3(archivePath);
  const { output, staging } = await newStaging(outputPath);
  try {
    const result = await extractXp3To(archive, staging, options);
    await publishDirectory(staging, output);
    return {
      output,
      files: archive.files,
      bytes: archive.bytes,
      renamedFiles: result.renamedFiles,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function unpackPath(input, outputPath, options = {}) {
  const source = resolve(input);
  if ((await lstat(source)).isFile())
    return unpackXp3(source, outputPath, options);
  const report = await inspectPath(source, { classify: false });
  if (!report.archives.length) throw new Error("No XP3 archives were found.");
  const bytes = report.archives.reduce(
    (sum, archive) => sum + archive.bytes,
    0,
  );
  if (bytes > (options.maxBytes ?? DEFAULT_MAX_BYTES))
    throw new Error("Expanded archives exceed the extraction limit.");
  const targets = report.archives.map((archive) => ({
    path: archive.source.slice(0, -4),
    archive,
  }));
  assertUniquePaths(targets);
  const { output, staging } = await newStaging(outputPath, report.path);
  let files = 0;
  let renamedFiles = 0;
  try {
    for (const target of targets) {
      const result = await extractXp3To(
        target.archive,
        join(staging, target.path),
        options,
      );
      files += result.files;
      renamedFiles += result.renamedFiles;
    }
    await publishDirectory(staging, output);
    return { output, files, bytes, archives: targets.length, renamedFiles };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
