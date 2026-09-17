# Slim v0 checkpoint

Implemented with Luna Max agents in a standalone repository. PLAN.md records
the first slice; compiler, host, game, and validation had separate ownership.

Working: direct WASM emission, mutable f32 state, functions, conditionals,
loops, short-circuit logic, reachability pruning, diagnostics, solid RGB
triangles, keyboard/pointer input, fixed ticks, JS sound events, and a complete
Rainbow Run sample with collection, hazards, win/loss, and restart.

## Size

Values include the complete ZIP and entry overhead.

| WASM optimization | Packaging | ZIP bytes |
| --- | --- | ---: |
| Binaryen -Oz | Separate WASM | 3,753 |
| None | Separate WASM | 3,826 |
| Binaryen -Oz | Embedded WASM | 4,375 |
| None | Embedded WASM | 4,415 |

The selected package leaves 9,559 bytes under 13,312. Embedding costs 622 more
bytes. The archive contains exactly `index.html` and `game.wasm`; JS, shaders,
and styles are inline. WASM is 3,939 bytes before ZIP compression. Separate WASM
needs HTTP; embedded variants support direct file opening.

Two fresh builds with the same toolchain produced ZIP SHA256
`3D100B6985E0001DCC00986D298F870DC0E36EEF1522F661BA80EC1415A5B3F3`.
Measured with Node 24.12.0, Python 3.12.10, and Binaryen 132.

## Validation

- 16 persistent Node tests cover real WASM semantics, sample gameplay, host
  regressions, and deterministic packaging.
- Installed Chrome 152.0.7977.83 and Playwright Firefox 155.0 passed GPU pixels,
  keyboard movement, pointer collection/win, pointer restart, R restart, audio
  context creation, and no console/page errors.
- Tested HTML/WASM match ZIP contents byte for byte.
- Initial probe failures came from reading after presentation and wrong color
  offsets; the corrected probe reads inside the draw callback.
- Firefox subprocesses required host execution outside the local sandbox. Its
  test browser is in ignored `output/browsers`, not the shipped game.

## Limits and next work

All values are f32; locals are function-scoped. No arrays, strings, heap,
modules, or compound assignment. Approximate `%` is for small game values.
Sound is placeholder 130 ms tones; tests establish event/node/context behavior,
not subjective quality or audible playback on every device.

Direct triangle imports remain the baseline. Shared-memory batching and
throughput are not benchmarked; the sample observes at most 42 triangles.
There is no equivalent JavaScript size baseline yet: this establishes feasibility,
not that WASM is smallest for every game. Next slice: fixed-capacity arrays and
a second game with more entities, followed by measured ABI/packing comparisons.

Visual evidence: inspected `output/final-browser-check/chromium.png` and
`output/final-browser-check/firefox.png`. Both show the restarted game with
triangle geometry, player, collectibles, and hazards; results are in `summary.json`.
