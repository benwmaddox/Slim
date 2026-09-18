# Slim

A small experimental game language that compiles directly to WebAssembly, with
a triangle-only WebGL host, procedural JavaScript sound, and keyboard/pointer
input. Independent of Stasis. See [PLAN.md](PLAN.md) for scope and milestones.

The same source builds to WASM or JavaScript. See [PROGRESS.md](PROGRESS.md)
for complete ZIP comparisons, validation, and current limits.

## Build

Requires modern Node.js, Python 3, and Binaryen's `wasm-dis` for readable WAT.
Terser is a pinned build dependency; nothing from npm ships with the game.

```sh
npm ci
npm test
npm run build
```

Outputs follow the source basename: `rainbow.wasm`, `rainbow.wat`,
`rainbow.html`, and `rainbow.zip`. The build compares embedded and separate WASM,
plain and optional Binaryen `-Oz`, `-Os`, `-O4`, and `-Oz --converge`, and original versus
Terser-minified scripts.
It selects by complete ZIP size, including archive overhead.

For a release build, add `--release` or run `npm run build:release`. This also
compares f32 and compact integer-array storage, plus plain, compact numeric,
and byte-string sound presets. Supply triangle
array names to compare their packed and unpacked WASM forms:

```sh
node tools/build.mjs examples/shardbound.slim --release --keyboard-only --pack-triangles ATLAS
```

Each backend keeps its smallest measured complete ZIP. Equal sizes favor simpler
encodings. Release builds default to staged search: change one setting at a time
and recheck for interactions in a second pass. Cached trials avoid repeated work.
Use `--search exhaustive` for a complete audit, or `--search staged` to use the
same approach in an ordinary build. The size report records phase savings,
selected settings, and unsupported candidates. Trial files stay temporary.
See [STAGED_SEARCH.md](STAGED_SEARCH.md) for the order and limits.
Without `--release`, `--pack-triangles` forces packing. Use `--sound-packing`
with `none`, `numbers`, or `bytes` to force a sound format;
`--sound-packing auto` compares them. `--integer-arrays f32`, `compact`, or
`auto` controls the exact integer-storage experiment; ordinary builds default
to f32. JS/HTML minification runs on every build.

`rainbow.js.html` / `rainbow.js.zip` contain the native JavaScript version;
`rainbow.js` is its readable generated factory.
`rainbow.size.json` records every candidate against the 13,312-byte target.
Only these eight final files are retained. Optimizer intermediates and packaging
candidates are measured in a temporary directory and discarded. Successful builds
also remove obsolete candidate files for the current source basename.

For numeric comparisons, `npm run build -- --compare-f32` additionally emits
`rainbow.f32.js`, `rainbow.f32.html`, and `rainbow.f32.zip`. Normal builds remove
these optional outputs. To browser-check that comparison, pass
`--profiles=wasm,js-native,js-f32` to `tools/browser-check.mjs`.
Archives use top-level `index.html`, as required by the supplied rules; an
external WASM layout also contains `rainbow.wasm`. Inspection artifacts and
development dependencies are excluded.

Serve the selected output with `python -m http.server 8000 --directory dist`,
then open `http://localhost:8000/rainbow.html` or `rainbow.js.html`.
Separate WASM needs HTTP because browsers
restrict file URL fetching. The JavaScript versions are self-contained and can
be opened directly after extraction.

Optional: put Binaryen's `wasm-opt` on PATH, or set `SLIM_WASM_OPT` to its
executable. Set `SLIM_WASM_DIS` if the disassembler is not on PATH. The build
compares plain, `-Oz`, `-Os`, `-O4`, and `-Oz --converge` output across both packaging
layouts and selects the smallest complete ZIP. Set `SLIM_PYTHON` if Python uses
a different command name. An explicitly configured optimizer failure aborts
the build.

## Second example: Blockbound

```sh
npm run build:blockbound
```

Blockbound is a keyboard-only side-scrolling platformer with original faceted
characters and a course loosely inspired by an introductory platformer level.
Use Left/Right or A/D to move, Space to jump, and R to restart. Its build keeps
the same eight final files under the `blockbound` basename; Rainbow's outputs
remain available. Open `dist/blockbound.js.html` or serve `blockbound.html`.

`node tools/browser-check.mjs --source=blockbound` checks the generated JS and
WASM with a repeatable keyboard route, jumping, loss/restart, and GPU output.

## Array example: Shardbound

```sh
npm run build:shardbound
node tools/browser-check.mjs --source=shardbound
```

Shardbound is a three-level keyboard platformer. Collect the required shards
and reach its exit; Space continues between levels. Arrows/A-D move, Space
jumps, and R resets the entire run. Terrain arrays drive drawing and collision.
Enemy pools share update loops, and characters use an atlas of reusable triangle
parts with translation, scale, flip, and pose transforms. This exercises content
reuse rather than adding a general game engine.

`npm run build:shardbound` enables release selection for the immutable `ATLAS`
array and the shared sound host. The JavaScript profile keeps ordinary numeric
geometry. Directly invoke `tools/build.mjs` without `--release` or
`--pack-triangles` for the unpacked control. Both builds keep eight files under
the `shardbound` basename.
Serve
`dist/shardbound.html` or open `dist/shardbound.js.html` for the native JS version.

## Initial language

```text
const INPUT_RIGHT = 1;
global x = 100;
fn init() { x = 100; }
fn frame() {
  x = x + input(INPUT_RIGHT) - input(0);
  tri(x, 100, x + 20, 100, x, 120, 1, 0, 0);
}
```

Numbers, parameters, globals, locals, and function results are f32 in WASM and
exact-f32 JS. The native JS comparison uses JavaScript number semantics. Functions
without a return produce zero. Both `init` and `frame` must be declared and take
zero arguments. Globals are mutable persistent game state, with constant numeric
initializers. Locals are function-scoped in v0 and start at zero on each call.
There are local `let` declarations, assignments, `if/else`, `while`, `return`,
function calls, arithmetic, comparisons, and short-circuit logical expressions.
Comparisons and logical expressions produce numeric 0 or 1. Arithmetic and
constant initializers round at each f32 operation. `%` is implemented as
`x - trunc(x / y) * y`, with f32 rounding; it is intended for small game values
and can lose precision for large quotients. Fixed numeric arrays are described
below. There are no strings, allocation, classes, or modules. WASM is emitted directly; no C,
Rust, LLVM, or language runtime is required to build a game.

## Compile-time constants

Top-level constants give numbers meaningful names without runtime storage:

```text
const STATE_PLAYING = 0;
const STATE_WON = 1;
const JUMP_SPEED = 12 + 3;
global state = STATE_PLAYING;
```

Constants may reference other constants, including later declarations. Their
numeric expressions use Slim's f32 arithmetic at compile time. Constants cannot
depend on mutable globals or calls, and cannot be assigned to. Function parameters
and locals may shadow a constant, following the existing function scope rules.
The compiler replaces constant references with numeric literals before either
backend runs. No constant declarations, names, globals, or lookup code ship in
the game. Both examples use constants for game states, input indices, and sound
events.

## WASM state storage experiment

The default compiler keeps Slim globals as mutable WASM globals. For a fixed
memory layout, use `compileDetailed(source, {globalStorage: 'memory'})`.
`globalLayout` reports each name and its byte offset; slots are little-endian f32
values, four bytes each, starting at zero in the exported memory. Initial values
are present when the module is instantiated, before `init()` runs.
`arrayLayout` reports array lengths, materialization, and offsets. Materialized
arrays follow scalar memory slots; scalar globals use no linear-memory slots.

`node tools/compare-state.mjs examples/rainbow.slim` compares both storage modes
with identical minified hosts and archive names, including plain and Binaryen Oz
variants when available. Add `--keyboard-only` for Blockbound. Experiment reports
and selected WASM/WAT files go under `output/state-comparison`, keeping normal
`dist` builds unchanged. This changes state storage only; triangle imports remain
the same.

## Browser boundary

`tri(x1,y1,x2,y2,x3,y3,r,g,b)` submits one solid-color triangle, using an 800x600
logical viewport and RGB channels in 0..1. JS batches triangles into a WebGL draw.
`sound(id,pitch,gain)` requests a synthesized effect: pitch is a semitone offset
from 220 Hz, gain is 0..1, and zero gain is silent. `input(index)` returns:

| Index | Value |
| --- | --- |
| 0..3 | Left, right, up, down held (arrows/WASD) |
| 4 | Primary held (pointer/Space) |
| 5 | Primary pressed since previous simulation tick |
| 6..7 | Pointer x/y in logical coordinates |
| 8 | Pointer currently held |
| 9 | R restart pressed |

Sound IDs 0..4 select jump, pickup/stomp, loss, win arpeggio, and level transition.
The host supplies envelopes and pitch changes, caps simultaneous oscillator
voices at eight, and disconnects ended nodes. All effects use the same import;
there are no audio assets to package.

These imports return numbers. The compiler only includes functions/imports
reachable from the entry points. The host specializes to the imports present in
the module. All interop is deliberately small; shared-memory batching remains a
future comparison against this baseline.

## Fixed numeric arrays

Top-level arrays support literal lists, repeated initial values, indexing, and
the existing `while` loops:

```text
const ENEMY_COUNT = 3;
const enemy_x = [180, 420, 700];
global enemy_alive = [1; ENEMY_COUNT];

fn reset_enemies() {
  let i = 0;
  while (i < ENEMY_COUNT) {
    enemy_alive[i] = 1;
    i = i + 1;
  }
}
```

Elements are f32 in both backends, including native JS. Mutable arrays persist
between frames; `init` and restart code must reset them explicitly. Constant
arrays reject writes. Constant-index reads can inline values; runtime-indexed
arrays use WASM memory or JavaScript typed arrays. Scalar state still defaults
to WASM globals.

Indices evaluate once and must be finite integers in `[0,length)`. Invalid
constant indices fail compilation; invalid dynamic indices trap in WASM or
throw `RangeError` in JS. A write checks its index before evaluating its value.
Lengths must be compile-time nonnegative integers; total array elements are
limited to 65,536. Arrays cannot resize, nest, alias, or be passed/returned as
values. Locals and parameters can shadow array names as scalar values.

See [CONTENT_PLAN.md](CONTENT_PLAN.md) for the implementation contract and
[ARRAY_PLAN.md](ARRAY_PLAN.md) for the earlier unchecked experiment. Its sizes
are historical, rather than promises for checked indexing.

The immutable triangle-array packing experiment is described in
[PACKED_TRIANGLES.md](PACKED_TRIANGLES.md). It is enabled only for selected WASM
builds and leaves `compileJavaScript(source)` unchanged.
See [INTEGER_ARRAYS.md](INTEGER_ARRAYS.md) for exact byte/short storage and
the level-data cleanup.

`node tools/compare-wasm-opt.mjs` compares optimizer settings by complete ZIP
size and validates gameplay callbacks. Reports go under `output`. See
[WASM_SIZE.md](WASM_SIZE.md) for earlier measurements and remaining opportunities.

## Limits

This is a prototype, not a general compiler or game engine. WASM and the f32 JS
profile use single precision. Native JS uses double precision and native `%`;
rounding and collision timing can differ. Loops must terminate. Browser audio
requires a user gesture. Latest Chrome and Firefox remain the contest compatibility
target; validation evidence and outstanding coverage are recorded as development
progresses. The sample is a technical experiment, not a contest submission.

## Browser validation

`node tools/browser-check.mjs` runs generated output through installed Playwright
and browsers, checking GPU output, keyboard/pointer gameplay, restart, audio
gesture setup, and console errors. Playwright is a development tool and does not
ship with the game. Configure `SLIM_PLAYWRIGHT_MODULE` with its installed
`index.mjs` path when it is not locally resolvable. Optional executable overrides
are `SLIM_CHROMIUM_PATH` and `SLIM_FIREFOX_PATH`; Firefox automation requires a
Playwright-compatible Firefox build. Missing browser coverage fails by default;
`--allow-missing` records limited coverage explicitly. PNGs and `summary.json`
are written to `output/browser-check`.
