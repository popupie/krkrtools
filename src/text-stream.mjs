import { inflateSync } from "node:zlib";

// Decode the FE FE text-stream wrapper, not TJS bytecode. Format reference:
// https://github.com/krkrz/krkrz/blob/master/base/TextStream.cpp
export function decodeTextStream(bytes, { maxBytes = 1024 * 1024 } = {}) {
  if (bytes[0] !== 0xfe || bytes[1] !== 0xfe) return bytes;
  if (bytes.length < 5 || bytes[3] !== 0xff || bytes[4] !== 0xfe)
    throw new Error("Invalid encoded TJS text-stream header.");
  const mode = bytes[2];
  let body;
  if (mode === 0 || mode === 1) {
    if ((bytes.length - 5) % 2)
      throw new Error("Truncated encoded TJS text stream.");
    if (bytes.length - 3 > maxBytes)
      throw new Error("Decoded TJS text exceeds the inspection size limit.");
    body = Buffer.from(bytes.subarray(5));
    for (let i = 0; i < body.length; i += 2) {
      const value = body.readUInt16LE(i);
      const decoded =
        mode === 1
          ? ((value & 0xaaaa) >>> 1) | ((value & 0x5555) << 1)
          : value >= 0x20
            ? value ^ (((value & 0xfe) << 8) ^ 1)
            : value;
      body.writeUInt16LE(decoded, i);
    }
  } else if (mode === 2) {
    if (bytes.length < 21)
      throw new Error("Truncated compressed TJS text stream.");
    const stored = bytes.readBigUInt64LE(5),
      expanded = bytes.readBigUInt64LE(13);
    if (stored !== BigInt(bytes.length - 21) || expanded % 2n)
      throw new Error("Invalid compressed TJS text-stream sizes.");
    if (expanded + 2n > BigInt(maxBytes))
      throw new Error("Decoded TJS text exceeds the inspection size limit.");
    body = inflateSync(bytes.subarray(21), {
      maxOutputLength: Math.max(1, Number(expanded)),
    });
    if (body.length !== Number(expanded))
      throw new Error("Compressed TJS text-stream size mismatch.");
  } else throw new Error(`Unsupported encoded TJS text-stream mode: ${mode}`);
  return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
}
