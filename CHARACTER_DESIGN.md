# Shardbound character design

Interpretive refinement of the first triangle-art pass, inspected in `output/shardbound/first-art-preview.png`. Runtime representation remains native numeric triangle geometry: nine f32 values per triangle, no textures or new dependencies. The preview generator is development evidence only.

## Shape and palette

The right-facing fox courier is anchored at the feet (0, 0). Its local envelope is x=-58..32, y=-99..0. Two tall ears, an extended cream muzzle with a dark nose and eye, a cream-tipped swept tail, separated broad dark boots, a teal scarf, and a small golden satchel provide recognizable landmarks. The tail is deliberately decorative beyond the existing collision half-width; retain gameplay collision dimensions. Warm coat marker RGB [0.95, 0.32, 0.10] remains triangle zero.

Coat orange [0.95,0.32,0.10], lit orange [1,0.56,0.19], burnt shadow [0.64,0.19,0.10], cream [1,0.88,0.62], dark plum [0.16,0.12,0.16], scarf teal [0.08,0.48,0.49], satchel gold [1,0.72,0.20]. Small facial landmarks use a single triangle each rather than thin strokes.

The beetle is a low purple armored mound with a shell seam, three pointed legs, an amber eye and a short upward horn. At scale 0.85 its envelope is about 52x29 pixels, resting at y=0. The fly has two wide pale mint wings, a compact teal body with gold band, and two dangling dark legs. At scale 0.90 its envelope is about 56x46 pixels. Pale wings against darker body keep it distinct from the grounded beetle and collectible diamonds.

## Atlas parts and integration

| Part | Start | Count |
|---|---:|---:|
| Coat | 0 | 5 |
| Head, ears, muzzle and eye | 5 | 11 |
| Scarf | 16 | 2 |
| Feet | 18 | 4 |
| Tail | 22 | 5 |
| Satchel | 27 | 3 |
| Beetle | 30 | 12 |
| Fly | 42 | 11 |

Hero total: 30 triangles per pose. Beetle: 12. Fly: 11. Each is below the 50-triangle ceiling. Total atlas: 53 triangles / 477 numeric values.

Keep `draw_part` translation, scale, flip and tilt unchanged. Replace hero draw calls with this painter order so the tail and boots sit behind the torso:

```slim
draw_part(22, 5, x, y, 1, facing, tilt);
draw_part(18, 4, x, y, 1, facing, tilt);
draw_part(0, 5, x, y, 1, facing, tilt);
draw_part(5, 11, x, y, 1, facing, tilt);
draw_part(16, 2, x, y, 1, facing, tilt);
draw_part(27, 3, x, y, 1, facing, tilt);
```

Use `draw_part(30, 12, x, y, 0.85, 1, lean)` for beetle and `draw_part(42, 11, x, y, 0.90, 1, lean)` for fly. Preserve the existing pose shears 0 / 0.07 / -0.04; flipping continues to mirror geometry without changing the atlas.

## Review evidence and remaining integration check

`output/character-refinement/refined-preview.png` shows actual gameplay sizes and a 2x inspection view, with idle, walking shear and mirrored jump. Visually inspected: distinct ears/muzzle/tail, clear dark eye and nose, broad separate feet, beetle shell and horn, and paired fly wings remain visible. Compared to the first preview, the fox reads as an animal courier rather than disconnected shards, and enemies have different silhouettes. The source generator verifies 9 values per row, RGB in [0,1], nonzero triangle area, part counts, and unchanged first marker. No game/compiler/host/test/tool files were changed by this design pass. The integrating agent must capture the real runtime and run existing replay tests after replacing geometry; this standalone preview is not runtime proof.

## Numeric atlas

This complete literal is also saved at `output/character-refinement/atlas.slim.txt`; `atlas.json` supplies named ranges for inspection. Coordinates are local pixels, y decreases upward, and each row is x1,y1,x2,y2,x3,y3,r,g,b.

```slim
const ATLAS = [
  -14, -59, 13, -59, 12, -28, 0.95, 0.32, 0.1,
  -14, -59, 12, -28, -16, -28, 0.64, 0.19, 0.1,
  -9, -56, 8, -56, 3, -37, 1, 0.88, 0.62,
  8, -54, 20, -37, 10, -34, 1, 0.56, 0.19,
  -16, -28, 12, -28, 16, -20, 0.16, 0.12, 0.16,
  -15, -69, -19, -94, -2, -82, 0.64, 0.19, 0.1,
  0, -79, 10, -99, 16, -73, 1, 0.56, 0.19,
  -14, -86, -7, -80, -13, -77, 1, 0.88, 0.62,
  8, -89, 11, -77, 4, -79, 0.64, 0.19, 0.1,
  -16, -78, 8, -82, 19, -65, 0.95, 0.32, 0.1,
  -16, -78, 19, -65, -8, -58, 1, 0.56, 0.19,
  1, -70, 30, -65, 12, -56, 1, 0.88, 0.62,
  -8, -58, 1, -70, 12, -56, 1, 0.88, 0.62,
  25, -67, 32, -65, 27, -61, 0.16, 0.12, 0.16,
  9, -77, 15, -75, 10, -71, 0.16, 0.12, 0.16,
  -9, -68, -3, -62, -15, -63, 0.64, 0.19, 0.1,
  -14, -60, 13, -57, 8, -51, 0.08, 0.48, 0.49,
  -14, -60, -33, -55, -21, -48, 0.08, 0.48, 0.49,
  -13, -25, -2, -24, -8, -5, 0.64, 0.19, 0.1,
  -8, -9, -6, 0, -20, 0, 0.16, 0.12, 0.16,
  3, -25, 13, -24, 13, -5, 0.64, 0.19, 0.1,
  8, -8, 21, 0, 6, 0, 0.16, 0.12, 0.16,
  -10, -31, -35, -24, -51, -42, 0.64, 0.19, 0.1,
  -10, -31, -51, -42, -34, -43, 0.95, 0.32, 0.1,
  -34, -43, -51, -42, -58, -68, 1, 0.56, 0.19,
  -58, -68, -51, -42, -42, -50, 1, 0.88, 0.62,
  -58, -68, -42, -50, -47, -66, 1, 0.88, 0.62,
  -14, -52, -4, -46, -17, -34, 1, 0.72, 0.2,
  -17, -34, -4, -46, -6, -33, 0.64, 0.19, 0.1,
  -13, -49, -5, -46, -10, -41, 1, 0.88, 0.62,
  -21, -12, -30, 0, -18, -4, 0.16, 0.12, 0.16,
  -6, -10, -13, 0, -2, -4, 0.16, 0.12, 0.16,
  9, -10, 14, 0, 19, -4, 0.16, 0.12, 0.16,
  -26, -12, -15, -30, -2, -8, 0.22, 0.14, 0.29,
  -15, -30, 8, -31, -2, -8, 0.47, 0.28, 0.57,
  8, -31, 21, -16, -2, -8, 0.3, 0.18, 0.39,
  -26, -12, -2, -8, 17, -6, 0.14, 0.1, 0.2,
  -14, -28, 4, -29, -4, -22, 0.73, 0.48, 0.61,
  -1, -29, 2, -28, -2, -10, 0.16, 0.12, 0.16,
  15, -21, 29, -18, 24, -6, 0.16, 0.12, 0.16,
  23, -16, 28, -16, 25, -12, 1, 0.72, 0.2,
  23, -20, 29, -34, 31, -20, 0.38, 0.23, 0.43,
  -5, -15, -31, -35, -25, -10, 0.69, 0.95, 0.91,
  -5, -15, -25, -10, -12, -5, 0.31, 0.73, 0.75,
  2, -16, 25, -38, 31, -13, 0.85, 1, 0.92,
  2, -16, 31, -13, 16, -5, 0.37, 0.79, 0.8,
  -11, -15, 8, -15, 15, -2, 0.16, 0.12, 0.16,
  -11, -15, 15, -2, -4, 5, 0.08, 0.36, 0.4,
  -6, -13, 2, -13, 4, 2, 1, 0.72, 0.2,
  8, -17, 20, -13, 17, -2, 0.13, 0.51, 0.52,
  14, -14, 20, -12, 16, -8, 1, 0.88, 0.62,
  -3, 2, -9, 13, 1, 6, 0.16, 0.12, 0.16,
  4, 3, 10, 13, 10, 4, 0.16, 0.12, 0.16,
];
```
