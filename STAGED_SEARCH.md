# Staged release search

Release builds compare one setting at a time by complete ZIP size. Each trial
runs JS/HTML minification and compares the original and minified page. The build
retains the smallest measured candidate; ties use the existing preference for
simpler encodings and stable candidate IDs.

## Order

Start with plain WASM, external placement, and the first allowed triangle,
integer-array, and sound formats. Compare these settings in order:

1. WASM optimizer: plain, Oz, Os, O4, converged Oz (when wasm-opt is available).
2. Placement: external or embedded WASM.
3. Triangles: unpacked or the requested packed arrays.
4. Integer arrays: f32 or exact compact storage.
5. Sounds: original, compact numbers, or bytes.

Each stage holds the other settings at the current winner. A second pass
rechecks the same settings for interactions. Stop after an unchanged pass or
two passes. Forced format flags restrict the available choices. Sources without
sound imports and byte-identical integer encodings avoid redundant trials.

Optimized modules are cached by triangle format, integer format, and optimizer.
HTML/ZIP trials are cached by the complete setting tuple, so revisiting a
candidate does not rebuild it. Native JS and optional f32 JS each compile once
and compare their allowed sound formats independently.

## Commands and reports

`--release` defaults to staged search. Ordinary builds keep exhaustive search
for compatibility. `--search staged` or `--search exhaustive` overrides either
default. For an occasional complete audit:

```sh
node tools/build.mjs examples/shardbound.slim --release --keyboard-only --pack-triangles ATLAS --search exhaustive --out-dir output/search-audit
```

The version 6 size report records `search`, visited candidates, and
`searchStages`: phase, pass, prior/selected candidate IDs, ZIP size, saving, and
trial IDs. Compiler layout metadata describes the selected WASM. The usual eight
source-named artifacts remain; all trial archives are temporary.

## Limit

Staged search finds the best candidate it visits, rather than guaranteeing the
minimum over every combination. Several settings can jointly improve the ZIP
while each separate change loses. The two-pass bound can also stop before every
interaction settles. Use exhaustive search when auditing the absolute minimum
within the available formats, optimizer profiles, and placements.

## Shardbound measurement

On 2026-09-17, the default staged release visited 38 candidates instead of the
previous exhaustive build's 246 (32 WASM pages and 6 native JS pages). Both
selected ZIP sizes stayed unchanged: 6,565 bytes for WASM and 6,552 bytes for JS.
All seven game artifacts were byte-identical to the previous browser-tested
winners; only the size report changed.

The first pass saved 702 ZIP bytes through WASM optimization, 125 through triangle
packing, and 101 through compact integer arrays. External placement and original
sound code won. The second pass kept the same winner. These results describe
this game and toolchain; they do not guarantee that staged search matches every
future exhaustive audit.

Validation: all 96 tests passed, including search normalization, second-pass
interactions, exhaustive opt-in, forced modes, output preservation, archive sizes,
and selected WASM/JS runtime behavior. Syntax and diff checks passed.
