# Native size experiment

SLIM’s normal build remains JavaScript. The optional native builder compiles the
same `.slim` source through the C backend and links a small Windows or Android
host. Game logic and its generated tables are embedded in the executable or
APK; the package does not fetch assets at runtime.

## Build

Run the builder from the repository root:

```powershell
node tools/build-native.mjs examples/rainbow.slim --target all --out-dir output/native/rainbow
```

The default Android ABI is `arm64-v8a`. Use `--abi x86_64` to build an emulator
package, or `--abi arm64-v8a,x86_64` to produce one APK for each ABI. Other
options are `--target windows|android|all`, `--out-dir DIR`, `--unsigned`, and
`--smoke`. A smoke Windows build accepts `--smoke` or `--ticks=N` when launched
and writes `slim-smoke.bmp` after running the requested number of frames.

The output directory contains the generated `game.c` and `native-report.json`.
Windows builds also contain a standalone `.exe` and a ZIP containing that one
file. Android builds contain a signed APK by default and a copy of its native
library for size inspection. The report records all three compiler candidates
(`-Oz`, `-Os`, and `-O2`), their full compiler/link arguments, imports, hashes,
and byte counts. The builder chooses the smallest complete Windows ZIP or
Android APK among those candidates. It uses LTO, disables floating-point
contraction, and does not enable fast-math.

The Android APK compresses `libslim.so` and sets `extractNativeLibs` so Android
extracts the library during installation. It keeps `resources.arsc`
uncompressed and 4-byte aligned for current Android package requirements. The
report lists the APK size, the extracted library size, and their sum as an
installed-payload estimate. That sum excludes Android-generated package
metadata and filesystem allocation.
Android builds target API 36 with minimum API 26, which provides AAudio. The
manifest uses `NativeActivity` and includes no Java bytecode or separate asset
files. Windows builds target 64-bit Windows 10 or later and rely on system DLLs
listed in the report; they do not bundle those operating-system components.

## Complete tiny package

To compare every backend for one game, run:

```powershell
node tools/build-tiny.mjs examples/boxpush.slim
```

This makes `dist/tiny/boxpush/` with a Windows executable and ZIP, signed
arm64 and x86_64 Android APKs, and standalone JavaScript and WASM HTML pages
with matching ZIPs. Both browser pages embed their complete runtime and game
data, so they can be opened offline from a file. The browser pages include
on-screen direction, action, restart, and menu controls on touch devices;
keyboard controls remain available. The ordinary JavaScript build and its
defaults are unchanged. Pass `--abi arm64-v8a` to omit the emulator APK or
`--out-dir DIR` to choose another package directory.

The distribution folder contains only the portable game artifacts, a controls
README, and `compact-size-report.json`. Intermediate C sources, shared
libraries, optimizer candidates, and detailed native/browser build reports
remain under ignored `output/tiny-package/boxpush/` for inspection. The report
includes artifact hashes, native system dependencies, Android extracted
library sizes, selected compiler profiles, and browser candidate measurements.
The APK-plus-extracted-library value is an estimate and excludes Android
package metadata and filesystem allocation.

Android signing uses the existing local debug keystore at
`C:\Users\Ben\OneDrive\KeyStores\stasis-local-debug.keystore` when it is
available; its default alias is `androiddebugkey`. This is the workstation’s
debug identity, not a production release key. The command does not create or
copy signing keys. To sign with this or another keystore, provide
`SLIM_ANDROID_STORE_PASSWORD` and `SLIM_ANDROID_KEY_PASSWORD` in the build
environment. For another keystore, also set `SLIM_ANDROID_KEYSTORE` and
`SLIM_ANDROID_KEY_ALIAS`. Passwords have no built-in defaults; if signing
credentials are missing, the builder explains which variables are required.
Use `--unsigned` to skip signing; an unsigned APK cannot be installed until it
is signed. Password values are passed to the signer through environment
references and are not written to the report.

## Scope of the size result

The result compares three compiler optimization profiles for the current C
backend and host. It is a measured lower result among those candidates, not a
proof of the smallest possible executable or APK. Other host implementations,
compiler versions, and linker options may change the result.

The native host keeps an 800×600 logical coordinate space and rasterizes the
4:3 game viewport at the drawable's pixel resolution. This makes triangle
graphics sharp on high-density displays. The physical framebuffer is runtime
memory rather than installed game data, and its size does not materially
affect the package-size comparison. Windows and Android frame loops target
60 frames per second; the operating system may schedule less frequently when
the device is busy or the app is in the background. Windows uses the system
Segoe UI font, while Android uses a compact 5×7 bitmap font with uppercase
letters, digits, and basic punctuation; lowercase is drawn as uppercase and
unsupported characters use a replacement glyph. Native sound uses a small
waveform and envelope synthesizer behind WinMM or AAudio, so its output is not
sample-identical to the JavaScript WebAudio backend.

Exact artifact sizes and hashes are recorded by each build in
`native-report.json` or `compact-size-report.json`. These measurements describe
the tested compiler candidates and host implementation, not a proof of the
smallest possible package.

## Boxpush measurement

The `dist/tiny/boxpush/` sample compares the final self-contained installers
and browser files generated by `tools/build-tiny.mjs`. The native Windows and
Android targets selected Clang `-Oz`; the browser WASM page embeds a 20,496-byte
module. The measured files are:

| Target | Self-contained file | Compressed archive | Extracted Android library | APK plus library estimate |
|---|---:|---:|---:|---:|
| Windows | `game.exe` 51,200 B | 22,664 B | — | — |
| Android arm64-v8a | APK 37,280 B | — | 51,624 B | 88,904 B |
| Android x86_64 | APK 37,277 B | — | 58,336 B | 95,613 B |
| Browser JavaScript | HTML 28,554 B | 10,709 B | — | — |
| Browser WASM | HTML 36,242 B | 13,815 B | — | — |

Each HTML file contains its runtime and game data, so it can run from a local
file without downloads. APKs are signed for local testing. The APK-plus-library
figures are payload estimates and exclude Android-generated metadata and
filesystem allocation; Windows archives and browser archives each contain one
standalone file.
