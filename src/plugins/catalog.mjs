const native = [
  "csvParser",
  "getSample",
  "json",
  "KAGParserEx",
  "layerExBTOA",
  "layerExImage",
  "layerExRaster",
  "layerExVector",
  "saveStruct",
  "scriptsEx",
  "shrinkCopy",
  "getLangName",
  "textrender",
  "tjsDataPack",
  "tlgSliceLoader",
  "psbfile",
  "extrans",
  "extNagano",
];

export const PLUGINS = [
  ...native.map((name) => ({
    id: name.toLowerCase(),
    name,
    kind: "native",
    target: `${name}.dll`,
    status: "native",
    ...(name === "json"
      ? {
          provides:
            "Native JSON parser with core text-file reads and legacy 32-bit hex color literals",
        }
      : {}),
  })),
  {
    id: "wuvorbis",
    name: "wuvorbis",
    kind: "codec",
    status: "mapped",
    provides: "Ogg Vorbis through WaveSoundBuffer",
  },
  {
    id: "krmovie",
    name: "krmovie",
    kind: "movie",
    status: "mapped",
    provides: "VideoOverlay through the browser video backend",
    limits: "Browser-supported video codecs",
  },
  {
    id: "krflash",
    name: "krflash",
    kind: "flash",
    status: "partial",
    provides: "Flash movies through Ruffle and VideoOverlay",
    limits:
      "Ruffle animation playback; no seeking, VideoOverlay loop control, interactive input, ActiveX or frame-accurate end detection",
  },
  {
    id: "flashplayer",
    name: "flashPlayer",
    kind: "script",
    file: "flashplayer.tjs",
    status: "partial",
    provides: "FlashPlayer playback and layer drawing through Ruffle",
    limits:
      "Ruffle animation playback; no seeking, VideoOverlay loop control, interactive input, ActiveX or frame-accurate end detection",
  },
  {
    id: "gfxeffect",
    name: "gfxEffect",
    aliases: ["gfxfire"],
    kind: "script",
    file: "fire.tjs",
    status: "partial",
    provides:
      "gfxFire heat simulation, seed images, wind, cooling and color tables",
    limits:
      "Independent implementation; native-plugin pixel parity is not established",
  },
  {
    id: "particle",
    name: "particle",
    kind: "script",
    file: "particle.tjs",
    status: "partial",
    provides: "Particle and Emitter",
    limits: "Experimental TJS implementation",
  },
  {
    id: "arrayex",
    name: "arrayEx",
    kind: "script",
    file: "arrayex.tjs",
    status: "partial",
    provides: "Array values, uniform, grep and eval",
  },
  {
    id: "gamepad",
    name: "gamepad",
    kind: "script",
    file: "gamepad.tjs",
    status: "partial",
    provides:
      "Browser standard controllers, axes, buttons, edge counters and rumble",
    limits:
      "No DirectInput configuration; rumble requires browser/controller support",
  },
  {
    id: "layerexdraw",
    name: "layerExDraw",
    kind: "vector",
    target: "layerExVector.dll",
    status: "mapped",
    limits: "LayerExVector's GdiPlus subset; font handling differs",
  },
  {
    id: "layerexsave",
    name: "layerExSave",
    kind: "script",
    file: "layerexsave.tjs",
    status: "partial",
    provides:
      "Synchronous Layer.saveLayerImagePng and saveLayerImageTlg5 through native image encoders",
    limits:
      "No tags/compression options, octet exports, province images, asynchronous Window saving or other layerExSave utilities",
  },
  {
    id: "kagparser",
    name: "KAGParser",
    aliases: ["kagparserez"],
    kind: "parser",
    target: "KAGParserEx.dll",
    status: "mapped",
  },
  {
    id: "psd",
    name: "psd",
    kind: "alias",
    target: "psdfile.dll",
    status: "mapped",
    limits: "Requires the runtime's PSD implementation",
  },
  {
    id: "addfont",
    name: "addFont",
    kind: "font",
    status: "mapped",
    provides: "System.addFont",
  },
  {
    id: "fstat",
    name: "fstat",
    aliases: ["dirlist"],
    kind: "filesystem",
    status: "partial",
    provides: "Core Storages file information and directory listing",
    limits: "No Windows file attributes or registry",
  },
  {
    id: "menu",
    name: "menu",
    kind: "menu",
    status: "partial",
    provides: "Shared MenuItem object model",
    limits: "KAG browser controls; no Windows menu bar",
  },
  ...[
    "AlphaMovie",
    "clipfile",
    "expat",
    "krkr_richtext",
    "layerExAreaAverage",
    "layerExLongExposure",
    "lineParser",
    "minizip",
    "sigcheck",
    "krkreffekseer",
    "krkrlive2d",
    "krkrgles",
    "binaryStream",
    "fpslimit",
    "httprequest",
    "memfile",
    "messenger",
    "msgreceiver",
    "process",
    "shellExecute",
    "stdio",
    "systemEx",
    "tftSave",
    "varfile",
    "win32dialog",
    "win32ole",
    "windowEx",
    "windowExProgress",
  ].map((name) => ({
    id: name.toLowerCase(),
    name,
    kind: "unavailable",
    status: "unsupported",
  })),
  ...[
    "big_int",
    "bzip2",
    "checksum",
    "compression",
    "encoding",
    "functor",
    "local_files",
    "math_ex",
    "network",
    "octet_builder",
    "os_version",
    "ptime",
    "ptree",
    "serialization",
    "splash_window",
    "sprite_coord",
    "sprites",
    "storage_stream",
    "thread_task",
    "tjs_engine",
    "utils",
    "variate_random",
  ].map((name) => ({
    id: `ktl_${name}`,
    name: `ktl_${name}`,
    kind: "unavailable",
    status: "unsupported",
    limits: "KTL's Windows native module is not implemented",
  })),
].sort((a, b) => a.id.localeCompare(b.id, "en"));

export function pluginName(name) {
  const key = String(name)
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/\.(?:dll|tpm)$/u, "");
  return key.startsWith("ktl_")
    ? key.replace(/-d$/u, "").replace(/-v\d+$/u, "")
    : key;
}

export function getPlugin(name) {
  const key = pluginName(name);
  return (
    PLUGINS.find(
      (plugin) => plugin.id === key || plugin.aliases?.includes(key),
    ) ?? null
  );
}

export function pluginTableSource() {
  const entries = {};
  for (const plugin of PLUGINS)
    for (const id of [plugin.id, ...(plugin.aliases ?? [])])
      entries[id] = plugin;
  const encode = (value) =>
    Array.isArray(value)
      ? `[${value.map(encode).join(",")}]`
      : value && typeof value === "object"
        ? `%[${Object.entries(value)
            .map(([key, item]) => `${JSON.stringify(key)}=>${encode(item)}`)
            .join(",")}]`
        : JSON.stringify(value);
  return `global.krkrtoolsPluginCatalog = ${encode(entries)};\n`;
}
