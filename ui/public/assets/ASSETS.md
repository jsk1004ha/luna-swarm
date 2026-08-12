# Luna HQ pixel assets

All raster assets in this directory were created specifically for Luna Swarm
and are distributed with the project. No third-party game asset pack is used.

- `employee-atlas-v2.png`: 4×4 transparent standing-employee atlas. The first
  three rows preserve the original project atlas. The fourth row was regenerated
  from the four damaged identities with the built-in OpenAI image generator on
  a flat chroma-key background, locally converted to alpha, resized with
  nearest-neighbor sampling, and validated inside isolated 192×192 cells.
- `hq/seated-workers-{north,south,east}.png`: 4×4 directional seated employee
  atlases. West-facing seats mirror the east atlas at render time.

Generation prompt for the repaired row:

> Create the four original bottom-row office employees in one horizontal row,
> complete from hair to shoes, crisp pixel art, no overlap, on one uniform
> `#00ff00` chroma-key background. Preserve identity, clothing, props, pose, and
> dark outline; add no text, grid, shadow, border, extra person, or watermark.
