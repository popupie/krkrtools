import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { isInside, requireDirectory, safeRelativePath } from "./files.mjs";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ogg", "audio/ogg"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".ttf", "font/ttf"],
  [".woff2", "font/woff2"],
]);

export function parseRange(header, size) {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const suffix = !match[1];
  const first = Number(suffix ? match[2] : match[1]);
  const last = suffix || !match[2] ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    first < 0 ||
    (suffix && first === 0)
  )
    return null;
  const start = suffix ? Math.max(0, size - first) : first;
  if (start >= size || last < start) return null;
  return { start, end: Math.min(last, size - 1) };
}

export async function serveWebExport(
  rootDir,
  { port = 4178, host = "127.0.0.1" } = {},
) {
  const root = await requireDirectory(rootDir);
  if (!(await lstat(join(root, "index.html"))).isFile())
    throw new Error("The export has no index.html.");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`Invalid port: ${port}`);
  const server = createServer(async (request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end();
        return;
      }
      // Validate before URL normalization can erase parent path segments.
      let requested = decodeURIComponent((request.url ?? "/").split("?")[0]);
      if (!requested.startsWith("/")) throw new Error("Invalid URL path.");
      requested = requested.slice(1);
      if (!requested || requested.endsWith("/")) requested += "index.html";
      const path = join(root, safeRelativePath(requested));
      const actual = await realpath(path);
      if (!isInside(root, actual))
        throw new Error("Path escapes the export folder.");
      const file = await lstat(actual);
      if (!file.isFile()) throw new Error("Not a file.");
      // HEAD describes the full representation; Range is a GET request header.
      const range =
        request.method === "HEAD"
          ? undefined
          : parseRange(request.headers.range, file.size);
      if (range === null) {
        response.writeHead(416, {
          "Content-Range": `bytes */${file.size}`,
          "Content-Length": "0",
        });
        response.end();
        return;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? file.size - 1;
      response.setHeader(
        "Content-Type",
        MIME.get(extname(path).toLowerCase()) ?? "application/octet-stream",
      );
      response.setHeader("Content-Length", range ? end - start + 1 : file.size);
      if (range)
        response.setHeader(
          "Content-Range",
          `bytes ${start}-${end}/${file.size}`,
        );
      response.writeHead(range ? 206 : 200);
      if (request.method === "HEAD" || !file.size) {
        response.end();
        return;
      }
      const stream = createReadStream(actual, { start, end });
      response.once("close", () => stream.destroy());
      stream.once("error", () => response.destroy());
      stream.pipe(response);
    } catch {
      if (!response.headersSent)
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      response.end(request.method === "HEAD" ? undefined : "Not found\n");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return { server, root, url: `http://${host}:${server.address().port}/` };
}
