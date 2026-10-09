# Exact integer array storage

This size experiment changes physical WASM storage without adding Slim types.
Authored arrays still contain f32 values, and JavaScript still emits normal
numeric arrays. Mutable physics state stays in f32 storage.

## Compiler contract

`compileDetailed(source, {integerArrayStorage: 'compact'})` chooses the narrowest
exact storage for immutable arrays: `u8`, `i8`, `u16`, or `i16`. Nonnegative data
uses unsigned storage. Fractions, negative zero, nonfinite values, and integers
outside these ranges use f32. Explicit triangle packing takes precedence.
The default is `integerArrayStorage: 'f32'`.

Static constant reads still inline. Dynamic reads retain the existing finite,
integer, and bounds checks and evaluate their index once. WASM narrow loads
convert the result to f32. No custom runtime decoder or JavaScript codec ships.
Combined layouts may be unaligned; inspect exported memory with `DataView`.
Physical byte offsets, allocated bytes, and page counts describe the chosen
storage, while logical lengths and the 65,536-element capacity remain unchanged.

## Release selection

`--release` compares f32 and compact integer storage alongside the triangle,
sound, optimizer, packaging, and minification choices. Each backend keeps its
smallest measured complete ZIP. Ties favor simpler representations; byte-identical compiler
variants are measured once. `--integer-arrays f32`, `compact`, or `auto` provides
an explicit override; ordinary builds default to f32. Normal output remains
eight source-named artifacts and one JavaScript profile.

## Game source cleanup

Shardbound replaces repeated spawn-height and start-position arrays with named
constants. A per-level boundary-array experiment visited only the current
level's terrain, enemies, gems, and hazards, preserving their original order.
It reduced data storage but increased both ZIPs, so production retains the
original level-ID loops and full reset behavior.

RGB-byte palettes are a separate lossy experiment and are not included here.

## Measured Shardbound results

Fresh builds on 2026-09-17 used exact triangle packing, Node 24.12.0,
Python 3.12.10, Binaryen 132, and Terser 5.43.1. Sizes include the complete
ZIP and archive overhead. JS keeps its normal numeric geometry representation.

| Variant | WASM ZIP | Selected raw WASM | Native JS ZIP | Allocated data |
| --- | ---: | ---: | ---: | ---: |
| Prior release | 6,691 B | 12,679 B | 6,573 B | 2,167 B |
| Compact integers only | 6,601 B | 12,013 B | 6,573 B | 1,389 B |
| Compact integers + constants (production) | 6,565 B | 11,800 B | 6,552 B | 1,370 B |
| Compact integers + constants + level ranges (experiment) | 6,609 B | 12,193 B | 6,634 B | 1,324 B |

Production saves 126 WASM ZIP bytes and 21 JS ZIP bytes. WASM selects compact
integer arrays, packed `ATLAS`, external WASM, and converged `-Oz`; the selected
sound format is `none`. Both backends select minified HTML. All variants still
use one 65,536-byte WASM memory page; allocated data is not total browser memory.

## Validation and search cost

All 91 tests passed after the final refinement. Signed/unsigned boundaries,
negative zero, fractions, NaN/infinity, overflow fallback, checked indexing,
side-effect order, mixed layouts, page boundaries, and logical capacity are
covered. Default compiler binaries and JS factories remain identical for the
saved original sources.

A 1,614-tick original-versus-production replay matches init, triangle, and sound
callbacks across eight WASM storage/packing combinations plus native and f32 JS.
The selected optimized release WASM also matches that trace. Selected WASM and
native JS pass Chrome 152 and Firefox 155 win/loss/restart, GPU, keyboard, and
audio-context setup checks.

At the integer-storage checkpoint, exhaustive search measured 246 candidates
and retained eight final artifacts. Release builds subsequently switched to
staged search; see [STAGED_SEARCH.md](STAGED_SEARCH.md) for the current order,
search cost, and limits. `--search exhaustive` retains the complete audit.
