# WASM size review

The production build already compares plain WASM with `wasm-opt -Oz` and selects
by complete ZIP size. This review uses Binaryen 132 and fresh compiler output.
The experiments leave production sources, compiler behavior, and `dist` unchanged.

## Measurements

All ZIPs include the same minified game host and source-named external WASM.
The optimizer matrix also tests embedded packaging; external wins in these games.

| Blockbound variant | Raw WASM | Complete ZIP |
| --- | ---: | ---: |
| Current compiler, plain | 15,329 B | 5,852 B |
| Current compiler, `-Oz` | 13,539 B | 5,770 B |
| Current compiler, `-Os` | 13,595 B | 5,766 B |
| Direct branch conditions, `-Oz` | 10,228 B | 5,633 B |
| Memory arrays / loops, `-Oz` | 11,639 B | 5,637 B |
| Arrays / loops + direct conditions, `-Oz` | 8,973 B | 5,521 B |
| Combined + separate array base offsets, `-Oz` | 8,925 B | 5,516 B |

The strongest combined prototype saves 254 ZIP bytes (4.4%) versus the current
`-Oz` build. Raw savings are much larger because repeated instructions compress
well. The arrays occupy 120 bytes within the existing 65,536-byte memory page.

| Rainbow variant | Raw WASM | Complete ZIP |
| --- | ---: | ---: |
| Current compiler, plain | 4,251 B | 3,681 B |
| Current compiler, `-Oz` | 3,939 B | 3,608 B |
| Current compiler, `-O4` | 3,997 B | 3,600 B |
| Direct branch conditions, `-Oz` | 3,462 B | 3,585 B |

`-O4` wins over `-Oz` for Rainbow's ZIP despite producing larger raw WASM. For
Blockbound, `-Os` saves four ZIP bytes. Convergence and shrink-level variants offer
no useful additional savings here. Adding flatten/rereloop and other passes after
`-Oz` made both games substantially larger. There is no universal smallest flag.

## Clean compiler opportunity

Current branch emission first converts comparison results from i32 to f32, then
compares that numeric boolean against zero. Optimized Blockbound WAT still contains
374 such conversions; Rainbow has 61. The prototype emits direct i32 conditions
for comparisons, logical negation, and short-circuit `&&` / `||`. Arbitrary numeric
conditions retain the existing `value != 0` rule. Value expressions still produce
f32 numeric booleans. This removes all 374 conversions from optimized Blockbound.

The array experiment originally indexed one flat data area with `i + 10` and
`i + 20`. Giving x, y, and alive arrays their own fixed base offsets avoids those
f32 additions before conversion to an integer address. The same array layout and
known integer loop indices are retained. This saves another 48 raw / five ZIP bytes.
It is not a general rewrite of arbitrary floating-point index arithmetic.

## Other opportunities and limits

- Blockbound's optimized code section is 13,198 bytes, about 97% of its module.
  Imports occupy 29 bytes and exports 25 bytes. No shipped debug names or compiler
  metadata remain to trim. Function sharing matters more than headers.
- Before optimization, `surface()` is the largest function at 3,605 bytes, followed
  by `hero()` at 2,210 and `update_enemies()` at 2,126. Shared terrain data for surface
  queries, solid collision, and drawing is the next useful same-game experiment.
- Internal procedure results are already removed by `-Oz`. Integer-convert
  constants, zero locals, and immutable global constants fold back to `f32.const`.
  These tricks offer no demonstrated saving after optimization.
- Triangle and sound imports retain f32 results and discarded statement results.
  Usage-sensitive void imports could remove drops, but change the ABI and need
  value-position calls preserved. Measure before adding that complexity.
- Removing unused memory from globals-only modules saved 13 ZIP bytes for Rainbow
  and 15 for Blockbound in a header-only prototype, plus the unused memory page.
  Removing its export before reoptimization can also help memory-using modules a
  little. Current tests expose memory deliberately; leave that contract unchanged
  during this review. Arrays still require a memory page.
- Compact mesh data or palette indices could replace repeated triangle-building
  code, but introduce decode/render code. Their net saving requires measurement.
- These prototypes use known-safe array loop indices. General array index checks
  are not implemented, so measured sizes are not promises for a checked language.
  Runtime speed and total engine memory consumption are not benchmarked.

## Reproduction and validation

```text
node tools/compare-enemy-arrays.mjs
node tools/compare-wasm-opt.mjs
node tools/compare-wasm-conditions.mjs
```

The first command refreshes the optional memory-loop optimizer seed. The optimizer
matrix compiles fresh production sources, runs nine bounded profiles per game,
checks imports/exports/pages and callback parity, and compares embedded/external
minified packages. Its optional loop seed is identified as already optimized and
checked against fresh production game callbacks.

The condition study patches temporary compiler copies and compiles every profile
fresh. Plain and optimized variants match 600 mixed pointer/keyboard Rainbow ticks
and the complete 1,706-tick Blockbound winning/loss/restart trace. Synthetic cases
cover nested logic, import effects, NaN truth, and signed zero. Repeated runs produce
stable ZIP hashes. The existing 47 tests pass. Syntax and diff checks pass.

Reports and raw tool-generated WAT are under `output/wasm-opt-study` and
`output/wasm-condition-study`. No WAT readability pass or runtime dependency is added.

Recommendation: first retain direct condition emission, then implement fixed arrays
with runtime loops and separate base offsets. Continue selecting optimizers by
complete ZIP size. Keep larger ABI/rendering experiments separate.
