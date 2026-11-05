import { installGamepads } from "./gamepad.mjs";
// Browser controls for the generated KAG3 compatibility profile.
// REPL results use TJS expression escaping, which also escapes apostrophes and
// supports C control escapes. Decode string literals without executing them.
export function decodeTjsResult(value) {
  if (typeof value !== "string") throw new Error("Invalid runtime response.");
  if (!value.startsWith('"')) return JSON.parse(value);
  if (!value.endsWith('"') || value.length < 2)
    throw new Error("Invalid runtime string.");
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
  };
  let result = "";
  for (let i = 1; i < value.length - 1; i++) {
    const ch = value[i];
    if (ch === '"') throw new Error("Invalid runtime string.");
    if (ch !== "\\") {
      result += ch;
      continue;
    }
    const escape = value[++i];
    if (i >= value.length - 1) throw new Error("Invalid runtime escape.");
    if (escape === "x") {
      const hex = /^[0-9a-f]{1,4}/iu.exec(value.slice(i + 1))?.[0];
      if (!hex) throw new Error("Invalid runtime hex escape.");
      result += String.fromCharCode(Number.parseInt(hex, 16));
      i += hex.length;
    } else if (Object.hasOwn(escapes, escape)) result += escapes[escape];
    else throw new Error("Invalid runtime escape.");
  }
  return result;
}

export function createTjsBridge(getModule = () => globalThis.Module) {
  let pending = Promise.resolve();
  return (expression) => {
    const work = pending.then(async () => {
      const module = getModule();
      if (!module?.ccall || !module.krkrzRuntimeReady)
        throw new Error("The game is still loading.");
      // Restoring a bookmark can suspend through Asyncify. Serializing calls
      // also keeps polling out of the engine while that restore is pending.
      const raw = await module.ccall(
        "krkrz_repl_eval",
        "string",
        ["string"],
        [expression],
        { async: true },
      );
      const reply = JSON.parse(raw);
      if (!reply.ok)
        throw new Error(
          String(reply.error ?? "The game command failed.").replace(
            /^Error: /,
            "",
          ),
        );
      return decodeTjsResult(reply.result);
    });
    pending = work.catch(() => {});
    return work;
  };
}

export function createKagCommands(evaluate, logger) {
  let token = 0;
  const pending = new Map();
  const marker = "@krkrtools-command:";
  // Upstream replaces Module.print/printErr during initialization. Its native
  // Debug output ultimately uses these console channels; preserve both sinks.
  for (const channel of ["log", "error"]) {
    const previous = logger[channel];
    logger[channel] = function (...args) {
      const text = args.join(" ");
      const start = text.indexOf(marker);
      if (start >= 0) {
        try {
          const result = JSON.parse(text.slice(start + marker.length));
          const command = pending.get(result.token);
          if (command) {
            pending.delete(result.token);
            if (result.ok) command.resolve();
            else
              command.reject(
                new Error(result.error || "The game command failed."),
              );
          }
        } catch {}
      }
      if (previous) previous.apply(this, args);
    };
  }
  return {
    async run(operation, argument) {
      const id = ++token;
      const completed = new Promise((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      // Register the completion handler before the timer can deliver its event.
      const requested = evaluate(
        `krkrtoolsRequest(${JSON.stringify(operation)},${JSON.stringify(argument)},${id})`,
      );
      requested.catch((error) => {
        pending.get(id)?.reject(error);
        pending.delete(id);
      });
      await completed;
    },
    abort(error) {
      for (const command of pending.values()) command.reject(error);
      pending.clear();
    },
  };
}

export function installKagControls({ gameId }) {
  const panel = document.createElement("aside");
  panel.id = "krkrtools-controls";
  panel.setAttribute("aria-label", "Game controls");
  panel.innerHTML = `<style>
#krkrtools-controls{position:fixed;top:8px;right:8px;z-index:15;background:#181b20ee;color:#eee;border:1px solid #555;border-radius:7px;padding:7px;font:13px system-ui;max-width:90vw}
#krkrtools-controls button,#krkrtools-controls select{font:inherit;margin:2px;padding:5px;color:#eee;background:#303640;border:1px solid #626a78;border-radius:4px}
#krkrtools-controls button:disabled{opacity:.45}#krkrtools-controls details>summary{cursor:pointer}
#krkrtools-menu{max-height:50vh;overflow:auto}#krkrtools-menu details{padding-left:12px}#krkrtools-menu button{display:block;text-align:left}
#krkrtools-text{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:14;width:min(92vw,760px);max-height:28vh;overflow:auto;box-sizing:border-box;white-space:pre-wrap;background:#111e;color:#fff;border-radius:6px;padding:10px;font:17px/1.5 system-ui;user-select:text}
#krkrtools-status{max-width:360px;margin:3px 0 0;white-space:pre-wrap}
</style><details id="krkrtools-panel"><summary>Game controls</summary>
<button id="krkrtools-menu-toggle" type="button">Game menu</button>
<label>Slot <select id="krkrtools-slot"></select></label>
<button id="krkrtools-save" type="button" disabled>Save</button><button id="krkrtools-load" type="button" disabled>Load</button>
<p id="krkrtools-save-hint" hidden>Use the game's Save and Load screens.</p>
<label><input id="krkrtools-overlay" type="checkbox" checked> Text overlay</label>
<div id="krkrtools-menu" hidden></div><p id="krkrtools-status" role="status"></p></details>`;
  document.body.append(panel);
  const overlay = document.createElement("div");
  overlay.id = "krkrtools-text";
  overlay.setAttribute("aria-label", "Game text");
  overlay.hidden = true;
  document.body.append(overlay);
  const find = (id) => panel.querySelector(`#krkrtools-${id}`);
  const save = find("save"),
    load = find("load"),
    slot = find("slot"),
    toggle = find("overlay");
  const status = (message) => {
    find("status").textContent = message;
  };
  let ready = false,
    busy = false,
    polling = false,
    lastText = "",
    stateError = false;
  const preference = `krkrtools:${gameId}:overlay`;
  try {
    toggle.checked = localStorage.getItem(preference) !== "false";
  } catch {}
  toggle.addEventListener("change", () => {
    overlay.hidden = !toggle.checked || !lastText;
    try {
      localStorage.setItem(preference, String(toggle.checked));
    } catch {}
  });
  const evaluate = createTjsBridge();
  installGamepads(evaluate);
  const commands = createKagCommands(evaluate, console);
  window.addEventListener("error", (event) =>
    commands.abort(new Error(event.message || "The game stopped.")),
  );
  const sync = () =>
    new Promise((resolve, reject) => {
      const fs = globalThis.Module?.FS;
      if (!fs?.syncfs) {
        reject(
          new Error("The supplied runtime has no save synchronization API."),
        );
        return;
      }
      try {
        const mount = fs.lookupPath("/persist").node.mount;
        if (
          mount.mountpoint !== "/persist" ||
          typeof mount.type.syncfs !== "function"
        )
          throw new Error(
            "The supplied runtime has no persistent save filesystem at /persist.",
          );
      } catch (error) {
        reject(error);
        return;
      }
      fs.syncfs(false, (error) => (error ? reject(error) : resolve()));
    });
  const action = async (work) => {
    if (busy) return;
    busy = true;
    save.disabled = load.disabled = true;
    try {
      await work();
    } catch (error) {
      status(error.message);
    } finally {
      busy = false;
    }
  };
  save.addEventListener("click", () =>
    action(async () => {
      await commands.run("save", Number(slot.value));
      await sync();
      status(`Saved in slot ${slot.selectedOptions[0].textContent}.`);
    }),
  );
  load.addEventListener("click", () =>
    action(async () => {
      await commands.run("load", Number(slot.value));
      status(`Loaded slot ${slot.selectedOptions[0].textContent}.`);
    }),
  );
  const renderMenu = (items, target) => {
    for (const item of items) {
      const caption = item.caption.replace(/\(&.\)|&/g, "");
      if (item.children.length) {
        const group = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = caption;
        group.append(summary);
        if (!item.enabled) {
          group.setAttribute("aria-disabled", "true");
          continue;
        }
        renderMenu(item.children, group);
        target.append(group);
      } else {
        const button = document.createElement("button");
        button.textContent = `${item.checked ? "✓ " : ""}${caption}`;
        button.disabled = !item.enabled;
        button.addEventListener("click", () =>
          action(async () => {
            if (!/^\d+(?:\.\d+)*$/.test(item.path))
              throw new Error("Invalid menu selection.");
            await commands.run("menu", item.path);
            await sync();
            find("menu").hidden = true;
            status("");
          }),
        );
        target.append(button);
      }
    }
  };
  find("menu-toggle").addEventListener("click", () =>
    action(async () => {
      const target = find("menu");
      if (!target.hidden) {
        target.hidden = true;
        return;
      }
      target.replaceChildren();
      renderMenu(JSON.parse(await evaluate("krkrtoolsMenus()")), target);
      target.hidden = false;
    }),
  );
  const tick = async () => {
    if (
      busy ||
      polling ||
      document.hidden ||
      !globalThis.Module?.krkrzRuntimeReady
    )
      return;
    polling = true;
    try {
      const state = JSON.parse(
        await evaluate(`krkrtoolsState(${Number(slot.value)})`),
      );
      if (!state.ready || busy) return;
      if (stateError) {
        status("");
        stateError = false;
      }
      if (!ready) {
        const count = Math.max(
          1,
          Math.min(1000, Number(await evaluate("kag.numBookMarks"))),
        );
        if (busy) return;
        for (let i = 0; i < count; i++) {
          const option = document.createElement("option");
          option.value = String(i);
          option.textContent = String(i + 1);
          slot.append(option);
        }
        ready = true;
      }
      save.disabled = !state.canSave;
      load.disabled = !state.canLoad;
      save.hidden =
        load.hidden =
        slot.closest("label").hidden =
          Boolean(state.customSaveMenu);
      find("save-hint").hidden = !state.customSaveMenu;
      const text = state.text.trim();
      if (text !== lastText) {
        lastText = text;
        overlay.textContent = lastText;
      }
      overlay.hidden = !toggle.checked || !lastText;
    } catch (error) {
      save.disabled = load.disabled = true;
      stateError = true;
      status(error.message);
    } finally {
      polling = false;
    }
  };
  setInterval(tick, 500);
}
