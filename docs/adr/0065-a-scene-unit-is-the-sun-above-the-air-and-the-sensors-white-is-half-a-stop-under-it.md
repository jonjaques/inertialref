# ADR-0065: A scene unit is the sun above the air, and the sensor's white is half a stop under it

Status: accepted · 10 Nov 2026. Names the unit
[ADR-0056](0056-the-air-is-measured-and-its-gain-is-pi.md)'s gain of π
implies. No constant changes value and no picture moves.

## Context

Every absolute emitter the weather plan adds converts a physical radiance into
scene units: lightning, the moon, a city under cloud, airglow. The tree states
the unit two ways, and they are not one number.

| Name                | Value                                                            | What it calls a unit                                                                | Read by                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0056's unit     | `ATMOSPHERE_GAIN = π`, anchored at E⊥ = 133.8 klx                | An albedo-one surface under the sun **above the air** at 1 AU: E⊥/π = 42,590 cd/m²  | Every air call site: the shell, the sphere, the ground, the sea, and the cloud composite                                                                                                                                                                                                                                      |
| `SURFACE_LUMINANCE` | 30,000 cd/m², "an albedo-one surface under terrestrial sunlight" | A surface under sea-level sunlight                                                  | The photographic exposure and its calibration EV, `sceneRadianceGain` and `integratedGainFor` (`render/radiance.ts`), the galaxy (`render/galaxyVolume.ts`), star sprites (`render/materials.ts`), the star-visibility floor (`starVisibility.ts`), the sun's disk and its cap (`render/bodyUniforms.ts`, `scene/Bodies.tsx`) |
| `SOLAR_LUMINANCE`   | 1.6 × 10⁹ cd/m²                                                  | The sun's disk as seen **at sea level**: over the disk's 6.794 × 10⁻⁵ sr, 108.7 klx | `stellarLuminance` and `stellarIlluminance` (`photometry.ts`)                                                                                                                                                                                                                                                                 |

The surfaces' beam reaches the ground through the air's transmittance table,
so a sunlit surface at sea level is under one unit of sunlight, not at it: the
unit the pictures are drawn in is the first row's. Read as one unit, the first
two rows disagree by 42,590/30,000 = 1.420, 0.506 stop. The third is 0.81 of
E⊥, and the disk above the air is about 1.97 × 10⁹ cd/m².

Three things follow from the disagreement as the tree stands. The galaxy and
the stars are converted through 30,000 while the sky they sit in is converted
through 42,590, so against the sunlit world they draw 1.42 times bright. The
stars' visibility floor is off by up to 0.22 mag. And the sun's disk is drawn
at 1.6 × 10⁹/30,000 = 53,333 units where a disk that lights an albedo-one
surface to one unit is π/Ω = 46,240, 1.153 times.

## Decision

**The scene unit is `SCENE_UNIT_LUMINANCE`, an albedo-one surface under the
sun above the air at 1 AU, and `SURFACE_LUMINANCE` is the sensor's calibration
white, a calibration half a stop under the unit and not a definition of it.**

- `EXTRATERRESTRIAL_ILLUMINANCE = 133_800` lux and
  `SCENE_UNIT_LUMINANCE = EXTRATERRESTRIAL_ILLUMINANCE / Math.PI`, 42,590
  cd/m², are exported from `packages/rendering/src/exposure.ts`. The air's
  anchor in `atmosphere.test.ts` imports the illuminance in place of a literal
  of its own, so ADR-0056's anchor and the unit are one number.
- **An absolute emitter converts physical radiance into scene units by
  dividing by `SCENE_UNIT_LUMINANCE`.** Lightning, the moon, cities and
  airglow do so when their phases build them.
- `SURFACE_LUMINANCE` keeps 30,000. Its doc comment calls it the sensor's
  calibration white: the luminance the photographic exposure equates with one
  scene unit.
- `SOLAR_LUMINANCE` keeps 1.6 × 10⁹, and its doc comment says what it is: the
  disk at sea level, 108.7 klx at 1 AU, 0.81 of E⊥.
- **Under Enhanced staging an absolute emitter is also divided by its body's
  `sunlight`.** Staging draws every body's sunlight at 1
  (`render/bodyUniforms.ts`), so an emitter that skips the second division
  changes its ratio to the sun with the camera mode: 2.32 times on Mars, whose
  sunlight is 0.431. That figure is inferred from the staging code, not
  measured.
- Three tests in `packages/rendering/src/exposure.test.ts` pin the naming, and
  each fails when its constant moves:

  | Test                                                       | Bound                           | What fails it                                  |
  | ---------------------------------------------------------- | ------------------------------- | ---------------------------------------------- |
  | `SCENE_UNIT_LUMINANCE` is `EXTRATERRESTRIAL_ILLUMINANCE/π` | exact, and within 0.5 of 42,590 | The plan's 133.3 klx reads 159 cd/m² off       |
  | `SCENE_UNIT_LUMINANCE/SURFACE_LUMINANCE`                   | in [1.418, 1.422]               | The white at 42,590 reads a bias of 1.000      |
  | `stellarIlluminance(1, AU)/EXTRATERRESTRIAL_ILLUMINANCE`   | in [0.80, 0.83]                 | The disk above the air reads a share of 1.0004 |

  The second assertion's message names the ratio the sensor's half-stop
  calibration bias and says that moving it moves every plate, so a change to
  either constant has to restate the bias on purpose.

- The four conversions that divide by the white as though it were the unit —
  the galaxy, the star sprites, the star-visibility floor and the sun's disk —
  are one open defect in
  [the air's plan](../../design/plans/the-air.md#the-galaxy-the-stars-and-the-suns-disk-take-the-sensors-white-for-the-scene-unit),
  with the figures above. The weather's phase 5 fixes them, when the moon,
  airglow and the stars are calibrated together and the `night-side` preset is
  re-scored.

Every figure in this record is computed from the constants. None is a GPU
measurement.

## Alternatives considered

**Setting `SURFACE_LUMINANCE` to 42,590.** It makes the two names one number
and fixes all four conversions at once. It also opens every manual exposure by
0.51 EV at a fixed lens, moves the calibration EV readouts, dims the galaxy
and the stars to 0.70 of the world, shifts the star floor by up to 0.22 mag
and takes the disk's compression exponent from 0.191 to 0.197. Every
photographic plate moves, and every plate with stars or the galaxy behind it
moves twice. No emitter is calibrated against either constant yet, so the move
improves no picture there is to judge it by. It belongs to the phase that
calibrates the night, which can score the result.

**Scaling the air's gain to match 30,000.** That is a fitted gain over the
march's sum, the error ADR-0056 removed, and it fails the anchor: the zenith
under a 60° sun leaves the CIE standard clear sky it is held to.

**Leaving both unnamed until an emitter needs one.** The first emitter then
picks whichever constant its author finds first. Lightning's measured power
spans a hundredfold and the moon's irradiance is three orders over airglow's,
so a 1.42 times error in the unit is invisible in either alone and wrong in
their ratio to each other and to the sun.

## Consequences

- An emitter's conversion has one answer, and a test fails if the constant
  behind it moves.
- **The four conversions stay wrong until phase 5.** The galaxy and the stars
  draw 1.42 times bright against the sunlit world, the star floor is off by up
  to 0.22 mag, and the disk is 1.153 times its consistent value. Naming the
  unit records the defect and does not fix it.
- **The name `SURFACE_LUMINANCE` still reads like a unit.** Its doc comment
  says it is a calibration; a caller that reads only the identifier can still
  divide by it as one. The defect entry lists the four that do.
- Manual exposure, the plates and the ledger are untouched: the tests that
  hard-code 1/30,000 or read the white pass unchanged.

## Related

- The constants and their doc comments:
  [`packages/rendering/src/exposure.ts`](../../packages/rendering/src/exposure.ts).
  The pinning tests:
  [`exposure.test.ts`](../../packages/rendering/src/exposure.test.ts), "the
  scene unit". The anchor:
  [`atmosphere.test.ts`](../../packages/rendering/src/atmosphere.test.ts).
- [ADR-0056](0056-the-air-is-measured-and-its-gain-is-pi.md): the gain of π
  and the anchor at 133.8 klx.
  [ADR-0037](0037-the-enhanced-camera.md): the staging that draws every body's
  sunlight at 1.
- The open defect and the emitter rule:
  [the air: what is left](../../design/plans/the-air.md).
- The weather's other phase 0 records:
  [ADR-0063](0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md),
  [ADR-0064](0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md),
  [ADR-0066](0066-the-droplets-phase-is-lorenz-mie-at-one-narrow-width-generated-offline.md).
