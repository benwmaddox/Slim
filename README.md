# Slim

A small experimental game language that compiles directly to WebAssembly, with
a triangle-only WebGL host, procedural JavaScript sound, and keyboard/pointer
input. Independent of Stasis. See [PLAN.md](PLAN.md) for scope and milestones.

The same source builds to WASM or JavaScript. See [PROGRESS.md](PROGRESS.md)
for ZIP comparisons, validation, and current limits.

## Build

Requires modern Node.js, Python 3, and Binaryen's `wasm-dis` for readable WAT.
Terser is a pinned build dependency; nothing from npm ships with the game.

```sh
npm ci
npm test
npm run build
```

Outputs follow the source basename: `rainbow.wasm`, `rainbow.wat`,
`rainbow.html`, and `rainbow.zip`. The build compares external WASM and external
minified JavaScript pages using complete ZIP sizes, including archive overhead.
The ZIP contains `index.html` plus the winning `.wasm` or `.js` payload; both
standalone HTML pages and the full minified script remain available to inspect.
The JavaScript page points to `rainbow.min.js`; `rainbow.js` remains the readable
generated game factory.

For a release build, add `--release` or run `npm run build:release`. This also
compares f32 and compact integer-array storage, plus plain, compact numeric,
and byte-string sound presets. Supply triangle
array names to compare their packed and unpacked WASM forms:

```sh
node tools/build.mjs examples/shardbound.slim --release --keyboard-only --pack-triangles ATLAS
```

Each backend keeps its smallest measured complete ZIP, then the smaller backend's
ZIP becomes `rainbow.zip`. Equal sizes favor simpler encodings. Release builds
default to staged search: change one setting at a time
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

`rainbow.js.html` loads the external, compressed and mangled browser script
`rainbow.min.js`. `rainbow.js` is its readable generated factory. The winning
ZIP uses `index.html` and `rainbow.js` when the JavaScript backend is smaller.
`--compare-f32` also emits `rainbow.f32.min.js` alongside the readable f32 factory.
`rainbow.size.json` records every candidate against the 13,312-byte target.
A game sets its page title and control hint with comment lines in its source,
`// title: Crate Shift` and `// footer: Arrows: move`; `--title TEXT` and
`--footer TEXT` override them. Without either, the title comes from the file
name and the host's default hint is used.
Only these eight final files are retained, plus three optional f32 inspection files.
Optimizer intermediates and packaging
candidates are measured in a temporary directory and discarded. Successful builds
also remove obsolete candidate files for the current source basename.

For numeric comparisons, `npm run build -- --compare-f32` additionally emits
`rainbow.f32.js`, `rainbow.f32.min.js`, and `rainbow.f32.html`. Normal builds
remove these optional outputs. To browser-check that comparison, pass
`--profiles=wasm,js-native,js-f32` to `tools/browser-check.mjs`.
Archives use top-level `index.html` and only the selected backend's payload.
Inspection artifacts and development dependencies are excluded.

Serve the selected output with `python -m http.server 8000 --directory dist`,
then open `http://localhost:8000/rainbow.html` or `rainbow.js.html`. Both
standalone pages load their external payload beside them.

Optional: put Binaryen's `wasm-opt` on PATH, or set `SLIM_WASM_OPT` to its
executable. Set `SLIM_WASM_DIS` if the disassembler is not on PATH. The build
compares plain, `-Oz`, `-Os`, `-O4`, and `-Oz --converge` output for external WASM
packages. Set `SLIM_PYTHON` if Python uses
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

## Puzzle example: Crate Shift

```sh
npm run build:boxpush
```

Crate Shift is a six-level push-only puzzle. Move with the arrows or WASD and
push crates onto the gold diamonds; crates can only be pushed, never pulled, and
only one at a time. Space undoes the last move (hold it to keep undoing), R
restarts the level, and Space also continues after a clear. The counter at the
top left shows moves taken; clearing a level awards one to three stars against a
reference solution and remembers your best finish for the session. A crate
pushed into a corner it can never leave throbs red, so a dead end is obvious.
The game opens on a level-select screen: arrows move a gliding cursor between
the six cards, Space opens an unlocked level, and Esc or M returns to the menu
from play. Each card shows the level name, your best stars and best moves, and
levels unlock in order as you clear them. The names and messages are browser text
from `// text:` lines (see Browser boundary).
The source is [examples/boxpush.slim](examples/boxpush.slim); each level is a
flat 9x8 grid with its ASCII layout kept in comments.

Everything that moves is animated without changing game logic: levels drop in as
a diagonal wave that dips and settles, the porter glides with an ease-out and a
parabolic hop (crates slide with them, undo slides them back), dust puffs kick up
at each step, a blocked move shakes, a crate landing on a target sends out a
ring, and a cleared level jolts the view, drops in a bouncing panel, pops the
stars, and throws confetti. The backdrop has twinkling stars, banded sky and
vignette, and every tile casts a shadow.

The look deliberately mixes shapes. Rectangles (two triangles each) form the base
of the board, diamonds mark targets and pips, and true triangles carry the rest:
mitred bevels and diagonal facets on floors, walls, and crates, the porter's
pointed cap, chamfered menu cards with triangular cursor brackets, five-pointed
stars made of ten triangles, large slow shards drifting behind the board, and a
pool of 56 spinning shards thrown out when a crate is pushed, lands on a target,
or a level is cleared. In the test measurements a playing frame is roughly 57%
rectangles, 10% diamonds and 33% lone triangles, and a cleared level about 42%
triangles. Game state changes instantly; the
animation timers only decide how far drawing lags behind, so input is never
delayed.

`tools/boxpush-solver.mjs` is an independent breadth-first solver (fewest
pushes). `tests/boxpush.test.mjs` decodes the levels straight out of the Slim
source, proves each is solvable, and replays every solution through real input
in WASM, native JS, and f32 JS until the win screen. Solutions need 3, 8, 12, 20,
26, and 35 pushes. The same tests check undo, stars, the stuck-crate warning, and
the animation timing. Levels 4 to 6 came from hill-climbing random layouts toward
more pushes with the same solver.

## Procedural animals example

```sh
npm run build:critters
```

Critters is a small procedural-animation simulation inspired by Argonaut’s
chain technique. Three autonomous animals use fixed arrays of joints: a snake,
a lizard with alternating legs, and a beetle with a six-leg gait. Each link
follows its predecessor toward a target distance using compact Manhattan
normalization; overlapping triangle discs and bars form the silhouettes. Space
cycles the highlighted animal and R resets the deterministic walk. The source
is [examples/critters.slim](examples/critters.slim), and the release output is
written as the usual source-named files under `dist/`.

### Blog SVG replay

The same deterministic triangle stream can be exported as a standalone,
animated SVG for a short blog replay:

```sh
npm run export:svg
```

This writes `dist/critters.svg` and an optional `dist/critters.svg.gz`. The
exporter samples the WASM game, leaves static triangles as ordinary polygons,
factors pure translations into compact SVG/SMIL `animateTransform` elements,
aligns conditional draw calls by their export-only call-site identity, and uses
`points` animations for deforming triangle slots. The default is four
seconds at eight samples per second with two-pixel coordinate quantization;
increase `--quantize` for a smaller file or lower it for smoother geometry:

```sh
node tools/export-svg.mjs examples/critters.slim --out dist/critters.svg \
  --seconds 6 --fps 12 --quantize 1 --gzip
```

Games can mark contiguous draw calls with an export-only group marker:

```slim
svg_group(12);
draw_body();
svg_group(0);
```

The SVG exporter records those markers and, when the triangles move as one
rigid part, emits a shared translate/rotate/scale animation for the group.
Deforming groups automatically fall back to per-triangle animation. Normal
compiles and release builds strip `svg_group` calls completely, so the marker
does not add a runtime import or release bytes. In a loop, include the instance
index in the marker (for example, `svg_group(100 + i)`) so objects that enter
or leave the viewport keep their own animation slot. Visibility changes use
discrete opacity, which keeps a new object from interpolating out of the
placeholder origin.

For games that need interaction to show useful motion, pass a JSON input
schedule with one frame per sample. Each frame can be an array or a sparse
object keyed by Slim input index; omitted values are zero:

```json
[{}, {"4": 1}, {}, {"2": 1}]
```

```sh
node tools/export-svg.mjs examples/game.slim --inputs replay.json --gzip
```

The SVG is self-contained and can be embedded with an ordinary blog image
element. It does not need the Slim runtime, WASM, JavaScript, or a video
player. Ungrouped and deforming triangles remain frame-faithful; marked rigid
groups use shared transforms so their repeated motion is compact. For a blog
post, the embedding can stay as simple as:

```html
<img src="critters.svg" alt="Animated low-poly critters">
```

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
initializers. Locals are block scoped and start at zero on each call; see
[Locals and scope](#locals-and-scope).
There are local `let` declarations, assignments, `if/else`, `while`, `return`
(or a bare `return;`, which yields 0), function calls, arithmetic, comparisons,
and short-circuit logical expressions.
Comparisons and logical expressions produce numeric 0 or 1. Arithmetic and
constant initializers round at each f32 operation. `%` is implemented as
`x - trunc(x / y) * y`, with f32 rounding; it is intended for small game values
and can lose precision for large quotients. Fixed numeric arrays are described
below. There are no strings, allocation, classes, or modules. WASM is emitted directly; no C,
Rust, LLVM, or language runtime is required to build a game.

## Locals and scope

A `let` is visible from its declaration to the end of the block it is in. Sibling
blocks (the bodies of two loops, or the two arms of an `if`) can each declare a
local with the same name. Redeclaring a name that is already visible, whether a
parameter or a local from an enclosing block, is an error. A local named like a
global, array, or constant shadows it only inside its block, and a use before the
`let` still refers to the global. The frontend gives each declaration a unique
internal name, so both backends keep a flat local layout and generated code does
not change.

```text
fn frame() {
  let i = 0;
  while (i < 3) {
    let x = i * 10;   // this x ...
    i = i + 1;
  }
  if (i == 3) {
    let x = 7;        // ... and this x do not conflict
  }
}
```

## Math builtins

These are available without declaring them, and their names are reserved.

| Builtin | Meaning | WASM |
| --- | --- | --- |
| `floor(x)`, `ceil(x)`, `trunc(x)` | round down, up, or toward zero | one f32 instruction |
| `abs(x)`, `sqrt(x)` | absolute value, square root | one f32 instruction |
| `min(a, b)`, `max(a, b)` | smaller or larger | one f32 instruction |
| `sin(x)`, `cos(x)`, `atan2(y, x)`, `pow(x, y)` | JavaScript `Math` functions | imported from the host |

JavaScript output calls `Math.floor`, `Math.sin`, and so on directly. In WASM the
first group needs no import; the second group adds an import only when the game
uses it, and the browser host forwards it to `Math`. Integer division is
`floor(a / b)` and a cell's row in a flat grid is `floor(index / width)`.
`round` is left out on purpose: `Math.round` rounds halves up while `f32.nearest`
rounds them to even, so the backends would disagree. Native JS keeps `Math`'s
double result for `sin` and friends while WASM stores f32, like the rest of the
native-versus-f32 differences described under Limits.

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
and locals may shadow a constant inside their scope.
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
| 10 | Esc or M pressed since previous simulation tick |

Sound IDs 0..4 select jump, pickup/stomp, loss, win arpeggio, and level transition.
The host supplies envelopes and pitch changes, caps simultaneous oscillator
voices at eight, and disconnects ended nodes. All effects use the same import;
there are no audio assets to package.

`text(id,x,y,size,tone)` draws a line of browser text centered at (x, y) in the
same 800x600 space, with `size` in logical pixels and `tone` 0 white, 1 gold,
2 green, 3 muted. The strings are not in the program: each `// text: ...` line
of the source becomes `<template id=t0>`, `t1`, ... in the page, and `id` is the
position in that list. The host reads a template once, caches it, and draws on a
transparent 2D canvas stacked over the WebGL one. That overlay is sized to the
displayed canvas times the device pixel ratio, so text stays sharp at any scale,
and it is cleared before every simulation tick like the triangle buffer. A page
only gets the overlay and templates when the game calls `text`; a game that calls
it with no `// text:` lines fails to build. In measurements on Crate Shift the
whole mechanism costs about 350 zipped bytes, plus roughly 10 per string.

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
