# ADR-0076: The WebGPU cloud renderer is takram's port

Status: accepted · 26 Nov 2026

## Context

The weather field and the frame in which it draws belong to the game. Shota
Matsuda's volumetric renderer, ported to WebGPU by John Fewell, already has
four cloud layers, shadow cascades, temporal reconstruction and five quality
presets. The spike put its resolved image in the game's scene and retained
the scene's depth and radiance units. [Port source](https://github.com/johnfewell/three-clouds-webgpu)

Two visits to the same setting used to draw different programs. Cold `low`
failed to compile a vertex shader because three had registered the atmosphere
parameter structure in the fragment stage alone. Every old visit built at
`high` before applying its requested preset, which hid the failure. A second
bug appeared on a live switch. Three's material key walked the inputs to the
TSL function. Closing over the layer kept the program key constant even as
the shadow or light graph changed shape.

## Decision

**The game draws volumetric clouds with the pinned WebGPU port and selects
its quality before the first shader builds.** The adapter supplies the
body frame, the sun, the resolved scene depth and the conversion to scene
radiance. The port owns its march, shadows and temporal targets. The page
owns its settings. Each live sensor chain applies writes to its own context.

- The default on the M6 mini is high, with shadow cascades fitted to 200 km.
  At the G1 fair-weather stance, high took 14.46 ms and ultra took 17.98 ms
  for the whole 1920 × 1080 frame. A display preference persists across
  visits, including an existing choice to turn clouds off.
- A diagnostic link chooses its renderer for that page. `?clouds=1` draws
  the port, `?clouds=low` selects its low preset, `?clouds=march` builds
  the native diagnostic, and `?clouds=0` disables the volume. WebGL reports
  the volume unavailable. Ordinary Earth views keep their textured deck.
- The two scene passes and the over-cloud layer remain the frame contract.
  The scene unit still measures an albedo-one surface under the sun above
  the air. [ADR-0063](0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md) · [ADR-0065](0065-a-scene-unit-is-the-sun-above-the-air-and-the-sensors-white-is-half-a-stop-under-it.md)
- The native march and its droplet tables retain their records until their
  last readers retire. [ADR-0064](0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md) · [ADR-0066](0066-the-droplets-phase-is-lorenz-mie-at-one-narrow-width-generated-offline.md)

## Alternatives considered

Extending the native march would make us responsible for the lighting,
reprojection and quality levels that the port supplies. The frame, weather
field, instruments and reference pictures have consumers independent of
either renderer.

We tried the port's quality governor on its real context with a synthetic
30 Hz cadence. It stepped down on frames 10 and 103. The second step selected
`lowEnd` and cleared the shadow distance cap. At 60 Hz it took until frame
484 to restore high and its range. The game keeps the player's chosen
quality. Its presentation watchdog diagnoses a blank canvas and retires at
first light. A missed frame alone gives it no cause to change a setting.

## Consequences

The display offers five presets in one click and the instruments expose
the port's tunables. Changes in graph shape must reach the material cache
key. The atmosphere constant must declare its type in every shader stage
that builds it. The preset test exercises a new renderer for each cold build.

The port still supplies its stock weather and terrestrial air. Its reference
plates therefore record the renderer, served body, settled history and
measured cloud mask. The Air's sustained 30 Hz preset remains unmeasured.
