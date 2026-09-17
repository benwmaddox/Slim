# Slim project notes

- Use Luna Max for implementation. After the first character design pass, use
  Astra with low reasoning for silhouette, proportions, palette, and pose refinement.
- Keep the compiler small: fixed numeric data, direct WASM, and standalone JS.
  Games ship without runtime libraries or external services.
- Keep characters within 50 emitted triangles per pose. Prefer reusable parts
  and shared level data over duplicated geometry and collision definitions.
- Preserve both JS and WASM outputs; choose packaging by complete ZIP size.
  Normal builds retain eight source-named artifacts and one JS profile.
- Generated `dist/` and `output/` remain untracked. Do not add a project license.
- Validate with `npm test`, fresh builds, gameplay replays, and applicable browser
  checks. For arrays, audit bounds, side-effect order, data offsets, and page capacity.
