// Recognize the standard KAG recipe that restarts the same EXE with options.
// The original script remains intact; the exporter supplies its options early.
function tokens(text) {
  const code = text.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
    (match, quote) => quote ?? " ",
  );
  return [
    ...code.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|\S/gu),
  ].map(([token]) => token.replace(/^'([^'\\]*)'$/u, '"$1"'));
}

const recipe = tokens(`function set_cmdline_opts(opts=%[]) {
  var illegal = false;
  var optstr = "";
  for (var i = opts.count-1; i >= 0; i--) {
    optstr += " "+opts[i];
    var opt = opts[i].split("=");
    if (opt.count == 2 && System.getArgument(opt[0]) != opt[1]) illegal = true;
  }
  if (illegal) {
    System.shellExecute(Storages.getLocalName(System.exeName), optstr);
    System.exit();
  }
}`);

export function startupRelaunchOptions(raw) {
  const text =
    raw[0] === 0xff && raw[1] === 0xfe
      ? raw.subarray(2).toString("utf16le")
      : raw[0] === 0xfe && raw[1] === 0xff
        ? Buffer.from(raw.subarray(2)).swap16().toString("utf16le")
        : raw.toString("latin1");
  const code = tokens(text);
  const start = code.findIndex((_, i) =>
    recipe.every((token, j) => code[i + j] === token),
  );
  if (start < 0) return null;
  // Only accept a literal top-level call after the exact self-relaunch recipe.
  let depth = 0;
  for (let i = start + recipe.length; i < code.length; i++) {
    if (["{", "(", "["].includes(code[i])) depth++;
    if (["}", ")", "]"].includes(code[i])) depth--;
    if (
      depth ||
      code[i] !== "set_cmdline_opts" ||
      code[i + 1] !== "(" ||
      code[i + 2] !== "["
    )
      continue;
    const args = [];
    let j = i + 3;
    while (
      /^"-[A-Za-z][A-Za-z0-9_-]*=[A-Za-z0-9_.+-]+"$/u.test(code[j] ?? "")
    ) {
      args.push(code[j++].slice(1, -1));
      if (code[j] !== ",") break;
      j++;
    }
    return args.length &&
      code[j] === "]" &&
      code[j + 1] === ")" &&
      code[j + 2] === ";"
      ? args
      : null;
  }
  return null;
}
