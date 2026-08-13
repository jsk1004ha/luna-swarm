# UI asset policy

The command center intentionally ships without raster image assets. This
includes people photos, employee portraits, character sprite sheets, and the
former HQ background images.

The ZIP command-center UI is the visual source of truth. DOM identity uses
initials and semantic colors, the summary artwork is CSS-only, and the optional
Pixi headquarters view renders agents and rooms procedurally.

Future UI work must preserve this image-free contract unless the user
explicitly requests a new asset. Extend the ZIP layout and its existing visual
tokens instead of introducing a second shell, a photographic background, or a
parallel design system.
