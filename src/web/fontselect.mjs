// Recognize the KAG/Krkr2Compat font-picker loader.
export function adaptFontLoader(raw) {
  let text, encode;
  if (raw[0] === 0xff && raw[1] === 0xfe) {
    text = raw.subarray(2).toString("utf16le");
    encode = (s) =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
  } else if (raw[0] === 0xfe && raw[1] === 0xff) {
    text = Buffer.from(raw.subarray(2)).swap16().toString("utf16le");
    encode = (s) =>
      Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from(s, "utf16le").swap16(),
      ]);
  } else {
    text = raw.toString("latin1");
    encode = (s) => Buffer.from(s, "latin1");
  }
  const code = text.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
    (match, quote) => quote ?? " ".repeat(match.length),
  );
  const tokens = [
    ...code.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|\S/gu),
  ];
  const expected = [
    "if",
    "(",
    "useKrkrZ",
    ")",
    "{",
    "KAGLoadScript",
    "(",
    '"win32dialog.tjs"',
    ")",
    ";",
    "KAGLoadScript",
    "(",
    '"k2compat.tjs"',
    ")",
    ";",
    "KAGLoadScript",
    "(",
    '"k2compat_fontselect.tjs"',
    ")",
    ";",
    "}",
  ];
  const replacements = [];
  for (let i = 0; i <= tokens.length - expected.length; i++) {
    if (
      !expected.every(
        (token, j) => tokens[i + j][0].replace(/^'(.*)'$/u, '"$1"') === token,
      )
    )
      continue;
    const last = tokens[i + expected.length - 1];
    replacements.push([tokens[i].index, last.index + last[0].length]);
    i += expected.length - 1;
  }
  if (!replacements.length) return null;
  for (const [start, end] of replacements.reverse())
    text =
      text.slice(0, start) +
      'if(useKrkrZ) { KAGLoadScript("k2compat.tjs"); Scripts.execStorage("_krkrtools/fontselect.tjs"); }' +
      text.slice(end);
  return { data: encode(text), replacements: replacements.length };
}
