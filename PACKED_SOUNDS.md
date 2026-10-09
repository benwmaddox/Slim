# Packed sound presets

This experiment measured whether the five built-in sound presets benefit from
the same kind of fixed integer packing used for triangle data. The host owns
the table, so the result affects both the WASM and JavaScript packages while
leaving the `sound(event, pitch, gain)` API unchanged.

The five presets currently contain ten voices total, with six values per voice:

```text
pitch, sweep, delaySec, durationSec, wave, gain
```

The bounded candidates used signed integer pitch and sweep values, delay and
duration ticks at `1/200` second, a wave index, and gain hundredths. Candidate
one stored the 60 values in a flat numeric array with ten numeric start/count
descriptors. Candidate two stored the same six-byte logical records as 60
printable string code units and decoded them with `charCodeAt`; the string was
60 source bytes, but the descriptor and decoder remained runtime source.

The fresh baseline used:

```sh
node tools/build.mjs examples/shardbound.slim --keyboard-only --pack-triangles ATLAS --out-dir output/packed-sounds/baseline
```

The initial experiment substituted each candidate host and used the same command
with `flat` and `string` output directories. The complete minified ZIP measurements were:

| Build | WASM ZIP | JS ZIP | Minified WASM HTML | Minified JS HTML |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 6,691 B | 6,573 B | 4,759 B | 17,000 B |
| Flat integer table | 6,705 B | 6,590 B | 4,744 B | 16,985 B |
| Compact string table | 6,708 B | 6,599 B | 4,761 B | 17,002 B |

The source table became shorter, but the complete ZIP results show that the
decoder and descriptor overhead outweighed the storage saving.
Neither candidate improved the complete packages, so ordinary builds retain
the original preset representation. The optional formats use the same synthesis
behavior and interoperability calls, without runtime dependencies.

Both candidates were checked against the original host with mocked Web Audio:
16 sound calls produced 290 exact events for each backend, including all ten
voices, waveform selections, pitch sweeps, starts, stops, delays, durations,
envelopes, gains, clamps, and silent invalid-gain calls. The focused host suite
also passed at that checkpoint (`13` tests).

A larger sound catalog or music sequences might amortize a decoder. For the
current five-preset table, the ordinary numeric representation is smaller.

## Release selection

`--release` now compares `none`, `numbers`, and `bytes` sound representations,
including minification, triangle encoding, optimizer, and HTML packaging choices.
WASM and JS each retain their smallest measured complete ZIP; ties prefer simpler
representations. Only the selected format is emitted, with the usual eight
files per source. Trial artifacts stay in a temporary directory.

Use `--sound-packing none`, `--sound-packing numbers`, or
`--sound-packing bytes` to force a sound representation. `--sound-packing auto`
enables the comparison even without `--release`. Generated-host API callers can
pass `{soundPacking: 'bytes'}` or either of the other two formats; the default
is `none`.
Sources without sound imports do not produce redundant sound candidates.

The first integrated release checkpoint measured 126 Shardbound candidates on 2026-09-17.
Its smallest ZIP for each sound mode (including geometry, optimizer, packaging,
and minification choices) was:

| Sound mode | WASM ZIP | Native JS ZIP |
| --- | ---: | ---: |
| `none` | 6,691 B | 6,573 B |
| `numbers` | 6,718 B | 6,611 B |
| `bytes` | 6,716 B | 6,614 B |

These implemented decoders differ from the initial experiment above. Both
backends selected `none`; WASM selected packed `ATLAS`, external WASM, and
`Oz-converge`. Both selected minified HTML. All 81 tests passed, and all six
backend/sound-mode schedule comparisons matched 290 original Web Audio events
exactly. The seven selected game artifacts were byte-identical to the prior
Chrome/Firefox-tested build; the size report now records the release search.

See [INTEGER_ARRAYS.md](INTEGER_ARRAYS.md) for the subsequent release search
with exact integer storage and the current production sizes.

Release trials now use [staged search](STAGED_SEARCH.md); add
`--search exhaustive` to audit all combinations.
