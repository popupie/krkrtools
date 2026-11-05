import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertUniquePaths,
  listFiles,
  newStaging,
  publishFile,
  requireDirectory,
} from "./files.mjs";
import { MAX_FILES, writeXp3 } from "./archive/xp3.mjs";
import { restoreArchivePaths } from "./archive/paths.mjs";

export async function packXp3(sourceDir, outputPath, options = {}) {
  const source = await requireDirectory(sourceDir);
  const files = await restoreArchivePaths(source, await listFiles(source));
  assertUniquePaths(files);
  if (!files.length) throw new Error("The source folder has no files.");
  if (files.length > MAX_FILES)
    throw new Error("Too many files for one XP3 archive.");
  const { output, staging } = await newStaging(outputPath, source);
  try {
    const temporary = join(staging, "archive.xp3");
    await writeXp3(files, temporary, options);
    await publishFile(temporary, output);
    return {
      output,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
