import { createReadStream } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflate, deflateSync, inflateSync } from "node:zlib";
import { assertUniquePaths, safeRelativePath } from "../files.mjs";
import { extractionPaths, writePathMap } from "./paths.mjs";

export const XP3_MAGIC = Buffer.from([
  0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01,
]);
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 200_000;
export const DEFAULT_MAX_BYTES = 64 * 1024 ** 3;
const BLOCK_BYTES = 1024 * 1024;
const STORED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".tlg",
  ".ogg",
  ".opus",
  ".mp3",
  ".m4a",
  ".mp4",
  ".webm",
  ".mkv",
  ".xp3",
  ".zip",
  ".gz",
  ".7z",
]);

export function adler32(bytes, previous = 1) {
  let a = previous & 0xffff;
  let b = previous >>> 16;
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(bytes.length, start + 5552);
    for (let i = start; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function xorBytes(bytes, key) {
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= key;
}

function checksumError(entry) {
  return new Error(
    `XP3 checksum/size mismatch: ${entry.path} (corrupt data or an unsupported game filter; supported hash-XOR decoding did not validate).`,
  );
}

// KiriKiri's example xp3enc/xp3dec filter XORs decompressed bytes with the
// low byte of the original Adler-32. Try it only after plain validation fails.
function filterKey(entry) {
  return entry.protected ? entry.adler32 & 0xff : 0;
}

async function decodeExtractedFile(handle, entry) {
  const key = filterKey(entry);
  if (!key) throw checksumError(entry);
  const buffer = Buffer.alloc(Math.min(BLOCK_BYTES, entry.size));
  let position = 0,
    checksum = 1;
  while (position < entry.size) {
    const length = Math.min(buffer.length, entry.size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (!bytesRead)
      throw new Error(`Truncated extracted XP3 file: ${entry.path}`);
    const bytes = buffer.subarray(0, bytesRead);
    xorBytes(bytes, key);
    checksum = adler32(bytes, checksum);
    await writeAt(handle, bytes, position);
    position += bytesRead;
  }
  if (checksum !== entry.adler32) throw checksumError(entry);
}

function uint64(bytes, offset = 0) {
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("XP3 offset or size exceeds safe integer range.");
  return Number(value);
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function checkedRange(offset, length, size, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > size - length
  )
    throw new Error(`Invalid or truncated XP3 ${label}.`);
}

async function readAt(handle, offset, length, size, label) {
  checkedRange(offset, length, size, label);
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const result = await handle.read(bytes, done, length - done, offset + done);
    if (!result.bytesRead) throw new Error(`Truncated XP3 ${label}.`);
    done += result.bytesRead;
  }
  return bytes;
}

async function writeAt(handle, bytes, position) {
  let done = 0;
  while (done < bytes.length) {
    const result = await handle.write(
      bytes,
      done,
      bytes.length - done,
      position + done,
    );
    if (!result.bytesWritten) throw new Error("Could not write XP3 output.");
    done += result.bytesWritten;
  }
}

async function findArchiveOffset(handle, size) {
  const head = await readAt(handle, 0, Math.min(size, 19), size, "header");
  if (head.subarray(0, 11).equals(XP3_MAGIC)) return 0;
  if (head.toString("ascii", 0, 2) !== "MZ")
    throw new Error("Not a standard XP3 archive (bad signature).");
  // EXE-embedded XP3 archives: scan bounded chunks, including boundary overlap.
  let previous = Buffer.alloc(0);
  for (let offset = 0; offset < size; offset += BLOCK_BYTES) {
    const bytes = await readAt(
      handle,
      offset,
      Math.min(BLOCK_BYTES, size - offset),
      size,
      "EXE data",
    );
    const joined = Buffer.concat([previous, bytes]);
    let match = joined.indexOf(XP3_MAGIC);
    while (match >= 0) {
      const candidate = offset - previous.length + match;
      // The executable may also contain the signature as a string constant.
      // Require an in-bounds index pointer and recognized flag before accepting it.
      if (candidate <= size - 19) {
        const relative = (
          await readAt(handle, candidate + 11, 8, size, "embedded pointer")
        ).readBigUInt64LE();
        const index = candidate + Number(relative);
        if (
          relative >= 19n &&
          relative < BigInt(size - candidate) &&
          Number.isSafeInteger(index)
        ) {
          const flag = (
            await readAt(handle, index, 1, size, "embedded index")
          )[0];
          if (!(flag & ~0x81)) return candidate;
        }
      }
      match = joined.indexOf(XP3_MAGIC, match + 1);
    }
    previous = bytes.subarray(Math.max(0, bytes.length - 10));
  }
  throw new Error("The executable has no standard embedded XP3 archive.");
}

function* chunks(bytes, label) {
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12)
      throw new Error(`Truncated XP3 ${label} chunk.`);
    const tag = bytes.toString("ascii", offset, offset + 4);
    const size = uint64(bytes, offset + 4);
    offset += 12;
    checkedRange(offset, size, bytes.length, `${tag} chunk`);
    yield { tag, body: bytes.subarray(offset, offset + size) };
    offset += size;
  }
}

function parseFile(body, archiveSize, archiveOffset) {
  const fields = new Map();
  for (const field of chunks(body, "File")) {
    if (fields.has(field.tag))
      throw new Error(`Duplicate XP3 ${field.tag} field.`);
    fields.set(field.tag, field.body);
  }
  const info = fields.get("info");
  const segm = fields.get("segm");
  const adlr = fields.get("adlr");
  if (
    !info ||
    info.length < 22 ||
    !segm ||
    segm.length % 28 ||
    !adlr ||
    adlr.length !== 4
  )
    throw new Error(
      "Unsupported or malformed XP3 File entry (info/segm/adlr required).",
    );
  const nameLength = info.readUInt16LE(20) * 2;
  if (info.length !== 22 + nameLength)
    throw new Error("Invalid XP3 filename length.");
  const decoded = new TextDecoder("utf-16le", {
    fatal: true,
    ignoreBOM: true,
  }).decode(info.subarray(22));
  const path = safeRelativePath(decoded);
  const flags = info.readUInt32LE(0);
  const size = uint64(info, 4);
  const storedSize = uint64(info, 12);
  const segments = [];
  let originalTotal = 0;
  let storedTotal = 0;
  for (let offset = 0; offset < segm.length; offset += 28) {
    const encoding = segm.readUInt32LE(offset);
    if (encoding !== 0 && encoding !== 1)
      throw new Error(`Unsupported XP3 segment encoding: ${encoding}`);
    const start = uint64(segm, offset + 4) + archiveOffset;
    const original = uint64(segm, offset + 12);
    const stored = uint64(segm, offset + 20);
    checkedRange(start, stored, archiveSize, "segment");
    if (encoding === 0 && stored !== original)
      throw new Error(`Invalid raw segment size: ${path}`);
    if (encoding === 1 && stored === 0)
      throw new Error(`Empty compressed segment: ${path}`);
    originalTotal += original;
    storedTotal += stored;
    if (
      !Number.isSafeInteger(originalTotal) ||
      !Number.isSafeInteger(storedTotal)
    )
      throw new Error("XP3 segment sizes overflow.");
    segments.push({
      encoding,
      offset: start,
      size: original,
      storedSize: stored,
    });
  }
  if (
    size !== originalTotal ||
    storedSize !== storedTotal ||
    (size > 0 && !segments.length)
  )
    throw new Error(`XP3 segment totals do not match: ${path}`);
  return {
    path,
    size,
    storedSize,
    flags,
    protected: Boolean(flags & 0x80000000),
    adler32: adlr.readUInt32LE(0),
    segments,
  };
}

export async function readXp3(
  archivePath,
  { maxIndexBytes = MAX_INDEX_BYTES, maxFiles = MAX_FILES } = {},
) {
  const path = resolve(archivePath);
  const handle = await open(path, "r");
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error(`Not a regular file: ${path}`);
    const archiveOffset = await findArchiveOffset(handle, details.size);
    let next =
      uint64(
        await readAt(
          handle,
          archiveOffset + 11,
          8,
          details.size,
          "index pointer",
        ),
      ) + archiveOffset;
    const entries = [];
    const visited = new Set();
    let indexBytes = 0;
    while (true) {
      if (visited.has(next) || visited.size >= 1024)
        throw new Error("XP3 index chain contains a cycle or too many links.");
      visited.add(next);
      const flag = (
        await readAt(handle, next, 1, details.size, "index flag")
      )[0];
      if (flag & ~0x81) throw new Error(`Unsupported XP3 index flags: ${flag}`);
      const compressed = Boolean(flag & 1);
      const sizes = await readAt(
        handle,
        next + 1,
        compressed ? 16 : 8,
        details.size,
        "index sizes",
      );
      const storedSize = uint64(sizes);
      const size = compressed ? uint64(sizes, 8) : storedSize;
      if (storedSize > maxIndexBytes || size > maxIndexBytes - indexBytes)
        throw new Error("XP3 index exceeds the metadata size limit.");
      const bodyOffset = next + 1 + sizes.length;
      const stored = await readAt(
        handle,
        bodyOffset,
        storedSize,
        details.size,
        "index",
      );
      const index = compressed
        ? inflateSync(stored, { maxOutputLength: Math.max(1, size) })
        : stored;
      if (index.length !== size)
        throw new Error("XP3 index decompressed size mismatch.");
      indexBytes += size;
      for (const chunk of chunks(index, "index")) {
        if (chunk.tag !== "File") continue;
        if (entries.length >= maxFiles)
          throw new Error("XP3 file count exceeds the metadata limit.");
        entries.push(parseFile(chunk.body, details.size, archiveOffset));
      }
      if (!(flag & 0x80)) break;
      next =
        uint64(
          await readAt(
            handle,
            bodyOffset + storedSize,
            8,
            details.size,
            "next index pointer",
          ),
        ) + archiveOffset;
    }
    assertUniquePaths(entries);
    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (!Number.isSafeInteger(bytes))
      throw new Error("XP3 expanded size exceeds safe integer range.");
    return {
      path,
      archiveOffset,
      archiveBytes: details.size,
      indexBytes,
      bytes,
      files: entries.length,
      entries,
    };
  } finally {
    await handle.close();
  }
}

function fileChunk(entry) {
  const name = Buffer.from(entry.path, "utf16le");
  if (name.length / 2 > 65535)
    throw new Error("XP3 filename exceeds 65535 UTF-16 code units.");
  const info = Buffer.alloc(22 + name.length);
  info.writeBigUInt64LE(BigInt(entry.size), 4);
  info.writeBigUInt64LE(BigInt(entry.storedSize), 12);
  info.writeUInt16LE(name.length / 2, 20);
  name.copy(info, 22);
  const segments = Buffer.alloc(28 * entry.segments.length);
  entry.segments.forEach((segment, index) => {
    const offset = index * 28;
    segments.writeUInt32LE(segment.encoding, offset);
    segments.writeBigUInt64LE(BigInt(segment.offset), offset + 4);
    segments.writeBigUInt64LE(BigInt(segment.size), offset + 12);
    segments.writeBigUInt64LE(BigInt(segment.storedSize), offset + 20);
  });
  const hash = Buffer.alloc(4);
  hash.writeUInt32LE(entry.adler32);
  return chunkBuffer(
    "File",
    Buffer.concat([
      chunkBuffer("info", info),
      chunkBuffer("segm", segments),
      chunkBuffer("adlr", hash),
    ]),
  );
}

function chunkBuffer(tag, bytes) {
  return Buffer.concat([Buffer.from(tag), u64(bytes.length), bytes]);
}

// Write archive bytes to a caller-owned staging file.
export async function writeXp3(
  files,
  outputPath,
  { compress = true, onProgress } = {},
) {
  const destination = await open(outputPath, "wx");
  const indexParts = [];
  let indexBytes = 0;
  let position = 19;
  try {
    await writeAt(destination, Buffer.concat([XP3_MAGIC, u64(0)]), 0);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const entry = {
        path: file.path,
        size: 0,
        storedSize: 0,
        adler32: 1,
        segments: [],
      };
      const input = await open(file.full, "r");
      try {
        const originalStat = await input.stat();
        while (entry.size < originalStat.size) {
          const raw = await readAt(
            input,
            entry.size,
            Math.min(BLOCK_BYTES, originalStat.size - entry.size),
            originalStat.size,
            "source file",
          );
          const zipped =
            compress && !STORED_EXTENSIONS.has(extname(file.path).toLowerCase())
              ? deflateSync(raw)
              : raw;
          const encoded = zipped.length < raw.length;
          const stored = encoded ? zipped : raw;
          await writeAt(destination, stored, position);
          entry.segments.push({
            encoding: encoded ? 1 : 0,
            offset: position,
            size: raw.length,
            storedSize: stored.length,
          });
          entry.adler32 = adler32(raw, entry.adler32);
          entry.size += raw.length;
          entry.storedSize += stored.length;
          position += stored.length;
        }
        if (!entry.segments.length)
          entry.segments.push({
            encoding: 0,
            offset: position,
            size: 0,
            storedSize: 0,
          });
        const finalStat = await input.stat();
        if (
          finalStat.size !== originalStat.size ||
          finalStat.mtimeMs !== originalStat.mtimeMs
        )
          throw new Error(`Source changed during packing: ${file.path}`);
      } finally {
        await input.close();
      }
      const part = fileChunk(entry);
      indexBytes += part.length;
      if (indexBytes > MAX_INDEX_BYTES)
        throw new Error("XP3 index exceeds the metadata size limit.");
      indexParts.push(part);
      onProgress?.({ path: file.path, completed: i + 1, total: files.length });
    }
    const index = Buffer.concat(indexParts);
    const candidate = compress ? deflateSync(index) : index;
    const zipped = candidate.length < index.length;
    const encoded = zipped ? candidate : index;
    await writeAt(
      destination,
      Buffer.concat([
        Buffer.from([zipped ? 1 : 0]),
        u64(encoded.length),
        ...(zipped ? [u64(index.length)] : []),
        encoded,
      ]),
      position,
    );
    await writeAt(destination, u64(position), 11);
    await destination.sync();
  } finally {
    await destination.close();
  }
}

// Checksum-verified metadata scripts for inspection.
export async function readXp3Entry(
  archive,
  entry,
  { maxBytes = 512 * 1024 } = {},
) {
  if (
    entry.size > maxBytes ||
    entry.storedSize > maxBytes + 64 * 1024 ||
    entry.segments.length > 4096
  )
    throw new Error(`Script exceeds the inspection limit: ${entry.path}`);
  if (entry.flags & 0x7fffffff)
    throw new Error(`Unsupported XP3 file flags: ${entry.path}`);
  const handle = await open(archive.path, "r");
  try {
    const { size } = await handle.stat();
    if (size !== archive.archiveBytes)
      throw new Error("Archive changed after inspection.");
    const parts = [];
    let total = 0;
    for (const segment of entry.segments) {
      const stored = await readAt(
        handle,
        segment.offset,
        segment.storedSize,
        size,
        "script segment",
      );
      const bytes =
        segment.encoding === 1
          ? inflateSync(stored, { maxOutputLength: Math.max(1, segment.size) })
          : stored;
      if (bytes.length !== segment.size || total > maxBytes - bytes.length)
        throw new Error(`XP3 script segment size mismatch: ${entry.path}`);
      parts.push(bytes);
      total += bytes.length;
    }
    const bytes = Buffer.concat(parts, total);
    if (total !== entry.size) throw checksumError(entry);
    if (adler32(bytes) !== entry.adler32) {
      const key = filterKey(entry);
      if (!key) throw checksumError(entry);
      xorBytes(bytes, key);
      if (adler32(bytes) !== entry.adler32) throw checksumError(entry);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function extractXp3To(
  archive,
  root,
  { maxBytes = DEFAULT_MAX_BYTES, onProgress } = {},
) {
  if (archive.bytes > maxBytes)
    throw new Error(
      `Expanded archive exceeds the ${maxBytes}-byte extraction limit.`,
    );
  if (archive.entries.some((entry) => entry.flags & 0x7fffffff))
    throw new Error("Unsupported XP3 file flags; no extraction was started.");
  const paths = extractionPaths(archive.entries);
  const details = await lstat(archive.path);
  if (details.size !== archive.archiveBytes)
    throw new Error("Archive changed after inspection.");
  const filters = [];
  for (let i = 0; i < archive.entries.length; i++) {
    const entry = archive.entries[i];
    const target = join(root, ...paths[i].extracted.split("/"));
    await mkdir(dirname(target), { recursive: true });
    const output = await open(target, "wx+");
    let written = 0;
    let checksum = 1;
    try {
      for (const segment of entry.segments) {
        let segmentBytes = 0;
        const source = segment.storedSize
          ? createReadStream(archive.path, {
              start: segment.offset,
              end: segment.offset + segment.storedSize - 1,
            })
          : Readable.from([]);
        const meter = new Transform({
          transform(bytes, encoding, callback) {
            segmentBytes += bytes.length;
            if (segmentBytes > segment.size)
              return callback(
                new Error(
                  `Segment expands beyond declared size: ${entry.path}`,
                ),
              );
            checksum = adler32(bytes, checksum);
            callback(null, bytes);
          },
        });
        const sink = new Writable({
          write(bytes, encoding, callback) {
            writeAt(output, bytes, written).then(() => {
              written += bytes.length;
              callback();
            }, callback);
          },
        });
        await pipeline(
          ...[
            source,
            ...(segment.encoding === 1 ? [createInflate()] : []),
            meter,
            sink,
          ],
        );
        if (segmentBytes !== segment.size)
          throw new Error(`Segment size mismatch: ${entry.path}`);
      }
      if (written !== entry.size) throw checksumError(entry);
      if (checksum !== entry.adler32) {
        await decodeExtractedFile(output, entry);
        let filter = filters.find((filter) => filter.id === "xor-adler32");
        if (!filter)
          filters.push((filter = { id: "xor-adler32", files: 0, bytes: 0 }));
        filter.files++;
        filter.bytes += entry.size;
      }
    } finally {
      await output.close();
    }
    onProgress?.({ path: entry.path, completed: i + 1, total: archive.files });
  }
  const renamedFiles = await writePathMap(root, paths);
  return {
    files: archive.files,
    bytes: archive.bytes,
    renamedFiles,
    paths,
    filters,
  };
}
