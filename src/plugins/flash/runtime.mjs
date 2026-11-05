// This hook targets the upstream HTML-video factory.
export function patchFlashVideoFactory(source) {
  const marker = 'var v=document.createElement("video");v.preload="auto";';
  if (
    source.split(marker).length !== 2 ||
    !source.includes("__asyncjs__krkrz_video_open_js")
  )
    throw new Error(
      "Flash support needs a compatible krkrz_web HTML-video backend.",
    );
  return source.replace(
    marker,
    'var v=await globalThis.krkrtoolsCreateVideo(url,data?HEAPU8.slice(data,data+len):null);v.preload="auto";',
  );
}
export function needsFlash(files, scripts) {
  return (
    files.some((file) => /\.swf$/iu.test(file.path)) ||
    scripts.some((text) =>
      /["'](?:[^"'\r\n]*[\\/])?(?:krflash|flashplayer)(?:\.(?:dll|tpm))?["']/iu.test(
        text,
      ),
    )
  );
}
