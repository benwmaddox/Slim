# Slim v0

Goal: a small, standalone game language and size-first browser packager. This is
independent of Stasis. The acceptance artifact is a playable game in a standard
ZIP of at most 13,312 bytes, including archive overhead.

## First slice

- Dependency-free Node compiler directly emits WASM. Numeric globals, locals,
  functions, expressions, if/else, while, return. All source numbers are f32.
- No arrays, heap, GC, strings, reflection, dynamic dispatch, modules, or general
  vector paths in the initial language. Unsupported syntax must fail clearly.
- Triangle-only graphics: three 2D points and one RGB color. JS collects triangles
  and submits them to WebGL in one draw per simulation frame.
- JS sound synthesis and keyboard/pointer input, accessed through three compact
  WASM imports. This is a measurable baseline before designing a buffered ABI.
- Compare embedded WASM with a separate source-named WASM; select the smaller
  complete ZIP. A same-package fetch is allowed; there are no external resources.
- Fixed 60 Hz simulation with bounded catch-up. Focus loss clears input.
- A fresh Rainbow Run sample demonstrates game state, collision, scoring,
  restart, procedural sound, keyboard, and pointer controls.
- Deterministic ZIP and a size report. Compare unoptimized and optional Binaryen
  -Oz payloads using complete ZIP sizes, selecting the smallest.

## Validation

- `npm test`: instantiate real compiler output and observe behavior and imports.
- `npm run build`: compile the actual sample, validate WASM, generate HTML, ZIP,
  and size report; reject a package exceeding the budget.
- Browser acceptance: inspect actual generated package, keyboard/pointer input,
  restart, audio gesture, rendering, console errors, and screenshots in Chromium
  and Firefox when available. Report missing browser coverage plainly.
- Run build twice and compare ZIP hashes. Run `git diff --check`.

## Subsequent slices, conditional on measurements

### Side-scroller check: Blockbound

- Original faceted characters, each at most 50 solid-color triangles.
- Keyboard-only left/right, Space jump, R restart; no pointer gameplay code.
- A scrolling course loosely follows the introductory platformer progression:
  early blocks/enemy, rising obstacles, gaps, elevated platforms, stairs, finish.
- Simple bounded movement and collision on the existing numeric language; no
  compiler expansion or general physics engine.
- Check standing, jumping, collision, scrolling, enemies, loss/restart, and a
  complete deterministic keyboard route in JS and WASM.
- Measure complete selected ZIPs against 13,312 bytes and inspect real Chrome
  and Firefox output. Retain the eight final files for this source basename.

1. Improve diagnostics and language ergonomics based on the sample.
2. Compare triangle/input/sound shared-memory buffers with the direct-import
   baseline for package size and frame time.
3. Add fixed arrays only when a second game requires them.
4. Add reachability for state and host feature removal; compression experiments
   must preserve behavior and improve the final ZIP, not merely raw WASM size.

The comparison slice emits native JS and exact-f32 JS through the same browser
host, tool-generated WAT, source-named artifacts, and Terser variants. Choose
packaging by complete ZIP size; preserve readable sources separately.

The state-storage experiment translates Slim globals to fixed f32 memory slots
and compares raw WASM and complete ZIPs with identical hosts and archive names.
Both measured games favor mutable globals, which remain the production default.

No general optimizer or complex compiler framework is planned for v0. Build
dependencies do not ship. An existing compiler/runtime can be reused to create
new contest games; the example is a technical proof, not a contest submission.
