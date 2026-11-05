// Compile data, never game-supplied expressions, for the TJS particle adapter.
const NUMERIC = new Set([
  "max_particles",
  "lifespan",
  "lifespan_variance",
  "start_size",
  "start_size_variance",
  "finish_size",
  "finish_size_variance",
  "emitter_angle",
  "emitter_angle_variance",
  "x_variance",
  "y_variance",
  "speed",
  "speed_variance",
  "x_gravity",
  "y_gravity",
  "rad_acc",
  "rad_acc_var",
  "tan_acc",
  "tan_acc_var",
  "start_rot",
  "start_rot_variance",
  "rot_per_sec",
  "rot_per_sec_variance",
  "max_radius",
  "max_radius_variance",
  "min_radius",
  "deg_per_sec",
  "deg_per_sec_var",
  "delay",
  "duration",
  "offset_x",
  "offset_y",
  ...["hor", "ver"].flatMap((axis) =>
    ["amplitude", "amplitude_var", "cycle", "cycle_var"].map(
      (field) => `${axis}_${field}`,
    ),
  ),
  ...["start", "finish"].flatMap((end) =>
    ["r", "g", "b", "a"].flatMap((ch) => [
      `${end}_color_${ch}`,
      `${end}_color_${ch}_var`,
    ]),
  ),
]);
const BOOL = new Set([
  "enable_color",
  "color_constant",
  "texture_direction_before",
]);
const ENUM = {
  type: ["gravity", "radial"],
  blending_mode: ["normal", "add"],
  sort_type: ["none", "duration_asc", "duration_desc"],
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function particleSettingsSource(raw, path = "particle settings") {
  const fail = (message) => {
    throw new Error(`Unsupported particle settings in ${path}: ${message}`);
  };
  if (Buffer.byteLength(raw) > 1024 * 1024) fail("file exceeds 1 MiB");
  let settings;
  try {
    settings = JSON.parse(String(raw).replace(/^\uFEFF/u, ""));
  } catch {
    fail("expected .pee JSON data");
  }
  if (
    !object(settings) ||
    !Array.isArray(settings.emitter) ||
    settings.emitter.length > 128
  )
    fail("expected up to 128 emitters");
  let total = 0;
  for (const emitter of settings.emitter) {
    if (!object(emitter)) fail("invalid emitter");
    for (const [key, value] of Object.entries(emitter)) {
      if (NUMERIC.has(key)) {
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          Math.abs(value) > 1e7
        )
          fail(`invalid ${key}`);
      } else if (BOOL.has(key)) {
        if (typeof value !== "boolean") fail(`invalid ${key}`);
      } else if (Object.hasOwn(ENUM, key)) {
        if (!ENUM[key].includes(value)) fail(`${key}=${value}`);
      } else if (key === "name") {
        if (typeof value !== "string") fail("invalid name");
      } else if (key !== "texture") fail(`unknown emitter field ${key}`);
    }
    if (
      !Number.isInteger(emitter.max_particles) ||
      emitter.max_particles < 1 ||
      emitter.max_particles > 20000 ||
      !(emitter.lifespan > 0) ||
      emitter.lifespan > 3600
    )
      fail("invalid particle capacity or lifespan");
    total += emitter.max_particles;
    const texture = emitter.texture;
    if (
      !object(texture) ||
      typeof texture.filename !== "string" ||
      !texture.filename ||
      /[\x00-\x1f]/u.test(texture.filename)
    )
      fail("invalid texture filename");
    for (const [key, value] of Object.entries(texture)) {
      if (key === "filename") continue;
      if (key === "is_animation" && typeof value === "boolean") continue;
      if (
        ["split_x", "split_y"].includes(key) &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 256
      )
        continue;
      if (
        key === "frames" &&
        Array.isArray(value) &&
        value.length <= 65536 &&
        value.every(
          (ms) =>
            typeof ms === "number" &&
            Number.isFinite(ms) &&
            ms > 0 &&
            ms <= 3600000,
        )
      )
        continue;
      fail(`invalid texture field ${key}`);
    }
  }
  if (total > 100000) fail("particle capacity exceeds 100000");
  const quote = (text) =>
    JSON.stringify(text).replace(
      /[\u007f-\uffff]/gu,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  const literal = (value) =>
    Array.isArray(value)
      ? `[${value.map(literal).join(",")}]`
      : object(value)
        ? `%[${Object.entries(value)
            .map(([k, v]) => `${quote(k)}=>${literal(v)}`)
            .join(",")}]`
        : typeof value === "string"
          ? quote(value)
          : JSON.stringify(value);
  return `// Generated .pee data for the krkrtools particle adapter.\n${literal(settings.emitter)};\n`;
}
