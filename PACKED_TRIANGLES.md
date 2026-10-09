# Packed triangle arrays

Slim has a small WASM-only packing experiment for immutable arrays that hold
triangle records. Enable it from the compiler with

```js
compileDetailed(source, {packedTriangleArrays: ['ATLAS']});
```

or from the build CLI. The flag is repeatable; comma-separated names are also
accepted:

```sh
node tools/build.mjs examples/shardbound.slim --keyboard-only --pack-triangles ATLAS
node tools/build.mjs examples/shardbound.slim --release --keyboard-only --pack-triangles ATLAS
```

`npm run build:shardbound` supplies `--release --pack-triangles ATLAS` by default.
Release builds compare unpacked and packed WASM candidates by complete ZIP size.
Without `--release`, `--pack-triangles` forces the selected encoding for testing.
The JavaScript backend does not receive this option and continues to emit its normal
numeric `Float32Array` representation. This keeps the JS artifact and archive
byte-identical between the unpacked and packed builds when the source and host
options are the same.

If byte packing cannot represent a requested array, release builds record the
skipped candidate and retain the unpacked version. Forced packing still fails.
Unknown array names remain errors in both modes. The size report distinguishes
requested arrays from the arrays packed in the selected WASM artifact; its
compiler layout always describes that selected artifact.

The logical array stride is nine f32 values per triangle:

```text
x1, y1, x2, y2, x3, y3, r, g, b
```

The packed WASM representation stores each triangle as seven bytes: six signed
i8 coordinate values followed by one u8 palette index. Coordinates are required
to be finite integer values in the signed i8 range; unsupported coordinate forms
or values fail compilation instead of being quantized. Colors are deduplicated
by their exact f32 values and remain a 12-byte f32 RGB palette entry, preserving
the first experiment's exact appearance. The physical size is therefore
`triangleCount * 7 + paletteSize * 12`.

Arrays must be immutable, have a length divisible by nine, and use no more than
256 distinct colors. Negative-zero coordinates are rejected because signed
bytes cannot preserve their sign; negative-zero array indices still select zero.

`arrayLayout` in `*.size.json` retains the structural packing metadata, including
the `triangles-i8-palette-f32` encoding, triangle and palette counts, physical
byte length, and `paletteOffset` when a palette is materialized. `allocatedBytes`
and `memoryPages` use that physical layout. Unpacked arrays retain their ordinary
f32 storage and metadata. Packed layouts can leave the palette and subsequent
f32 arrays unaligned. WASM supports these accesses; use `DataView` to inspect
their values through the reported byte offsets.

To measure the same source in separate ignored directories, run:

```sh
node tools/build.mjs examples/shardbound.slim --keyboard-only --out-dir output/packed-triangles/baseline
node tools/build.mjs examples/shardbound.slim --keyboard-only --pack-triangles ATLAS --out-dir output/packed-triangles/packed
```

Compare the two `shardbound.size.json` files. Report `selectedWasm.zipBytes`,
`selectedWasm.wasmBytes` (raw WASM), `selectedJs.zipBytes`,
`compiler.allocatedBytes` / `compiler.memoryPages`, and
`selectedWasm.optimization`; the candidate list contains the corresponding
plain and Binaryen optimizer measurements. Set `SLIM_WASM_OPT` or put
`wasm-opt` on `PATH` to include the optimizer candidates.

The Shardbound comparison on 2026-09-17 selected `Oz-converge` for both WASM
builds. Packing reduced the selected WASM ZIP by 128 bytes, the selected raw
WASM by 1,258 bytes, and allocated linear-memory data by 1,285 bytes. The JS
artifact and archive stayed byte-identical:

| Build | Selected WASM ZIP | Selected raw WASM | Native JS ZIP | Allocated memory | Pages | Optimizer |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Baseline | 6,819 B | 13,937 B | 6,573 B | 3,452 B | 1 | `Oz-converge` |
| Packed `ATLAS` | 6,691 B | 12,679 B | 6,573 B | 2,167 B | 1 | `Oz-converge` |

`tools/compare-wasm-opt.mjs` includes unpacked and packed Shardbound controls in
its callback and optimizer comparison, and `tools/compare-state.mjs` accepts the
same `--pack-triangles NAME` option for state-storage comparisons.

At the initial packing checkpoint, all 76 tests passed. Packed and unpacked WASM produce identical
triangle and sound callbacks across the 1,614-tick winning/loss/restart trace.
All nine optimizer profiles preserve that behavior. Selected WASM and unchanged
native JS pass Chrome and Firefox gameplay checks, and the eight normal dist
artifacts match the browser-tested build.

Release builds also compare exact integer storage for other immutable arrays.
See [INTEGER_ARRAYS.md](INTEGER_ARRAYS.md) for the subsequent measurements.
