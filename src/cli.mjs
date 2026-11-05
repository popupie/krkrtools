import { formatPluginDetection } from "./inspect/plugins.mjs";
import { PLUGINS } from "./plugins/catalog.mjs";
import { packXp3 } from "./pack.mjs";
import { inspectPath, formatInspection } from "./inspect.mjs";
import { unpackPath } from "./unpack.mjs";
import { convertToWeb } from "./web.mjs";
import { serveWebExport } from "./serve.mjs";

export const HELP = `krkrtools — standard KiriKiri XP3 and loose-file web exports

Usage:
  krkrtools inspect <game folder, XP3, or EXE> [--json]
  krkrtools plugins [--json]
  krkrtools list <XP3 or EXE>
  krkrtools pack <folder> <new output.xp3> [--no-compress]
  krkrtools unpack <XP3, EXE, or folder> <new output folder> [--max-bytes N]
  krkrtools web <game folder> [new output folder] [--runtime <built krkrz_web folder>]
  krkrtools serve <web export folder> [port]

Web options:
  --runtime <folder>        Use a local runtime first.
  --cache-dir <folder>      Runtime cache (default: ~/.cache/krkrtools, or XDG_CACHE_HOME).
  --ruffle <folder>        Use local Ruffle files for Flash (otherwise cached on demand).
  --offline                Skip upstream checks.
  --archive <relative.xp3>   Override automatic selection.
  --archive-lookup <mode>   auto (default), path, or basename for flat KAG patches.
  --compat <profile>       auto (default), none, or kag3 for older KAG browser APIs.
  --resources <folder>      Override the runtime resource/ sidecars.
  --encoding <name>         Script encoding (default: Shift_JIS).
  --entry <path>            Startup script (default: startup.tjs).
  --game-id <id>            Stable save identity when moving/re-exporting a game.
  --arg <option>            Repeat additional runtime options, e.g. --arg=-drawthread=1.
  --max-bytes N             Maximum expanded bytes (default: 64 GiB).

No game files are uploaded.
`;

function optionsFor(values, { flags = [], values: names = [], repeat = [] }) {
  const positional = [];
  const options = {};
  let ended = false;
  for (let i = 0; i < values.length; i++) {
    const item = values[i];
    if (item === "--" && !ended) {
      ended = true;
      continue;
    }
    if (ended || !item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const split = item.indexOf("=");
    const key = split < 0 ? item.slice(2) : item.slice(2, split);
    if (flags.includes(key)) {
      if (split >= 0 || key in options)
        throw new Error(`Invalid or repeated --${key}.`);
      options[key] = true;
      continue;
    }
    if (!names.includes(key) && !repeat.includes(key))
      throw new Error(`Unknown option: --${key}`);
    const value = split >= 0 ? item.slice(split + 1) : values[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`--${key} needs a value.`);
    if (repeat.includes(key)) (options[key] ??= []).push(value);
    else {
      if (key in options)
        throw new Error(`--${key} may only be specified once.`);
      options[key] = value;
    }
  }
  return { positional, options };
}

function count(command, positional, amount) {
  if (positional.length !== amount)
    throw new Error(
      `${command} needs ${amount} positional value(s). Run krkrtools help.`,
    );
}

function limit(value) {
  if (value === undefined) return undefined;
  if (
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw new Error("--max-bytes needs a positive safe integer.");
  return Number(value);
}

export async function runCli(
  argv,
  { write = (message) => process.stderr.write(message) } = {},
) {
  const [command = "help", ...values] = argv;
  if (["help", "--help", "-h"].includes(command)) return HELP;
  if (["--version", "version"].includes(command)) return "krkrtools 0.1.0";
  if (command === "plugins") {
    const { positional, options } = optionsFor(values, { flags: ["json"] });
    count(command, positional, 0);
    return options.json
      ? JSON.stringify(PLUGINS, null, 2)
      : PLUGINS.map(
          (plugin) =>
            `${plugin.name}\t${plugin.status}\t${plugin.provides ?? plugin.limits ?? plugin.target ?? "A compatible implementation is required."}`,
        ).join("\n");
  }
  if (command === "pack") {
    const { positional, options } = optionsFor(values, {
      flags: ["no-compress"],
    });
    count(command, positional, 2);
    const result = await packXp3(...positional, {
      compress: !options["no-compress"],
    });
    return `Packed ${result.files} files (${result.bytes} bytes).\nOutput: ${result.output}`;
  }
  if (command === "unpack") {
    const { positional, options } = optionsFor(values, {
      values: ["max-bytes"],
    });
    count(command, positional, 2);
    const result = await unpackPath(...positional, {
      maxBytes: limit(options["max-bytes"]),
    });
    return (
      `Unpacked ${result.files} files (${result.bytes} bytes).\nOutput: ${result.output}` +
      (result.renamedFiles
        ? `\nMapped ${result.renamedFiles} long filename(s). Originals are recorded in .krkrtools-paths.json for repacking.`
        : "")
    );
  }
  if (command === "inspect" || command === "list") {
    const { positional, options } = optionsFor(values, {
      flags: command === "inspect" ? ["json"] : [],
    });
    count(command, positional, 1);
    const result = await inspectPath(positional[0], {
      classify: command === "inspect",
    });
    if (options.json) return JSON.stringify(result, null, 2);
    if (command === "list") {
      if (result.kind !== "xp3")
        throw new Error("list expects one XP3 archive or embedded EXE.");
      return result.entries
        .map(
          (entry) =>
            `${entry.protected ? "Flagged. checksum required" : "Standard"}\t${entry.size}\t${entry.path}`,
        )
        .join("\n");
    }
    return formatInspection(result);
  }
  if (command === "web") {
    const { positional, options } = optionsFor(values, {
      flags: ["offline"],
      values: [
        "runtime",
        "ruffle",
        "cache-dir",
        "resources",
        "encoding",
        "entry",
        "game-id",
        "archive-lookup",
        "compat",
        "max-bytes",
      ],
      repeat: ["archive", "arg"],
    });
    if (positional.length < 1 || positional.length > 2)
      throw new Error(
        "web needs a game folder and an optional output folder. Run krkrtools help.",
      );
    const result = await convertToWeb(positional[0], positional[1], {
      runtimeDir: options.runtime,
      ruffleDir: options.ruffle,
      resourcesDir: options.resources,
      encoding: options.encoding,
      runtimeCacheDir: options["cache-dir"],
      offline: Boolean(options.offline),
      onPlan: (plan) => {
        write(
          `Archives (${plan.archiveSelection}): ${plan.archives.join(" -> ") || "loose files"}\n`,
        );
        write(
          `Compatibility: ${plan.compatibility}; archive lookup: ${plan.archiveLookup}\n`,
        );
        if (plan.framework?.id === "kag3")
          write(
            `KAG3 evidence: ${plan.framework.detections.map((detection) => detection.source).join(", ")}\n`,
          );
      },
      onPluginReport: (report) =>
        write(
          `${formatPluginDetection(report, { details: false }).join("\n")}\n`,
        ),
      onRuntimeProgress: (event) => {
        if (event.type === "flash-upstream-check")
          write("Checking upstream Ruffle Flash runtime...\n");
        if (event.type === "flash-cache")
          write(`Using cached Ruffle ${event.version}: ${event.path}\n`);
        if (event.type === "flash-download")
          write(
            `Downloading Ruffle ${event.version} (Flash files remain lazy in the browser)...\n`,
          );
        if (event.type === "missing")
          write(
            `Runtime folder not found: ${event.path}. Resolving the default runtime.\n`,
          );
        if (event.type === "upstream-check")
          write("Checking upstream KiriKiri Z runtime...\n");
        if (event.type === "upstream-version")
          write(`Upstream runtime: ${event.id}\n`);
        if (event.type === "cache")
          write(`Using cached runtime: ${event.path}\n`);
        if (event.type === "download-start")
          write(
            `Downloading KiriKiri Z runtime (${(event.bytes / 1024 ** 2).toFixed(1)} MiB) to ${event.path}\n`,
          );
        if (event.type === "download-file")
          write(
            `Runtime file ${event.completed}/${event.total}: ${event.path}\n`,
          );
      },
      entry: options.entry,
      gameId: options["game-id"],
      archives: options.archive,
      archiveLookup: options["archive-lookup"],
      compatibility: options.compat,
      args: options.arg,
      maxBytes: limit(options["max-bytes"]),
    });
    return (
      `Created web export with ${result.files} loose game files (${result.gameBytes} bytes).\nRuntime files: ${result.bytes} bytes.\nRuntime: ${result.runtime.path}` +
      (result.plan.startupOptions
        ? `\nStartup options (${result.plan.startupOptions.source}): ${result.plan.startupOptions.args.join(" ")}`
        : "") +
      `\nOutput: ${result.output}`
    );
  }
  if (command === "serve") {
    const { positional, options } = optionsFor(values, { values: ["port"] });
    if (positional.length < 1 || positional.length > 2)
      throw new Error(
        "serve needs a web export folder and an optional port. Run krkrtools help.",
      );
    if (positional[1] !== undefined && options.port !== undefined)
      throw new Error(
        "Specify the port once: after the folder or with --port.",
      );
    const port = options.port ?? positional[1];
    if (port !== undefined && (!/^\d+$/u.test(port) || Number(port) > 65535))
      throw new Error("Port must be an integer between 0 and 65535.");
    const result = await serveWebExport(positional[0], {
      port: port === undefined ? undefined : Number(port),
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => result.server.close());
    return `Serving ${result.root}\nOpen: ${result.url}`;
  }
  throw new Error(`Unknown command: ${command}. Run krkrtools help.`);
}
