# Luna HQ employee atlas provenance

- Generated: 2026-08-12
- Tool: OpenAI ImageGen
- Runtime asset: `employee-atlas.png`
- Source asset: `employee-atlas-source.png`
- Post-processing: `generate2dsprite.py`, 4×4 shared-scale grid, bottom alignment, magenta color-key cleanup

## Final generation prompt

Use case: game UI production asset, static employee sprite atlas.

Create one cohesive transparent-ready pixel-art atlas for a modern AI company dashboard named Luna HQ. Exact 4 columns by 4 rows, 16 distinct full-body office employee archetypes, each character isolated in a perfectly equal cell and shown from a consistent slightly top-down 3/4 office-game view. Modern polished pixel art, crisp readable silhouettes at small size, not chunky 8-bit nostalgia. Diverse ages, skin tones, body shapes, hairstyles and hair textures. Mix of engineers, product designers, researchers, QA specialists, operations staff, finance staff, managers and executives. Distinct outfits and accessories: hoodies, shirts, blazers, cardigans, jumpsuits, skirts, slacks, glasses, headsets, tablets, notebooks, lanyards, watches. Friendly competent company atmosphere. Consistent anatomy, lighting from upper left, scale, foot baseline and camera angle across all 16.

Composition constraints: exact 4x4 grid with generous even padding; one character per cell; every character centered; no character or accessory crosses a cell boundary; no overlap; full body fully visible; same scale; no dividers, frames, shadows crossing cells, labels, text, logos, watermark or UI chrome.

Background must be a single perfectly flat solid chroma-magenta #FF00FF with no texture, gradient, lighting, shadow, antialias halo or color variation. No magenta anywhere on the characters. Output as a clean square atlas suitable for color-key transparency and web canvas cropping.
