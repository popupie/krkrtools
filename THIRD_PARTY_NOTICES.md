# Source references and runtime notices

krkrtools uses Node.js built-in modules and has no third-party package dependencies.
Its archive implementation is written in JavaScript for this package.

The standard XP3 field layout and web sidecar protocol were checked against:

- [KiriKiri XP3 reader](https://github.com/fenghengzhi/kirikiroid2-web/blob/2028cbccaa91498bd36f270d349ae711d0e8fed3/cpp/core/base/XP3Archive.cpp).
- [KiriKiri Z Web XP3 reference tool](https://github.com/wamsoft/krkrz_web/blob/2fe46168acebc9ecf093d95e630a98f50a17efba/tools/xp3pack.py).
- [KiriKiri Z Web staging and manifest tools](https://github.com/wamsoft/krkrz_web/tree/2fe46168acebc9ecf093d95e630a98f50a17efba/tools).
- [KiriKiri Z Web REPL bridge](https://github.com/wamsoft/krkrz/blob/7d91ba56bcfe241df349b01badd915a156bc47cf/common/utils/ReplWasmBridge.cpp) and [TJS string escaping](https://github.com/wamsoft/krkrz/blob/7d91ba56bcfe241df349b01badd915a156bc47cf/common/tjs2/tjsString.cpp), used to check the browser controls' protocol.
- [GamepadPort constants and disconnected-device API](https://github.com/wamsoft/gamepad/blob/master/readme.txt).
- [LayerExVector's LayerExDraw-compatible subset](https://github.com/wamsoft/layerExVector), used through the supplied runtime's native implementation.

No KiriKiri, SDL, font, codec, or game binaries are included in this package.
The optional runtime supplied to `web` and its resources retain their own licenses.

## Optional Flash runtime

Flash exports may download `@ruffle-rs/ruffle` from the official package registry.
Ruffle is licensed under MIT or Apache-2.0. Its `LICENSE_MIT` and
`LICENSE_APACHE` files are retained under `lib/ruffle/` in each Flash export.
See https://github.com/ruffle-rs/ruffle.

The independent gfxFire adapter follows the published interface in Kaede
Software's gfxEffect package (https://kaede-software.com/krlm/plugin/).
It does not copy the native DLL, its random-number implementation, or sample-game
assets, and does not claim identical rendering.
