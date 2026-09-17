# Fixed arrays for Slim

Blockbound repeats ten enemy collision blocks, draw branches, alive flags, and
reset assignments. Terrain data repeats between collision and drawing. Rainbow
has similar repeated hazards and collectible flags. Fixed arrays are a useful
next language feature, but their representation should follow actual game sizes.

## Same-game comparison

Run `node tools/compare-enemy-arrays.mjs`. This isolated experiment patches
temporary copies of the compiler and JS backend; production language syntax,
game sources, and `dist` remain unchanged. Selected artifacts and a full report
are written to `output/array-study/runtime-comparison`.

Every profile uses the same keyboard-only host, archive filenames, minifier, and
ZIP settings. The tool measures plain/Oz WASM, embedded/external packaging, and
minified/unminified pages, then selects the smallest complete package.

| Blockbound | Existing globals | Shared helper / globals | Arrays / runtime loops |
| --- | ---: | ---: | ---: |
| Selected Oz WASM, raw | 13,539 B | 11,935 B | 11,639 B |
| Complete WASM ZIP | 5,770 B | 5,711 B | 5,637 B |
| Complete native JS ZIP | 5,146 B | 5,097 B | 5,060 B |
| Complete exact-f32 JS ZIP | 5,758 B | 5,699 B | 5,702 B |

The memory version loops over enemy reset, drawing, and collision. It preserves
one `before` feet snapshot per update, enemy order, alive writes before sound,
and continued collision checks after a loss. Array loads/stores compile directly
to WASM instructions; imports remain only triangle, sound, and input.

All candidates match the original draw/sound event sequence across 1,706 ticks:
full winning route, restart, hazard loss, and restart. Both plain and Oz WASM,
native JS, and exact-f32 JS are checked. This establishes behavior for the actual
game and hosts; it is not a benchmark of runtime speed or general array semantics.

The arrays occupy 120 bytes: 80 bytes of constant coordinates and 40 bytes of
mutable flags. The module retains 12 scalar globals instead of 22. Allocated
linear memory remains one 65,536-byte page, already present in the baseline.
These figures describe linear memory, not total engine memory consumption.

A separate exploratory update-only WAT loop saved raw WASM but increased its ZIP
by 40 bytes; dynamically indexed globals through dispatch increased it by 67
bytes. Converting the whole enemy data path matters. Those exploratory results
are not separate production profiles in the reproducible tool.

## Recommended first slice

Keep scalar state in mutable globals. Use fixed memory arrays for runtime-indexed
collections. In this game they save 133 bytes of WASM ZIP and 86 bytes of native
JS ZIP versus the original. The shared-helper global option remains slightly
smaller for exact-f32 JS. Earlier scalar-memory results do not decide array storage.

Start with one-dimensional top-level numeric arrays, literal lists and repeat
initializers, indexing, and existing `while` loops. No allocation, resizing,
references, slices, nesting, passing arrays, or returning arrays. Proposed syntax
(not implemented):

```text
const ENEMY_COUNT = 10;
const enemy_x = [550, 1140, 1540, 1780, 3400, 4385, 4765, 5400, 6000, 6420];
const enemy_y = [500, 404, 372, 372, 500, 404, 436, 500, 392, 500];
global enemy_alive = [1; ENEMY_COUNT];

fn update_enemies() {
  let before = player_y - player_vy;
  let i = 0;
  while (i < ENEMY_COUNT) {
    // One collision body uses enemy_x[i], enemy_y[i], enemy_alive[i].
    i = i + 1;
  }
}
```

Lengths resolve to finite nonnegative compile-time integers. Elements retain f32
semantics. Constant-index reads of constant arrays can inline literals; dynamic
reads require materialized data. Constant arrays reject writes. Mutable array
initial data is installed before `init`, and game reset remains explicit.

Before shipping dynamic indexing, define and test integer/index bounds behavior
consistently across WASM and JS. The experiment uses known-safe loop indices and
adds no bounds checks; its exact sizes are not a promise for a checked language
implementation. Resolve array names with the existing local shadowing rules.

Compile-time `unroll i in 0..COUNT` can follow as a separate small feature for
static geometry and tiny fixed sets. It needs immutable indices, half-open
ranges, hygienic body locals, and a total expansion limit. Flattening statically
indexed mutable arrays to globals can remain an optimization. Unrolling a large
body alone cleans source but duplicates output; shared functions avoid that.

## Implementation and validation

1. Add array declaration/index AST nodes and a shared semantic pass for lengths,
   constant data, immutability, bounds, and shadowing.
2. Allocate deterministic memory slots, emit initial data and direct loads/stores,
   and add matching fixed storage to the JS backend. Audit existing scalar-memory
   mode so layouts and data segments cannot overlap.
3. Refactor Blockbound's three enemy operations to one coordinate definition and
   loops, leaving terrain and other game behavior unchanged.
4. Test initialization, mutation, constants, index errors, evaluation order,
   f32 behavior, memory layout/page capacity, and both JS profiles. Retain the
   full winning/loss/restart replay on plain and optimized WASM.
5. Rebuild and compare complete ZIPs against this experiment; run `npm test`,
   syntax checks, and `git diff --check`. Keep normal builds at eight artifacts.

General array syntax is still planned. The committed comparison tool is the
reviewable proof for choosing its first storage backend.

The subsequent [WASM size review](WASM_SIZE.md) combines array loops with direct
branch conditions and separate array base offsets: Blockbound's complete WASM ZIP
falls to 5,516 bytes. This remains an isolated prototype with known-safe indices.
