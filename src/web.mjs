import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asciiLower,
  assertUniquePaths,
  copyAndHash,
  exists,
  listFiles,
  newStaging,
  pathKey,
  publishDirectory,
  requireDirectory,
  safeRelativePath,
} from "./files.mjs";
import { DEFAULT_MAX_BYTES, extractXp3To, readXp3 } from "./archive/xp3.mjs";
import { resolveRuntime } from "./runtime/cache.mjs";
import { detectGamePlugins } from "./inspect/plugins.mjs";
import { classifyGame } from "./inspect/classify.mjs";
import { selectArchives } from "./web/archives.mjs";
import { particleSettingsSource } from "./web/particle.mjs";
import {
  macroArgumentDeclarations,
  adaptMacroCalls,
} from "./web/macro-arguments.mjs";
import { adaptFontLoader } from "./web/fontselect.mjs";
import { startupRelaunchOptions } from "./web/startup.mjs";
import { resolveRuffle } from "./plugins/flash/cache.mjs";
import {
  needsFlash,
  patchFlashVideoFactory,
} from "./plugins/flash/runtime.mjs";
import { pluginTableSource } from "./plugins/catalog.mjs";
import { generatedLauncherSource, scriptJson } from "./web/launcher.mjs";
import { decodeTextStream } from "./text-stream.mjs";

const IGNORED_ROOTS = new Set([".git", "node_modules", "savedata", "save"]);
const IGNORED_EXTENSIONS = new Set([".exe", ".dll", ".tpm", ".xp3", ".pdb"]);
const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;

function scriptTags(html) {
  return [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu)].map(
    ([tag]) => {
      const attribute = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(
        tag.slice(0, tag.indexOf(">") + 1),
      );
      return { tag, src: attribute?.[1] ?? attribute?.[2] ?? attribute?.[3] };
    },
  );
}

async function validateRuntime(runtimeDir, resourcesDir, compatibility) {
  const root = await requireDirectory(runtimeDir);
  const htmlPath = (await exists(join(root, "krkrz.html")))
    ? join(root, "krkrz.html")
    : join(root, "index.html");
  for (const name of ["krkrz.js", "krkrz.wasm", "krkrz.data"]) {
    if (!(await lstat(join(root, name))).isFile())
      throw new Error(`Runtime is missing ${name}.`);
  }
  if ((await lstat(join(root, "krkrz.js"))).size > 64 * 1024 * 1024)
    throw new Error("Runtime JavaScript exceeds 64 MiB.");
  const html = await readFile(htmlPath, "utf8");
  const js = await readFile(join(root, "krkrz.js"), "utf8");
  const engineScripts = scriptTags(html).filter((script) =>
    /^(?:\.\/)?krkrz\.js(?:\?.*)?$/u.test(script.src ?? ""),
  );
  if (engineScripts.length !== 1 || html.includes("{{{ SCRIPT }}}"))
    throw new Error(
      "Supply a built krkrz_web runtime with one classic krkrz.js script, not its source template.",
    );
  if (
    !js.includes("KRKRZ_WEB_DEFAULT_WEBBASE") ||
    !js.includes("KRKRZ_WEB_RESOURCE_BASE")
  )
    throw new Error(
      "Runtime lacks the krkrz_web loose-file/sidecar loader. Build a compatible shared runtime.",
    );
  if (
    compatibility === "kag3" &&
    (!js.includes("krkrz_repl_eval") ||
      !/Module\s*(?:\[\s*["']ccall["']\s*\]|\.ccall)\s*=/u.test(js) ||
      !/Module\s*(?:\[\s*["']FS["']\s*\]|\.FS)\s*=/u.test(js) ||
      !js.includes("syncfs"))
  )
    throw new Error(
      "The kag3 profile needs a runtime exporting krkrz_repl_eval, ccall and FS.syncfs.",
    );
  const moduleFile = await open(join(root, "krkrz.wasm"), "r");
  const header = Buffer.alloc(8);
  try {
    await moduleFile.read(header, 0, 8, 0);
  } finally {
    await moduleFile.close();
  }
  if (!header.equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
    throw new Error("Runtime has an invalid wasm32 module header.");
  const resources = await requireDirectory(
    resourcesDir ?? join(root, "resource"),
  );
  const resourceFiles = await listFiles(resources);
  if (
    !resourceFiles.length ||
    !resourceFiles.some((file) => file.path === "config.cf")
  )
    throw new Error(
      "Runtime resources need config.cf and the engine's messages/fonts/scripts.",
    );
  return {
    root,
    html,
    engineTag: engineScripts[0].tag,
    resources,
    resourceFiles,
    jspi: js.includes("WebAssembly.Suspending") && !js.includes("Asyncify"),
  };
}

async function rejectArchiveReferences(files, root) {
  for (const file of files) {
    if (!/\.(?:tjs|ks)$/iu.test(file.path)) continue;
    if (file.size > MAX_SCRIPT_BYTES)
      throw new Error(
        `Script exceeds the 16 MiB inspection limit: ${file.path}`,
      );
    const raw = await readFile(join(root, file.path));
    const text =
      raw[0] === 0xff && raw[1] === 0xfe
        ? raw.subarray(2).toString("utf16le")
        : raw[0] === 0xfe && raw[1] === 0xff
          ? Buffer.from(raw.subarray(2)).swap16().toString("utf16le")
          : raw.toString("latin1");
    // Preserve strings and line positions while ignoring disabled example code.
    const code = text.replace(
      /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
      (match, quote) => quote ?? match.replace(/[^\r\n]/gu, " "),
    );
    // KAG also contains archive discovery code ending in ".xp3>". It safely
    // skips absent archives; reject only literal references to an inner file.
    for (const match of code.matchAll(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu,
    )) {
      if (!/\.xp3\s*>[^\r\n]/iu.test(match[0].slice(1, -1))) continue;
      const line = code.slice(0, match.index).split(/\r\n|\r|\n/u).length;
      throw new Error(
        `Archive-qualified storage reference in ${file.path}:${line}: ${match[0].slice(0, 200)}. ` +
          "Web export merges XP3 files and cannot preserve this archive-specific lookup.",
      );
    }
  }
}

export async function convertToWeb(
  sourceDir,
  outputPath,
  {
    runtimeDir,
    runtimeCacheDir,
    ruffleDir,
    offline = false,
    onRuntimeProgress,
    resourcesDir,
    archives: requestedArchives = [],
    encoding = "Shift_JIS",
    gameId,
    entry = "startup.tjs",
    args = [],
    archiveLookup = "auto",
    compatibility = "auto",
    maxBytes = DEFAULT_MAX_BYTES,
    onProgress,
    onPlan,
    onPluginReport,
  } = {},
) {
  if (!["auto", "path", "basename"].includes(archiveLookup))
    throw new Error("--archive-lookup must be auto, path or basename.");
  if (!["auto", "none", "kag3"].includes(compatibility))
    throw new Error("--compat must be auto, none or kag3.");
  const automaticLookup = archiveLookup === "auto";
  if (!/^[A-Za-z0-9_-]+$/u.test(encoding))
    throw new Error("Invalid script encoding name.");
  entry = safeRelativePath(entry);
  if (/\s/u.test(entry))
    throw new Error(
      "The upstream startup-argument parser does not support spaces in the entry path.",
    );
  if (
    args.some(
      (arg) =>
        !/^-[^\s\x00-\x1f]+$/u.test(arg) ||
        /^-(?:appname|orgname|webbase|webmanifest|datapath|startup|readencoding)(?:=|$)/iu.test(
          arg,
        ),
    )
  )
    throw new Error(
      "Extra runtime arguments must be single option tokens; save identity and launch paths are controlled by the exporter.",
    );
  const source = await requireDirectory(sourceDir);
  const id =
    gameId ??
    createHash("sha256")
      .update(`${await realpath(source)}\0${entry}`)
      .digest("hex")
      .slice(0, 24);
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(id))
    throw new Error(
      "--game-id must contain 1–64 ASCII letters, digits, hyphens or underscores.",
    );
  const saveStorage = `file://./persist/krkrtools/${id}`;
  const allFiles = await listFiles(source);
  const archiveFiles = allFiles.filter((file) => /\.xp3$/iu.test(file.path));
  const selection = selectArchives(archiveFiles, requestedArchives);
  const parsed = [];
  let expandedBytes = 0;
  for (const file of selection.files) {
    const archive = await readXp3(file.full);
    expandedBytes += archive.bytes;
    parsed.push({ ...archive, source: file.path });
  }
  const framework =
    compatibility === "auto" || automaticLookup
      ? (
          await classifyGame({
            files: allFiles,
            archives: parsed,
            executableFiles: [],
          })
        ).framework
      : null;
  if (compatibility === "auto")
    compatibility = framework.id === "kag3" ? "kag3" : "none";
  if (automaticLookup)
    archiveLookup = framework.id === "kag3" ? "basename" : "path";
  const launchArgs = [...args];
  if (compatibility === "kag3") {
    // KAG3 uses the 2D window API. Keep SDL for WebKit compatibility, but
    // retain one rendering worker: drawthread=0 stalls this Web runtime.
    if (!args.some((arg) => /^-drawdevice(?:=|$)/iu.test(arg)))
      launchArgs.push("-drawdevice=sdl");
    if (!args.some((arg) => /^-drawthread(?:=|$)/iu.test(arg)))
      launchArgs.push("-drawthread=1");
  }
  const plan = {
    archives: parsed.map((archive) => archive.source),
    archiveSelection: selection.mode,
    compatibility,
    archiveLookup,
    framework,
  };
  const loose = allFiles.filter(
    (file) =>
      !IGNORED_ROOTS.has(file.path.split("/")[0].toLowerCase()) &&
      !IGNORED_EXTENSIONS.has(extname(file.path).toLowerCase()),
  );
  expandedBytes += loose.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes > maxBytes)
    throw new Error("Expanded export exceeds the extraction limit.");
  assertUniquePaths(loose);
  const { output, staging } = await newStaging(
    outputPath ?? join(dirname(source), `${basename(source)} web`),
    source,
  );
  try {
    onPlan?.(plan);
    const payload = join(staging, ".payload");
    await mkdir(payload);
    const manifestEntries = new Map();
    const nativePlugins = allFiles
      .filter(
        (file) =>
          /\.(?:dll|tpm)$/iu.test(file.path) &&
          !IGNORED_ROOTS.has(file.path.split("/")[0].toLowerCase()),
      )
      .map((file) => ({
        path: file.path,
        source: `loose:${file.path}`,
        bytes: file.size,
      }));
    const filenameMappings = [];
    const patchOverrides = [];
    const scriptAdaptations = [];
    const archiveFilters = [];
    const directories = new Set();
    const install = async (
      path,
      full,
      origin,
      allowOverride,
      allowIdentical = false,
    ) => {
      const physical = asciiLower(path);
      const key = pathKey(physical);
      const previous = manifestEntries.get(key);
      if (
        previous &&
        !allowOverride &&
        allowIdentical &&
        previous.path === physical
      ) {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(full)) {
          bytes += chunk.length;
          hash.update(chunk);
        }
        if (bytes === previous.bytes && hash.digest("hex") === previous.sha256)
          return;
        throw new Error(
          `Conflicting base archive file: ${path} in ${previous.source} and ${origin}. Specify each --archive in load order to choose which archive overrides it.`,
        );
      }
      if (previous && (!allowOverride || previous.path !== physical))
        throw new Error(
          `Ambiguous loose/archive file collision: ${path}. Move overrides into an explicitly ordered patch archive.`,
        );
      // Check each parent once; avoid quadratic scans on large asset manifests.
      const parents = key.split("/");
      parents.pop();
      if (directories.has(key))
        throw new Error(`File/directory conflict: ${path}`);
      for (let i = 1; i <= parents.length; i++) {
        const parent = parents.slice(0, i).join("/");
        if (manifestEntries.has(parent))
          throw new Error(`File/directory conflict: ${path}`);
        directories.add(parent);
      }
      const target = join(payload, physical);
      if (previous) await rm(target);
      const hash = await copyAndHash(full, target);
      manifestEntries.set(key, { path: physical, source: origin, ...hash });
    };
    for (let index = 0; index < parsed.length; index++) {
      const archive = parsed[index];
      const explicitOrder = selection.mode === "explicit";
      const isPatch =
        explicitOrder || selection.patches.includes(archive.source);
      const extracted = join(staging, `.archive-${index}`);
      await mkdir(extracted);
      const extraction = await extractXp3To(archive, extracted, {
        maxBytes,
        onProgress,
      });
      if (extraction.filters.length)
        archiveFilters.push({
          archive: archive.source,
          filters: extraction.filters,
        });
      const earlier = [...manifestEntries.values()];
      const earlierByName = new Map();
      if (archiveLookup === "basename" && isPatch)
        for (const item of earlier) {
          const key = pathKey(basename(item.path));
          if (!earlierByName.has(key)) earlierByName.set(key, []);
          earlierByName.get(key).push(item);
        }
      for (const [fileIndex, file] of archive.entries.entries()) {
        const physical = extraction.paths[fileIndex].extracted;
        if (IGNORED_EXTENSIONS.has(extname(file.path).toLowerCase())) {
          nativePlugins.push({
            path: file.path,
            source: archive.source,
            bytes: file.size,
          });
          continue;
        }
        if (physical !== file.path)
          filenameMappings.push({
            original: file.path,
            extracted: physical,
            source: archive.source,
          });
        if (
          archiveLookup === "basename" &&
          isPatch &&
          !file.path.includes("/")
        ) {
          const matches = earlierByName.get(pathKey(file.path)) ?? [];
          // A previous flat patch leaves a root alias and the canonical path.
          // Identical bytes in those paths represent one unambiguous asset.
          if (
            automaticLookup &&
            new Set(matches.map((match) => match.sha256)).size > 1
          )
            throw new Error(
              `Flat patch ${archive.source}>${file.path} matches multiple earlier paths. Choose --archive-lookup path or basename explicitly.`,
            );
          for (const previous of matches) {
            if (pathKey(previous.path) === pathKey(file.path)) continue;
            await install(
              previous.path,
              join(extracted, physical),
              archive.source,
              true,
            );
            patchOverrides.push({
              path: previous.path,
              patchPath: file.path,
              source: archive.source,
            });
          }
        }
        await install(
          physical,
          join(extracted, physical),
          archive.source,
          index > 0 && (explicitOrder || isPatch),
          !explicitOrder && !isPatch,
        );
      }
      await rm(extracted, { recursive: true });
    }
    // A loose project may keep its startup script directly in data/.
    const prefix =
      !parsed.length &&
      !loose.some((file) => pathKey(file.path) === pathKey(entry)) &&
      loose.some((file) => pathKey(file.path) === pathKey(`data/${entry}`))
        ? "data/"
        : "";
    for (const file of loose) {
      if (prefix && !file.path.startsWith(prefix)) continue;
      await install(
        prefix ? file.path.slice(prefix.length) : file.path,
        file.full,
        `loose:${file.path}`,
        false,
      );
    }
    // Normalize standard encoded source before preflight and compatibility
    // transforms. Unpack keeps the original inner text-stream bytes intact.
    const decodedScript = join(staging, "decoded-script.tjs");
    for (const file of [...manifestEntries.values()]) {
      if (!/\.(?:tjs|ks)$/iu.test(file.path)) continue;
      if (file.bytes > MAX_SCRIPT_BYTES)
        throw new Error(
          `Script exceeds the 16 MiB inspection limit: ${file.path}`,
        );
      const raw = await readFile(join(payload, file.path));
      const decoded = decodeTextStream(raw, {
        maxBytes: Math.min(
          MAX_SCRIPT_BYTES,
          maxBytes - expandedBytes + file.bytes,
        ),
      });
      if (decoded === raw) continue;
      expandedBytes += decoded.length - file.bytes;
      await writeFile(decodedScript, decoded);
      scriptAdaptations.push({
        path: file.path,
        adapter: `kirikiri-text-mode-${raw[2]}`,
        originalSha256: file.sha256,
      });
      await install(file.path, decodedScript, file.source, true);
    }
    await rm(decodedScript, { force: true });
    plan.archiveFilters = archiveFilters;
    const pluginReport = await detectGamePlugins({
      files: [...manifestEntries.values()].map((file) => ({
        path: file.path,
        full: join(payload, file.path),
        size: file.bytes,
        source: file.source.startsWith("loose:")
          ? file.source.slice(6)
          : `${file.source}>${file.path}`,
      })),
      nativeFiles: nativePlugins.map((file) => ({
        path: file.path,
        size: file.bytes,
        source: file.source.startsWith("loose:")
          ? file.source.slice(6)
          : `${file.source}>${file.path}`,
      })),
    });
    pluginReport.scope =
      "merged game scripts before compatibility adaptations; selected archives only";
    plan.plugins = pluginReport;
    onPluginReport?.(pluginReport);
    const resolvedRuntime = await resolveRuntime({
      runtimeDir,
      cacheDir: runtimeCacheDir,
      offline,
      excludeRoot: source,
      onProgress: onRuntimeProgress,
    });
    const runtime = await validateRuntime(
      resolvedRuntime.path,
      resourcesDir,
      compatibility,
    );
    const managedRuntimeFiles = resolvedRuntime.files
      ? new Set(resolvedRuntime.files)
      : null;
    if (managedRuntimeFiles && !resourcesDir)
      runtime.resourceFiles = runtime.resourceFiles.filter((file) =>
        managedRuntimeFiles.has(`resource/${file.path}`),
      );
    const flashNeeded =
      Boolean(ruffleDir) ||
      needsFlash([...manifestEntries.values()], []) ||
      pluginReport.plugins.some(
        (plugin) =>
          ["krflash", "flashplayer"].includes(plugin.id) &&
          plugin.references.length,
      );
    const flash = flashNeeded
      ? await resolveRuffle({
          ruffleDir,
          cacheDir: runtimeCacheDir,
          offline,
          onProgress: onRuntimeProgress,
        })
      : null;
    let flashPatch = null;
    let launchEntry = asciiLower(entry);
    let startupOptions = null;
    if (compatibility === "kag3") {
      const startup = manifestEntries.get(pathKey(entry));
      if (startup && startup.bytes <= MAX_SCRIPT_BYTES) {
        const required = startupRelaunchOptions(
          await readFile(join(payload, startup.path)),
        );
        if (required) {
          for (const option of required) {
            const key = option.slice(0, option.indexOf("="));
            if (
              /^-(?:appname|orgname|webbase|webmanifest|datapath|startup|readencoding)$/iu.test(
                key,
              )
            )
              throw new Error(
                `Startup relaunch requests exporter-controlled option ${key}; a script adaptation is required.`,
              );
            const existing = launchArgs.find(
              (arg) => arg.split("=")[0].toLowerCase() === key.toLowerCase(),
            );
            if (existing && existing !== option)
              throw new Error(
                `Startup requires ${option}, but ${existing} was supplied. Remove the conflicting --arg or adapt the startup script.`,
              );
            if (!existing) launchArgs.push(option);
          }
          startupOptions = {
            source: startup.path,
            args: required,
            evidence: "standard set_cmdline_opts self-relaunch recipe",
          };
          plan.startupOptions = startupOptions;
        }
      }
      if (
        [...manifestEntries.values()].some((file) =>
          file.path.startsWith("_krkrtools/"),
        )
      )
        throw new Error(
          "Game uses the reserved _krkrtools compatibility directory.",
        );
      await install(
        "_krkrtools/kag3.tjs",
        fileURLToPath(new URL("./web/kag3.tjs", import.meta.url)),
        "krkrtools:compat-kag3",
        false,
      );
      await install(
        "_krkrtools/particle.tjs",
        fileURLToPath(new URL("./web/particle.tjs", import.meta.url)),
        "krkrtools:compat-particle",
        false,
      );
      await install(
        "_krkrtools/arrayex.tjs",
        fileURLToPath(new URL("./web/arrayex.tjs", import.meta.url)),
        "krkrtools:compat-arrayex",
        false,
      );
      await install(
        "_krkrtools/gamepad.tjs",
        fileURLToPath(new URL("./web/gamepad.tjs", import.meta.url)),
        "krkrtools:compat-gamepad",
        false,
      );
      for (const name of [
        "plugins",
        "fire",
        "flashplayer",
        "dialogs",
        "layerexsave",
        "json-reader",
      ])
        await install(
          `_krkrtools/${name}.tjs`,
          fileURLToPath(new URL(`./web/${name}.tjs`, import.meta.url)),
          `krkrtools:compat-${name}`,
          false,
        );
      const catalog = join(staging, "plugin-catalog.tjs");
      await writeFile(catalog, pluginTableSource());
      await install(
        "_krkrtools/plugin-catalog.tjs",
        catalog,
        "krkrtools:plugin-catalog",
        false,
      );
      await rm(catalog);
      const fontLoader = join(staging, "font-loader.tjs");
      for (const file of [...manifestEntries.values()]) {
        if (
          !/\.tjs$/iu.test(file.path) ||
          file.path.startsWith("_krkrtools/") ||
          file.bytes > MAX_SCRIPT_BYTES
        )
          continue;
        const adapted = adaptFontLoader(
          await readFile(join(payload, file.path)),
        );
        if (!adapted) continue;
        await writeFile(fontLoader, adapted.data);
        scriptAdaptations.push({
          path: file.path,
          adapter: "krkr2compat-font-picker",
          originalSha256: file.sha256,
          evidence:
            "useKrkrZ loads win32dialog.tjs, k2compat.tjs, k2compat_fontselect.tjs in order",
        });
        await install(file.path, fontLoader, file.source, true);
      }
      await rm(fontLoader, { force: true });
      if (scriptAdaptations.length)
        await install(
          "_krkrtools/fontselect.tjs",
          fileURLToPath(new URL("./web/fontselect.tjs", import.meta.url)),
          "krkrtools:compat-fontselect",
          false,
        );
      const macroFiles = [...manifestEntries.values()].filter((file) =>
        /\.ks$/iu.test(file.path),
      );
      const macroFields = new Map();
      for (const file of macroFiles) {
        if (file.bytes > MAX_SCRIPT_BYTES)
          throw new Error(
            `Script exceeds the 16 MiB inspection limit: ${file.path}`,
          );
        for (const [name, fields] of macroArgumentDeclarations(
          await readFile(join(payload, file.path)),
          { encoding },
        )) {
          if (!macroFields.has(name)) macroFields.set(name, new Set());
          for (const field of fields) macroFields.get(name).add(field);
        }
      }
      const macroCall = join(staging, "macro-call.ks");
      for (const file of macroFiles) {
        if (!macroFields.size) break;
        const adapted = adaptMacroCalls(
          await readFile(join(payload, file.path)),
          macroFields,
          { encoding },
        );
        if (!adapted) continue;
        await writeFile(macroCall, adapted.data);
        scriptAdaptations.push({
          path: file.path,
          adapter: "kag-mutable-macro-arguments",
          originalSha256: file.sha256,
          calls: adapted.calls,
          fields: adapted.fields,
          evidence:
            "macro assigns mp fields and forwards arguments with *; declare missing fields as void at static calls",
        });
        await install(file.path, macroCall, file.source, true);
      }
      await rm(macroCall, { force: true });
      const particleSettings = join(staging, "particle-settings.tjs");
      for (const file of [...manifestEntries.values()]) {
        if (!/\.pee$/iu.test(file.path)) continue;
        if (file.bytes > 1024 * 1024)
          throw new Error(`Particle settings exceed 1 MiB: ${file.path}`);
        const raw = await readFile(join(payload, file.path));
        await writeFile(
          particleSettings,
          particleSettingsSource(raw, file.path),
          "ascii",
        );
        await install(
          `${file.path}.krkrtools.tjs`,
          particleSettings,
          "krkrtools:particle-settings",
          false,
        );
      }
      await rm(particleSettings, { force: true });
      launchEntry = "_krkrtools/startup.tjs";
      const bootstrap = join(staging, "bootstrap.tjs");
      await writeFile(
        bootstrap,
        `global.krkrtoolsFlashAvailable = ${Boolean(flash)};\nglobal.krkrtoolsSaveStorage = ${JSON.stringify(saveStorage)};\nScripts.execStorage("_krkrtools/kag3.tjs");\nScripts.execStorage(${JSON.stringify(asciiLower(entry))});\n`,
      );
      await install(launchEntry, bootstrap, "krkrtools:bootstrap", false);
      await rm(bootstrap);
    }
    const files = [...manifestEntries.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    if (!files.some((file) => pathKey(file.path) === pathKey(entry)))
      throw new Error(
        `No ${entry} was found in the exported game. Select the correct source folder or --entry.`,
      );
    await rejectArchiveReferences(
      files.map((file) => ({ ...file, size: file.bytes })),
      payload,
    );
    const revision = createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex")
      .slice(0, 24);
    const gameRoot = `gamedata/${revision}`;
    await mkdir(join(staging, "gamedata"));
    await rename(payload, join(staging, gameRoot));
    const paths = files.map((file) => file.path);
    if (paths.includes("krkrz_files.json"))
      throw new Error("Game uses the reserved krkrz_files.json manifest name.");
    await writeFile(
      join(staging, gameRoot, "krkrz_files.json"),
      `${JSON.stringify(paths)}\n`,
    );
    await writeFile(
      join(staging, "asset_manifest.json"),
      `${JSON.stringify({ version: 1, engine: "kirikiri", revision, root: `${gameRoot}/`, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }, null, 2)}\n`,
    );

    const runtimeFiles = (await listFiles(runtime.root)).filter(
      (file) =>
        (!managedRuntimeFiles || managedRuntimeFiles.has(file.path)) &&
        ((/^krkrz(?:\.[^/]+)+$/u.test(file.path) &&
          !/\.(?:html|map)$/u.test(file.path)) ||
          /^.*worker.*\.(?:js|mjs)$/u.test(file.path) ||
          /^(?:(?:third[_-]party[_-])?notices?|licenses?|copying)(?:[./_-]|$)/iu.test(
            file.path,
          )),
    );
    const runtimeHashes = [];
    for (const file of runtimeFiles) {
      const target = join(staging, file.path);
      const original = await copyAndHash(file.full, target);
      if (flash && file.path === "krkrz.js") {
        const patched = patchFlashVideoFactory(await readFile(target, "utf8"));
        await writeFile(target, patched);
        const bytes = Buffer.byteLength(patched),
          sha256 = createHash("sha256").update(patched).digest("hex");
        flashPatch = {
          adapter: "html-video-swf-factory",
          originalSha256: original.sha256,
          sha256,
        };
        runtimeHashes.push({ path: file.path, bytes, sha256 });
      } else runtimeHashes.push({ path: file.path, ...original });
    }
    if (flash) {
      for (const file of flash.files)
        runtimeHashes.push({
          path: `lib/ruffle/${file.path}`,
          ...(await copyAndHash(
            join(flash.path, file.path),
            join(staging, "lib/ruffle", file.path),
          )),
        });
      runtimeHashes.push({
        path: "lib/flash.mjs",
        ...(await copyAndHash(
          fileURLToPath(new URL("./web/flash.mjs", import.meta.url)),
          join(staging, "lib/flash.mjs"),
        )),
      });
    }
    for (const file of runtime.resourceFiles) {
      const path = `resource/${file.path}`;
      runtimeHashes.push({
        path,
        ...(await copyAndHash(file.full, join(staging, path))),
      });
    }
    if (compatibility === "kag3")
      runtimeHashes.push({
        path: "lib/kag3.mjs",
        ...(await copyAndHash(
          fileURLToPath(new URL("./web/kag3.mjs", import.meta.url)),
          join(staging, "lib/kag3.mjs"),
        )),
      });
    if (compatibility === "kag3")
      runtimeHashes.push({
        path: "lib/gamepad.mjs",
        ...(await copyAndHash(
          fileURLToPath(new URL("./web/gamepad.mjs", import.meta.url)),
          join(staging, "lib/gamepad.mjs"),
        )),
      });
    const runtimeHash = createHash("sha256")
      .update(JSON.stringify(runtimeHashes))
      .digest("hex");
    await writeFile(
      join(staging, "resource.list"),
      `${JSON.stringify(runtime.resourceFiles.map((file) => file.path))}\n`,
    );
    await mkdir(join(staging, "lib"), { recursive: true });
    await writeFile(
      join(staging, "lib", "launch.mjs"),
      generatedLauncherSource(
        id,
        runtimeHash,
        runtime.jspi,
        launchArgs,
        compatibility,
        flash ? `${gameRoot}/` : null,
      ),
    );
    // Target the runtime's IDBFS mount explicitly. Some older web builds treat
    // user:// as a literal MEMFS filename even though they mount /persist.
    const defaultArgs = [
      "-bitmappoolsize=128",
      "-filepoolsize=32",
      "-krkrzpoolsize=64",
      "-soundpoolsize=16",
      ...launchArgs,
      `-orgname=krkrtools`,
      `-appname=${id}`,
      `-datapath=${saveStorage}`,
      `-startup=${launchEntry}`,
      `-readencoding=${encoding}`,
    ];
    await writeFile(
      join(staging, "webconfig.js"),
      [
        "// Generated by krkrtools; game files are fetched through web:// on demand.",
        "var KRKRZ_WEB_DATA_XP3 = false;",
        "var KRKRZ_WEB_DATA_PRELOAD = false;",
        'var KRKRZ_WEB_RESOURCE_BASE = "resource/";',
        `var KRKRZ_WEB_DEFAULT_WEBBASE = ${scriptJson(`${gameRoot}/`)};`,
        `var KRKRZ_WEB_DEFAULT_ARGS = ${scriptJson(defaultArgs.join(" "))};`,
        "",
      ].join("\n"),
    );
    let html = runtime.html.replace(
      runtime.engineTag,
      '<script type="module" src="lib/launch.mjs"></script>',
    );
    for (const script of scriptTags(html)) {
      if (/^(?:\.\/)?coi-serviceworker\.js(?:\?.*)?$/u.test(script.src ?? ""))
        html = html.replace(script.tag, "");
    }
    if (
      !scriptTags(html).some((script) =>
        /^(?:\.\/)?webconfig\.js(?:\?.*)?$/u.test(script.src ?? ""),
      )
    )
      html = html.replace(
        /<head\b[^>]*>/iu,
        '$&<script src="webconfig.js"></script>',
      );
    await writeFile(join(staging, "index.html"), html);
    const metadata = {
      format: "krkrtools-web-export",
      version: 1,
      title: basename(source),
      engine: "kirikiri",
      projectId: id,
      runtime: {
        backend: "krkrz-web",
        buildHash: runtimeHash,
        files: runtimeHashes,
        jspi: runtime.jspi,
        args: launchArgs,
        source: resolvedRuntime.source,
      },
      data: {
        delivery: "files",
        manifest: "asset_manifest.json",
        root: `${gameRoot}/`,
        entry: launchEntry,
        originalEntry: asciiLower(entry),
        archives: plan.archives,
        archiveSelection: selection.mode,
        archiveLookup,
      },
      conversion: {
        compatibility,
        framework,
        filenameMappings,
        patchOverrides,
        archiveFilters,
        scriptAdaptations,
        startupOptions,
        plugins: {
          detection: pluginReport,
          catalog:
            compatibility === "kag3" ? "_krkrtools/plugin-catalog.tjs" : null,
          flash: flash
            ? { ...flash.source, patch: flashPatch, lazy: true }
            : null,
        },
        omittedNativeFiles: nativePlugins,
      },
      saves: {
        backend: "IDBFS",
        storage: saveStorage,
        org: "krkrtools",
        app: id,
      },
      capabilities: {
        textOverlay: compatibility === "kag3",
        playerSaveTransfer: false,
      },
    };
    await writeFile(
      join(staging, "browser-game.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await writeFile(
      join(staging, "README.txt"),
      [
        "Prepared by krkrtools. Serve this folder with krkrtools serve (COOP/COEP required).",
        "Game resources load individually; native plugins and archive-qualified scripts need compatible adaptations.",
        "Saves use the supplied runtime's IDBFS implementation and belong to this browser origin and game ID.",
        compatibility === "kag3"
          ? "Game controls provide KAG menu commands, checkpoint-aware save/load and selectable MessageLayer text. Games with custom save screens should use those screens."
          : "This export does not include browser text-overlay controls.",
        "Player save-transfer integration is not included. Keep the runtime's licenses with this export.",
        "",
      ].join("\n"),
    );
    await publishDirectory(staging, output);
    return {
      output,
      files: files.length,
      bytes: metadata.runtime.files.reduce((sum, file) => sum + file.bytes, 0),
      gameBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      projectId: id,
      revision,
      runtime: resolvedRuntime,
      plan,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
