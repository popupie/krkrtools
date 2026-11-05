import { createHash } from "node:crypto";
import { safeRelativePath } from "../files.mjs";
import DEFAULT_RUNTIME from "./manifest.json" with { type: "json" };

export const UPSTREAM_URL =
  "https://api.github.com/repos/wamsoft/krkrz_dev/git/trees/master?recursive=1";
const DEMO = "doc/_assets/demo/";
const NOTICES = new Map([
  ["LICENSE.md", "licenses/krkrz-dev-LICENSE.md"],
  ["doc/guide/Licenses.en.md", "licenses/Licenses.en.md"],
  ["doc/guide/BundledLicenses.en.md", "licenses/BundledLicenses.en.md"],
  ["data/DEMO-ASSETS.md", "licenses/DEMO-ASSETS.md"],
]);

export function manifestFromUpstream(tree) {
  if (
    !tree ||
    !/^[a-f0-9]{40}$/u.test(tree.sha) ||
    tree.truncated ||
    !Array.isArray(tree.tree) ||
    tree.tree.length > 20000
  )
    throw new Error("Incomplete or invalid upstream runtime metadata.");
  const files = [];
  for (const item of tree.tree) {
    if (typeof item.path !== "string")
      throw new Error("Invalid upstream file path.");
    let path = NOTICES.get(item.path);
    if (item.path.startsWith(DEMO)) {
      const relative = item.path.slice(DEMO.length);
      if (relative === "index.html") path = "krkrz.html";
      else if (
        ["krkrz.js", "krkrz.wasm", "krkrz.data", "resource.list"].includes(
          relative,
        ) ||
        (relative.startsWith("resource/") && item.type === "blob") ||
        (relative !== "coi-serviceworker.js" &&
          /worker.*\.(?:js|mjs)$/u.test(relative))
      )
        path = relative;
    }
    if (!path) continue;
    if (
      item.type !== "blob" ||
      !["100644", "100755"].includes(item.mode) ||
      !/^[a-f0-9]{40}$/u.test(item.sha) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0
    )
      throw new Error(`Unsupported upstream runtime file: ${item.path}`);
    safeRelativePath(path);
    const known = DEFAULT_RUNTIME.files.find(
      (file) =>
        file.path === path &&
        file.gitSha === item.sha &&
        file.bytes === item.size,
    );
    files.push({
      path,
      url: `https://raw.githubusercontent.com/wamsoft/krkrz_dev/${tree.sha}/${item.path}`,
      bytes: item.size,
      gitSha: item.sha,
      ...(known ? { sha256: known.sha256 } : {}),
    });
  }
  for (const path of [
    "krkrz.html",
    "krkrz.js",
    "krkrz.wasm",
    "krkrz.data",
    "resource.list",
    "resource/config.cf",
    ...NOTICES.values(),
  ])
    if (!files.some((file) => file.path === path))
      throw new Error(`Upstream runtime is missing ${path}.`);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const fingerprint = (items) =>
    createHash("sha256")
      .update(
        JSON.stringify(
          items
            .map(({ path, bytes, gitSha }) => ({ path, bytes, gitSha }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        ),
      )
      .digest("hex");
  // Keep the already downloaded baseline cache. Changes elsewhere in the repo
  // do not change the build identity or trigger another runtime download.
  if (fingerprint(files) === fingerprint(DEFAULT_RUNTIME.files))
    return DEFAULT_RUNTIME;
  return {
    format: "krkrtools-runtime",
    version: 1,
    id: `krkrz-web-${fingerprint(files).slice(0, 24)}`,
    repository: DEFAULT_RUNTIME.repository,
    revision: tree.sha,
    files,
  };
}

export async function checkUpstreamRuntime({
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    const response = await fetchImpl(UPSTREAM_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "krkrtools",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 ** 2)
        throw new Error("Upstream metadata exceeds 8 MiB.");
      chunks.push(Buffer.from(chunk));
    }
    return manifestFromUpstream(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } catch (error) {
    throw new Error(
      `Could not check upstream runtime: ${error.message}. Use --offline for the last cached version or --runtime <built folder>.`,
      { cause: error },
    );
  }
}
