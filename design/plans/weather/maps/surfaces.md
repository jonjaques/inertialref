# Map: surfaces and lights that will read `cloudSunlight` (rule 59 parity)

Repository: `/Users/jonjaques/.t3/worktrees/inertialref/t3-e896a8db`, HEAD `c2a50f1`
(branch `feat/the-weather-stacked-prs`, clean tree). Every line number below is at that
commit. Paths are relative to the repository root. Read-only survey; nothing was run on
the GPU.

Plan sections this serves: `design/plans/the-weather.md` §6.1 (one shadow), §6.2 (under a
deck), §6.4 (the sun, the hull and the flare), §6.5 (what the sea reflects), §7.3 (wet
ground). Phase 1 lands the reflection probe, phase 2 lands `cloudSunlight` in all five
consumers and the descent-gate test, phase 3 retires Earth's deck, phase 4 lands wet ground,
phase 5 the moon as a second beam (`§10`).

"Inference" marks anything not read directly off the code.

---

## 0. The one-paragraph version

Three hand-written TSL materials draw the body, all `MeshBasicNodeMaterial` (unlit, so three's
lights never reach them): the **ground** (`render/terrain.ts`, opaque, body-fixed axes), the
**sea sheet** (`render/water.ts`, transparent and depth-writing, body-fixed axes, generated
wet worlds only) and the **sphere** (`render/planet.ts`, opaque, **render-space** axes). Each
forms `sunlight = sunColor·sunIntensity·sunThrough(air, point, sun)` and marches the air with
`airToward(air, eye, point, sun)` (4 samples), both from `render/air.ts`. `cloudSunlight`
multiplies `sunlight` in all three. The trap is the skylight: the ground and the sea take a
skylight share **out of** the beam and add it back as a hemispheric term, and the sphere has no
skylight term at all. Rule 59's parity rests on that identity, so with a cloud factor on the
beam alone a fully shadowed ground keeps its sky term, about `SKY_FRACTION·airThickness` of its
clear-sky light (a third on Earth, a fifth on Mars), while the sphere under the same shadow goes
dark. That is a step at the descent gate. The hull's key light is a three.js `PointLight` written on the CPU by
`CameraRig`. The flare's visibility is CPU arithmetic (`flareMath.ts`). Neither has a GPU hook
today. `wear.ts`/`groundWear.ts` are not wetness. They hold the per-mesh uniform record, and
they are where per-patch float64-reduced coordinates for a new lattice (shadow cascade,
clipmap) go.

---

## 1. Consumer table

| Consumer       | File (factory)                                                                                                        | Frame of point and sun                                                                                                            | Beam (multiply here)                                                                                                        | Sky irradiance (replace here)                                                               | Air march                                                       | Night term                                                                            | Pass / order                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Ground         | `apps/game/src/render/terrain.ts` `createTerrainMaterial()` L304                                                      | Body-fixed, meters. Point `anchor + local`, sun `sunDirection` already body-fixed                                                 | `sunlight` L1337 (feeds `direct` L1374 and the glint L1429)                                                                 | `thin` L1379–1383, `skyOverhead·skyView` L1384, beam share `(1 − diffuse·(1 − deep))` L1378 | `airToward(air, eyeUnits, pointUnits, sun)` L1428               | none (no night map). `visibilityAmbient` L1387, `skylightLeft` tail, `emission` L1237 | opaque, renderOrder 0                                                                |
| Sea sheet      | `apps/game/src/render/water.ts` `createWaterMaterial()` L269, two builds                                              | Body-fixed, meters, on the datum                                                                                                  | `sunlight` L463 (feeds `diffuseLight` L516–519 and `sunlight·glint` L614)                                                   | `diffuseLight`'s sky half L520–529; **reflected** sky `skyLight` L552–560                   | `airToward(...)` L651                                           | `visibilityAmbient·dayColor` L530, L560; `glow` L644                                  | transparent, `depthWrite = true`, renderOrder 0, splits the scene pass once (`full`) |
| Sphere         | `apps/game/src/render/planet.ts` `createPlanetMaterial()` L275                                                        | **Render space** (`positionWorld`, `sunDirection`, `spinAxis`, `center`). Body-fixed direction is `normalize(positionLocal)` L381 | `lit = daylight·ringShade·cloudShade` L504 (feeds `diffuse` L534 and glint L563). Existing cloud term `cloudShade` L443–464 | **none**: no skylight, no `skyOverhead`, no `visibilityAmbient`                             | `airToward(air, eyeUnits, pointUnits, light)` L589, inside `Fn` | `night` L617–625, dimmed `1 − cloudCover·0.85` L621                                   | opaque, renderOrder −1 under streamed ground, else 0                                 |
| Hull key light | `apps/game/src/scene/CameraRig.tsx` L53, materials `apps/game/src/render/shipMaterial.ts` `rebuildShipMaterial()` L19 | Render space; light at the star's render position                                                                                 | `PointLight` intensity L157–159 (CPU)                                                                                       | none; Enhanced ambient 0.16 and fill 0.35 (`packages/rendering/src/nearFieldLighting.ts`)   | none (`the-air.md`: key light ignores the air)                  | emissive maps (`shipMaterial.ts` L50–52)                                              | opaque `MeshStandardNodeMaterial`, three's lighting                                  |
| Flare          | `apps/game/src/render/flare.ts` `createLensFlare()` L356; `flareMath.ts` `sunVisibility()` L109; `scene/SunFlare.tsx` | Render space, CPU                                                                                                                 | `strength = visibility·fade·(0.35 + 0.65·brightness)` flare.ts L419 → `intensity` uniforms L609–616                         | n/a                                                                                         | n/a (`graze` reddening L586–591)                                | n/a                                                                                   | additive, `depthTest = false`, renderOrder 10                                        |

---

## 2. Shared machinery every surface calls

### 2.1 `apps/game/src/render/air.ts` (858 lines)

- `createAirUniforms()` L141–232 returns one bundle **per material** (`top`, `betaRayleigh`,
  `mieScatter`, `mieExtinction`, `mieForward`, `aerosolSky`, `ozone*`, `detached*`,
  `hRayleigh`, `hMie`, `transmittance` (texture node over `LUT_WHITE`), `multiScatter` (over
  `LUT_BLACK`), `limb`, `limbFalloff`, plus `set(recipe, sunTable, psiTable)`,
  `lift(strength, falloff)`, `clear()`). `AirUniforms` = its return type (L234). The host writes
  it every frame: `TerrainPatches.tsx` L192–201, `WaterPatches.tsx` L112–117, `Bodies.tsx`
  L514–522. **This is the pattern a `createCloudShadowUniforms()` bundle should copy:** one per
  material, `set`/`clear` idempotent, the stand-ins filtered linear (`lutPixel` L121–127; rule
  56), one stand-in object per role (rule 57).
- `marchAir(air, origin, direction, near, far, sun, samples, clearBeam?)` L266–349. Points are
  in **sea-level units about the body's center** in whatever axes the caller uses. Per sample
  (inside `crowdedSamples` L445–478, a `Loop`):
  ```ts
  const sunT = sunTableAt(air, muSun, height01).toVar()            // L319, 1 tap
  if (clearBeam !== undefined) If(clearBeam.greaterThan(0), () => { // L323–326
    sunT.assign(clearedBeam(air, sunT, height01, clearBeam)) })     // +1 tap, Enhanced from orbit only
  const psi = psiTableAt(air, muSun, height01)                     // L327, 1 tap
  const single = (βR·ρR + scatterD)·phaseR + scatterToward·ρM·phaseM  ·  sunT   // L332–337
  const multiple = psi · (βR·ρR + mieScatter·ρM + scatterD)        // L338–343
  inscatter += throughput · (single + multiple) · stepLight         // L344
  throughput *= stepThrough                                        // L345
  ```
  §6.3 hooks: `single` × `cloudSunlight(point)`, `multiple` × the column's diffuse transmittance
  over the sample. Add them as an **optional parameter** in the shape of `clearBeam`. The
  function is shared by four materials (see the next bullet), and the shell's binding count is
  pinned by a test (§10).
- Callers of the march: the shell, `materials.ts` L368 (`marchAir` + `marchLimb` L400 +
  `throughLimb` L409); the sphere, `planet.ts` L589 (`airToward`); the ground, `terrain.ts`
  L1428; the sea, `water.ts` L651. `sunThrough` is called at `planet.ts` L503, `terrain.ts` L1337
  and `water.ts` L463.
- `crowdedSamples` L445–478 puts midpoint samples, `u = (i + 0.5)/samples`, crowded toward the
  segment's lowest point. No sample lands on the surface point, so the surface's own beam tap
  cannot reuse a march sample (inference from the formula).
- `SURFACE_AIR_SAMPLES = 4` L481. `airToward` defaults to it (L716). This is the plan's "four
  taps per terrain fragment".
- `airToward(air, eye, point, sun, samples = 4)` L711–743. It enters the air at `top` using
  `|d × c|` (L725), passes `clearedFromOrbit(air).mul(ORBIT_AIRLIGHT)` as `clearBeam`, and
  returns `{ inscatter, transmittance: mix(T, 1, clearedFromOrbit) }`.
- `sunThrough(air, point, sun)` L784–796 reads `sunTableAt` at the point's height and sun
  cosine, then `clearedBeam(...)` L804–824, which **always** samples the overhead column
  (`air.transmittance.sample(vec2(1, height01))`, L810). That is 2 taps a call, unconditional.
- `clearedFromOrbit(air)` L763–765 is `air.limb·enhancedSky`: 0 inside the air and under a
  photographic lens.
- The tables are single-level (`atmosphereLuts.ts` L81–85: linear, `generateMipmaps = false`).
  That is why the plain `.sample()` calls inside `Loop` are benign today. A cloud shadow with
  mips is not: per plan §5.2, name `.level(0)` on every read inside a loop. That is an
  inference about the existing code; the plan states the r185 hazard.
- `marchAir`'s doc comment L261–264: `Loop` and `toVar` emit statements, so they work only
  inside a material's `Fn`. Built at material scope, the loop is never emitted and compiles
  cleanly to a vacuum.

### 2.2 `apps/game/src/render/radiance.ts`

- `skyOverhead` L28: module-level `uniform(Vector3)`, the zenith over the datum under the eye.
  `Bodies.tsx` L670–679 writes it (`airOverheadRgb`), and only for a deep air
  (`standingAir.deep`). The ground and the sea read it under `deepSky`.
- `visibilityAmbient = enhancedSky.mul(0.03).mul(stagedLight)` L64: Enhanced's legibility floor,
  not light. The ground and the sea take it and the sphere does not
  (`surfaceVisibility.gpu.test.ts` expects ground = 1.03 × sphere under Enhanced).
- `stagedLight` L44–46, `enhancedSky` L11–13, `sceneRadianceGain` L29–31.
- `sensorRadiance(material, overlay = false, instrument = false, reactive = …)` L95–112 is the
  output seam: it scales by `sceneRadianceGain`, clamps to 65,504, and writes `motionOverlay` /
  `meterOverlay` / `reactiveCoverage`. Ground and sphere use the defaults (reactive 0), the sea
  `0.3`, the deck `'alpha'`, the flare `overlay = true`.

### 2.3 `apps/game/src/render/twilight.ts`

`skylightLeft(incidence, horizon)` L20–30. For `incidence ≥ 0` it is `saturate(incidence +
horizon)`, the linear day ramp the plan's §6.2 calls a defect ("a quarter of the noon sky on
the ground"). Below the horizon it is `horizon·e^(66·incidence)`. The ground and the sea's body
light use `horizon = 0.25`; the sea's reflection uses `0.15`.

### 2.4 Constants `water.ts` imports from `terrain.ts`

`BEAM_TERMINATOR = 0.025` L1629, `SKY_FRACTION = 0.33` L1640, `deepSky(skyStrength) =
smoothstep(LIMB_OWN_FROM, LIMB_OWN_TO, skyStrength)` L1648–1650, `paint()` L1620, `BLACK_RGB`
L1684. The sea imports them at `water.ts` L62–68, so the ground and the sea share the skylight
model by import. A cloud-occluded skylight function belongs beside these, or replaces them,
and both files must call it.

---

## 3. The ground: `apps/game/src/render/terrain.ts` (1,684 lines)

### 3.1 Interface and inputs

`export interface TerrainMaterial` L123–167 has `material`, `sunDirection` ("Unit vector toward
the star, **in the body's own rotating axes**"), `sunColor`, `sunIntensity`, `air`,
`albedoScale`, `setPixelAngle`, `setPalette`, `setAlbedoMap`, `setSlopeTable`, `setQuality`, and
`setBakeMode(0 | 1 | 2)`.

Per-material uniforms (L305–408) include `lunarLambert` L330, `bodyRadius` L332 (the datum
radius, meters), `skyColor` L375, `skyStrength` L376 (`palette.airThickness`), `air` L377,
`pixelAngle` L385, `displayPixelAngle` L391, `albedoMap` L407, `mapped` L408 and `bakeMode` L374.

Per-mesh `onObjectUpdate` uniforms read off `groundWearOf(object)` (L417–478): `eyeLocal`,
`morphBand`, `morphEdges`, `morphCorners`, `patchLevel`, `anchor` (float32-rounded),
`anchorAltitude`, `grainOrigin`, `macroCell`, `macroOffset`. See §8 for the record.

One material for the session, created in `scene/SceneView.tsx` L78 and shared by
`TerrainPatches` and `ScatterRocks` (instanced, so a second pipeline: `SceneView.tsx` L60–76,
`ScatterRocks.tsx` L79/L135). The orbital bake (`render/orbitalBake.ts` L503–525) draws through
it with `setBakeMode(1|2)` and puts it back to 0.

### 3.2 Frames and units

- Everything is body-fixed. `TerrainPatches.tsx` L176–186 rotates the star direction by
  `Q.conjugate(state.orientation)` on the CPU and writes `terrain.sunDirection`. The patch mesh
  carries the body's rotation as its quaternion (L237–242).
- `up = normalize(anchorDirection + local/|anchor|)` L561–563. Altitude uses the
  no-cancellation form (rule 52) L585–589:
  `altitude = (2·dot(anchor, local) + dot(local, local)) / max(|anchor + local| + |anchor|, 1) + anchorAltitude`.
- Air units L1332–1333: `pointUnits = (anchor + local)/bodyRadius` and `eyeUnits = (anchor +
eyeLocal)/bodyRadius` are sea-level units at the **drawn ground height**, unlike the sphere's,
  which sit at the datum.
- `bodyRadius` is `state.datumRadius`, the equatorial `body.radius` (`terrainStreamer.ts`
  L454–464). The sphere's `seaLevel` is `body.trueRadius·compression` (`Bodies.tsx` L512), and
  `trueRadius` is `body.radius` too (`packages/rendering/src/scene.ts` L437). Same unit.
- `mapUv` L1146–1149 is SphereGeometry's UV layout from body-fixed `up`:
  `(atan(up.z, −up.x)/2π, 1 − acos(up.y)/π)`. It is identical to the sphere's `uv()`, so anything
  the sphere reads by UV (the deck's map) the ground can read by `mapUv`.

### 3.3 Per-pixel lighting, in graph order (`material.colorNode = Fn(() => …)` L537–1469)

```ts
const sun = normalize(sunDirection)                                          // L1280
const incidence = dot(up, sun)                                               // L1302
const pastHorizon = sqrt(2|altitude|/max(bodyRadius,1))·sign(altitude)       // L1303–1308
const daylight = smoothstep(−BEAM_TERMINATOR, BEAM_TERMINATOR, incidence + pastHorizon) // L1309–1313
const mu0 = max(dot(shaded, sun), 0); const mu = max(dot(shaded, view), 0.05)  // L1317–1318
const photometric = mix(mu0, (2·mu0/(mu0 + mu))·sign(mu0), lunarLambert)     // L1323–1324
const dayColor = sunColor.mul(sunIntensity)                                  // L1336
const sunlight = dayColor.mul(sunThrough(air, pointUnits, sun))              // L1337  ← BEAM
const diffuse = min(skyStrength·SKY_FRACTION, 1)                             // L1359
const skyView = saturate(dot(shaded, up))·0.5 + 0.5                          // L1360
const deep = deepSky(skyStrength)                                            // L1373
const direct = surfaceAlbedo·photometric·daylight·sunlight·(1 − diffuse·(1 − deep))   // L1374–1378
const thin = skyColor·diffuse·skyView·skylightLeft(incidence, 0.25)·dayColor // L1379–1383 ← SKY
const ambient = mix(thin, skyOverhead·skyView, deep) + skyView·visibilityAmbient       // L1384–1387
const indirect = surfaceAlbedo·ambient                                       // L1388
const glint = (pow(lobe, s) + 0.32·pow(lobe, s/16))·fresnel·water·daylight   // L1401–1412, s = 2/max(roughness², 1e-4), lobe on `up`
const marched = airToward(air, eyeUnits, pointUnits, sun)                    // L1428  ← AIR
const surface = direct + indirect + sunlight·glint + emission               // L1429
const lit = surface·marched.transmittance + marched.inscatter·dayColor·ATMOSPHERE_GAIN // L1430–1432
return mix(lit, baked, saturate(bakeMode))                                   // L1468
```

`surfaceAlbedo` (L1227–1231) is `mix(mix(ground, oceanColor, water), riverColor, river·(seaSheet

- 1 − seaEnabled))·albedoScale`. `ground`(L1216–1218) is the reflectance after the ceiling.`surfaceRoughness = mix(roughness, 0.06, water)`L1234.`emission = liquidGlow·water` L1237.

### 3.4 Hook points for the weather

1. **Beam.** Multiply `sunlight` at L1337 by `cloudSunlight(point)`. That dims `direct` and the
   glint (`sunlight.mul(glint)` L1429) together, which is right: the glint is the sun's disk.
   Do **not** fold the factor into `dayColor`, because the skylight `thin` and the air's
   `inscatter·dayColor` are made of `dayColor` and must not be dimmed by the shadow at the
   point.
2. **Skylight under a deck (§6.2).** The energy balance replaces the sky half: `thin`
   (L1379–1383), the deep `skyOverhead·skyView` (L1384), and the beam share-out
   `(1 − diffuse·(1 − deep))` (L1378), because once the sky comes from the irradiance table it
   is no longer a share of the beam. `skyView` (L1360) stays as the hemisphere's visibility.
   This is also where the air plan's two defects close: the linear ramp in `skylightLeft`, and
   `skyOverhead` being "one zenith under the eye".
3. **Air (§6.3).** The ground's 4-sample march is `airToward` L1428, which goes to `marchAir`.
   Per-sample cloud factors go in `marchAir` (§2.1). For the composite the plan needs the
   surfaces' air split at `t₀` (§5.6), so the march must be reachable from the composite with
   identical taps. That is an inference from §5.6/§6.3.
4. **Night.** The ground has no night lights (no `nightMap`; `rg night` finds nothing in
   `terrain.ts`). Its night side is `visibilityAmbient` (Enhanced only), the
   `skylightLeft` exponential tail past sunset, and `emission` (magma). The moon (phase 5) is a
   second beam, built as `direct` is and taking the cloud column's transmittance (§5.3). §6.6's
   "city under cloud lights the base" is the sphere's term only. On Earth the ground already
   lacks the sphere's city lights at the gate: a pre-existing rule-59 asymmetry, read from the
   code.
5. **Wetness (§7.3, phase 4).** Darken `surfaceAlbedo` (L1227–1231), **not** `ground`: the bake
   reads `ground` and `riverColor` (L1463–1467), and a wet `ground` would be baked into the
   sphere's cached reflectance (§8.3). Smooth toward water through `surfaceRoughness`
   (L1234). Puddles are the glint's own form, which already exists: F0 0.02, flat (radial)
   normal, `lobe = max(dot(up, half), 0)` L1401–1412. Its gate `.mul(water)` would become
   `max(water, puddle)`. The ground has **no sky-reflection term**, so a puddle reflecting the
   clouds (§6.5) needs one, shaped like the sea's `skyLight`.
6. **Bake mode.** `mix(lit, baked, saturate(bakeMode))` L1468 discards every light term in bake
   modes 1 and 2. Keep any weather term out of `ground`, `riverColor`, `normal`, `flat` and
   `river`, the inputs of `baked` (L1457–1467).
7. **The relief gate is not a light gate.** `gate` (L666–671) fades the detail bands to zero
   before the switch to the sphere. A cloud term must **not** take `gate`, because the sphere
   carries the same term on the other side.
8. **Per-patch coordinates** for any fine lattice the shadow or clipmap reads go through the
   wear record (§8) and `placeEye` per frame, never `anchor + local` as an absolute float32
   (rule 58).

### 3.5 What one ground fragment costs today (read off the graph)

| Read                | Count                                                                                                                                                                        | Where                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Air tables          | 10 per fragment: `sunThrough` 2 + march 4×2; 14 under Enhanced from outside the air (+4 `clearedBeam` overhead reads in a uniform `If`)                                      | air.ts L319, L327, L794, L810  |
| Deposit slope table | 4 `textureLoad`s when `patchLevel ≥ 0`                                                                                                                                       | `slopeTable.ts` L78–110        |
| Albedo map          | 1 gradient sample, mapped bodies only, in `If(mapped)`                                                                                                                       | terrain.ts L1180–1190          |
| Baked noise (3D)    | 0–3 by footprint: micro 1 (L1045–1056), grain 2 (L1076–1096), each in an `If` on its fade and on `detailBands`. Macro and gullies are arithmetic (`latticeNoise`, `stripes`) | terrain.ts L702–729, L985–1038 |

- Cost is controlled by **uniform branches, not multiplies by zero** (`detailBands` L365, "a
  noise multiplied by zero is a noise evaluated"), and the quality lever (`render/quality.ts`
  `GroundDetail` L18, `groundBandsFor` L80) drives `setQuality`. A cloud-tap lever would follow
  the same pattern: a uniform plus an `If`.
- The plan's "four taps per terrain fragment" (§6.3, §9 "Shadowed air … four per terrain
  fragment") is one shadow tap per march sample. **Inference:** the full count is 4 + 1 (the
  beam at the point, which no march sample lands on) + up to 4 more for Ψ's column diffuse
  transmittance, unless the column depth rides in the same texel as the sun's optical depth.
  So 5–9 new reads against today's ~14–18.
- Retina context (`design/plans/perf.md` L363–375): the held ground frame is 12.39 ms at 1080p
  and 26.20 ms at 2880×1800; the Retina ground runs 30–34 fps and the Retina descent misses
  vsync on 192 of 502 intervals. 877/944 patches and ~7.2–7.7 M triangles (L394–396). Measure
  A/B with `ir.gpu()` in one boot (`docs/guides/harness.md` L660–700). Apple timestamps are
  latency, not share.

### 3.6 The host: `apps/game/src/scene/TerrainPatches.tsx`

`useTimedFrame('terrainPatches', …)` L98 at priority 0 writes, every frame: `setQuality` L125,
`setPalette` L127, `setSlopeTable` L128, `setPixelAngle(display·perSample, display)` L150,
`setAlbedoMap` L160–163, `albedoScale` L168–174, `sunDirection` (body-fixed) L185, `sunColor`
L187, `sunIntensity = visibility ? 1 : light` L189, and `air.set/lift/clear` L192–201. Per patch
it sets position, quaternion and `placement.scale` (L232–246) and calls `placeEye(...)`
L250–256. A per-frame `cloudShadow.set(...)` and any per-patch shadow or clipmap origin belong
here. The warm-up runs `warmAtMount` → `warmCompile` on `groundDummy(material)` L82–96 (rule
61).

---

## 4. The sea sheet: `apps/game/src/render/water.ts` (724 lines) + `seaReflection.ts` (406)

### 4.1 Where it exists, and two builds

- A sheet is drawn only where `palette.sheet > 0` (`WaterPatches.tsx` L120), meaning a
  **mapless** body with a liquid and a sea datum (`packages/rendering/src/terrainPalette.ts`
  `seaSheetDatum` L263–271, `sheet: patchWater(body).seabed ? 1 : 0` L488). **Earth has no
  sheet.** Its sea is the photograph painted by the ground material, and on a mapped body the
  ground's `water` is 0 (`flat` and `river` are both × `invented`, L812–824). So Earth's
  streamed ocean has no Fresnel sky reflection and no sun glint, while Earth's sphere does have
  the glint (`specularStrength: relief ? 1 : 0`, `bodyUniforms.ts` L430). The overcast-over-water
  plate on Earth therefore lands on `terrain.ts`, not `water.ts`, unless Earth gains a sheet.
  This is an open question for phase 3.
- `const build = (options: WaterBuild)` L325. `full = build({ refraction: true, reflection:
true })` and `plain = build({ refraction: false, reflection: false })` L672–673. `material` is
  a getter returning `selected` L677–679, and `materials: [full, plain]` L680. Both builds share
  every uniform (L270–318). The varyings and the noise binding are per build (L326–328). A probe
  or shadow texture node is likewise per build, and **both** are warmed (`WaterPatches.tsx`
  L60–77 loops `water.materials`).

### 4.2 Lighting, in graph order (`shading = Fn(() => …)` L361–655)

```ts
const up = normalize(anchorDirection + local/|anchor|)                // L371
const view = normalize(eyeLocal − local)                               // L372–373
const normal = bumped(up, slope)                                       // L443 (wave normal)
const sun = normalize(sunDirection); const incidence = dot(up, sun)    // L447–448
const daylight = smoothstep(−BEAM_TERMINATOR, BEAM_TERMINATOR, incidence) // L451–455 (no pastHorizon: the-air.md open defect)
const pointUnits = (anchor + local)/datumRadius                        // L458
const dayColor = sunColor·sunIntensity                                 // L462
const sunlight = dayColor·sunThrough(air, pointUnits, sun)             // L463  ← BEAM
const diffuse = min(skyStrength·SKY_FRACTION, 1); const deep = deepSky(skyStrength) // L467–468
const fresnel = 0.02 + 0.98·(1 − saturate(dot(normal, view)))^5         // L472–473
const skyView = float(1)                                               // L515
const diffuseLight = max(incidence,0)·daylight·(1 − diffuse·(1 − deep))·sunlight     // L516–519
  + mix(skyColor·diffuse·skylightLeft(incidence, 0.25)·dayColor, skyOverhead·skyView, deep) // L520–529 ← SKY (body light)
  + skyView·visibilityAmbient·dayColor                                 // L530
const bodyLight = liquid·diffuseLight                                  // L531
const subsurface = frame ? mixPerChannel(bodyLight, frame.rgb/sceneRadianceGain, transmittance) : bodyLight // L534–541
const skyLight = mix(skyColor·min(skyStrength,1)·skylightLeft(incidence, 0.15)·0.9·dayColor,
                     skyOverhead·0.9, deep) + visibilityAmbient·dayColor // L552–560 ← REFLECTED SKY
let glint = (pow(lobe,1800) + 0.32·pow(lobe,110))·glintFresnel·daylight·60 // L561–571, lobe on the wave normal
let reflection = skyLight                                              // L580
// full build only, L581–609:
//   land = landReflection(frame, { position: positionView, direction: reflect(normalize(positionView), toView(normal)), up })
//   reflection = mix(skyLight, land.rgb/sceneRadianceGain, land.a·reach);  glint *= 1 − mirrored
let color = mix(subsurface, reflection, fresnel) + sunlight·glint      // L613–615
color = mix(color, 0.55·diffuseLight, foam·0.75)                       // L627–640
color += glow                                                          // L644
const marched = airToward(air, eyeUnits, pointUnits, sun)              // L651  ← AIR
return color·marched.transmittance + marched.inscatter·dayColor·ATMOSPHERE_GAIN // L652–654
```

### 4.3 The reflected sky, and where a cloud probe stands

- `skyLight` (L552–560) is **direction-independent**. It varies per fragment only through
  `incidence = dot(up, sun)` and never reads the reflected direction. Today the sea mirrors a
  uniform sky. The probe (§6.5, phase 1) makes it directional for the first time.
- The reflected direction is not computed in body-fixed axes anywhere. It exists only in view
  space, only in the `full` build, and only inside `If(reach > 0)` for the land search (L593–603:
  `reflect(normalize(positionView), toView(normal))`). A probe lookup wants
  `R = reflect(view.negate(), normal)` in body-fixed axes (`view` and `normal` are both
  body-fixed unit vectors here), available in **both** builds.
- Composition order. The land search must keep winning over clouds (a cliff stands in front of
  the deck). So the probe goes on `skyLight` **before** the land mix:
  `skyWithWeather = probe.rgb + probe.transmittance·skyLight` (inference: the obvious "clouds in
  front of the air" form), then `reflection = mix(skyWithWeather, land, mirrored)` at L605–607.
  The glint is already `× (1 − mirrored)` at L608. Under a cloud the glint takes
  `cloudSunlight` through `sunlight` (L614), because the glint is the sun's disk occluded along
  the sun ray from the sea point. Do not use the probe's transmittance along R for it.
- From orbit and far off (§6.5), the far-atlas slab evaluation along R starts from the sea
  point. The sea stands on its datum, so its height over the datum is 0 by construction. Form
  the shell crossings from heights (`t = −μ + sqrt(μ² + 2h + h²)` in datum units, μ =
  `dot(up, R)`) and never from `length(point) − R` (rule 52). Sampled sheets (lakes) stand at
  the field's own water, not the datum: `patchWater(...).sampled`, `terrainPalette.ts`
  L307–311.
- `skylightLeft(incidence, 0.15)·0.9` is today's stand-in for sky radiance and its twilight
  fall. The probe's `transmittance` multiplies it, and the probe's `radiance` adds the clouds'
  own light.

### 4.4 The glint

The exponents 1800 and 110 are literals in the graph (L566–567). "The sea under rain loses the
sharpness of its glint" (§7.3) makes them functions of a rain or wetness uniform. Make that a
uniform, not a build option, so that no pipeline is added.

### 4.5 Depth, transparency, draw order, split

- `material.transparent = true` L336, `material.depthWrite = true` L337, `sensorRadiance(…,
false, false, 0.3)` L330–335 (reactive 0.3). `opacityNode = smoothstep(0.02, 0.5,
max(waterDepth, 0))` L664–668 is the soft shoreline. Default renderOrder 0.
- Being transparent puts the sheet after every opaque draw. Within the transparent list it
  sorts by `groupOrder`, `renderOrder`, then z back to front, then id, all reversed for reversed
  depth (`render/sceneOrder.ts` `installSceneOrder` L10–24). At renderOrder 0 it interleaves by
  z with the atmosphere shells (`materials.ts` L425–427: transparent, `BackSide`, no depth
  write).
- The `full` build's frame read (`seaFrame(shifted, options.reflection)` L505–507 →
  `SeaFrameNode`, `seaReflection.ts` L124–256) **ends the scene pass, copies color and depth,
  and resumes it**, exactly once per render. `updateBefore` L173–255 holds
  `encoder.beginRenderPass` to slip the depth copy into the same split. Pinned by
  `water.gpu.test.ts` L186–219: full is `['scene', 'scene after copy']`, plain is `['scene']`.
  This is the "copy, not a hook" the plan's §5.6 rejects as a composite insertion point.
- `landReflection` returns `vec4(0)` on non-WebGPU backends (`seaReflection.ts` L318–320), the
  precedent for a backend-gated branch built inside `Fn((builder) => …)`.

### 4.6 The host: `apps/game/src/scene/WaterPatches.tsx`

`useTimedFrame('waterPatches', …)` L79 sets `setQuality` L83, `setPalette` L86, `setPixelAngle`
L91, `sunDirection` (body-fixed, `Q.conjugate(orientation)`) L101–105, `sunColor` L107,
`sunIntensity` L109, `air` L112–117 and `setTime(renderTime)` L118. Per sheet it calls
`placeEye(...)` L159–165. The sea's wear record has no `anchorAltitude` (§8).

---

## 5. The sphere: `apps/game/src/render/planet.ts` (972 lines)

### 5.1 Inputs and frames

- `export interface PlanetMaterial` L180–266. Key uniforms: `sunDirection` ("Unit vector toward
  the star, **render space**") L183, `spinAxis` L187, `center` L189, `lunarLambert` L202,
  `terminator` L230, `nightStrength` L231, `seaLevel` L235, `flattening` L241, `air` L243,
  `cloudHeight` L253, `cloudShadow` L254, `ring*` L260–262, `setTextures(maps)` L263,
  `setBake(maps | null)` L265.
- Texture nodes L276–304: `albedoMap(WHITE)`, `normalMap(FLAT_NORMAL)`, `nightMap(BLACK)`,
  `cloudMap(CLEAR)`, `ringMap(RING_WHITE)`, `bakeMap`/`bakeRelief` (two separate cube
  stand-ins; rule 57 L157–167).
- **One graph for every body.** "a hundred and thirty bodies that differ only in their uniforms
  and texture bindings compile once. A branch per body would be twenty-eight pipelines"
  (L60–64). So every weather term on the sphere is a uniform or a uniform `If`, never a variant.
- Frames: `geometric = normalize(normalWorld)` L365, `view = normalize(cameraPosition −
positionWorld)` L403, `light = normalize(sunDirection)` L404, all render space. The
  body-fixed direction is `bakeDirection = normalize(positionLocal)` L381, valid because the
  mesh's local frame is the body's (`Bodies.tsx` L447–452 copies the body quaternion). There is
  **no body-fixed sun uniform**. A body-fixed `cloudSunlight(point, sun)` on the sphere needs
  one, written by `Bodies.tsx` as `Q.rotate(Q.conjugate(orientation), sun)`, exactly as
  `TerrainPatches.tsx` L181–185 does (recommendation).
- Air units L494–503: `meshUnits = unstretch(positionWorld − center)/seaLevel`, `pointUnits =
normalize(meshUnits)·max(length(meshUnits), 1)` (**the datum under the fragment**; the mesh is
  sunk under it), `eyeUnits = unstretch(cameraPosition − center)/seaLevel`, all render-space
  axes.
- **Most of the graph is built at material scope**, outside any `Fn` (L339–563). Only
  `colorNode` is a `Fn` (L588–628). A `cloudSunlight` that emits statements (`If`, `toVar`,
  `Loop`, cascade selection) must be called inside that `Fn`, or it is never emitted. Planet.ts
  L579–586 describes exactly this failure for the air march. Today `cloudShade`/`lit`/`diffuse`/
  `glint` are material-scope nodes that the `Fn` reads, so moving the shadow into the `Fn`
  means moving `lit`, `diffuse` and `glint` with it.

### 5.2 Lighting, in order

```ts
const incidence = dot(geometric, light)                                // L408
const daylight = smoothstep(−terminator, terminator, incidence)        // L409 (band = body's relief, 6° on Mars; rule 59's one unshared term)
const ringShade = 1 − throughRing·ringSample.a·ringOpacity·0.92        // L420–441 (analytic ray–plane crossing)
// the deck's shadow (L443–464):
const upwards = max(dot(geometric, light), 0.12)
const reach = cloudHeight.div(upwards)
const cosLatitude = max(sin(surfaceUv.y·π), 0.15)
const shadowUv = vec2(surfaceUv.x − dot(light, east)·reach/(cosLatitude·2π),
                      surfaceUv.y + dot(light, north)·reach/π)
const cloudCover = cloudMap.sample(shadowUv).a
const cloudShade = oneMinus(cloudCover.mul(cloudShadow))               // cloudShadow = 0.55 with a map, else 0
const photometric = mix(mu0, 2·mu0/(mu0 + mu)·sign(mu0), lunarLambert)  // L468–472, identical to terrain L1323–1324
const sunlight = dayColor.mul(sunThrough(air, pointUnits, light))      // L503
const lit = daylight.mul(ringShade).mul(cloudShade)                    // L504  ← where cloudSunlight replaces cloudShade
const albedo = mix(rich, oceanColor, ocean·0.65)·albedoScale           // L527
const diffuse = albedo·photometric·sunlight·lit·limbShade              // L534
const glint = (pow(lobe, sharp) + 0.32·pow(lobe, sharp/16))·fresnel·60·ocean·specularStrength·lit // L553–563
// colorNode Fn (L588–628):
const marched = airToward(air, eyeUnits, pointUnits, light)            // L589
const veilLight = marched.inscatter·dayColor·ATMOSPHERE_GAIN·ringShade // L590–593 (ring shades the veil; the deck does not)
const surfaceLight = diffuse + sunlight·glint + liquidGlow·ocean       // L605–607
const shadedSurface = surfaceLight·marched.transmittance + veilLight   // L608
const night = nightMap.rgb·smoothstep(0.05, −0.14, incidence)·nightStrength
              ·(1 − cloudCover·0.85)·marched.transmittance             // L617–625
return shadedSurface + night                                           // L627
```

Values come from `render/bodyUniforms.ts`: `cloudShadow: maps.clouds ? 0.55 : 0` L432,
`cloudHeight: appearance.clouds === null ? 0 : altitude/trueRadius` L433–436. `Bodies.tsx`
writes them at L525–526.

### 5.3 What the existing cloud term gets wrong (verified by reading; not observed in a frame)

1. **The shadow ignores the deck's drift.** The deck draws its map at `vec2(uv.x + drift,
uv.y)` (`createCloudMaterial` L728–730), with `drift = time/deck.rotationPeriod −
time/body.rotationPeriod` (`bodyUniforms.ts` L483) written at `Bodies.tsx` L551. The sphere
   samples `cloudMap` at `shadowUv`, built from the **undrifted** `surfaceUv`, and has no drift
   uniform (`rg drift planet.ts` hits only the cloud material). For Earth (25.5 h deck against
   an 86,164 s day) the drift moves −7.1 × 10⁻⁷ turns/s, 22° of longitude a day. At a
   present-day `renderTime` (~8.2 × 10⁸ s) it is hundreds of turns, so the shadow lies at an
   arbitrary longitude from the clouds that cast it. Arithmetic is mine, from the code's
   formulas. `bodyUniforms.test.ts` L242 pins only the drift's value.
2. **It projects from the true altitude, not the drawn shell.** `cloudHeight` is the deck's
   12 km/R. The shell is drawn lifted to at least 0.4% of R (`bodyUniforms.ts` L458–459), which
   is 25.5 km on Earth, so the drawn parallax and the shadow's offset disagree by about 2×.
3. **Night lights are dimmed by the sun-projected cover.** L621 reuses `cloudCover`, sampled at
   the **sunward-displaced** `shadowUv`. On the night side `upwards` clamps to 0.12, so the
   sample sits about 8× the cloud height (~100 km on Earth) toward the sun. A city is hidden by
   cloud along the **view** ray. Inference: under the volume this becomes the cloud
   transmittance from the composite or a view-ray atlas read, and §6.6 spreads the emission
   over the base.
4. **No skylight, no deep sky, no `visibilityAmbient`.** The sphere draws the whole beam
   (`design/plans/the-air.md` L118–125, "Mars's ground takes a fifth of its light from a sky the
   sphere does not have"). See §9 for why this decides rule 59 under a cloud.

### 5.4 Hook points

1. Replace `cloudShade` in `lit` (L504) with `cloudSunlight(bodyFixedDatumPoint,
bodyFixedSun)`. That keeps the shadow on both `diffuse` and the glint. Retire
   `cloudShadow`/`cloudHeight` (interface L253–254, `bodyUniforms.ts` L79–80/L432–436,
   `Bodies.tsx` L525–526) when the deck retires in phase 3. Until then Earth keeps the deck
   (`§10`: "no frame on `main` takes Earth's clouds away").
2. Add the sky term the ground has (§9) to `diffuse`, or the gate steps under every shadow.
3. Per-sample air hooks reach the sphere through `airToward` L589 (§2.1). The veil is
   multiplied by `ringShade` (L593), the precedent for a sun-ray occluder dimming the air in
   front of a surface.
4. The sphere becomes the far march for a clouded body the trace does not serve (§5.4–5.5).
   That is a large addition to a one-pipeline graph, so it must be a uniform branch, as `baked`
   (L305) is.
5. Wetness (phase 4) darkens `albedo` at L527, matched in mean to the ground's darkening.

### 5.5 The deck that retires: `createCloudMaterial()` L713–789

A second sphere mesh sharing `spheres[0].geometry` (`Bodies.tsx` L349–355), `renderOrder = 1`,
transparent, `depthWrite = false`, `sensorRadiance(…, 'alpha')` (the deck's alpha is the
reactive mask, per ADR-0044). `colorNode = cover.rgb·baseColor·sunColor·sunIntensity·glow·(max(incidence,
0)·0.96 + 0.04)·daylight` L759–765, with `daylight = smoothstep(−0.22, 0.12, incidence)` L737.
`opacityNode = cover.a·opacity·daylight·entry` L770, where
`entry = smoothstep(0, entryDistance, eyeAltitude)` L769 and `eyeAltitude` comes from the CPU
`cloudShellAltitude` (`bodyUniforms.ts` L465–470). Tests that move with it: `cloudEntry.gpu.test.ts`
(two cases), `materials.gpu.test.ts` "the clouds" stand-in L366–377 and "the planet, its clouds
and its rings" L162–172, `bodyUniforms.test.ts` L198/L201–206/L242.

---

## 6. The hull's key light

### 6.1 `apps/game/src/scene/CameraRig.tsx` (220 lines)

- Three lights in JSX L208–218: `<ambientLight intensity={0}>`, `<pointLight distance={0}
decay={0}>` (the key), and `<directionalLight position={[0,0,1]}>` (the fill).
- `useTimedFrame('cameraRig', updateCamera, −0.5)` L206 runs before every priority-0 consumer
  and before `Bodies` computes the air.
- Ambient and fill: `nearFieldLighting(policy, calibrated)` L77–80 gives Photographic
  `{0, 0}`, Enhanced `{ambient 0.16, fill 0.35}`, Staging `{0.16, 1.6}`
  (`packages/rendering/src/nearFieldLighting.ts`). Under Enhanced each is × `staged =
integratedGainFor(engine.exposure.total)` L85–90, which is **last frame's** reading.
- Key, L156–167:
  ```ts
  light.current.intensity = 4 * (engine.visibilityProcessing ? staged : (star?.sunlight ?? 0))
  light.current.position.set(star.placement.position.x, …)   // render space
  light.current.color.setRGB(star.color.r, star.color.g, star.color.b)
  ```
  No air transmittance (`design/plans/the-air.md` L50–60 lists that as open) and no cloud.
- Fill aim L188–203: `FILL = −viewDir − 0.85·toStar`, normalized (`FILL_OFF_AXIS = 0.85` L50).
  It "switches itself off on lit surfaces and covers exactly the ones the key cannot" (L22–28).
  **Gotcha (inference):** under a cloud the key goes dark but the fill still subtracts the key's
  direction, so the sunward faces get neither key nor fill. An overcast hull reads lit from the
  wrong side. Photographic mode has no ambient and no fill at all, so under an overcast the
  photographic hull is black but for its emissive windows. Nothing in the plan gives the near
  field a sky irradiance.

### 6.2 Which materials the key reaches

Every `MeshStandardNodeMaterial` made by `rebuildShipMaterial(source, anisotropy)`
(`render/shipMaterial.ts` L19–72; `rebuildMaterials(root, anisotropy)` L82–99): the hulls
(`render/shipModels.ts` L62), the astronaut (`render/astronaut.ts` L45), surface structures and
stations (`render/surfaceModels.ts` L15; `scene/Stations.tsx`, `scene/SurfaceStructures.tsx`),
and the debug cone (`scene/debugMaterials.ts`). `render/ships.ts` is only the manifest
(`SHIP_SPECS`, `SHIP_IDS`, `DEFAULT_SHIP = 'enterprise-d'`) and carries no lighting. Ship pose:
`ShipModel.tsx` L99–150 sets `group.position`/`quaternion` from `scene.entities` (render space),
or from the cinematic's prop.

### 6.3 GPU hook options in three r185 (read from `node_modules/.pnpm/three@0.185.1/.../src/nodes/lighting/`)

- **`light.colorNode`.** `AnalyticLightNode` constructor:
  `this.colorNode = ( light && light.colorNode ) || uniform( this.color ).setGroup( renderGroup )`
  (`AnalyticLightNode.js` L54). `PointLightNode.setupDirect` passes `color: this.colorNode`
  (`PointLightNode.js` L89–95). A `pointLight.colorNode = keyRadiance.mul(cloudSunlight(…))` is
  evaluated per fragment in every lit material, so it can read `positionWorld`. Caveats, all
  read from source: (a) `update()` still writes `light.color × intensity` into `this.color`,
  which the custom node no longer reads, so the node must carry color × intensity itself (a
  uniform the CPU writes); (b) the light node is created once per light and cached
  (`LightsNode.js` L265–275, `_lightsNodeRef` WeakMap), and `LightsNode.customCacheKey` hashes
  `colorNode` only for spot lights (L157–162), so set it **before the first build** and never
  swap it; (c) this reaches under three's documented surface for point lights. The plan's §12
  names that risk class ("the code a three upgrade breaks first").
- **`light.shadow.shadowNode`** (`AnalyticLightNode.js` L204–246) multiplies
  `colorNode·shadowNode`, but only when `renderer.shadowMap.enabled`, `light.castShadow` and
  `object.receiveShadow` are all set, and a casting `PointLight` renders cube shadow maps. Nothing
  in the repository uses shadow maps (`rg shadowMap|castShadow` is empty). Not recommended.
- **The point.** `positionWorld` in the hull's fragment is render space and compressed or rebased.
  The cloud field is body-fixed. Either the light's node converts with a body-relative matrix
  uniform, or the "own point" is one uniform (the ship's body-fixed position from float64 on the
  CPU) read by a 1-texel GPU evaluation. A hull is ~640 m long (Enterprise-D), against
  kilometer-scale shadow edges.
- Shared node: a module-level node read by the hull's light and the flare (§7.3), on the
  `stagedLight`/`skyOverhead` precedent in `radiance.ts`, keeps one evaluation a frame. That is a
  recommendation, not existing code.

---

## 7. The flare

### 7.1 Visibility is computed on the CPU, analytically

- `scene/SunFlare.tsx` `useTimedFrame('sunFlare', …)` L47–131 at priority 0. Occluders are every
  drawn body as a sphere of `placement.scale`. The body the eye stands on is lifted toward the
  ground under it by `standingWeight(ground.eye/ground.ground − 1)` (L75–86;
  `flareMath.ts` `standingWeight` L90–92, `STANDING = 0.02` L75).
- `sunVisibility(camera, sun, occluders, sunRadius = 0.0047): FlareVisibility` (`flareMath.ts`
  L109–176) returns `{ visibility, graze, eclipse }`. It takes the closest approach of the sight
  segment to each center, `smooth(0.985, 1.03, ratio)` (L64–65, L140), and the horizon test
  under `STANDING` radii (L141–157).
- `flare.update(camera, sunWorld, starColor, brightness, angularRadius, occlusion, artifacts,
coronaDrive, lens, natural?, anamorphicDrive?, coreGain?, occluders?)`
  (`flare.ts` L302–352, L396–618) computes `strength = occlusion.visibility·fade·(0.35 +
0.65·brightness)` L419, with an **early-out** `group.visible = false` when `strength < 0.003 &&
coronaStrength < 0.003` (L433–436). Each element's `intensity.value = spec.gain·strength·nearSun·onDisk·lens·(core
&& !natural ? 0 : 1)·(glow ? coreGain : 1)` (L609–616), and the tint is reddened by
  `occlusion.graze` (L586–591).

### 7.2 Element materials (`elementMaterial(kind)` L139–298)

`sensorRadiance(new MeshBasicNodeMaterial(), true)` (overlay) L268;
`material.colorNode = color.mul(profile).mul(intensity).mul(stagedLight)` L272, built at
material scope with no `Fn`. Custom additive blending with alpha left untouched (L288–294),
`depthTest = false`, `depthWrite = false` L295–296. Every quad has `renderOrder = 10`
(L361–383), quads sit at camera-space depth 20 and are snapped to the camera each frame
(L439–440). The seven `ELEMENTS` quads (L102–113) compile at most four pipelines, one per
kind (glow, streak, disc, ring); the corona and the anamorphic streak add one each. Warmed by
`SunFlare.tsx` L32–45 (`warmCompile`). A GPU cloud factor in the shared `colorNode` line keeps
that count, because every kind gets the same extra read.

### 7.3 Hook for §6.4 ("on the GPU, no readback")

- Multiply each element's `colorNode` (L272) by a GPU-evaluated eye-to-sun cloud transmittance:
  `cloudSunlight(eye)` toward the star. Because every flare pixel shares one value, evaluate it
  once a frame into a 1-element storage buffer or a 1×1 texture, and read that in `colorNode`.
  The star-extinction cache is a precedent for GPU results read by a material
  (`render/starExtinctionCache.ts`, `storage` and `instancedBufferAttribute` imports L7–20).
- The CPU early-out at L433–436 cannot see clouds. With a GPU factor the group stays visible
  and is dimmed to ~0, which is harmless. Do not try to make the CPU aware; that is the readback
  §6.4 forbids.
- Photographic (`natural = false`, `SunFlare.tsx` L124): the core glow's intensity is 0 (L615)
  and the sensor's PSF (`render/psf.ts` `PsfNode`, a post pass over the frame) makes the glare
  from the disk's pixels. **Inference:** once the composite covers the disk, the PSF glare dims
  with no flare change. Ghost elements still need the GPU factor.
- The disk itself: `createStarMaterial` (`materials.ts` L134) is opaque, and `Bodies.tsx`
  L640–660 dims it through the air on the CPU (`diskThroughAir`). §6.4 puts it behind the clouds
  in the composite, so no change is needed in the star material.
- Same-frame requirement: the shadow, or the eye's transmittance, must be written before the
  sensor's scene pass draws the flare and the hull (sensor `useTimedFrame` priority 1,
  `scene/Sensor.tsx` L147–156). A value computed inside the scene pass after these draws lags a
  frame. That is an inference from the ordering.

---

## 8. Wetness candidates: what `wear.ts` and `groundWear.ts` actually are

### 8.1 They are not wetness

- `apps/game/src/render/wear.ts` (122 lines) is "What a mesh wears to be drawn as the ground or
  the sea": the typed per-mesh record the materials read through `onObjectUpdate` uniforms.
  `GroundWear` L21–66 has `eyeLocal`, `morphBand`, `morphEdges`, `morphCorners`, `anchor`
  (float32-rounded), `anchorAltitude` (float64 against that rounding), `grainOrigin` (anchor
  reduced mod the grain period in float64), `level`, `macroCell` and `macroOffset` (the anchor
  split over the 4 km macro lattice in float64). `NO_SLOPE_LEVEL = -1` L73. `SeaWear` L76–83
  has the same eye, morph and anchor, plus `waveOrigin`, and **no** `anchorAltitude`. Readers:
  `groundWearOf(object)` L117–119, `seaWearOf(object)` L121–122. Keys: `GROUND_WEAR =
'groundWear'`, `SEA_WEAR = 'seaWear'` L85–86.
- `apps/game/src/render/groundWear.ts` (462 lines) is the dresser: `attachCover` L87–112,
  `disposeKeepingSharedIndex` L126–129 (rule 55), `patchGeometry` L153–179, `sheetGeometry`
  L182–207, `wearGround(object, anchor, datumRadius, level)` L248–269, `anchorGround` L289–321
  (the float64 reductions), `wearSea(object, anchor)` L330–349, `placeEye(object, eye,
morphStart, morphEnd, finerEdges)` L362–384 (per frame), and the warm-up dummies `groundDummy`
  L409–434 and `seaDummy` L437–449.
- **Their role in the weather:** the record is where any **per-patch, float64-reduced
  coordinate** for a new lattice goes. That covers the shadow cascade's or grid's origin, the
  clipmap's origin relative to the patch anchor, and a tile frame for wetness. It is the
  `macroCell`/`macroOffset`/`grainOrigin` pattern rule 58 requires. A field added to
  `GroundWear` must also be added to `UNDRESSED_GROUND` (L94–105) or `UNDRESSED_SEA` (L107–114), `wearGround` and
  `anchorGround`. Per-frame values (a scrolling cascade) belong in `placeEye` or a sibling,
  called from `TerrainPatches.tsx` L250 and `WaterPatches.tsx` L159.

### 8.2 What wet-related state exists today

- The cover's `wet` channel is **rivers**: "Standing liquid in a channel"
  (`packages/universe/src/cover.ts` L64–73, `wetCover` L233–236), packed in byte 4
  (`packCover` L513–524). The shader reads it as `cover2.x`, `river =
saturate(cover2.x)·invented` at `terrain.ts` L823. It is static per vertex and generated with
  the heightfield, so it is not rain.
- Bytes 6 and 7 of the cover are written as zero and "read by nothing", reserved for the
  canonical slope (`cover.ts` L508–511). They are vertex data uploaded once per patch, so they
  cannot carry time-varying wetness. They could carry a static puddle propensity (inference).
- The water terms rain would extend: `water`/`flat`/`river`/`dry` (L812–825), `surfaceRoughness`
  (L1234) and the glint gate `.mul(water)` (L1411).
- Plan §4.8: wetness and puddles are the **clipmap's two spare channels** (4 RGBA8 per level, 6
  levels × 256², 250 m to 8 km a texel), so wetness is a texture the ground, the sea and the
  sphere each sample (rule 59, §7.3).

### 8.3 Traps

- **The bake.** The orbital bake draws the ground material in bake modes 1 and 2
  (`orbitalBake.ts` L503–525) and caches the result per body address. It is the sphere's
  reflectance for every generated world. Wetness applied to `ground`/`riverColor` would freeze
  the rain at bake time into the sphere. Apply it in `surfaceAlbedo` and have the sphere apply
  its own.
- **The sphere has to match.** "The ground, the sea and the sphere take wetness alike" (§7.3).
  The sphere's hook is `albedo` (`planet.ts` L527). The sea's is the glint exponents (§4.4) and
  the foam.

---

## 9. Rule 59: why the beam alone is not enough

Rule 59 (`docs/agents/invariants.md` L687–706): the ground and the sphere "share the
lunar-Lambert split and the published photograph", and three terms had to be matched: "skylight
comes _out of_ the direct beam rather than beside it" (15%), the air carried by the ground and
the sea (48%), and the photograph's albedo (9%). Measured gate: 3.1% on Mars and 1.5% on Earth
(a browser measurement, `CONTEXT.md` L5783–5798, `docs/adr/0020-the-face.md` L156–157; **no
test holds it**).

On flat ground (`skyView = 1`), from the code:

- ground ≈ `A·[photometric·daylight·B·(1 − d) + skyColor·d·skylightLeft·dayColor]`, with
  `d = min(0.33·airThickness, 1)` and `B` = beam;
- sphere ≈ `A·photometric·B·lit`.

The two agree in clear air because the ground's sky share `d` came out of its own beam. Put a
cloud transmittance `T` on both beams, and in full shadow (`T → 0`) the ground keeps
`A·skyColor·d·…` while the sphere goes to 0. On Earth (`d = 0.33`) that is roughly a third of
the clear value; on Mars (`d = 0.19`, `the-air.md` L118–125) about a fifth. This is arithmetic
on the code's terms, and it ignores Lommel-Seeliger's view term and `skyColor`'s tint. Today the
sphere is floored at `1 − 0.55·cover` and the ground carries nothing, so the step already exists
in the other direction. Rule 59 plus §6.2 therefore require one of these:

1. the sphere gains the same sky term, which the plan's energy balance makes table-driven and
   per point (this also closes `the-air.md`'s open "a sky the sphere does not have"); or
2. both take one function, `groundLight(point, sun, normal, albedo)`, built from the
   clear-sky table, the deck's diffuse transmission and the base bounce, called by `terrain.ts`,
   `water.ts` (body light) and `planet.ts` alike.

Precision: the ground's point is at its drawn height and the sphere's at the datum. At the gate
the relief is under 8 display pixels (`TERRAIN_RELIEF_PIXELS = 8`,
`engine/terrainStreamer.ts` L278), about 2,000 km up on Earth (L261–265), so the difference in
where each samples the shadow is sub-pixel. Inference.

Other rule-59 asymmetries that exist today and that the weather work meets at the gate (none are
cloud terms; all read from code):

- Enhanced's `visibilityAmbient` is on the ground and the sea, not the sphere (pinned at +3% by
  `surfaceVisibility.gpu.test.ts` L153–160).
- Earth's sphere has a sun glint and city lights; Earth's ground has neither (`water = 0` on
  mapped bodies; no night map in `terrain.ts`).
- The terminator: per point on the ground, the relief band on the sphere (rule 59's named
  exception; `the-air.md` L109–116).
- The sea sheet reflects a sky; the sphere's ocean (bake mask `relief.b`) does not.

---

## 10. Tests that pin this area, or that the weather work moves

| Test                                                                                                                                        | What it pins                                                                                                                                                                                                              | Effect of the weather                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/game/src/render/surfaceVisibility.gpu.test.ts` L93–178, "keeps mapped=%s sphere, ground and bake reflectance consistent across modes" | Ground pixel (36,27) vs sphere pixel (32,32), each within 1% of `expected·gain` across `CAMERA_MODES`; ground ×1.03 under Enhanced; bake mode 1 = `expected` to 5 places. Sun head-on, `airThickness: 0`, uniform deposit | **The natural home for §6.1's "a GPU test holds the sphere's cloud shadow and the ground's to one value at the descent gate".** Add a known cloud field (constant `T`) and an air. No such test exists today |
| same file L180–251, "reserves the %s night-side visibility floor for Enhanced"                                                              | Ground, water and foam night side: > 1e-4 Enhanced, < 1e-7 photographic; twilight > 1e-6 at `airThickness 0.4`                                                                                                            | A cloud-occluded skylight must keep a lit twilight above 1e-6                                                                                                                                                |
| `materials.gpu.test.ts` L722–821, "a magma sea, on the ground and from orbit"                                                               | Sheet glow and sphere glow equal to 3 decimals on the night side                                                                                                                                                          | Template for sea/sphere parity                                                                                                                                                                               |
| `materials.gpu.test.ts` L823–987, "the disk, seen through its own air"                                                                      | Veil over a black disk; Enhanced limb kept off the disk; cleared surface `= bare + airlight`; beam floor; march to the datum                                                                                              | Per-sample cloud hooks must leave these unchanged with no cloud                                                                                                                                              |
| `materials.gpu.test.ts` L401–411, "the atmosphere binds exactly its two scattering tables"                                                  | The shell's fragment has exactly 2 `texture_2d<f32>`                                                                                                                                                                      | **Breaks** if `marchAir` binds a cloud texture unconditionally. Make the hook optional and change the count deliberately                                                                                     |
| `materials.gpu.test.ts` L269–391, stand-in signatures (ground, atmosphere, planet, clouds, rings)                                           | Stand-in program equals real-map program (filter and binding count)                                                                                                                                                       | Every new texture node (shadow, probe, wetness) needs a linear stand-in, one object per node (rules 56, 57), and a case here                                                                                 |
| `materials.gpu.test.ts` L142–210, "every production material compiles"                                                                      | Ground (with `latticeNoise`, `gullyStripes`), planet, clouds, rings, flare, warp, plumes compile                                                                                                                          | A light `colorNode` on the key changes every lit material, so add a hull compile case                                                                                                                        |
| `water.gpu.test.ts` L138–184                                                                                                                | Full sea mirrors the cliff; plain mirrors nothing                                                                                                                                                                         | The probe must not reflect over the land hit                                                                                                                                                                 |
| `water.gpu.test.ts` L186–219                                                                                                                | Pass split: full `['scene','scene after copy']`, plain `['scene']`                                                                                                                                                        | Composite placement (§5.6) must keep or deliberately change this                                                                                                                                             |
| `cloudEntry.gpu.test.ts` (2 cases)                                                                                                          | Deck coverage 0 under the shell; rim fades with nadir                                                                                                                                                                     | Retires with the deck (phase 3)                                                                                                                                                                              |
| `bodyUniforms.test.ts` L198, L201–206, L242                                                                                                 | `cloudShadow` 0.55 with a map and 0 without; `drift` value                                                                                                                                                                | Retires with the deck                                                                                                                                                                                        |
| `flareMath.test.ts` (`sunVisibility`, `ghostCover` …)                                                                                       | CPU geometric occlusion                                                                                                                                                                                                   | A GPU cloud factor leaves these untouched                                                                                                                                                                    |
| `flare.gpu.test.ts` (3 cases)                                                                                                               | Natural glow kept when ghosts are down; anamorphic streak anchoring; core gain                                                                                                                                            | Add a case: glow × cloud factor                                                                                                                                                                              |
| `terrainBands.gpu.test.ts`, `terrainKernel.gpu.test.ts`                                                                                     | The elevation producer's bands against the CPU (ADR-0023)                                                                                                                                                                 | **Not a lighting parity test** despite the name. Unaffected                                                                                                                                                  |

Run one GPU file with `pnpm vitest run --config apps/game/vitest.gpu.config.ts <substring>`
(`.claude/rules/testing.md`). It takes the machine's GPU lock (rule 68).

---

## 11. Rules that apply here, and the naive moves that break them

| Rule                      | What breaks if done naively in this area                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 59 (`invariants.md` L687) | A cloud term on the ground without the sphere, or the reverse, is a step at the 8-pixel gate. **Specifically:** beam-only shadowing leaves the ground's skylight unshadowed against a sphere that has none (§9)                                                                                                                                                            |
| 52 (L562)                 | Height over a cloud shell as `length(p) − R_shell` in float32. Form crossings from CPU heights (`cloudShellAltitude`), or `(2a·l + l·l)/(                                                                                                                                                                                                                                  | p   | +   | a   | )` on the ground |
| 58 (L665)                 | A shadow-cascade or clipmap texel from `(anchor + local)` absolute float32. Carry per-patch offsets in `GroundWear`/`SeaWear` (§8.1). Toroidal wrap decisions in integers                                                                                                                                                                                                  |
| 56 / 57 (L630, L649)      | Nearest `DataTexture` stand-ins for the shadow, probe or wetness compile `textureLoad` and freeze it. Two nodes over one stand-in share one binding. One linear stand-in object per node, as `LUT_WHITE`/`LUT_BLACK`, `RING_WHITE`, `BLANK_RELIEF` do. Better (inference): bind the real cleared texture from boot so the warmed program is the drawn one                  |
| 61 (L713)                 | New bindings change the ground, sea (both builds), planet, flare and hull programs. Warm through the existing `warmAtMount`/`warmCompile` registrations (`TerrainPatches.tsx` L82–96, `WaterPatches.tsx` L60–77, `SunFlare.tsx` L32–45, `ShipModel.tsx` L83–96 ('compiling the cinematic hull'), `ScatterRocks.tsx`, `Bodies.tsx` build-ahead) with the stand-ins in place |
| 60 (L708)                 | `three/webgpu` and `three/tsl` only                                                                                                                                                                                                                                                                                                                                        |
| 53 (L580)                 | Puddles "below a flood level" read the **drawn** ground (presentational), never `groundElevation`                                                                                                                                                                                                                                                                          |
| 15, 2                     | Wetness history is a cache (no save) and reads presentation time (`renderTime`), never `clock.time` (`.claude/rules/rendering.md` first bullet)                                                                                                                                                                                                                            |
| §5.2 r185 hazard          | Shadow reads inside `marchAir`'s `Loop` must name `.level(0)` if the texture has mips. The existing in-loop reads get away without it only because the air tables are single-level                                                                                                                                                                                         |
| `Fn` scope                | The planet graph is mostly material scope (§5.1). Statements outside a `Fn` are dropped silently                                                                                                                                                                                                                                                                           |
| One planet pipeline       | No per-body variants in `planet.ts` (L60–64). Uniform branches only                                                                                                                                                                                                                                                                                                        |
| 68                        | GPU tests and `scripts/drive.mjs` rigs hold the GPU lock. Never run both                                                                                                                                                                                                                                                                                                   |

---

## 12. Open questions for the implementers

1. Earth during phases 1–2: does the ground under Earth's deck take the deck's map as a
   degenerate `cloudSunlight` (port the sphere's projection through `mapUv`, adding the
   missing `drift`), or does today's step stay on Earth until phase 3?
2. Earth's ocean has no sheet, so the overcast-over-water and puddle reflections on Earth land
   on `terrain.ts`. Does Earth gain a sheet, or does the ground gain a reflected-sky term
   (§3.4.5, §4.1)?
3. The sphere's sky term (§9): does it come from the same irradiance table read per point,
   making it a cost on all ~130 bodies' one pipeline, or does `airThickness = 0` gate it out by
   a uniform branch?
4. Hull: one cloud value per object (a uniform) or per fragment (`positionWorld` converted to
   body-fixed)? And does the fill's key-subtraction (`FILL_OFF_AXIS`) take the cloud factor too,
   so an overcast hull does not read lit from behind?
5. Night lights under the volume: which ray dims them (view, not sun), and from which texture
   (composite transmittance or the far atlas)?
6. Does `cloudSunlight` take points in sea-level units (as `sunThrough` does) or meters? Each
   surface's point is in a different frame today: body-fixed for the ground and the sea, render
   space for the sphere and the shell.
7. Do the hull and the flare share one GPU-evaluated eye or ship value a frame, and which pass
   writes it before the scene pass (§7.3)?
