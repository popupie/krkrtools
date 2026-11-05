// KAGParserEx keeps a private list of argument names for `*` and bookmarks.
// Declare fields written by a macro at its static call sites, with a void
// value until the game's script assigns them. This preserves native parsing
// and saved-state handling without executing or rewriting TJS expressions.
function source(raw, encoding) {
  if (raw[0] === 0xff && raw[1] === 0xfe)
    return {
      text: raw.subarray(2).toString("utf16le"),
      encode: (s) =>
        Buffer.concat([raw.subarray(0, 2), Buffer.from(s, "utf16le")]),
      name: (s) => s,
      multibyte: false,
    };
  if (raw[0] === 0xfe && raw[1] === 0xff)
    return {
      text: Buffer.from(raw.subarray(2)).swap16().toString("utf16le"),
      encode: (s) =>
        Buffer.concat([raw.subarray(0, 2), Buffer.from(s, "utf16le").swap16()]),
      name: (s) => s,
      multibyte: false,
    };
  const decoder = new TextDecoder(encoding);
  return {
    text: raw.toString("latin1"),
    encode: (s) => Buffer.from(s, "latin1"),
    name: (s) => decoder.decode(Buffer.from(s, "latin1")),
    multibyte: /^(?:shift[-_]?jis|sjis|cp932|windows-31j)$/iu.test(encoding),
  };
}

const asciiLower = (text) => text.replace(/[A-Z]/gu, (c) => c.toLowerCase());
const whitespace = (c) => c !== undefined && /[ \t\r\n\f\v]/u.test(c);

function tags(text, multibyte) {
  const result = [];
  const lead = (i) =>
    multibyte &&
    ((text.charCodeAt(i) >= 0x81 && text.charCodeAt(i) <= 0x9f) ||
      (text.charCodeAt(i) >= 0xe0 && text.charCodeAt(i) <= 0xfc));
  let script = false;
  for (let i = 0; i < text.length; ) {
    if (i === 0 || text[i - 1] === "\n" || text[i - 1] === "\r") {
      const line = /^[\t ]*([^\r\n]*)/u.exec(text.slice(i))[1];
      if (
        (script && !/^(?:@endscript\b|\[endscript\])/iu.test(line)) ||
        (!script && /^[;*]/u.test(line))
      ) {
        i +=
          text.slice(i).search(/[\r\n]/u) < 0
            ? text.length - i
            : text.slice(i).search(/[\r\n]/u) + 1;
        continue;
      }
      if (script) script = false;
      const spaces = /^[\t ]*/u.exec(text.slice(i))[0].length;
      if (text[i + spaces] === "@") i += spaces;
    }
    if (lead(i)) {
      i += 2;
      continue;
    }
    if (text.startsWith("[[", i)) {
      i += 2;
      continue;
    }
    const command =
      text[i] === "@" &&
      /^(?:[\t ]*)$/u.test(
        text.slice(
          Math.max(
            text.lastIndexOf("\n", i - 1),
            text.lastIndexOf("\r", i - 1),
          ) + 1,
          i,
        ),
      );
    if (text[i] !== "[" && !command) {
      i++;
      continue;
    }
    const start = i++;
    let quote = null;
    for (; i < text.length; i++) {
      if (lead(i)) {
        i++;
        continue;
      }
      const c = text[i];
      if (quote) {
        if (c === "`") {
          i++;
          continue;
        }
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (command ? /[\r\n]/u.test(c) : c === "]") break;
    }
    const end = i;
    const tokens = [];
    for (let at = start + 1; at < end; ) {
      if (whitespace(text[at])) {
        at++;
        continue;
      }
      const from = at,
        delimiter = text[at] === '"' || text[at] === "'" ? text[at++] : null;
      if (delimiter) {
        while (at < end) {
          if (lead(at)) {
            at += 2;
            continue;
          }
          if (text[at] === "`") {
            at += 2;
            continue;
          }
          if (text[at++] === delimiter) break;
        }
      } else if (text[at] === "=") at++;
      else
        while (at < end && !whitespace(text[at]) && text[at] !== "=")
          at += lead(at) ? 2 : 1;
      tokens.push({ value: text.slice(from, at), end: at });
    }
    const first = tokens.shift(),
      name = asciiLower(first?.value ?? ""),
      attributes = new Map();
    let wildcard = false;
    for (let t = 0; t < tokens.length; t++) {
      const key = asciiLower(tokens[t].value);
      if (key === "*") {
        wildcard = true;
        continue;
      }
      let value = "true";
      if (tokens[t + 1]?.value === "=") {
        value = tokens[t + 2]?.value ?? "";
        t += 2;
      }
      if (/^["']/u.test(value)) {
        const quoted = value.slice(1, -1);
        value = "";
        for (let at = 0; at < quoted.length; at++) {
          const code = quoted.charCodeAt(at);
          if (
            multibyte &&
            ((code >= 0x81 && code <= 0x9f) || (code >= 0xe0 && code <= 0xfc))
          )
            value += quoted[at] + quoted[++at];
          else value += quoted[at] === "`" ? (quoted[++at] ?? "") : quoted[at];
        }
      }
      attributes.set(key, value);
    }
    result.push({
      name,
      attributes,
      wildcard,
      end,
      insert: first?.end ?? start + 1,
    });
    if (name === "iscript") script = true;
    i += command ? 0 : 1;
  }
  return result;
}

export function macroArgumentDeclarations(
  raw,
  { encoding = "Shift_JIS" } = {},
) {
  const s = source(raw, encoding),
    declarations = new Map();
  let macro = null;
  for (const tag of tags(s.text, s.multibyte)) {
    if (tag.name === "macro") {
      const name = tag.attributes.get("name");
      macro =
        name && !/^[&%]/u.test(name)
          ? {
              name: s.name(name).toLowerCase(),
              fields: new Set(),
              wildcard: false,
            }
          : null;
    } else if (tag.name === "endmacro") {
      if (macro?.wildcard && macro.fields.size) {
        if (!declarations.has(macro.name))
          declarations.set(macro.name, new Set());
        for (const field of macro.fields)
          declarations.get(macro.name).add(field);
      }
      macro = null;
    } else if (macro) {
      macro.wildcard ||= tag.wildcard;
      if (tag.name !== "eval") continue;
      const code = (tag.attributes.get("exp") ?? "").replace(
        /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
        (m) => " ".repeat(m.length),
      );
      for (const m of code.matchAll(
        /(?<![\w$.])mp\s*\.\s*([a-z_][a-z_0-9]*)\s*(?:=(?!=)|[+*/%&|^-]=|\+\+|--)/gu,
      ))
        if (!["cond", "tagname"].includes(m[1])) macro.fields.add(m[1]);
    }
  }
  return declarations;
}

export function adaptMacroCalls(
  raw,
  declarations,
  { encoding = "Shift_JIS" } = {},
) {
  const s = source(raw, encoding),
    changes = [];
  for (const tag of tags(s.text, s.multibyte)) {
    const fields = declarations.get(s.name(tag.name ?? "").toLowerCase());
    if (!fields) continue;
    const missing = [...fields]
      .filter((field) => !tag.attributes.has(field))
      .sort();
    if (missing.length) changes.push({ end: tag.insert, fields: missing });
  }
  if (!changes.length) return null;
  let text = s.text;
  for (const change of changes.toReversed())
    text =
      text.slice(0, change.end) +
      change.fields.map((field) => ` ${field}=&void`).join("") +
      text.slice(change.end);
  return {
    data: s.encode(text),
    calls: changes.length,
    fields: [...new Set(changes.flatMap((change) => change.fields))].sort(),
  };
}
