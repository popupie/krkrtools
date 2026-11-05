import { open } from "node:fs/promises";
import { basename } from "node:path";
import { readXp3Entry } from "../archive/xp3.mjs";
import { decodeScript } from "./classify.mjs";
import { decodeTextStream } from "../text-stream.mjs";
import { getPlugin, pluginName } from "../plugins/catalog.mjs";

export const PLUGIN_SCAN_LIMITS = Object.freeze({
  scriptBytes: 1024 * 1024,
  totalBytes: 64 * 1024 ** 2,
  scripts: 4096,
  modules: 1024,
  evidence: 8192,
  perModule: 128,
  unresolved: 256,
  warnings: 128,
});

function quoted(text, start) {
  const quote = text[start];
  let value = "",
    valid = true,
    i = start + 1;
  const escapes = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "/": "/",
  };
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === quote) return { value: valid ? value : null, end: i + 1 };
    if (ch !== "\\") {
      value += ch;
      continue;
    }
    const escape = text[++i];
    if (escape === "x") {
      const hex = /^[a-f0-9]{1,4}/iu.exec(text.slice(i + 1))?.[0];
      if (hex) {
        value += String.fromCharCode(parseInt(hex, 16));
        i += hex.length;
      } else valid = false;
    } else if (Object.hasOwn(escapes, escape)) value += escapes[escape];
    else valid = false;
  }
  return { value: null, end: i };
}
function tokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const start = i,
      ch = text[i],
      previous = out.at(-1)?.text;
    if (/\s/u.test(ch)) {
      i++;
      continue;
    }
    if (text.startsWith("//", i)) {
      while (i < text.length && !/[\r\n]/u.test(text[i])) i++;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const value = quoted(text, i);
      i = value.end;
      out.push({
        text: text.slice(start, i),
        start,
        end: i,
        string: true,
        value: previous === "@" ? null : value.value,
      });
      continue;
    }
    // Ignore regular-expression bodies, including their quoted-looking text.
    if (
      ch === "/" &&
      (!previous ||
        /^(?:[=(:,[!;?{}]|return|throw|case|=>|&&|\|\|)$/u.test(previous))
    ) {
      i++;
      let cls = false;
      while (i < text.length) {
        const c = text[i++];
        if (c === "\\") {
          i++;
          continue;
        }
        if (c === "[") cls = true;
        if (c === "]") cls = false;
        if (c === "/" && !cls) break;
      }
      while (/[a-z]/iu.test(text[i] ?? "") && i < text.length) i++;
      out.push({ text: "<regex>", start, end: i });
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/u.exec(text.slice(i))?.[0];
    i += word?.length ?? 1;
    out.push({ text: word ?? ch, start, end: i });
  }
  return out;
}
function constantString(items) {
  if (!items.length || items.length > 128) return null;
  let i = 0;
  function atom(depth = 0) {
    if (depth > 32) return null;
    const token = items[i++];
    if (!token) return null;
    if (token.string) return token.value;
    if (token.text !== "(") return null;
    const value = expression(depth + 1);
    return items[i++]?.text === ")" ? value : null;
  }
  function expression(depth = 0) {
    let value = atom(depth);
    if (value === null) return null;
    while (items[i]?.text === "+") {
      i++;
      const next = atom(depth);
      if (next === null) return null;
      value += next;
      if (value.length > 1024) return null;
    }
    return value;
  }
  const value = expression();
  return i === items.length ? value : null;
}
function scanTjs(text, base = 0, kind = "tjs-link") {
  const all = tokens(text),
    found = [];
  for (let i = 0; i < all.length && found.length < 512; i++) {
    if (all[i].text !== "Plugins") continue;
    // Accept Plugins.link and global.Plugins.link, not unrelated object members.
    if (all[i - 1]?.text === "." && all[i - 2]?.text !== "global") continue;
    let next = i + 1;
    if (all[next]?.text === "." && all[next + 1]?.text === "link") next += 2;
    else if (
      all[next]?.text === "[" &&
      all[next + 1]?.value === "link" &&
      all[next + 2]?.text === "]"
    )
      next += 3;
    else continue;
    if (all[next]?.text !== "(") continue;
    const begin = ++next;
    let nesting = 0;
    for (; next < all.length; next++) {
      const t = all[next].text;
      if (nesting === 0 && (t === "," || t === ")")) break;
      if (["(", "[", "{"].includes(t)) nesting++;
      if ([")", "]", "}"].includes(t)) nesting--;
      if (nesting < 0) break;
    }
    const value = constantString(all.slice(begin, next));
    const end = all[next]?.end ?? all.at(-1).end;
    found.push({
      name: value,
      offset: base + all[i].start,
      kind,
      expression: text.slice(all[i].start, end).slice(0, 240),
      ...(value === null
        ? {
            literalFragments: all
              .slice(begin, next)
              .filter((t) => t.string && t.value !== null)
              .map((t) => t.value)
              .slice(0, 8),
          }
        : {}),
    });
  }
  return found;
}
function attributes(text) {
  const result = new Map();
  let i = 0;
  while (i < text.length) {
    const m = /[A-Za-z_]\w*\s*=\s*/gu;
    m.lastIndex = i;
    const match = m.exec(text);
    if (!match) break;
    i = m.lastIndex;
    const key = match[0].split("=")[0].trim().toLowerCase();
    let value;
    if (text[i] === '"' || text[i] === "'") {
      const q = quoted(text, i);
      value = q.value;
      i = q.end;
    } else {
      const bare = /^[^\s\]]+/u.exec(text.slice(i))?.[0] ?? "";
      value = bare;
      i += bare.length;
    }
    result.set(key, value);
  }
  return result;
}
function scanKag(text) {
  const found = [];
  let i = 0;
  while (i < text.length && found.length < 512) {
    const start = i,
      lineStart = i === 0 || /[\r\n]/u.test(text[i - 1]);
    if (lineStart && /^[\t ]*;/u.test(text.slice(i))) {
      while (i < text.length && !/[\r\n]/u.test(text[i])) i++;
      continue;
    }
    let body, end;
    if (lineStart && /^[\t ]*@/u.test(text.slice(i))) {
      const marker = /^[\t ]*@/u.exec(text.slice(i))[0].length;
      end = i + marker;
      while (end < text.length && !/[\r\n]/u.test(text[end])) end++;
      body = text.slice(i + marker, end);
    } else if (text.startsWith("[[", i)) {
      i += 2;
      continue;
    } else if (text[i] === "[") {
      end = i + 1;
      while (end < text.length && text[end] !== "]") {
        if (text[end] === '"' || text[end] === "'") end = quoted(text, end).end;
        else end++;
      }
      if (end >= text.length) break;
      body = text.slice(i + 1, end);
      end++;
    } else {
      i++;
      continue;
    }
    i = end;
    const command = /^\s*([A-Za-z_]\w*)/u.exec(body);
    if (!command) continue;
    const name = command[1].toLowerCase();
    if (name === "iscript") {
      const close = /^[\t ]*@endscript\b[^\r\n]*|\[endscript\s*\]/gimu;
      close.lastIndex = i;
      const match = close.exec(text);
      const stop = match?.index ?? text.length;
      found.push(...scanTjs(text.slice(i, stop), i));
      i = match ? close.lastIndex : text.length;
      continue;
    }
    const attrs = attributes(body.slice(command[0].length));
    if (name === "loadplugin") {
      const value = attrs.get("module");
      found.push({
        name: typeof value === "string" && !/^[&%]/u.test(value) ? value : null,
        offset: start,
        kind: "kag-loadplugin",
        expression: text.slice(start, end).slice(0, 240),
      });
    } else if (typeof attrs.get("exp") === "string") {
      for (const item of scanTjs(attrs.get("exp"), 0, "kag-expression"))
        found.push({
          ...item,
          offset: start,
          expression: text.slice(start, end).slice(0, 240),
          location: "tag",
        });
    }
  }
  return found.slice(0, 512);
}

export function inspectPluginSource(bytes, source, path = source) {
  bytes = decodeTextStream(bytes, { maxBytes: PLUGIN_SCAN_LIMITS.scriptBytes });
  const text = decodeScript(bytes),
    found = /\.ks$/iu.test(path) ? scanKag(text) : scanTjs(text);
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\r") {
      if (text[i + 1] === "\n") i++;
      starts.push(i + 1);
    } else if (text[i] === "\n") starts.push(i + 1);
  }
  return found.map(({ offset, ...item }) => {
    let low = 0,
      high = starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return { ...item, source, line: low + 1, column: offset - starts[low] + 1 };
  });
}

export async function detectGamePlugins({
  files = [],
  archives = [],
  nativeFiles = [],
  limits: overrides = {},
} = {}) {
  const limits = { ...PLUGIN_SCAN_LIMITS, ...overrides };
  for (const [key, n] of Object.entries(limits))
    if (
      !Object.hasOwn(PLUGIN_SCAN_LIMITS, key) ||
      !Number.isSafeInteger(n) ||
      n < 1 ||
      n > PLUGIN_SCAN_LIMITS[key]
    )
      throw new Error("Invalid plugin scan limit.");
  const modules = new Map(),
    warnings = [],
    unresolved = [],
    candidates = [];
  const scan = {
    scripts: 0,
    totalScriptFiles: 0,
    scriptBytes: 0,
    skippedScripts: 0,
    truncatedEvidence: false,
  };
  let evidence = 0;
  const warn = (source, message) => {
    if (warnings.length < limits.warnings) warnings.push({ source, message });
    else scan.truncatedEvidence = true;
  };
  function module(name) {
    const known = getPlugin(name),
      id = known?.id ?? pluginName(name);
    let entry = modules.get(id);
    if (!entry) {
      if (modules.size >= limits.modules) {
        scan.truncatedEvidence = true;
        return null;
      }
      entry = {
        id,
        name: known?.name ?? id,
        support: {
          status: known?.status ?? "unknown",
          ...(known?.provides ? { provides: known.provides } : {}),
          ...(known?.target ? { target: known.target } : {}),
          ...(known?.limits ? { limits: known.limits } : {}),
        },
        names: [],
        references: [],
        files: [],
      };
      modules.set(id, entry);
    }
    if (!entry.names.includes(name) && entry.names.length < 32)
      entry.names.push(name);
    return entry;
  }
  function collect(file) {
    const source = file.source ?? file.path;
    if (/\.(?:dll|tpm)$/iu.test(file.path)) {
      const entry = module(basename(file.path.replaceAll("\\", "/")));
      if (entry && entry.files.length < limits.perModule)
        entry.files.push({ source, bytes: file.size ?? file.bytes });
      else scan.truncatedEvidence = true;
    }
    if (
      /\.(?:tjs|ks)$/iu.test(file.path) &&
      !/(?:^|\/)_krkrtools\//iu.test(file.path)
    )
      candidates.push({ ...file, source });
  }
  for (const file of files) collect(file);
  for (const archive of archives)
    for (const entry of archive.entries)
      collect({
        path: entry.path,
        size: entry.size,
        archive,
        entry,
        source: `${archive.source ?? basename(archive.path)}>${entry.path}`,
      });
  for (const file of nativeFiles) collect(file);
  candidates.sort((a, b) => a.source.localeCompare(b.source, "en"));
  scan.totalScriptFiles = candidates.length;
  for (const file of candidates) {
    if (
      scan.scripts >= limits.scripts ||
      scan.scriptBytes + file.size > limits.totalBytes ||
      file.size > limits.scriptBytes
    ) {
      scan.skippedScripts++;
      warn(
        file.source,
        "Script skipped by the plugin inspection size/count limit.",
      );
      continue;
    }
    scan.scripts++;
    scan.scriptBytes += file.size;
    try {
      let bytes;
      if (file.archive)
        bytes = await readXp3Entry(file.archive, file.entry, {
          maxBytes: limits.scriptBytes,
        });
      else {
        const handle = await open(file.full, "r");
        try {
          if ((await handle.stat()).size !== file.size)
            throw new Error("Script changed after listing.");
          bytes = Buffer.alloc(file.size);
          let done = 0;
          while (done < bytes.length) {
            const read = await handle.read(
              bytes,
              done,
              bytes.length - done,
              done,
            );
            if (!read.bytesRead) throw new Error("Truncated script.");
            done += read.bytesRead;
          }
          if ((await handle.stat()).size !== file.size)
            throw new Error("Script changed while reading.");
        } finally {
          await handle.close();
        }
      }
      const decoded = decodeTextStream(bytes, {
        maxBytes: Math.min(
          limits.scriptBytes,
          limits.totalBytes - scan.scriptBytes + file.size,
        ),
      });
      scan.scriptBytes += Math.max(0, decoded.length - bytes.length);
      const found = inspectPluginSource(decoded, file.source, file.path);
      if (found.length === 512) scan.truncatedEvidence = true;
      for (const { name, ...reference } of found) {
        if (
          typeof name !== "string" ||
          !name ||
          name.length > 1024 ||
          /[\x00-\x1f\x7f]/u.test(name)
        ) {
          if (unresolved.length < limits.unresolved) unresolved.push(reference);
          else scan.truncatedEvidence = true;
          continue;
        }
        const entry = module(name);
        if (
          entry &&
          entry.references.length < limits.perModule &&
          evidence < limits.evidence
        ) {
          entry.references.push({ ...reference, value: name });
          evidence++;
        } else scan.truncatedEvidence = true;
      }
    } catch (error) {
      warn(file.source, error.message);
    }
  }
  const plugins = [...modules.values()].sort(
    (a, b) =>
      Number(b.references.length > 0) - Number(a.references.length > 0) ||
      a.id.localeCompare(b.id, "en"),
  );
  return {
    version: 1,
    plugins,
    unresolved,
    scan,
    limits,
    warnings,
    notes: [
      "References may be conditional, optional or inside uncalled functions. Bundled DLL/TPM files alone do not establish use.",
      "Dynamic names, aliases, generated code, custom loaders and unreadable/compiled scripts may hide additional plugins.",
      "Support statuses describe krkrtools' default web profile. A runtime may be different.",
    ],
  };
}

export function formatPluginDetection(report, { details = true } = {}) {
  if (!report) return [];
  const lines = ["Plugins (files and script references. Default web support):"];
  if (!report.plugins.length)
    lines.push(
      "  No plugin references or bundled DLL/TPM files found in the inspected files.",
    );
  for (const plugin of report.plugins) {
    lines.push(
      `  ${plugin.name}: ${plugin.support.status} (${plugin.references.length ? (plugin.files.length ? "referenced; bundled" : "referenced") : "bundled only"})`,
    );
    const refs = details ? plugin.references : plugin.references.slice(0, 1),
      files = details ? plugin.files : plugin.files.slice(0, 1);
    for (const ref of refs)
      lines.push(
        `    ${ref.source}:${ref.line}: ${ref.expression}${!details && plugin.references.length > 1 ? ` (+${plugin.references.length - 1} other references)` : ""}`,
      );
    for (const file of files)
      lines.push(
        `    Native file: ${file.source}${!details && plugin.files.length > 1 ? ` (+${plugin.files.length - 1} other files)` : ""}`,
      );
    if (plugin.support.limits)
      lines.push(`    Limits: ${plugin.support.limits}`);
  }
  if (report.unresolved.length) {
    lines.push(`Unresolved dynamic plugin loads: ${report.unresolved.length}`);
    if (details)
      for (const ref of report.unresolved)
        lines.push(`  ${ref.source}:${ref.line}: ${ref.expression}`);
  }
  lines.push(
    `Plugin scan: ${report.scan.scripts}/${report.scan.totalScriptFiles} scripts, ${report.scan.scriptBytes} bytes; ${report.scan.skippedScripts} skipped.`,
  );
  if (report.scan.truncatedEvidence)
    lines.push("Warning: Plugin evidence was truncated by the report limits.");
  for (const warning of report.warnings)
    lines.push(`Warning: ${warning.source}: ${warning.message}`);
  lines.push(...report.notes.map((note) => `Note: ${note}`));
  return lines;
}
