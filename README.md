# Slim

A small experimental game language that compiles directly to WebAssembly, with
a triangle-only WebGL host, procedural JavaScript sound, and keyboard/pointer
input. Independent of Stasis. See [PLAN.md](PLAN.md) for scope and milestones.

The first playable checkpoint is 3,753 bytes zipped. See [PROGRESS.md](PROGRESS.md)
for measurements, validation, and current limits.

## Build

Requires modern Node.js and Python 3. There are no npm dependencies.

```sh
npm test
npm run build
```

The playable submission is `dist/game.zip`. The build compares embedded and
separate WASM layouts, including archive overhead, and selects the smaller
package. JavaScript, shaders, and styles are inline in `index.html`; a separate
layout also contains `game.wasm`. Other files in `dist` are inspection/build
artifacts and are not added to the submitted ZIP. `dist/size.json` reports total
archive bytes against the 13,312-byte target.

Serve the selected output with `python -m http.server 8000 --directory dist`,
then open `http://localhost:8000/`. Separate WASM needs HTTP because browsers
restrict file URL fetching. The `*-embedded.zip` variants are self-contained
and can be opened directly after extraction.

Optional: put Binaryen's `wasm-opt` on PATH, or set `SLIM_WASM_OPT` to its
executable. The build compares plain and `-Oz` output across both packaging
layouts and selects the smallest complete ZIP. Set `SLIM_PYTHON` if Python uses
a different command name. An explicitly configured optimizer failure aborts
the build.

## Initial language

```text
global x = 100;
fn init() { x = 100; }
fn frame() {
  x = x + input(1) - input(0);
  tri(x, 100, x + 20, 100, x, 120, 1, 0, 0);
}
```

Numbers, parameters, globals, locals, and function results are f32. Functions
without a return produce zero. Both `init` and `frame` must be declared and take
zero arguments. Globals are mutable persistent game state, with constant numeric
initializers. Locals are function-scoped in v0 and start at zero on each call.
There are local `let` declarations, assignments, `if/else`, `while`, `return`,
function calls, arithmetic, comparisons, and short-circuit logical expressions.
Comparisons and logical expressions produce numeric 0 or 1. Arithmetic and
constant initializers round at each f32 operation. `%` is implemented as
`x - trunc(x / y) * y`, with f32 rounding; it is intended for small game values
and can lose precision for large quotients. No arrays,
strings, allocation, classes, or modules yet. WASM is emitted directly; no C,
Rust, LLVM, or language runtime is required to build a game.

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

These imports return numbers. The compiler only includes functions/imports
reachable from the entry points. The host specializes to the imports present in
the module. All interop is deliberately small; shared-memory batching remains a
future comparison against this baseline.

## Limits

This is a prototype, not a general compiler or game engine. All source arithmetic
uses single precision. Loops are authored code and must terminate. Browser audio
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
