# krkrtools

krkrtools is a command line tool for KiriKiri games. It can check game files, unpack supported archives, pack folders into archives, and create a website with KiriKiri Z Web.

Use krkrtools only with games you own or have permission to work with.

## Choose a command

- `inspect` identifies the engine, framework versions, and archive contents.
- `unpack` extracts original named assets from XP3 files or embedded EXEs.
- `pack` creates a standard XP3 archive from a folder.
- `list` lists the files in one archive without extracting it.
- `web` creates a website with loose game assets and a browser runtime.
- `serve` starts a local web server for testing or playing an export.

## Install

Requires Node.js 22+ and pnpm 10+. There are no third-party JavaScript
dependencies to install. Make the krkrtools command available on your computer:

```sh
pnpm link -g
```

Show command help:

```sh
krkrtools help
```

The [hello example](examples/hello/startup.tjs) is a small source project for
trying the commands without game's assets.

## Inspect a game

```sh
krkrtools inspect "/path/to/Game"
krkrtools inspect "/path/to/data.xp3" --json
krkrtools list "/path/to/data.xp3"
```

The report shows engine and KAG versions with the supporting file and field or
script declaration.
Inspect the original game folder when possible: XP3 or KAG alone cannot identify
the engine generation. Detection does not establish browser compatibility.

## Create a website

For a game folder, or a project containing `startup.tjs`:

```sh
krkrtools web "/path/to/Game"
```

The default output is a new sibling folder named `Game web`. To choose a different
output folder, provide it after the game folder:

```sh
krkrtools web "/path/to/Game" "/path/to/My website"
```

Runtime selection follows this order:

1. Use an existing `--runtime <built krkrz_web folder>` provided by the user.
2. Otherwise check upstream and reuse the matching build if it is already cached.
3. Download a new build when upstream changes, keeping previous builds cached.

The default cache is `~/.cache/krkrtools`, with `XDG_CACHE_HOME` and `--cache-dir`
overrides. Use `--offline` to skip network access and use the last complete cached
build.

The converter automatically loads a root `data.xp3`, other root asset archives
(such as `chara.xp3`, `dungeon.xp3`, and `voice.xp3`), then contiguous
`patch.xp3`, `patch2.xp3`, etc., or `patch_0.xp3`, `patch_1.xp3`, etc., in numeric
order. A detected KAG3 declaration enables its compatibility adapters and flat
patch lookup.

For conflicting base archives, nested archives, gaps, or mixed patch naming
conventions, select every required archive in load order, base first and patches last:

```sh
krkrtools web "/path/to/Game" "/path/to/Game web" \
  --archive data.xp3 --archive patch.xp3
```

Web conversion is experimental. Native Windows plugins are not converted, and
KiriKiri1 playback is not established. KiriKiri2 compatibility depends on the
scripts and plugins working with the Z runtime.

## Test or play a website

```sh
krkrtools serve "/path/to/Game web"
krkrtools serve "/path/to/Game web" 8080
```

Open the printed URL. The default port is 4178.

## Unpack assets

```sh
krkrtools unpack "/path/to/data.xp3" "/path/to/Game extracted"
krkrtools unpack "/path/to/Game" "/path/to/Game archives"
```

An EXE with a standard embedded XP3 is also accepted. A game folder extracts each
archive into a separate subfolder.
The output contains individual named assets:

```text
Game extracted/
  startup.tjs
  scenario/start.ks
  background/room.png
  voice/001.ogg
```

Original bytes and formats are preserved. Compiled or encoded scripts are not
automatically decoded. Long filenames may need a reversible mapping recorded in
`.krkrtools-paths.json`.

## Pack assets

```sh
krkrtools pack "/path/to/data" "/path/to/new/data.xp3"
```

Packing keeps filenames and subdirectories and compresses files when useful.
Use `--no-compress` to store all files directly.

## Privacy and licenses

Game files stay local and are never uploaded. Automatic network access checks
upstream runtime metadata and downloads engine files and notices when needed.
`--offline` disables both. Runtime binaries are not included in this package.
Exports keep downloaded notices under `licenses/`.
