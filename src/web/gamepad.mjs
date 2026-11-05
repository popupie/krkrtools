// Browser standard mapping -> GamepadPort's XInput-shaped public API.
export function gamepadSnapshot(pads) {
  const mask = [
    0x1000, 0x2000, 0x4000, 0x8000, 0x100, 0x200, 0, 0, 0x20, 0x10, 0x40, 0x80,
    1, 2, 4, 8,
  ];
  const axis = (value) =>
    Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  const result = [];
  for (const pad of pads ?? []) {
    if (
      !pad?.connected ||
      pad.mapping !== "standard" ||
      !Number.isInteger(pad.index) ||
      pad.index < 0 ||
      pad.index > 255
    )
      continue;
    const button = (i) =>
      Math.max(
        0,
        Math.min(
          1,
          Number(pad.buttons?.[i]?.value) ||
            (pad.buttons?.[i]?.pressed ? 1 : 0),
        ),
      );
    let keys = 0;
    for (let i = 0; i < mask.length; i++) if (button(i) >= 0.5) keys |= mask[i];
    const axes = [
      axis(pad.axes?.[0]),
      -axis(pad.axes?.[1]),
      axis(pad.axes?.[2]),
      -axis(pad.axes?.[3]),
    ];
    for (let i = 0; i < axes.length; i++)
      if (Math.abs(axes[i]) > 0.25) keys |= 0x10000 << i;
    const lt = button(6),
      rt = button(7);
    if (lt >= 0.5) keys |= 0x100000;
    if (rt >= 0.5) keys |= 0x200000;
    result.push([
      pad.index,
      String(pad.id)
        .replace(/[\u0000-\u001f\u007f]/gu, "")
        .slice(0, 256),
      keys,
      ...axes,
      lt,
      rt,
    ]);
  }
  return result;
}

export function installGamepads(
  evaluate,
  { getPads = () => navigator.getGamepads?.() ?? [], host = globalThis } = {},
) {
  const module = (host.Module ??= {});
  const callbacks = module.preRun;
  module.preRun = [
    ...(Array.isArray(callbacks) ? callbacks : callbacks ? [callbacks] : []),
    () => {
      let initial = [];
      try {
        initial = gamepadSnapshot(getPads());
      } catch {}
      // Startup TJS can inspect controllers before the REPL bridge is ready.
      module.arguments?.unshift(
        `-krkrtools-gamepads=${encodeURIComponent(JSON.stringify(initial))}`,
      );
    },
  ];
  let stopped = false,
    last = null,
    nextProbe = 0;
  const desired = new Map(),
    warned = new Set();
  const warn = (key, error) => {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`krkrtools gamepad: ${error}`);
    }
  };
  const tick = async () => {
    if (stopped) return;
    try {
      if (host.Module?.krkrzRuntimeReady && performance.now() >= nextProbe) {
        const pads = Array.from(getPads()),
          snapshot = host.document?.hidden ? [] : gamepadSnapshot(pads),
          encoded = JSON.stringify(snapshot);
        if (snapshot.length || encoded !== last) {
          const requests = await evaluate(
            `typeof global.krkrtoolsUpdateGamepads == "undefined" ? null : krkrtoolsUpdateGamepads(${encoded})`,
          );
          if (requests === undefined || requests === null)
            nextProbe = performance.now() + 1000;
          else {
            last = encoded;
            for (const [index, left, right] of JSON.parse(requests))
              desired.set(index, { left, right, next: 0 });
          }
        }
        for (const [index, state] of desired) {
          const pad = pads.find((p) => p?.index === index && p.connected);
          if (!pad || host.document?.hidden) {
            desired.delete(index);
            Promise.resolve(pad?.vibrationActuator?.reset?.()).catch(() => {});
            continue;
          }
          if (performance.now() < state.next) continue;
          state.next = performance.now() + 250;
          if (!pad.vibrationActuator?.playEffect) {
            if (state.left || state.right)
              warn(index, "This browser/controller has no rumble API.");
            desired.delete(index);
            continue;
          }
          Promise.resolve(
            pad.vibrationActuator.playEffect("dual-rumble", {
              startDelay: 0,
              duration: 500,
              strongMagnitude: state.left,
              weakMagnitude: state.right,
            }),
          ).catch((error) => warn(index, error.message));
          if (!state.left && !state.right) desired.delete(index);
        }
      }
    } catch (error) {
      nextProbe = performance.now() + 1000;
      warn("bridge", error.message);
    }
    if (!stopped) host.setTimeout(tick, 33);
  };
  tick();
  return () => {
    stopped = true;
    desired.clear();
  };
}
