// Shared SWF animation backend. Ruffle is loaded only when a SWF opens.
export function installFlash({ gameId, assetBase, ruffleBase }) {
  let loading;
  const loadRuffle = () =>
    (loading ??= new Promise((resolve, reject) => {
      globalThis.RufflePlayer = {
        config: { publicPath: ruffleBase, polyfills: false },
      };
      const script = document.createElement("script");
      script.src = `${ruffleBase}ruffle.js`;
      script.onload = () => {
        try {
          const runtime = globalThis.RufflePlayer.newest();
          if (!runtime?.createPlayer)
            throw new Error("Ruffle did not expose a player factory.");
          resolve(runtime);
        } catch (error) {
          loading = null;
          reject(error);
        }
      };
      script.onerror = () => {
        loading = null;
        reject(new Error("Could not load the exported Ruffle runtime."));
      };
      document.head.append(script);
    }));
  globalThis.krkrtoolsCreateVideo = async (url, bytes) => {
    const swf = bytes
      ? /^(?:FWS|CWS|ZWS)$/u.test(String.fromCharCode(...bytes.subarray(0, 3)))
      : /\.swf(?:[?#]|$)/iu.test(url);
    if (!swf) return document.createElement("video");
    const canvas = document.createElement("canvas"),
      context = canvas.getContext("2d");
    let player,
      api,
      ready,
      failed,
      closed = false,
      playing = false,
      volume = 1,
      started = 0,
      elapsed = 0,
      generation = 0;
    let callbackId = 0,
      frames = new Map(),
      timer,
      raf,
      source,
      lastFrame = -Infinity,
      refresh = false;
    const dispatch = (name) => canvas.dispatchEvent(new Event(name));
    const fail = (error) => {
      failed = error;
      playing = false;
      console.error("krkrtools Flash:", error);
      dispatch("error");
    };
    async function open() {
      const token = ++generation;
      const ruffle = await loadRuffle();
      if (closed || token !== generation) return;
      if (!bytes) {
        const response = await fetch(url);
        if (!response.ok)
          throw new Error(`Could not read SWF: HTTP ${response.status}`);
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      player?.remove();
      player = ruffle.createPlayer();
      player.style.cssText =
        "position:fixed;left:-100000px;top:0;width:1px;height:1px;pointer-events:none";
      player.setAttribute("aria-hidden", "true");
      player.inert = true;
      document.body.append(player);
      api = player.ruffle();
      const asset = new URL(url, assetBase);
      const relative = asset.href.startsWith(assetBase)
        ? asset.href.slice(assetBase.length)
        : "embedded.swf";
      const stableName = new URL(
        `krkrtools-flash/${encodeURIComponent(gameId)}/${relative}`,
        document.baseURI,
      ).href;
      await api.load({
        data: bytes,
        swfFileName: stableName,
        base: asset.protocol === "blob:" ? assetBase : new URL(".", asset).href,
        autoplay: "off",
        preferredRenderer: "canvas",
        wmode: "transparent",
        letterbox: "off",
        splashScreen: false,
        contextMenu: "off",
        unmuteOverlay: "hidden",
        allowScriptAccess: false,
        allowNetworking: "internal",
      });
      // load() can complete before metadata and the first renderer surface exist.
      const deadline = performance.now() + 30000;
      while (!api.metadata || !player.shadowRoot?.querySelector("canvas")) {
        if (closed || token !== generation) return;
        if (performance.now() > deadline)
          throw new Error(
            "Ruffle did not create a movie surface within 30 seconds.",
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (closed || token !== generation) return;
      const { width, height } = api.metadata;
      if (!(width > 0 && height > 0) || width * height > 16777216)
        throw new Error("Unsupported Flash surface dimensions.");
      canvas.width = width;
      canvas.height = height;
      player.style.width = `${width}px`;
      player.style.height = `${height}px`;
      source = player.shadowRoot.querySelector("canvas");
      api.volume = volume;
      api.suspend();
      dispatch("loadedmetadata");
      dispatch("canplay");
      if (playing) {
        started = performance.now();
        api.resume();
      }
      refresh = true;
      tick();
    }
    function tick() {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      if (closed) return;
      const now = performance.now(),
        interval = 1000 / (api?.metadata?.frameRate || 30);
      if (source && (refresh || (playing && now - lastFrame >= interval))) {
        refresh = false;
        lastFrame = now;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const waiting = frames;
        frames = new Map();
        for (const callback of waiting.values())
          callback(performance.now(), { mediaTime: canvas.currentTime });
      }
      // Ruffle owns its timeline. This only publishes its latest rendered image.
      if (document.hidden)
        timer = setTimeout(tick, 1000 / (api?.metadata?.frameRate || 30));
      else raf = requestAnimationFrame(tick);
    }
    Object.defineProperties(canvas, {
      src: {
        get: () => url,
        set: () => {
          ready ??= open().catch(fail);
        },
      },
      videoWidth: { get: () => api?.metadata?.width || 0 },
      videoHeight: { get: () => api?.metadata?.height || 0 },
      duration: { get: () => Infinity }, // Scripted SWFs have no HTML-video duration.
      currentTime: {
        get: () =>
          (elapsed + (playing ? performance.now() - started : 0)) / 1000,
        set: (value) => {
          if (value !== 0)
            throw new Error(
              "Flash seeking is unavailable: Ruffle does not expose frame-accurate timeline seeking.",
            );
          elapsed = 0;
          started = performance.now();
          if (api) {
            source = null;
            ready = open().catch(fail);
          }
        },
      },
      paused: { get: () => !playing },
      ended: { get: () => false },
      error: { get: () => failed },
      loop: {
        get: () => false,
        set: (value) => {
          if (value)
            throw new Error(
              "Flash looping is controlled by the SWF timeline; VideoOverlay.loop is unavailable.",
            );
        },
      },
      volume: {
        get: () => volume,
        set: (value) => {
          volume = Math.max(0, Math.min(1, value));
          if (api) api.volume = volume;
        },
      },
    });
    canvas.play = async () => {
      if (failed) throw failed;
      if (!playing) {
        playing = true;
        started = performance.now();
      }
      await ready;
      if (failed) throw failed;
      if (!closed) api?.resume();
    };
    canvas.pause = () => {
      if (playing) elapsed += performance.now() - started;
      playing = false;
      api?.suspend();
    };
    canvas.requestVideoFrameCallback = (callback) => {
      frames.set(++callbackId, callback);
      return callbackId;
    };
    canvas.cancelVideoFrameCallback = (id) => frames.delete(id);
    canvas.load = () => {};
    const remove = canvas.remove.bind(canvas);
    canvas.remove = () => {
      closed = true;
      generation++;
      frames.clear();
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      player?.remove();
      remove();
    };
    console.info(
      "krkrtools: Flash animation via Ruffle; seeking, loop control, interactive input and frame-accurate end detection are unavailable.",
    );
    return canvas;
  };
}
