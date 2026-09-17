# Compact 2D content plan

This implementation follows the measured array and WASM studies. Production
features should remain small and support both JS and WASM.

The measurements below record the first array/content checkpoint with an
unpacked atlas. See [PACKED_TRIANGLES.md](PACKED_TRIANGLES.md) for the subsequent
WASM packing experiment and current Shardbound build sizes.

## Scope and ownership

- Compiler: fixed one-dimensional top-level f32 arrays, literal/repeat initializers,
  persistent memory, checked indexing, shared frontend semantics, and direct i32
  branch conditions. No heap, array references, aliases, nesting, or generic types.
- Audio host: distinct procedural jump, pickup/stomp, loss, win, and transition
  sounds through the existing three-number import, with envelopes and bounded voices.
- Shardbound: three original keyboard platforming levels, pooled enemies with
  different behavior, collectibles, shared terrain data, and reusable mesh parts.
- Character refinement: Astra low after the initial Luna design, with readable
  silhouettes and at most 50 triangles per character pose.
- Integration: source-named builds, optimizer selection by ZIP size, browser replay,
  current documentation, and retirement of superseded prototype patch tools.

## Array contract

Arrays contain f32 elements. Dynamic indices evaluate once, must be finite integer
values in [0,length), and reject invalid values: WASM traps, JS throws RangeError.
Negative zero selects element zero. Statically invalid indices are compile errors.
Array writes evaluate/check the index before the value expression. Constant arrays
reject writes; arrays cannot be passed or returned as values. Function-wide scalar
locals and parameters retain shadowing rules. Total array elements are capped at
65,536; the compiler must audit combined scalar-memory and array layouts.

## Acceptance and validation

- Existing Rainbow and Blockbound behavior and complete keyboard replay remain valid.
- New game is playable across all three levels in native JS, f32 JS, and WASM.
- Plain and optimized WASM match f32 JS callbacks on a full real-input replay.
- Character poses emit at most 50 triangles with finite geometry and valid colors.
- Audio event tests verify envelopes and cleanup; browser checks verify setup.
- Both complete new-game ZIPs fit 13,312 bytes. Generated files remain untracked.
- `npm test`, syntax checks, fresh builds, browser checks, and `git diff --check` pass.

## Delivered checkpoint

Luna Max implemented the compiler, JS backend, sound host, and game; Astra low
refined the character atlas after the first art pass. A Sol medium review checked
array semantics and layout independently.

Shardbound has three levels, two enemy behaviors, collectible shards, hazards,
level transitions, win/loss, and restart. Its fox uses 30 triangles per pose;
beetles use 12 and flies 11. Shared terrain drives both collision and drawing.
The atlas uses reusable translated, scaled, flipped, and posed parts. Five sound
presets use the existing three-number import, envelopes, eight bounded voices,
and ended-node cleanup. No runtime dependencies or separate assets ship.

Complete ZIP measurements with Node 24.12.0, Python 3.12.10, Binaryen 132,
and Terser 5.43.1:

| Game | Native JS | WASM | Selected WASM optimizer |
| --- | ---: | ---: | --- |
| Rainbow | 3,628 B | 4,056 B | O4 |
| Blockbound | 5,636 B | 6,117 B | Os |
| Shardbound | 6,573 B | 6,819 B | Oz + converge |

Selected scripts are minified; WASM packages use external source-named modules.
Normal builds compare plain, Oz, Os, O4, and converged Oz across both packaging
layouts and retain eight files with one JS profile. WAT is raw Binaryen output.
The old temporary compiler-patching tools are retired; their measurements remain
historical in ARRAY_PLAN.md and WASM_SIZE.md.

Shardbound uses 3,452 bytes of array storage within one 65,536-byte WASM page.
Scalar globals remain the default: the same-game Oz scalar-memory comparison
costs 35 additional ZIP bytes (6,882 versus 6,847). This counts linear memory,
rather than total browser memory. Richer sound costs about 470–490 complete ZIP
bytes in the control games. Short decimal array initializers round to the same
f32 bits and avoid unnecessarily long JavaScript data literals.

## Validation and limits

- `npm test`: 67 tests pass, including array errors/effects, combined capacity,
  page offsets, constant replacement, and 138 DataView-derived f32 data cases.
- Real keyboard winning replay: 1,012 ticks across all three levels, then
  restart, walking loss, and restart. Default WASM, scalar-memory WASM, native
  JS, and exact-f32 JS win; f32 callbacks match WASM.
- Nine optimizer profiles per game preserve imports, exports, page counts, and
  callback traces: 663 Rainbow, 1,706 Blockbound, and 1,614 Shardbound ticks.
  Platformer traces also assert win and loss markers.
- JS and selected WASM pass Chrome 152 and Firefox 155 gameplay/GPU/restart/audio
  setup checks. Firefox runs on the host because sandbox page creation fails.
  Runtime character/level captures were visually checked at gameplay scale.

Arrays remain fixed numeric data without references, nesting, heap allocation,
or resizing. Native scalar JS arithmetic can differ from f32 WASM even though
both tested routes win. Runtime speed and total engine memory are not benchmarked.
This is a size and authoring prototype, rather than a contest submission.

Reproduce with `npm test`, `npm run build:shardbound`, and
`node tools/browser-check.mjs --source=shardbound`. Optimizer and scalar-storage
studies use `node tools/compare-wasm-opt.mjs` and
`node tools/compare-state.mjs examples/shardbound.slim --keyboard-only`.
