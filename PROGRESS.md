# Slim comparison checkpoint

Built independently of Stasis with Luna Max agents and a focused Sol medium review.
The same Slim source produces WASM, native JS, and exact-f32 JS through one browser
host. Rendering uses solid RGB triangles; gameplay includes collection, hazards,
win/loss, restart, keyboard/pointer controls, and procedural JS sound.

## Complete ZIP comparison

Measured with Node 24.12.0, Python 3.12.10, Binaryen 132, and Terser 5.43.1.
Values include archive entry overhead. All selected scripts are minified.

| Profile | ZIP bytes | Remaining from 13,312 |
| --- | ---: | ---: |
| Native JavaScript | 3,160 | 10,152 |
| Exact-f32 JavaScript | 3,519 | 9,793 |
| WASM -Oz, separate | 3,608 | 9,704 |
| WASM -Oz, embedded | 4,236 | 9,076 |

Native JS saves 448 bytes against WASM; exact-f32 JS saves 89. Embedding WASM
costs 628 bytes here. Native arithmetic uses doubles and native remainder, so
collision timing can differ. Exact-f32 JS matches WASM in the tested replay.

Both outputs need the JS graphics/audio/input host. JS likely benefits here from
whole-script minification, repeated compressible text, and avoiding the WASM
loader, binary structure, and second ZIP entry. More game logic may change the
result; throughput and larger-game crossover are not measured.

The WASM archive contains index.html and rainbow.wasm. JS archives contain only
index.html. JS, shaders, and styles are inline. No external dependencies ship.
Source-named HTML previews, readable JS factories, final selected WASM disassembly
(rainbow.wat), and rainbow.size.json are inspection artifacts. Original and
minified candidates are compared using actual ZIP sizes; this is not a claim of
globally optimal compression.

Dist now retains only eight selected WASM/native JS playable and inspection files.
Exact-f32 JS is opt-in with --compare-f32; normal builds remove its old outputs.
Candidate ZIPs and plain/Oz intermediates are temporary; measurements remain in the
size report. Successful builds clean obsolete candidates for the same source
basename while preserving other files.

Two fresh builds produced identical selected archives. SHA256:

```text
rainbow.zip      069B04C9D0E4937126150013610ADD98827C46F58F4F02173B6275C637329092
rainbow.js.zip   15275218B15D136BDB2F40D8CE9960FC7F7980BC943AB543FFB6F4BE19F5C324
rainbow.f32.zip  C9AE94DC4E9FB50CAD483F7EF66F8517AFBABD25E16C9BECE84F69786C56702C
```

## Validation

- Node tests exercise real WASM and JS semantics, host regressions, source naming,
  final WAT, archive entries, and deterministic packaging.
- A replay covers movement, collection, win, loss, restart, and 1,000 further
  ticks. Exact-f32 draw/sound events match WASM. Minification preserves both JS
  profiles; native coordinates are compared before collision divergence.
- The replay exposed and fixed a WASM opcode bug: remainder emitted f32.nearest
  instead of the documented f32.trunc calculation.
- Chrome 152.0.7977.83 and Playwright Firefox 155.0 passed all three profiles:
  GPU pixels, keyboard movement, pointer collection/win, pointer and R restart,
  audio context setup, and no console/page errors.
- Tested HTML/WASM match ZIP contents byte for byte. WAT reassembles with Binaryen
  wasm-as. Browser screenshots were visually inspected.
- Evidence: output/comparison-browser-check/summary.json and profile PNGs.
  Firefox automation requires host subprocess execution in this environment.

## Blockbound prototype

`examples/blockbound.slim` is a keyboard-only side-scroller with an original
faceted fox and beetles. Its 6,800-unit course follows a familiar introductory
platformer progression: early blocks, rising pillars, gaps, paired stairs, and a
final beacon. This is an approximate course, with original triangle artwork.

The fox emits 28 triangles in each tested pose and each beetle emits 13. Movement, variable-height
jumps, terrain collision, stomping, camera tracking, terminal states, and restart
are written in Slim. The keyboard-only host removes pointer handling.

Current minified archives are 5,146 bytes for native JavaScript and 5,770 bytes for
WASM with Binaryen Oz. The selected WASM is 13,539 bytes before ZIP compression.
Focused tests cover actual shape poses and both wall and ceiling collisions,
floor beneath floating blocks, stomping, falling, and restart. A 1,103-tick real
keyboard replay reaches the beacon in WASM, memory-state WASM, native JS, and
exact-f32 JS. The complete memory and exact-f32 draw/sound traces match default
WASM; at most 117 scene triangles were observed.

Chrome 152.0.7977.83 and Firefox 155.0 pass the generated WASM and native JS
packages: GPU pixels, movement, jump, ignored pointer input, complete course,
loss, and restart after both terminal states, with no browser errors. Initial,
course, and win screenshots were inspected. Evidence is under
`output/blockbound-browser-check`.

## WASM state storage

The optional `globalStorage: 'memory'` compiler mode translates every Slim global
to a fixed little-endian f32 slot in exported linear memory. It uses active data
for initial values and direct loads/stores; there is no allocator. Normal builds
continue to use mutable WASM globals.

| Source | Globals | Plain WASM, globals | Plain WASM, memory | Oz ZIP, globals | Oz ZIP, memory |
| --- | ---: | ---: | ---: | ---: | ---: |
| Rainbow | 21 | 4,251 B | 4,648 B | 3,608 B | 3,669 B |
| Blockbound | 22 | 15,329 B | 15,915 B | 5,770 B | 5,854 B |

Memory initializers need fewer bytes, but each access needs an address plus a
load/store instead of a compact global get/set. The complete optimized ZIP
comparison is recorded separately by `tools/compare-state.mjs` with identical
hosts and archive entry names.

For Blockbound, Oz emits 13,539 B with globals and 14,169 B with memory slots.
The complete minified external-WASM ZIPs are 5,770 B and 5,854 B respectively.
Globals save 84 B after compression and remain the production choice. The memory
mode is retained only for comparison.
Historical byte comparison against the preceding compiler confirms unchanged
default output for both games. Tests cover manual slot writes from JavaScript,
initial data, persistent mutation, local shadowing, f32 special values, and
layouts extending beyond the first 64 KB page. WAT uses the disassembler's output
without a readability pass.

## Language and runtime limits

No arrays, strings, heap, modules, or compound assignment. Function-scoped locals
start at zero. Approximate f32 remainder is for small game values. Authored loops
must terminate. Direct triangle imports remain the baseline; shared-memory
batching and throughput are not benchmarked. At most 42 triangles were observed.

Audio is placeholder 130 ms oscillator tones: pickup uses sine, collision square,
and win sine. Pitch is semitones from 220 Hz. Tests establish events and context
setup, not subjective quality or audible playback on every device. Audio needs a
gesture. No music yet.

The supplied rules require readable sources and top-level index.html. The requested
repository is private, with no project license. This is a technical experiment,
not a submitted contest entry.
