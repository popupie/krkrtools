import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import { inspectExecutable } from "./pe.mjs";
import { readXp3Entry } from "../archive/xp3.mjs";
import { decodeTextStream } from "../text-stream.mjs";

const MAX_SCRIPT = 512 * 1024;
const MAX_SCRIPT_BYTES = 4 * 1024 ** 2;
const MAX_SCRIPTS = 32;
const MAX_EXES = 8;
const SCRIPT_NAMES = [
  "initialize.tjs",
  "startup.tjs",
  "kagversion.tjs",
  "version.tjs",
  "kag.tjs",
  "kag3.tjs",
  "bootstrap.tjs",
  "init.tjs",
  "main.tjs",
  "mainwindow.tjs",
  "messagelayer.tjs",
];
const ENGINES = {
  krkr1: "KiriKiri1",
  krkr2: "KiriKiri2",
  krkrz: "KiriKiri Z",
  kirikiroid2: "Kirikiroid2",
};

function normalizedVersion(value) {
  const trimmed = value.trim();
  return /^\d{1,10}(?:\s*[.,]\s*\d{1,10}){1,3}$/u.test(trimmed)
    ? trimmed
        .split(/[.,]/u)
        .map((part) => String(Number(part.trim())))
        .join(".")
    : trimmed;
}

function engineId(text) {
  const value = text.normalize("NFKC");
  if (/\bKirikiroid2\b/iu.test(value)) return "kirikiroid2";
  const match =
    /(?:KiriKiri\)?\s*|吉里吉里(?:\[きりきり\])?\s*)([12Z])(?:\b|\s|実行)/iu.exec(
      value,
    );
  return match ? `krkr${match[1].toLowerCase()}` : null;
}

function namesEngine(text) {
  return /^(?:TVP\s*\(\s*)?(?:KiriKiri\)?\s*[12Z]|吉里吉里(?:\[きりきり\])?\s*[12Z]|Kirikiroid2)(?:\b|\s|実行)/iu.test(
    text.normalize("NFKC").trim(),
  );
}

function summarize(records, family = null) {
  const merged = new Map();
  for (const record of records) {
    const key = JSON.stringify([record.id, record.version, record.source]);
    const existing = merged.get(key);
    if (existing) existing.evidence.push(...record.evidence);
    else merged.set(key, { ...record, evidence: [...record.evidence] });
  }
  records = [...merged.values()].map((record) => ({
    ...record,
    evidence: [
      ...new Map(
        record.evidence.map((item) => [JSON.stringify(item), item]),
      ).values(),
    ],
  }));
  const ids = [...new Set(records.map((item) => item.id))];
  const versions = [
    ...new Set(records.map((item) => item.version).filter(Boolean)),
  ];
  return {
    ...(family ? { family } : {}),
    id: ids.length === 1 ? ids[0] : null,
    name: ids.length === 1 ? records[0].name : null,
    version: ids.length === 1 && versions.length === 1 ? versions[0] : null,
    detections: records,
  };
}

export function decodeScript(bytes) {
  bytes = decodeTextStream(bytes, { maxBytes: MAX_SCRIPT });
  let encoding;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  else {
    const sample = bytes.subarray(0, 256);
    let odd = 0,
      even = 0;
    for (let i = 0; i < sample.length; i++)
      if (!sample[i]) {
        if (i % 2) odd++;
        else even++;
      }
    if (odd > sample.length / 4) encoding = "utf-16le";
    else if (even > sample.length / 4) encoding = "utf-16be";
  }
  if (encoding) return new TextDecoder(encoding).decode(bytes);
  if (bytes.includes(0))
    throw new Error("Binary/compiled script cannot be classified as source.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

export function inspectScript(bytes, source) {
  const text = decodeScript(bytes);
  // Preserve quoted strings while removing comments.
  const code = text.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
    (match, quoted) => quoted ?? " ".repeat(match.length),
  );
  const detections = [];
  const tokens = [
    ...code.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|\S/gu),
  ].map((match) => match[0]);
  for (let i = 0; i < tokens.length - 2; i++) {
    if (
      !/^(?:kagVersion|kag_version)$/iu.test(tokens[i]) ||
      tokens[i + 1] !== "=" ||
      tokens[i - 1] === "/"
    )
      continue;
    const match = /^(["'])([0-9][A-Za-z0-9 ._()+-]{0,79})\1$/u.exec(
      tokens[i + 2],
    );
    if (!match) continue;
    const version = match[2].trim();
    const generation = /^([123])(?:\.|\s|$)/u.exec(version)?.[1];
    if (!generation) continue;
    detections.push({
      id: `kag${generation}`,
      name: `KAG${generation}`,
      version,
      source,
      evidence: [
        {
          field: "script declaration",
          value: `${tokens[i]} = ${tokens[i + 2]}`,
        },
      ],
    });
  }
  // Structural fallback identifies KAG without inventing a release number.
  const structure = code.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, " ");
  if (
    !detections.length &&
    /\bclass\s+KAGWindow\s+extends\s+Window\b/u.test(structure)
  )
    detections.push({
      id: "kag",
      name: "KAG (generation unknown)",
      version: null,
      source,
      evidence: [
        { field: "script class", value: "class KAGWindow extends Window" },
      ],
    });
  return detections;
}

export async function classifyGame({ files, archives, executableFiles }) {
  const engines = [];
  const frameworks = [];
  const notes = [];
  const warnings = [];
  const exes =
    executableFiles ??
    files.filter((file) => extname(file.path).toLowerCase() === ".exe");
  if (exes.length > MAX_EXES)
    warnings.push(`Only the first ${MAX_EXES} executables were inspected.`);
  let executablesRead = 0;
  for (const file of exes.slice(0, MAX_EXES)) {
    try {
      const report = await inspectExecutable(file.full);
      executablesRead++;
      if (!report) continue;
      warnings.push(
        ...report.warnings.map((message) => `${file.path}: ${message}`),
      );
      const detected = [];
      for (const resource of report.versions) {
        const identities = resource.strings.filter((item) =>
          ["FileDescription", "ProductName", "InternalName"].includes(item.key),
        );
        for (const identity of identities) {
          const id = engineId(identity.value);
          if (!id) continue;
          // ProductVersion may be the game's version, even in a standard engine.
          const fileVersions = resource.strings.filter(
            (item) => item.key === "FileVersion" && item.value.trim(),
          );
          const versionEvidence = resource.fileVersion
            ? [
                {
                  field: "VS_FIXEDFILEINFO.FileVersion",
                  value: resource.fileVersion,
                },
              ]
            : [];
          versionEvidence.push(
            ...fileVersions.map((item) => ({
              field: item.key,
              value: item.value,
            })),
          );
          // A game description merely mentioning KiriKiri does not make its
          // application version the engine build. Require an engine identity.
          const versions = namesEngine(identity.value)
            ? [
                ...new Set(
                  versionEvidence.map((item) => normalizedVersion(item.value)),
                ),
              ]
            : [];
          for (const version of versions.length ? versions : [null])
            detected.push({
              id,
              name: ENGINES[id],
              version,
              source: file.path,
              evidence: [
                { field: identity.key, value: identity.value },
                ...versionEvidence,
              ],
            });
        }
      }
      for (const value of report.strings) {
        const id = engineId(value);
        if (!id) continue;
        const existing = detected.find((item) => item.id === id);
        if (existing)
          existing.evidence.push({
            field: "embedded engine identification",
            value,
          });
        else
          detected.push({
            id,
            name: ENGINES[id],
            version: null,
            source: file.path,
            evidence: [{ field: "embedded engine identification", value }],
          });
      }
      engines.push(...detected);
    } catch (error) {
      warnings.push(`${file.path}: ${error.message}`);
    }
  }

  const candidates = files
    .filter((file) => SCRIPT_NAMES.includes(basename(file.path).toLowerCase()))
    .map((file) => ({ ...file, source: file.path }));
  for (const archive of archives) {
    for (const entry of archive.entries)
      if (SCRIPT_NAMES.includes(basename(entry.path).toLowerCase()))
        candidates.push({
          path: entry.path,
          size: entry.size,
          archive,
          entry,
          source: `${archive.source ?? basename(archive.path)}>${entry.path}`,
        });
  }
  candidates.sort(
    (a, b) =>
      SCRIPT_NAMES.indexOf(basename(a.path).toLowerCase()) -
        SCRIPT_NAMES.indexOf(basename(b.path).toLowerCase()) ||
      a.source.localeCompare(b.source, "en"),
  );
  let scriptsRead = 0,
    scriptBytes = 0,
    candidatesSeen = 0;
  for (const file of candidates) {
    if (++candidatesSeen > 128) {
      warnings.push("Only the first 128 candidate scripts were considered.");
      break;
    }
    if (file.size > MAX_SCRIPT) {
      warnings.push(
        `${file.source}: Script exceeds the 512 KiB inspection limit.`,
      );
      continue;
    }
    if (
      scriptsRead >= MAX_SCRIPTS ||
      scriptBytes + file.size > MAX_SCRIPT_BYTES
    ) {
      warnings.push("Script inspection stopped at 32 scripts or 4 MiB.");
      break;
    }
    scriptsRead++;
    scriptBytes += file.size;
    try {
      let bytes;
      if (file.archive)
        bytes = await readXp3Entry(file.archive, file.entry, {
          maxBytes: MAX_SCRIPT,
        });
      else {
        const handle = await open(file.full, "r");
        try {
          if ((await handle.stat()).size !== file.size)
            throw new Error("Script changed after inspection.");
          bytes = Buffer.alloc(file.size);
          let done = 0;
          while (done < bytes.length) {
            const result = await handle.read(
              bytes,
              done,
              bytes.length - done,
              done,
            );
            if (!result.bytesRead) throw new Error("Truncated script.");
            done += result.bytesRead;
          }
        } finally {
          await handle.close();
        }
      }
      const decoded = decodeTextStream(bytes, {
        maxBytes: Math.min(
          MAX_SCRIPT,
          MAX_SCRIPT_BYTES - scriptBytes + file.size,
        ),
      });
      scriptBytes += Math.max(0, decoded.length - bytes.length);
      frameworks.push(...inspectScript(decoded, file.source));
    } catch (error) {
      warnings.push(`${file.source}: ${error.message}`);
    }
  }
  // A declared KAG generation is more specific than a matching KAG class.
  const declaredFrameworks = frameworks.some((item) => item.version)
    ? frameworks.filter((item) => item.version)
    : frameworks;
  const family =
    engines.length ||
    frameworks.length ||
    archives.length ||
    files.some((file) => /(?:^|\/)startup\.tjs$/iu.test(file.path))
      ? "KiriKiri"
      : null;
  const engine = summarize(engines, family);
  const framework = summarize(declaredFrameworks);
  if (!engine.id)
    notes.push(
      engines.length
        ? "Multiple engine variants were found."
        : "Engine generation and build are not established by XP3 or KAG scripts alone.",
    );
  if (new Set(engines.map((item) => item.version).filter(Boolean)).size > 1)
    notes.push(
      "Multiple engine build versions were found. No single version was selected.",
    );
  if (
    new Set(declaredFrameworks.map((item) => item.version).filter(Boolean))
      .size > 1
  )
    notes.push(
      "Multiple framework versions were found. Archive precedence was not assumed.",
    );
  notes.push(
    "Static identification does not establish browser/plugin compatibility. No executable or script was run.",
  );
  return {
    engine,
    framework,
    notes,
    warnings,
    inspected: {
      executables: executablesRead,
      scripts: scriptsRead,
      scriptBytes,
    },
  };
}

export function formatClassification({ engine, framework, notes, warnings }) {
  const lines = [
    `Engine: ${engine.name ?? (engine.family ? "KiriKiri (generation unknown)" : "unknown")}; version: ${engine.version ?? "unknown"}`,
    `Framework: ${framework.name ?? "unknown"}; version: ${framework.version ?? "unknown"}`,
  ];
  for (const category of [engine, framework])
    for (const detection of category.detections) {
      lines.push(
        `  ${detection.source}: ${detection.name}${detection.version ? ` ${detection.version}` : ""}`,
      );
      for (const evidence of detection.evidence)
        lines.push(`    ${evidence.field}: ${JSON.stringify(evidence.value)}`);
    }
  lines.push(
    ...notes.map((note) => `Note: ${note}`),
    ...warnings.map((warning) => `Warning: ${warning}`),
  );
  return lines;
}
