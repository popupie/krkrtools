import { open } from "node:fs/promises";

const MAX_SCAN = 16 * 1024 ** 2;
const MAX_RESOURCE = 1024 ** 2;
const align = (offset) => Math.ceil(offset / 4) * 4;

// Read PE headers/resources as data. Never load or execute the supplied EXE.
export async function inspectExecutable(path) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    async function read(offset, length) {
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        offset > size - length
      )
        throw new Error("Truncated PE data.");
      const bytes = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const result = await handle.read(
          bytes,
          done,
          length - done,
          offset + done,
        );
        if (!result.bytesRead) throw new Error("Truncated PE data.");
        done += result.bytesRead;
      }
      return bytes;
    }
    if (size < 64) return null;
    const dos = await read(0, 64);
    if (dos.toString("ascii", 0, 2) !== "MZ") return null;
    const peOffset = dos.readUInt32LE(60);
    const header = await read(peOffset, 24);
    if (header.readUInt32LE(0) !== 0x4550)
      throw new Error("Invalid PE signature.");
    const count = header.readUInt16LE(6);
    const optionalSize = header.readUInt16LE(20);
    if (!count || count > 96 || optionalSize < 2)
      throw new Error("Invalid PE headers.");
    const optional = await read(peOffset + 24, optionalSize);
    const magic = optional.readUInt16LE(0);
    const directory = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
    if (!directory || optionalSize < directory)
      throw new Error("Unsupported PE optional header.");
    const table = await read(peOffset + 24 + optionalSize, count * 40);
    const sections = [];
    for (let i = 0; i < count; i++) {
      const offset = i * 40;
      const section = {
        name: table.toString("ascii", offset, offset + 8).replace(/\0.*$/u, ""),
        rva: table.readUInt32LE(offset + 12),
        size: table.readUInt32LE(offset + 16),
        offset: table.readUInt32LE(offset + 20),
        flags: table.readUInt32LE(offset + 36),
      };
      if (section.offset > size - section.size)
        throw new Error("Truncated PE section.");
      sections.push(section);
    }
    function fileOffset(rva, length) {
      const section = sections.find(
        (item) => rva >= item.rva && rva - item.rva <= item.size - length,
      );
      if (!section)
        throw new Error("PE resource points outside stored sections.");
      return section.offset + rva - section.rva;
    }

    const versions = [];
    const warnings = [];
    if (
      optional.readUInt32LE(directory - 4) > 2 &&
      optionalSize >= directory + 24
    ) {
      const rva = optional.readUInt32LE(directory + 16);
      const length = optional.readUInt32LE(directory + 20);
      if (rva && length) {
        try {
          if (length > 8 * MAX_RESOURCE)
            throw new Error(
              "PE resource directory exceeds the 8 MiB inspection limit.",
            );
          const resources = await read(fileOffset(rva, length), length);
          const seen = new Set();
          let nodes = 0;
          const range = (offset, bytes) => {
            if (offset < 0 || bytes < 0 || offset > resources.length - bytes)
              throw new Error("Truncated PE resource directory.");
          };
          async function visit(offset, depth) {
            if (depth > 3 || seen.has(offset) || ++nodes > 256)
              throw new Error("Invalid PE resource directory tree.");
            seen.add(offset);
            range(offset, 16);
            const entries =
              resources.readUInt16LE(offset + 12) +
              resources.readUInt16LE(offset + 14);
            range(offset + 16, entries * 8);
            for (let i = 0; i < entries; i++) {
              const entry = offset + 16 + i * 8;
              const name = resources.readUInt32LE(entry);
              if (depth === 0 && name !== 16) continue; // RT_VERSION only.
              const pointer = resources.readUInt32LE(entry + 4);
              const target = pointer & 0x7fffffff;
              if (pointer >>> 31) await visit(target, depth + 1);
              else {
                range(target, 16);
                const dataRva = resources.readUInt32LE(target);
                const dataSize = resources.readUInt32LE(target + 4);
                if (dataSize > MAX_RESOURCE || versions.length >= 16)
                  throw new Error(
                    "PE version resources exceed the inspection limit.",
                  );
                versions.push(
                  parseVersionResource(
                    await read(fileOffset(dataRva, dataSize), dataSize),
                  ),
                );
              }
            }
          }
          await visit(0, 0);
        } catch (error) {
          warnings.push(error.message);
        }
      }
    }
    // Only initialized non-executable sections: no appended XP3/game content.
    const strings = [];
    let scanned = 0;
    for (const section of sections.filter(
      (item) => item.flags & 0x40 && !(item.flags & 0x20000000),
    )) {
      const length = Math.min(section.size, MAX_SCAN - scanned);
      if (!length) continue;
      const bytes = await read(section.offset, length);
      scanned += length;
      for (const encoding of ["utf-16le", "utf-8", "shift_jis"]) {
        const text = new TextDecoder(encoding).decode(bytes);
        // Match engine self-identification, not arbitrary mentions of versions.
        for (const match of text.matchAll(
          /(?:吉里吉里(?:\[きりきり\])?\s*[12ZＺ１２]\s*実行コア|KiriKiri\s*[12Z]\s+(?:execution\s+)?core)[^\x00\r\n]{0,180}/giu,
        )) {
          if (strings.length < 32 && !strings.includes(match[0]))
            strings.push(match[0]);
        }
      }
    }
    if (
      sections
        .filter((item) => item.flags & 0x40 && !(item.flags & 0x20000000))
        .reduce((sum, item) => sum + item.size, 0) > scanned
    )
      warnings.push("Executable string scan stopped at 16 MiB.");
    return { versions, strings, warnings };
  } finally {
    await handle.close();
  }
}

export function parseVersionResource(bytes) {
  let nodes = 0;
  const strings = [];
  let fileVersion = null;
  let productVersion = null;
  function node(offset, parentEnd, depth) {
    if (++nodes > 2048 || depth > 6 || offset > parentEnd - 6)
      throw new Error("Invalid PE version resource.");
    const end = offset + bytes.readUInt16LE(offset);
    const valueLength = bytes.readUInt16LE(offset + 2);
    const type = bytes.readUInt16LE(offset + 4);
    if (end > parentEnd || end <= offset + 6 || type > 1)
      throw new Error("Invalid PE version block.");
    let cursor = offset + 6;
    const keyStart = cursor;
    while (cursor <= end - 2 && bytes.readUInt16LE(cursor)) cursor += 2;
    if (cursor > end - 2) throw new Error("Unterminated PE version key.");
    const key = bytes.toString("utf16le", keyStart, cursor);
    cursor = align(cursor + 2);
    const length = type === 1 ? valueLength * 2 : valueLength;
    if (length && cursor > end - length)
      throw new Error("Truncated PE version value.");
    if (depth === 0) {
      if (key !== "VS_VERSION_INFO")
        throw new Error("Invalid PE version root.");
      if (length) {
        if (length < 52 || bytes.readUInt32LE(cursor) !== 0xfeef04bd)
          throw new Error("Invalid fixed PE version data.");
        const version = (position) =>
          [
            bytes.readUInt16LE(position + 2),
            bytes.readUInt16LE(position),
            bytes.readUInt16LE(position + 6),
            bytes.readUInt16LE(position + 4),
          ].join(".");
        fileVersion = version(cursor + 8);
        productVersion = version(cursor + 16);
      }
    } else if (type === 1 && length) {
      strings.push({
        key,
        value: bytes
          .toString("utf16le", cursor, cursor + length)
          .replace(/\0+$/u, ""),
      });
    }
    cursor = align(cursor + length);
    while (cursor < end) {
      if (cursor > end - 6) break;
      cursor = align(node(cursor, end, depth + 1));
    }
    return end;
  }
  node(0, bytes.length, 0);
  return { fileVersion, productVersion, strings };
}
