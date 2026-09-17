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

## Limits

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
