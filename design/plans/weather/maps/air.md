# Map: the air — tables, march, `sunThrough`, the scene unit

Area map for the weather plan (`design/plans/the-weather.md`, phases 0–6) at
tree `feat/the-weather-stacked-prs` (HEAD `c2a50f1`). Everything below was read
from the code. Numbers marked **(computed)** came from scratch scripts that import
`packages/rendering/src/atmosphere.ts` under Node 26 on the CPU; they are not GPU
or browser measurements. Anything marked **(inference)** is a reading of the code,
not something I ran.

Plan sections read first: §3 (clouds stand in the one air), §5.3, §5.6, §6.2, §6.3,
§8.2, §8.3; then ADR-0056 in full, `design/plans/the-air.md`, ADR-0037's limb and
clearing paragraphs, perf.md § The air.

---

## 0. The ten things an implementer must know

1. **One march, four callers.** `marchAir` (`apps/game/src/render/air.ts:266`) is the
   only air integral on the GPU. The shell calls it with 12 samples
   (`materials.ts:368`, `ATMOSPHERE_SAMPLES = 12` at `materials.ts:215`). The sphere,
   the ground and the sea each call it through `airToward` with **4 samples**
   (`SURFACE_AIR_SAMPLES = 4`, `air.ts:481`; callers `planet.ts:589`,
   `terrain.ts:1428`, `water.ts:651`, none passes `samples`). The CPU has a third,
   32-sample column (`zenithSkyRadiance`, `atmosphere.ts:1037`).
2. **The shell is a back-side sphere** (`materials.ts:427`, `side = BackSide`, depth
   test against everything opaque). It survives only _outside_ the planet's
   silhouette. Everything the air does in front of a surface happens in that surface's
   own material. A cloud composite therefore sees two kinds of "air already in the
   scene": the shell's (12 samples, no `clearBeam`, gray alpha) at sky pixels, and
   `airToward`'s (4 samples, beam cleared by half under Enhanced from orbit,
   transmittance mixed toward 1) at surface pixels.
3. **Units are sea-level units about the body's center.** The datum (sea level) is 1
   and the tables' ceiling is `air.top` (= `recipe.topRatio`). The drawn sphere is sunk
   _under_ the datum (9.9 km on Earth). The tables and the march measure the air from
   the datum, and the march holds every point under the datum at sea-level density
   (`air.ts:286`, `height = max(radius − 1, 0)`).
4. **Two tables, both half-float RGBA, linear, clamp, no mips.** Transmittance
   T(r, μ) is 512 (μ ∈ [−1, 1]) × 64 (altitude). Ψ is 32 (μs) × 16 (altitude), stored
   as **ln Ψ** and read geometrically. Both are read at texel centers
   (`texelCentered`, `air.ts:91`). **There is no sky-irradiance table.** The plan's
   §5.3/§6.2 table is new work.
5. **`sunThrough(air, point, sun)`** (`air.ts:784`) is the beam's transmittance at a
   point, and the four materials agree on it. It always costs two table reads (the
   slant and the column overhead, through `clearedBeam`), and under Enhanced from
   orbit it returns a _cleared_ beam, not the physical one.
6. **`clearedFromOrbit(air) = air.limb · enhancedSky`** (`air.ts:763`) is applied in
   exactly two places. One is `airToward`, which mixes T toward 1 and clears the
   in-scatter's beam by `ORBIT_AIRLIGHT = 0.5`. The other is `sunThrough`, which clears
   the beam toward its hue. Both constants (`ORBIT_AIRLIGHT`, `ORBIT_BEAM_HUE`) are
   module-private. The shell never clears.
7. **Scene radiance = march radiance per unit irradiance × π × `dayColor`.**
   `ATMOSPHERE_GAIN = Math.PI` (`atmosphere.ts:266`). `dayColor` is the key star's
   color × `light`, and `light` is **1 for every body under Enhanced staging** but
   `body.sunlight` otherwise (`bodyUniforms.ts:351`, `TerrainPatches.tsx:189`,
   `WaterPatches.tsx:109`).
8. **The scene unit is stated two ways, 1.42× apart.** The air's anchor test converts
   cd/m² through E⊥/π with E⊥ = 133,800 lx, so 1 unit = 42,590 cd/m²
   (`atmosphere.test.ts:284–293`). The sensor, galaxy, stars, star-visibility
   threshold and disk use `SURFACE_LUMINANCE = 30_000` cd/m²
   (`packages/rendering/src/exposure.ts:4`). A third number, `SOLAR_LUMINANCE = 1.6e9`,
   implies 108.7 klx at 1 AU. See §9.
9. **Texture reads in loops.** three r185 emits `diagnostic(off, derivative_uniformity)`
   outside Firefox (`node_modules/.pnpm/three@0.185.1/.../WGSLNodeBuilder.js:247–251`).
   Every air table read today is a plain `.sample()` (`air.ts:421, 436, 810`). That is
   safe in `marchAir`'s constant-count loop (uniform control flow). It is undefined
   inside a cloud march with an early exit. Use `.level(0)` (`TextureNode.level`,
   `TextureNode.js:732`). The tables have one mip, so the value does not change.
10. **Rule 59 is the binding constraint.** Any light term the clouds add to the
    ground's sky, beam or air must go to the sphere and the sea too, and to the
    composite's air. The sphere today has **no skylight term and no
    `visibilityAmbient`** (`planet.ts:534, 605–627`), while the ground and the sea have
    both. That asymmetry already exists.

---

## 1. Files and what each owns

| File                                       | Lines | Owns                                                                                                                                                                                                                                                |
| ------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rendering/src/atmosphere.ts`     | 1,216 | Recipe, both bakes, CPU readers (`sampleLut`, `multipleScatteringAt`, `transmittanceFrom`, `zenithSkyRadiance`), `ATMOSPHERE_GAIN`, limb constants, `visibleThickness`, `limbShare`, `diskThroughAir`. Pure arrays, no three (rule 60, packages.md) |
| `packages/rendering/src/datum.ts`          | 128   | `sunkSphereRadius` (42), `atmosphereShellRatio` (54), `AirHeights` (63), `airHeights` (87), `airTopRatio` (105)                                                                                                                                     |
| `packages/rendering/src/exposure.ts`       | 428   | `SURFACE_LUMINANCE` (4), `SOLAR_LUMINANCE` (5), EV math, `meteredShare` (168), `resolveCameraPolicy` (174), meter (271), `ExposureMeter` (327)                                                                                                      |
| `packages/rendering/src/photometry.ts`     | 20    | `sunlightAt` (5), `stellarLuminance` (8), `stellarIlluminance` (13)                                                                                                                                                                                 |
| `packages/rendering/src/starVisibility.ts` | ~80   | `SKY_VISIBILITY.night = 2e-4 / SURFACE_LUMINANCE` (53), `skyMagnitudeLoss`                                                                                                                                                                          |
| `packages/rendering/src/scene.ts`          | —     | `RenderBody` air fields (62–110). `buildScene` produces `airTop`, `airHeights`, `limb`, `limbFalloff`, `sunlight` (381–436)                                                                                                                         |
| `apps/game/src/render/air.ts`              | 858   | GPU air: `createAirUniforms`, `marchAir`, `airToward`, `sunThrough`, `sunTableAt`, `clearedFromOrbit`, `marchLimb`, `throughLimb`, `limbReachOf`, sample counts                                                                                     |
| `apps/game/src/render/atmosphereLuts.ts`   | 340   | Half-float upload, the per-session cache, pool or main-thread bake, `standingIn`, `airOverhead(Rgb)`, `scatteringOf`                                                                                                                                |
| `apps/game/src/render/atmosphereTask.ts`   | 68    | Worker task `render.bakeAtmosphere` v4                                                                                                                                                                                                              |
| `apps/game/src/render/preloadPlan.ts`      | —     | `scatteringKey` (54–89), `scatteringBakes` (99–118, boot prebake)                                                                                                                                                                                   |
| `apps/game/src/render/radiance.ts`         | 112   | `enhancedSky`, `airLuminance`, `skyOverhead`, `sceneRadianceGain`, `integratedSkyGain`, `stagedLight`, `observerAir`, `visibilityAmbient`, `integratedGainFor`, `setSceneExposure`, `sensorRadiance`                                                |
| `apps/game/src/render/twilight.ts`         | 30    | `skylightLeft` (20)                                                                                                                                                                                                                                 |
| `apps/game/src/render/enhancedSky.ts`      | 34    | `composeSky` (24), `ENHANCED_SKY_GAIN = 2**23`, `ENHANCED_SKY_CEILING = 0.5`                                                                                                                                                                        |
| `apps/game/src/render/materials.ts`        | —     | The shell: `createAtmosphereMaterial` (257–461)                                                                                                                                                                                                     |
| `apps/game/src/render/planet.ts`           | 972   | Sphere (`createPlanetMaterial` 275–676), deck (`createCloudMaterial` 713–789)                                                                                                                                                                       |
| `apps/game/src/render/terrain.ts`          | 1,684 | Ground light and air (1278–1432), `BEAM_TERMINATOR` (1629), `SKY_FRACTION` (1640), `deepSky` (1648)                                                                                                                                                 |
| `apps/game/src/render/water.ts`            | 724   | Sea light, sky reflection, air (445–654)                                                                                                                                                                                                            |
| `apps/game/src/render/bodyUniforms.ts`     | 575   | Per-frame records: `sunColor` (351–356), deck (452–480), shell (503–550), `diskCompression` (290–294), `starAsBody` (301–329)                                                                                                                       |
| `apps/game/src/scene/Bodies.tsx`           | 803   | Writes the air uniforms for the sphere and the shell (510–626), computes `airLuminance`, `skyOverhead`, `observerAir` (662–689), the disk through the air (630–661)                                                                                 |
| `apps/game/src/scene/TerrainPatches.tsx`   | —     | Ground sun (body-fixed, 175–190), air (192–201)                                                                                                                                                                                                     |
| `apps/game/src/scene/WaterPatches.tsx`     | —     | Sea sun (body-fixed, 96–110), air (111–117)                                                                                                                                                                                                         |
| `apps/game/src/scene/CameraRig.tsx`        | —     | Hull lights: staged ambient, fill and key (76–91, 156–167)                                                                                                                                                                                          |

---

## 2. Units, frames and the gain

- **Sea-level units.** A position divided by the datum radius, about the body's center.
  The datum is 1 and the top of the air is `air.top`. The sphere and the shell take
  `(positionWorld − center) / seaLevel`, with `seaLevel = body.trueRadius ·
placement.compression` (`Bodies.tsx:512`, `bodyUniforms.ts:536`). For a giant only,
  they first unstretch along the spin axis by `1/flattening − 1`
  (`planet.ts:494–501`, `materials.ts:296–308`). The ground and the sea take
  `(anchor + local) / datumRadius` in **body-fixed axes** (`terrain.ts:1332–1333`,
  `water.ts:458–459`). Their sun is rotated into body-fixed axes on the CPU
  (`TerrainPatches.tsx:178–186`, `WaterPatches.tsx:96–106`). The sphere's and the
  shell's sun is in render space (`bodyUniforms.ts` `sun = normalize(keyLight −
position)`). Rule: point, eye and sun must share one frame.
- **Datum, not drawn sphere.** `airTopRatio(R, hazeHeight) = (R + h)/R`
  (`datum.ts:105`). `airHeights` puts both scale heights over the datum
  (`datum.ts:87–98`). The sphere's march ends **on the datum under the fragment**,
  `pointUnits = normalize(meshUnits) · max(|meshUnits|, 1)` (`planet.ts:499–500`),
  because a march to the sunk mesh crossed 9.9 km of sea-level air and doubled the
  nadir veil. `materials.gpu.test.ts:977` ("marches to the datum") holds it to 2%.
  The shell stops a ray at the **drawn** sphere (`ground = innerRadius/seaLevel`,
  `materials.ts:335, 358–365`), so the shell's horizon lies under every surface.
  `atmosphereSky.gpu.test.ts:286` holds that.
- **Scene units.** A material's output before `sceneRadianceGain` is in scene units: an
  albedo-one Lambertian surface lit square-on by the body's sun **above the air** is
  `1 × light`. The air's radiance per unit sun irradiance becomes scene units through
  `× ATMOSPHERE_GAIN (π)`. Callers: `materials.ts:410`, `planet.ts:592`,
  `terrain.ts:1432`, `water.ts:654`, and `zenithSkyRadiance` `atmosphere.ts:1093`.
  Then `× dayColor`. Then `sensorRadiance` multiplies by `sceneRadianceGain =
SURFACE_LUMINANCE · pre` and clamps at 65,504 (`radiance.ts:101`).
- **`dayColor`.** Sphere: `sunColor · sunIntensity`. Bodies writes `sunColor =
keyColor · light` and never writes `sunIntensity`, which stays 1 (`planet.ts:502`).
  Ground and sea: `sunColor = keyColor`, `sunIntensity = visibility ? 1 : light`. The
  shell: `sunColor = keyColor · light`. `light = frame.visibility ? 1 : body.sunlight`
  (`bodyUniforms.ts:351`). `body.sunlight` sums `sunlightAt` over every star
  (`scene.ts:400–408`), while the direction comes from `stars[0]` only.

---

## 3. The recipe and the hazes

### 3.1 `atmosphereRecipe(haze, topRatio, heights): AtmosphereRecipe` (`atmosphere.ts:443`)

`AtmosphereRecipe` (`atmosphere.ts:101–148`): `topRatio`, `hRayleigh`, `hMie` (datum
units). RGB per datum radius: `betaRayleigh`, `mieScatter`, `mieExtinction`,
`mieForward`. Also `aerosolSky` (0 or 1), `ozone` (RGB at its peak), `ozonePeak`,
`ozoneHalfWidth`, `detachedPeak`, `detachedHalfWidth`, `detachedExtinction` (gray) and
`detachedScatter` (RGB).

- The gas column is `TAU_RAYLEIGH_SUM = 0.38 · thickness` (`atmosphere.ts:181`), split by
  the authored zenith color, divided by `densityColumn(hR, ceiling)` (`607`). The
  coefficient is τ over the column the faded profile actually holds, not τ/H.
- Aerosol: `depth = haze.aerosolDepth ?? TAU_MIE(0.12)·thickness` at 550 nm, per band by
  Ångström (`BANDS = [680, 550, 440]`).
  - **Gas is the sky** (no `aerosolDepth`): scatter is tinted by `aerosolTint` (636),
    extinction is the untinted slope / `AEROSOL_ALBEDO (0.94)`, and `mieForward =
mieScatter`.
  - **Aerosol is the sky**: extinction is the measured depth. Scatter is `underPeak(color,
albedo)` sideways and `underPeak(limb, albedo)` forward (489–518).
- Ozone is a tent 10–40 km, peak 25 km, in gas scale heights
  (`OZONE_PEAK_HEIGHTS = 25/8.5`, `OZONE_HALF_WIDTH_HEIGHTS = 15/8.5`, 253–254). It
  absorbs only.
- The detached layer is a tent in gas scale heights. It extinguishes gray and scatters
  with Rayleigh's phase.
- One HG asymmetry for every haze: `AEROSOL_ASYMMETRY = 0.7` (209).
  `AEROSOL_FORWARD_PEAK = (1+g)/(4π(1−g)²)` (221) is the lobe's value toward the sun.
  The march turns from `mieScatter` to `mieForward` by `phase.mie / AEROSOL_FORWARD_PEAK`.
- Earth's recipe **(computed)**: `topRatio 1.015696`, `hRayleigh 1.334e-3`, `hMie 1.884e-4`,
  `betaRayleigh [51.0, 87.4, 172.9]`, `mieScatter [489, 645, 862]`,
  `mieExtinction [521, 686, 917]`, `ozone [13.6, 12.4, 0.86]` (per datum radius).

### 3.2 How hazes are parameterized per body

`HazeLayer` (`packages/universe/src/system.ts:311–384`): `height`, `color`, `limb`,
`thickness`, `aerosolHeight`, `aerosolAngstrom`, `ozone`, and optional `aerosolDepth`,
`aerosolAlbedo` and `detached{center, halfWidth, depth, color}`. Nothing in a haze is
canonical. It rides along without spending `system@4` (`versions.ts:52–64`).

**Sol (authored, `packages/universe/src/solar/bodies.ts`).**

| Body                        | Height | Thickness | Aerosol height          | Ångström | Depth / albedo | Notes                                                                                          |
| --------------------------- | ------ | --------- | ----------------------- | -------- | -------------- | ---------------------------------------------------------------------------------------------- |
| Earth (545–575)             | 100 km | 1         | 1.2 km                  | 1.3      | gas-lit        | 300 DU ozone. **Deck sphere**: `clouds: {altitude 12 km, rotationPeriod 25.5 h, opacity 0.92}` |
| Mars (600–640)              | 100 km | 0.0066    | 11.1 km                 | 0        | 0.3 / 0.93     | Dust is the sky                                                                                |
| Venus (495–530)             | 90 km  | 1         | 15.9 km                 | 0        | gas-lit, gray  | **Not the sulfuric family.** The deck is a sphere at 60 km, `opacity 1`, period −4.2 d         |
| Titan (355–390)             | 600 km | 2.7       | 70 km                   | 1.5      | 4.3 / 0.95     | Detached layer at 16 gas H (±2.4), depth 0.02. `clouds: null`                                  |
| Giants (744, 795, 848, 892) | —      | —         | 27, 59.5, 27.7, 19.7 km | 0        | gas-lit        | Mixed with the gas, gray                                                                       |
| Triton (938)                | —      | —         | 10 km                   | 0        | —              | —                                                                                              |

**Generated (`packages/universe/src/appearance.ts:207–294`, `hazeFor` at 296).** A
temperature-gated weighted draw. Applied at `system.ts:1250–1288`: rocky haze `height =
min(ceiling, 0.02 R)`, `thickness = min(1, ρ/1.2)`, and **`clouds: null` for every
generated body** (`system.ts:1259`).

| Family       | Sky / limb          | Aerosol scale           | Ångström | Depth / albedo                                 | T range   |
| ------------ | ------------------- | ----------------------- | -------- | ---------------------------------------------- | --------- |
| Rayleigh     | blue / orange       | 0.14 H (boundary layer) | 1.3      | gas-lit                                        | all       |
| Dust         | butterscotch / blue | 1 (mixed)               | 0        | **0.4 / 0.93**                                 | 150–900 K |
| **Sulfuric** | cream / gold        | 1                       | 0        | **8 / 0.98**. A deck _inside the air's tables_ | ≥ 450 K   |
| Tholin       | orange              | 2.9 (aloft)             | 1.5      | gas-lit                                        | ≤ 170 K   |
| Methane      | teal / warm         | 1                       | 1.5      | gas-lit                                        | ≤ 230 K   |
| Violet       | violet / rose       | 2.9                     | 1.5      | **0.25 / 0.9**                                 | all       |
| Green        | green / orange      | 0.14                    | 1.3      | gas-lit                                        | 200–500 K |

Giants use `KIND_HAZE[kind]` plus `GIANT_AEROSOL` (mixed, gray; `system.ts:1177–1199,
1251`).

**Thin against deep** (`visibleThickness`, `atmosphere.ts:590`; `limbShare`, 378;
`deepSky`, `terrain.ts:1648` = `smoothstep(LIMB_OWN_FROM 2, LIMB_OWN_TO 5, skyStrength)`).
Computed values: Earth 1.000, Venus 1.000, Mars 0.571, dust (thickness 1) 1.526, violet
1.228, Rayleigh 1.000, **Titan 10.37, sulfuric 16.68**. So Titan and every sulfuric
world are _deep_. The ground takes `skyOverhead`, and `limbShare = 0`, so there is no
Enhanced ring and no clearing from orbit. Everything else is _thin_, with
`limbShare = 1`.

**Weather consequence (plan §14, the-air.md).** The sulfuric family already draws an
eight-depth deck inside the transmittance and Ψ tables. Volumetric clouds on such a
world would count the cloud twice. Titan's haze is the same question. Ψ's transfer cap
(`Math.min(f, 0.95)`, `atmosphere.ts:998`) saturates for the sulfuric deck: Ψ inside
it is 2.1× low in 32 of 1,536 texel channels (the-air.md § "The sulfuric deck
saturates Ψ's transfer").

---

## 4. The tables

### 4.1 Parameterization, resolution, format

| Table                 | Constant                                               | Size     | u (columns)                                                    | v (rows)                                             | Stored                                                                                                                |
| --------------------- | ------------------------------------------------------ | -------- | -------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Transmittance T(r, μ) | `TRANSMITTANCE_WIDTH/HEIGHT` (`atmosphere.ts:157–158`) | 512 × 64 | μ ∈ [−1, 1] linear, Δμ = 2/511 = 0.0039 (0.22° at the horizon) | `r = 1 + (y/63)·(top−1)`. **1,587 m a row on Earth** | T to the top of the air along zenith cosine μ. **0 for rays meeting the datum sphere** (`transmittanceFrom`, 765–810) |
| Ψ(r, μs)              | `MULTI_SCATTER_WIDTH/HEIGHT` (160, 166)                | 32 × 16  | μs ∈ [−1, 1], Δμ = 2/31                                        | `r = 1 + (y/15)·(top−1)`. 6.7 km a row on Earth      | **ln Ψ**, floored at `ln(1e-30)` (`MULTI_SCATTER_FLOOR`, 171)                                                         |

Both are uploaded by `toTexture` (`atmosphereLuts.ts:69–88`) as
`DataTexture(Uint16 half, w, h, RGBAFormat, HalfFloatType)`, `LinearFilter` both ways,
`ClampToEdgeWrapping`, `generateMipmaps = false`. Half float because WebGPU guarantees
`rgba16float` is filterable. Alpha is 1.

### 4.2 The bakes (`packages/rendering/src/atmosphere.ts`)

- `bakeTransmittance(recipe): ScatteringLut` (822). `TRANSMITTANCE_STEPS = 48` per texel
  (425). Samples crowd toward the perigee (`marchSample`, 730). The density profile
  `densities` (673) carries the `(1 − h/C)` fade to zero at the ceiling, and sub-datum
  points take sea-level density.
- `bakeMultipleScattering(recipe, transmittance, steps = MS_STEPS 16): ScatteringLut`
  (906). Each grid point takes 64 Fibonacci directions (`MS_DIRECTIONS`, 436), with the
  sun at `[√(1−μs²), 0, μs]`. It accumulates isotropic second-order light and the
  transfer f, then stores `ln(max(L₂/(1 − min(f, 0.95)), 1e-30))`. On the ground row,
  rays aimed down are skipped (942). Each step's light is the constant-density integral
  `stepLight` (1110).
- CPU readers: `sampleLut(lut, u, v)` (843, bilinear at texel centers),
  `multipleScatteringAt(table, recipe, radius, μs)` (1010, exp of a bilinear ln read),
  `transmittanceFrom(r, μ, recipe)` (765, exact 48-step march; the CPU keeps no
  transmittance table).
- Cost: ADR-0056 gives 39 ms a bake (T 15 + Ψ 24). perf.md gives Ψ at 26–28 ms in Node on
  the M5. My one unquiet Node run of both was 60 ms. That is not a measurement.

### 4.3 Where a bake runs, the cache and the key

- `scatteringOf(engine, body)` (`atmosphereLuts.ts:330`) returns null with no haze. With
  a pool it is `scatteringVia` (225), which returns the cached set or null and submits
  `warmScattering` (161). With no pool it is `scatteringFor` (91), a synchronous bake.
  The cache is a module `Map` with no eviction. Sol produces nine keys (`atmosphereLuts.ts:119–127`).
- `AtmosphereScattering` (52–63): `{recipe, transmittance: Texture, multiScatter:
Texture, multiScatterTable: ScatteringLut}`. Only the Ψ floats are kept on the CPU,
  8 KB.
- Key: `scatteringKey(haze, topRatio, heights)` (`preloadPlan.ts:54–89`). It joins color,
  limb, thickness, Ångström, ozone, depth/albedo (or `'gas'`), detached,
  `topRatio.toFixed(6)` and both heights `toPrecision(6)`. The boot prebake
  (`scatteringBakes`, 99) builds the same key from `airTopRatio`/`airHeights`, so rule
  "the datum sphere has one definition" applies.
- Worker task (`atmosphereTask.ts:51–68`): `name: 'render.bakeAtmosphere'`, **`version:
4`**, request `{haze, topRatio, heights}`, response `{recipe, transmittance,
multiScatter}`. It transfers both `Float32Array` buffers ("520 KB a bake"). The file is
  in the worker bundle and **must not import `three/webgpu`**. `atmosphereTask.test.ts`
  holds pool equals main thread equals registry.

### 4.4 Accuracy of the transmittance table at cloud heights (computed, Earth, CPU `sampleLut` against exact `transmittanceFrom`)

Rows are 1,587 m and the aerosol scale height is 1,200 m, so the lowest row is coarse.

| Sun | h = 300 m          | 800 m              | 1,000 m           | 1,500 m | 3,000 m |
| --- | ------------------ | ------------------ | ----------------- | ------- | ------- |
| 60° | −0.9/−1.1/−1.4%    | −1.3/−1.6/−2.0%    | −1.1/−1.4/−1.8%   | −0.3%   | −0.2%   |
| 30° | −1.5/−1.8/−2.1%    | −2.0/−2.5/−2.9%    | −1.8/−2.2/−2.5%   | −0.4%   | −0.3%   |
| 10° | −2.8/−2.6/−0.5%    | −3.9/−3.7/−1.6%    | −3.4/−3.3/−1.6%   | −0.7%   | −0.5%   |
| 5°  | −1.7/**+2.8/+18%** | −3.0/+1.0/**+13%** | −2.8/+0.2/**+9%** | +1.1%   | −0.8%   |

A low cloud base under a low sun reads the beam's blue up to 18% bright. A finer or
warped altitude axis below ~2 km is a phase 0/1 question (inference). The GPU's
half-float storage and hardware filter weights add their own error, which I did not
measure.

### 4.5 How the tables are read in TSL (`air.ts`)

```ts
// air.ts:91 — 0 and 1 are the first and last texel centers, as the bake means them
function texelCentered(c: Node<'vec2'>, [w, h]) {
  return c.mul(vec2((w - 1) / w, (h - 1) / h)).add(vec2(0.5 / w, 0.5 / h))
}
// air.ts:415 (exported)
export function sunTableAt(
  air,
  muSun: Node<'float'>,
  height01: Node<'float'>,
): Node<'vec3'>
// = air.transmittance.sample(texelCentered(vec2((muSun+1)/2, height01), [512, 64])).rgb
// air.ts:430 (module-private)
function psiTableAt(air, muSun, height01): Node<'vec3'>
// = exp(air.multiScatter.sample(texelCentered(vec2((muSun+1)/2, height01), [32, 16])).rgb)
```

`muSun` is the sun's cosine over the sample's own horizontal,
`dot(point, sun)/|point|`. `height01` is `saturate((|point| − 1)/(top − 1))`. A bare
`uv` read lands a quarter texel off the CPU's `sampleLut`, which on Ψ's 32 columns is a
degree of sun and up to 3× in the sky through twilight (`air.ts:82–90`).

---

## 5. The GPU module, `apps/game/src/render/air.ts`

### 5.1 `createAirUniforms()` (141–232), type `AirUniforms` (234)

There is one object per material, and each material owns its own uniform nodes.

| Field                                                                                                                       | Node                 | Default                                                 | Written by `set(recipe, sunTable, psiTable)`      |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `top`                                                                                                                       | `uniform(1)`         | 1                                                       | `recipe.topRatio`                                 |
| `limb`                                                                                                                      | `uniform(0)`         | 0                                                       | `lift(strength, falloff)` takes `RenderBody.limb` |
| `limbFalloff`                                                                                                               | `uniform(0)`         | 0                                                       | `lift`: `RenderBody.limbFalloff`                  |
| `betaRayleigh`, `mieScatter`, `mieExtinction`, `mieForward`, `ozone`, `detachedScatter`                                     | `uniform(Vector3)`   | 0                                                       | recipe                                            |
| `aerosolSky`, `ozonePeak`, `ozoneHalfWidth`, `detachedPeak`, `detachedHalfWidth`, `detachedExtinction`, `hRayleigh`, `hMie` | `uniform(number)`    | 0/1                                                     | recipe                                            |
| `transmittance`                                                                                                             | `texture(LUT_WHITE)` | 1×1 white                                               | `sunTable`                                        |
| `multiScatter`                                                                                                              | `texture(LUT_BLACK)` | 1×1 zeros, ln Ψ = 0, so Ψ = 1 against zero coefficients | `psiTable`                                        |

`clear()` (204–230) is a vacuum. It resets every coefficient **and swaps both tables back
to the stand-ins**. `sunThrough` returns the table itself as the beam, and no
coefficient zeros it. Without the swap, Luna was lit through Earth's column.

Stand-ins (`lutPixel`, 121–129): `LinearFilter` both ways and one object per role
(`LUT_WHITE`, `LUT_BLACK`), shared across every material (rules 56 and 57; the comment
at 100–120). A value swap rebuilds no WGSL, so whatever the stand-in compiled is what
the real table is read with.

### 5.2 `marchAir` (266–349)

```ts
export function marchAir(
  air: AirUniforms,
  origin: Node<'vec3'>, // sea-level units about the center
  direction: Node<'vec3'>, // unit
  near: Node<'float'>, // distance along `direction` from `origin`, sea-level units
  far: Node<'float'>,
  sun: Node<'vec3'>, // unit, same frame as origin
  samples: number, // JS number: a constant-count Loop
  clearBeam?: Node<'float'>, // optional; uniform-branch-gated beam clearing
): Marched // { inscatter: vec3 (before sunColor and π), transmittance: vec3 (physical) }
```

Per sample, inside `crowdedSamples` (445–478), a `Loop(samples)`:

- `height = max(|p| − 1, 0)`, `height01 = saturate(height/(top − 1))`,
  `fade = 1 − height01`.
- `ρR = e^(−h/hR)·fade`, `ρM = e^(−h/hM)·fade`. The ozone and detached tents come from
  `tentAt` (376).
- `extinction = βR·ρR + σM,ext·ρM + ozone·ρO + detachedExt·ρD`, `stepTau = ext·Δ`,
  `stepThrough = e^(−stepTau)`.
- `stepLight = Δ·stepShare(stepTau, stepThrough)`. `stepShare` (366) is
  `(1 − e^(−τ))/τ`, with a series under τ = 0.01 for float32.
- `muSun = dot(p, sun)/|p|`, `sunT = sunTableAt(air, muSun, height01)`. Under the
  uniform branch `If(clearBeam > 0)` it becomes `sunT = clearedBeam(air, sunT,
height01, clearBeam)`.
- `psi = psiTableAt(air, muSun, height01)`.
- `single = ((βR·ρR + detScatter·ρD)·P_R + mix(mieScatter, mieForward, forwardShare)·ρM·P_HG)·sunT`.
- `multiple = psi·(βR·ρR + mieScatter·ρM + detScatter·ρD)`. Multiple scattering keeps
  the sideways color.
- `inscatter += throughput·(single + multiple)·stepLight`, then `throughput *= stepThrough`.

The phase is computed once per ray (`phasesToward(direction, sun)`, 390): Rayleigh
`3/(16π)(1+ν²)`, HG at g = 0.7, and `forward = mie / AEROSOL_FORWARD_PEAK`.

Sample placement (`crowdedSamples`): `span = far − near`,
`perigee = clamp(dot(−origin, dir) − near, 0, span)`, `split = perigee/span`. Sample i
sits at `u = (i+½)/n`. On the left, `t = near + perigee·(1 − w²)` with `w = (split −
u)/split`. On the right, `t = near + perigee + (span − perigee)·w²`. The step is the
Jacobian over n. The CPU mirror is `marchSample` (`atmosphere.ts:730`). From the ground
looking up, `perigee = 0` and samples crowd at the eye. From orbit looking down, the
perigee clamps to `far` and samples crowd at the surface. **The placement depends on
(near, far), so splitting a segment moves every sample.**

`Loop` and `toVar` emit statements. `marchAir` must be called inside a material's `Fn`.
At material scope it compiles cleanly and draws a vacuum (261–264;
`materials.gpu.test.ts:872` guards the sphere).

### 5.3 `airToward(air, eye, point, sun, samples = SURFACE_AIR_SAMPLES): Marched` (711–743)

```ts
const toPoint = point.sub(eye)
const span = length(toPoint)
const direction = toPoint.div(max(span, 1e-9))
const closest = dot(eye.negate(), direction)
const impactSquared = max(length(cross(direction, eye.negate())).pow(2), 0) // |d × c|, no imaginary root
const halfOuter = sqrt(max(top * top - impactSquared, 0))
const near = clamp(closest - halfOuter, 0, span) // where the eye's ray enters the air
const physical = marchAir(
  air,
  eye,
  direction,
  near,
  span,
  sun,
  samples,
  clearedFromOrbit(air).mul(ORBIT_AIRLIGHT),
) // 0.5, module-private
return {
  inscatter: physical.inscatter,
  transmittance: mix(physical.transmittance, vec3(1), clearedFromOrbit(air)),
}
```

Note that the returned `transmittance` is **cleared** and does not compose over
segments. The in-scatter was accumulated with the **physical** throughput. The physical
T is not returned.

### 5.4 `sunThrough(air, point, sun): Node<'vec3'>` (784–796) and `clearedBeam` (804–824, private)

```ts
height01 = saturate(max(|point| − 1, 0) / max(top − 1, 1e-6))
muSun    = dot(point, sun) / max(|point|, 1e-5)
table    = sunTableAt(air, muSun, height01)
return clearedBeam(air, table, height01, clearedFromOrbit(air))
// clearedBeam: overhead = T(μ=1, height01)        ← second table read, always
//              slant = table / max(overhead, 1e-4); brightest = max channel
//              kept = brightest / max(brightest, ORBIT_BEAM_FLOOR 0.3)
//              hue = (slant / brightest)^ORBIT_BEAM_HUE(0.5) · kept
//              return mix(table, hue, strength)
```

Without air, the stand-ins make it white.
`materials.gpu.test.ts:932` holds the floor and the half-power hue.

### 5.5 Enhanced's ring, shell only

`marchLimb(air, origin, dir, near, far, sun, samples)` (575–682) returns light only, ×
`LIMB_BRIGHTNESS 6`. It is gated by `If(air.limb·enhancedSky > 0)`. It takes 8 samples
(`LIMB_SAMPLES`, 488) and 4 table reads a sample. `throughLimb(physical, ring)` (694)
adds the ring's light and keeps the physics' T. `limbReachOf(air)` (496) matches the
CPU's `limbReach` (`atmosphere.ts:412`). The surfaces never draw the ring; ADR-0037 and
`materials.gpu.test.ts:881` hold that.

### 5.6 Constants

`SURFACE_AIR_SAMPLES = 4` (481), `LIMB_SAMPLES = 8` (488), `ORBIT_BEAM_FLOOR = 0.3`
(836, exported), `ORBIT_BEAM_HUE = 0.5` (847, private), `ORBIT_AIRLIGHT = 0.5` (858,
private). The shell's `ATMOSPHERE_SAMPLES = 12` is in `materials.ts:215`.

### 5.7 Exported and private

Exported: `createAirUniforms`, `AirUniforms`, `Marched`, `marchAir`, `sunTableAt`,
`SURFACE_AIR_SAMPLES`, `LIMB_SAMPLES`, `limbReachOf`, `marchLimb`, `throughLimb`,
`airToward`, `clearedFromOrbit`, `sunThrough`, `ORBIT_BEAM_FLOOR`.

Private: `texelCentered`, `lutPixel`, `LUT_WHITE/BLACK`, `stepShare`, `tentAt`,
`phasesToward`, `psiTableAt`, `crowdedSamples`, `clearedBeam`, `ORBIT_BEAM_HUE`,
`ORBIT_AIRLIGHT`.

(knip's gate check covers files, dependencies, unlisted, unresolved and cycles, not
exports, so an export with no consumer passes the gate: `package.json` `knip:check`.)

---

## 6. How each surface marches its air

### 6.1 Table reads per fragment (from the code; perf.md agrees for the shell)

| Material                   | March                                    | Reads                                                                      |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| Shell (`materials.ts:368`) | 12 samples × (T + Ψ), **no `clearBeam`** | 24, plus the ring 8 × 4 = 32 under Enhanced from orbit                     |
| Sphere, ground, sea        | `sunThrough` (2) + 4 × (T + Ψ)           | 10. Under Enhanced from orbit +4 (`clearedBeam`'s overhead per sample), 14 |

### 6.2 The shell (`createAtmosphereMaterial`, `materials.ts:257–461`)

- The ray is the eye to the back wall in stretched sea-level units.
  `near = max(closest − halfOuter, 0)`. `far` is the drawn ground if the ray meets it
  ahead, else the far wall (344–365).
- `physical = marchAir(air, eyeUnits, rayDirection, near, far, sun, 12)`.
  `ring = marchLimb(...)` to `limbReachOf`. `{inscatter, transmittance} =
throughLimb(physical, ring)`.
- Output: `radiance = inscatter·sunColor·ATMOSPHERE_GAIN`, alpha = `1 − mean(T)`
  (gray, 410–414). Blend is premultiplied, `out = L + (1 − α)·dst` = `L + T̄·background`
  (`OneFactor`, `OneMinusSrcAlphaFactor`, 428–442). Alpha writes are (Zero, One).
  `transparent`, `depthWrite = false`. It writes `reactive = alpha` through
  `sensorRadiance(..., 'alpha')`.
- Writers: `Bodies.tsx:576–626` sets center, radii, `seaLevel`, spin, flattening,
  `setLimb(shell.limb, shell.limbFalloff)`, `setScattering(recipe, T, Ψ)`, `sunColor`
  and `sunDirection`.

### 6.3 The sphere (`createPlanetMaterial`, `planet.ts:275–676`)

- `sunlight = dayColor · sunThrough(air, pointUnits, light)` (503). `diffuse =
albedo · photometric · sunlight · lit · limbShade` (534), where `lit = daylight ·
ringShade · cloudShade` (504).
- **No skylight term, no `visibilityAmbient`.** Its beam is whole.
- The deck's shadow: `cloudShade = 1 − cloudMap.sample(shadowUv).a · cloudShadow`.
  `cloudShadow` is 0.55 with a cloud map, else 0 (`bodyUniforms.ts:432`). The shadow is
  projected along the sun by the deck's real altitude (`cloudHeight`, 443–464).
- In the color `Fn` (588–628): `marched = airToward(air, eyeUnits, pointUnits, light)`,
  `veil = marched.inscatter·dayColor·π·ringShade`,
  `shaded = (diffuse + sunlight·glint + liquidGlow·ocean)·marched.transmittance + veil`.
  Night lights are `nightMap·smoothstep(0.05, −0.14, incidence)·nightStrength·(1 −
cloudCover·0.85)·marched.transmittance`. The cleared T lets the limb's cities shine
  through the slant (a the-air.md defect).
- Writers: `Bodies.tsx:510–522`: `air.clear()` with no haze, else `air.set(...)` and
  `air.lift(body.limb, body.limbFalloff)`.

### 6.4 The ground (`terrain.ts`)

- `sunlight = dayColor·sunThrough(air, pointUnits, sun)` (1337). The point is
  `(anchor + local)/bodyRadius` in body-fixed axes. Altitude is computed without
  subtracting radii: `(2a·l + l·l)/(|p| + |a|) + anchorAltitude` (583–589, rule 52).
- Beam terminator: `daylight = smoothstep(±BEAM_TERMINATOR 0.025, incidence +
√(2h/R)·sign h)` (1302–1313).
- Skylight is **taken out of the beam** (1357–1388):

  ```ts
  diffuse  = min(skyStrength · SKY_FRACTION(0.33), 1)      // skyStrength = palette.airThickness = visibleThickness
  skyView  = saturate(dot(shaded, up))·0.5 + 0.5
  deep     = deepSky(skyStrength)                          // smoothstep(2, 5, skyStrength)
  direct   = albedo·photometric·daylight·sunlight·(1 − diffuse·(1 − deep))
  thin     = skyColor·diffuse·skyView·skylightLeft(incidence, 0.25)·dayColor   // dayColor is ABOVE the air
  ambient  = mix(thin, skyOverhead·skyView, deep) + skyView·visibilityAmbient
  indirect = albedo·ambient
  lit      = (direct + indirect + sunlight·glint + emission)·marched.transmittance + marched.inscatter·dayColor·π
  ```

  `skyColor` is the palette's **unit-luminance tint of the authored haze color**
  (`terrainPalette.ts:500`, `unitLuminance`, 219). It is not from the tables.

- Writers: `TerrainPatches.tsx:175–201`.

### 6.5 The sea (`water.ts`)

- `sunlight = dayColor·sunThrough(air, pointUnits, sun)` (463). The sheet sits at the
  datum, so its terminator takes no height (451–455; the-air.md "The sea's terminator
  takes the sheet at the datum").
- The body of the water's light (515–531): `max(incidence, 0)·daylight·(1 −
diffuse·(1 − deep))·sunlight + mix(skyColor·diffuse·skylightLeft(incidence,
0.25)·dayColor, skyOverhead·skyView, deep) + skyView·visibilityAmbient·dayColor`,
  with `skyView = 1`.
- **The reflected sky** (552–560):
  `skyLight = mix(skyColor·min(skyStrength, 1)·skylightLeft(incidence, 0.15)·0.9·dayColor,
skyOverhead·0.9, deep) + visibilityAmbient·dayColor`. It does not vary with direction.
  On Earth at noon its luminance is **0.9 scene units** (unit-luminance `skyColor`).
  **(computed)** My CPU march of the clear sky at a 60° sun gives 0.11 at the zenith,
  0.077 at 30° up and 0.12 at 1–5° up (scene-unit luminance). The sea mirrors a sky
  roughly 7–12× brighter than the shell draws. §6.5's "reflected deck = traced deck" test
  will move every sea plate (inference; I ran no browser plate).
- Land reflection reads the frame and divides by `sceneRadianceGain` (539, 606), which is
  the precedent for any pass that reads the scene back into scene units.
- Air: `color·marched.transmittance + marched.inscatter·dayColor·π` (651–654). Material:
  `transparent = true`, **`depthWrite = true`** (336–337), reactive 0.3. Opacity fades in
  over the first 0.5 m of depth (664).
- Writers: `WaterPatches.tsx:96–117`.

---

## 7. The CPU side each frame (`Bodies.tsx`, `atmosphereLuts.ts`)

Order of frame callbacks: `cameraRig` (−0.5) → `orbitalBake` (−0.25) → `bodies`,
`terrainPatches`, `waterPatches` (0) → `sensor` (1, which renders and sets
`engine.exposure` for the _next_ frame). `CameraRig` and `Bodies` read the last frame's
exposure.

- `scatteringOf(engine, body)` is asked once per body per frame (`Bodies.tsx:427`). It is
  null while the pool bake is in flight, and the material draws a vacuum.
- `standingIn(shell, eye, center, spinAxis): Standing | null` (`atmosphereLuts.ts:266`)
  gives the eye's radius over sea level in the shell's stretched space, clamped at 1, or
  null above the air.
- `airOverhead(scattering, standing, sun, sunColor)` (294) is the luminance of
  `zenithSkyRadiance(recipe, ΨTable, radius, dot(up, sun))·sunColor`. It is a 32-sample
  column, and each sample is an exact 48-step `transmittanceFrom`. perf.md measured
  27.6 µs a call, allocating every frame. The brightest one becomes
  **`airLuminance.value`** (`Bodies.tsx:662`).
- **`skyOverhead.value`** (`Bodies.tsx:670–680`) is `airOverheadRgb` **at radius 1** (the
  datum) under the eye's up, at the camera's sun. It is written **only when the standing
  air is deep** (`visibleThickness > LIMB_OWN_FROM`), otherwise `(0, 0, 0)`. On Earth and
  Mars no shader reads it.
- `observerAir.depth = clamp((top − radius)/(top − 1), 0, 1)` (682–689) goes to the
  sensor's `meteredShare`.
- Disk through the air: `diskThroughAir(recipe, radius, settingDiskCosine(...),
diskCompression(star, visibility), DISK_THROUGH_AIR_CEILING / 2**opened)`
  (`Bodies.tsx:630–661`, `atmosphere.ts:1148`). The disk is pre-divided by the column's
  gray mean so the shell's T̄ takes it back off.

---

## 8. Radiance, staging, twilight, Enhanced's sky

**`radiance.ts`.**

- `enhancedSky` (11) is 1 iff `setSceneExposure` was called with a non-null `pre` and
  `'enhanced'`. It is a per-renderer `onRenderUpdate`.
- `sceneRadianceGain` (29) = `SURFACE_LUMINANCE·pre`, or 1.
- `integratedSkyGain` (33) = `integratedGainFor(total) = 1/(SURFACE_LUMINANCE·total)`.
- `stagedLight` (44) = Enhanced ? `integratedSkyGain` : 1. It holds staged light (galaxy,
  fill, flare) at display level when the meter opens.
- `visibilityAmbient` (64) = `enhancedSky·0.03·stagedLight`, Enhanced's 3% night fill. It
  is applied by the ground and the sea, **not the sphere**.
- `airLuminance` (21), `skyOverhead` (28) and `observerAir` (53) are written by `Bodies`.

**Earthshine.** The plan's §1 says "earthshine lights Luna alone (`render/radiance.ts`)".
The tree has **no earthshine term**. `radiance.ts:59` only cites earthshine (2.6e-4 of
sunlight) to justify the 3% fill. No night side, Luna's included, is lit by a second
body.

**Staged sunlight.** Under Enhanced every body's sun is 1 (`bodyUniforms.ts:351`;
`starAsBody` uses `CALIBRATED_STAR_RADIANCE = 8`, `bodyUniforms.ts:183, 301–309`).
`CameraRig.tsx:84–91, 156–159` lights the hull with ambient and fill ×
`integratedGainFor(total)` and key = `4·(visibility ? staged : star.sunlight)`. **The
hull's key takes no air transmittance** (the-air.md: it runs before `Bodies`).

**`twilight.ts` `skylightLeft(incidence, horizon)`** (20–30):
`incidence ≥ 0 ? saturate(incidence + horizon) : horizon·e^(66·incidence)`. The ground
uses `horizon = 0.25`. The sea uses 0.25 (body light) and 0.15 (reflection). This is
the-air.md's "day's skylight ramp" defect. **(Computed from the code.)** At sunset
(incidence 0) the ground's thin sky is `0.33 × 0.25 = 0.083` scene units of the beam
_above the air_, about 11 klx at E⊥ = 133.8 klx, against the ~400 lx a clear sky
measures. At noon it is 0.33 against a measured 17 klx / 133.8 klx = 0.127.

**`enhancedSky.ts` `composeSky(physical)`** (24): the galaxy lifted by 2²³ and compressed
by `y/(y + airLuminance·2²³)/0.5`, × `stagedLight`. Under clouds the veil is still the
clear zenith (inference: the composite's `T_c` dims the field, and the veil does not
know about the cloud).

**Meter.** `meterHistogram` (`exposure.ts:271`) and `ExposureMeter.update` (360) fall
back to `set − range.dark` (16 stops) when no lit sample remains. This is the-air.md's
"night meter dark clamp", which an overcast night meets first (plan §6.6).

---

## 9. The scene unit (plan §8.3)

### 9.1 The definitions

| Name                | Where                                                                                                                                                                                 | Value                                                                | What it means                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0056's unit     | `ATMOSPHERE_GAIN = Math.PI` (`atmosphere.ts:256–266`); the anchor `atmosphere.test.ts:284–293` `EXTRATERRESTRIAL_LUX = 133_800`, `toScene(cd) = π·cd/133,800`; CONTEXT.md:12121–12125 | **1 unit = E⊥/π = 42,590 cd/m²** (the plan writes 133.3 klx, 42,400) | An albedo-one surface under the sun **above the air** at 1 AU. The surfaces' beam crosses the air through `sunThrough`, which agrees: the noon beam on the ground is 0.77 units, 103 klx (computed T green at 90° = 0.768) |
| `SURFACE_LUMINANCE` | `exposure.ts:3–4` ("albedo-one surface under terrestrial sunlight"); ADR-0031:29; ADR-0037:77                                                                                         | **30,000 cd/m²**, i.e. 94.2 klx/π                                    | The sensor's calibration white. Read as the scene unit, the noon beam on the ground would be 0.77 × 94.2 = 72 klx                                                                                                          |
| `SOLAR_LUMINANCE`   | `exposure.ts:5`                                                                                                                                                                       | 1.6e9 cd/m²                                                          | The Sun's disk. Through `stellarIlluminance` it is **108.7 klx at 1 AU** (computed with Ω = 6.794e-5 sr)                                                                                                                   |

The ratios: 42,590/30,000 = **1.420** (0.506 stop), or 1.414 at the plan's 133.3 klx. A disk
consistent with "sunlight 1 → surface white 1" has radiance π/Ω = **46,239** units. The
code draws it at 1.6e9/30,000 = **53,333** (×1.153). Under ADR-0056's unit it would be
37,568 (×0.81).

### 9.2 Every consumer of `SURFACE_LUMINANCE`, and what a 1.42× change does to it

Changing the constant to 42,590 is option A. Keeping 30,000 as "the calibration white"
and converting emitters through E⊥/π is option B. The table describes A.

| Consumer                                 | Line                                                                                                                                                                                                                                        | Role                                                | Effect of 30,000 → 42,590                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sceneRadianceGain` / `setSceneExposure` | `radiance.ts:81`                                                                                                                                                                                                                            | gain = S·pre                                        | No change at the calibration (pre = 1/S). Manual mode draws 1.42× brighter at a given lens EV                                                    |
| `integratedGainFor`                      | `radiance.ts:71–72`                                                                                                                                                                                                                         | staged light = 1/(S·total)                          | No change at the calibration                                                                                                                     |
| Calibration EV                           | `exposure.ts:133, 195, 199, 328, 330, 355, 381, 395`                                                                                                                                                                                        | `exposureForLuminance(S)`                           | The calibration EV moves +0.51. A pinned script EV is relative to it, so the same picture. EV readouts move                                      |
| Disk cap stops opened                    | `Bodies.tsx:637`                                                                                                                                                                                                                            | `exposureForLuminance(S) − effectiveEV`             | Consistent if both move                                                                                                                          |
| Galaxy calibration                       | `galaxyVolume.ts:546–549`                                                                                                                                                                                                                   | nW m⁻² sr⁻¹ · 1e-9 · efficacy / S                   | The galaxy draws **0.70×** against the sunlit world. `composeSky`'s veil compares it with the air in ADR units, so today that ratio is off 1.42× |
| Star sprites (photographic)              | `materials.ts:606`                                                                                                                                                                                                                          | lux · angularDensity / S                            | Stars 0.70×                                                                                                                                      |
| Star-visibility night floor              | `starVisibility.ts:53`                                                                                                                                                                                                                      | `2e-4 cd/m² / S` against `airLuminance` (ADR units) | Today the air reads 1.42× dim in cd/m², which costs up to 2.5·0.59·log₁₀1.42 = **0.22 mag** of sky loss in bright skies                          |
| Disk radiance and compression            | `bodyUniforms.ts:291, 308`                                                                                                                                                                                                                  | `luminance / S`                                     | `diskCompression` changes from ln8/ln53,333 = 0.191 to ln8/ln37,568 = 0.197. The photographic disk is 0.70×                                      |
| Tests that use the constant              | `exposure.test.ts`, `starVisibility.test.ts`, `bodyUniforms.test.ts:369`, `cinematicStage/plumes/cameraSensor/galaxyDaylight/enhancedSky/surfaceVisibility.gpu.test.ts`, `galaxyOrientation.gpu.test.ts:42`, `gameEngine.galaxy.test.ts:15` | —                                                   | They follow the constant                                                                                                                         |
| **Tests that hard-code 30,000 or 1.6e9** | `materials.gpu.test.ts:889, 911, 946` (`pre = 1/30_000`); `atmosphereSky.gpu.test.ts:330, 380, 479, 511`; `atmosphere.test.ts:394`; `exposure.test.ts:35, 36, 96`                                                                           | —                                                   | They silently stop meaning "the calibration"                                                                                                     |

What the 1.42× changes for the weather: every phase 5 emitter (the moon at ~0.25 lx,
airglow at ~1.2e-4 cd/m², city light under cloud, lightning in watts) and the phase 4
lightning calibration convert a physical quantity into scene units. Through S they land
1.42× brighter relative to the sunlit world than through E⊥/π.

**There is a second normalization the plan does not name:** under Enhanced staging
every body's sunlight is renormalized to 1 (`bodyUniforms.ts:351`). An absolute emitter
must also be divided by `body.sunlight` under Enhanced, or its ratio to the sun changes
with the camera mode (×2.3 on Mars). This is an inference from the code.

The `RenderBody.sunlight` doc (`scene.ts:63`) and `SURFACE_LUMINANCE` both say
"terrestrial sunlight". `sunlightAt` is 1 at 1 AU _above_ the air, which is ADR-0056's
reading.

---

## 10. Answers: what a cloud march calls

### (a) The sun's transmittance through the air to a point at altitude h

```ts
import { sunThrough, sunTableAt, clearedFromOrbit } from './air.ts'
// point, sun: sea-level units about the body's center, one frame (body-fixed for a body-fixed trace)
const beam = sunThrough(air, point, sun) // vec3: physical table read, cleared toward its hue under Enhanced from orbit
const light = dayColor.mul(beam) // what the ground/sea/sphere use (`terrain.ts:1337`)
// Lower level, if h comes from float64 CPU heights (rule 52) rather than length(point) − 1:
const raw = sunTableAt(air, muSun, float(h).div(hazeHeightMeters)) // height01 = h/(R·(top−1)); NO clearing
```

Uniforms read: `air.transmittance` (the texture node), `air.top`, `air.limb` and
`enhancedSky`. The private `clearedBeam` is the only way to clear a raw read. A
float64-height variant, such as `sunThroughAt(air, muSun, height01)` that applies
`clearedBeam`, would have to be added and exported from `air.ts`; nothing like it exists.
A cloud lit by `sunTableAt` while the ground beside it takes `sunThrough` disagrees from
orbit under Enhanced, darker and redder toward the terminator (inference).

Inside a cloud march with an early exit, both functions' `.sample()` reads are in
non-uniform control flow. A `.level(0)` variant is needed (§0 item 9). The same tables
serve the **moon** as a second beam: T and Ψ are per unit irradiance of any distant
source, so call `sunThrough(air, p, moonDirection)` and scale by the moon's irradiance in
scene units (§9).

### (b) The air between two points on a view ray, for the composite

Today's call (`air.ts:266`):

```ts
const front = marchAir(air, eye, dir, entry, t0, sun, N0, clearBeam) // L_a(0,t0) raw, T_a(0,t0) physical
const span = marchAir(air, eye, dir, t0, t1, sun, N1, clearBeam) // L_a(t0,t1), T_a(t0,t1)
// scene units: L = marched.inscatter.mul(dayColor).mul(ATMOSPHERE_GAIN)
// build L_a(0,t1) FROM THE SAME TWO SEGMENTS, not a third march:
//   L_a(0,t1) = front.L + front.T · span.L ;  T_a(0,t1) = front.T · span.T
// entry exactly as airToward computes it (§5.3): clamp(closest − √(top² − b²), 0, …)
```

With `L_a(0,t1)` built from the two segments, the identity reduces to `out = scene` when
`T_c = 1` and `L_j = span.L`, whatever the quadrature.

**Conditions for exactness against the scene as built.**

1. The pixel's air must be the one the scene holds:
   - At **surface pixels** that is `airToward`: 4 samples over `[entry, |point − eye|]`,
     `clearBeam = clearedFromOrbit(air)·0.5` (`ORBIT_AIRLIGHT` is private), and the
     surface dimmed by `mix(T, 1, cleared)`.
   - At **sky pixels** it is the shell: 12 samples over `[entry, wall or drawn ground]`,
     **no `clearBeam`**, the background dimmed by gray `T̄` plus the ring's light under
     Enhanced.
2. The residual in between (derivation; phase 0 measures it) is

   ```
   T_c·{L_scene(0,end) − L_comp(0,t1) − T(0,t1)·L(t1,end)}
     + T_c·{T_scene(0,end) − T(0,t1)·T(t1,end)}·S
   ```

   It vanishes at `T_c = 0` and is largest for thin cloud. Through its second term it
   multiplies the _surface_ radiance S. A measured data point at a different sample count:
   `atmosphereSky.gpu.test.ts:503–508` holds the shell (12) and the sphere (4) on one
   chord to within 10%, measured 1.21 against 1.18.

3. **Enhanced from orbit.** Compose light with the **physical** throughput and dim what
   is seen through with the **cleared** T. `mix(T,1,c)` does not compose over segments
   for 0 < c < 1. `airToward` exposes only the cleared T, so a split variant inside
   `air.ts` that returns both is the natural hook.
4. **Sphere pixels.** The sphere's air ends on the **datum** under the fragment, but its
   depth buffer holds the **sunk mesh**, up to 9.9 km/cos θ deeper on Earth. A composite
   that takes `t1` from depth at a sphere pixel marches that extra column at sea-level
   density, and the nadir veil doubles (`materials.gpu.test.ts:977`). `t1` must stop at
   the ray's datum crossing there. Terrain under the datum (basins) marches to the point
   and holds sub-datum air at sea-level density (inference).
5. **The ring at sky pixels.** Under Enhanced from orbit the scene's sky holds the ring's
   light, but the subtraction removes only the physics. `T_c·scene` dims the whole ring,
   including any in front of the cloud (inference).
6. **Units.** The scene target holds `scene units × sceneRadianceGain`, clamped at
   65,504. Composite terms in scene units must be multiplied by `sceneRadianceGain`, or
   the scene divided by it as `water.ts:539` does.
7. **The joint span.** `L_j`, the air and cloud together, must carry the air's own terms:
   ozone, the detached layer, the aerosol's forward turn and the `stepShare` integral.
   `marchAir`'s per-sample body is a closure, so a cloud march cannot reuse it without
   a refactor that exports a per-sample "air medium at p" (extinction, scatter, single,
   multiple) (inference/recommendation).

### (c) Sky irradiance

**There is no sky-irradiance table or function.** What exists:

| Term                  | Where                                                                  | Value                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thin skylight, ground | `terrain.ts:1379–1384`                                                 | `skyColor·min(skyStrength·0.33, 1)·skyView·skylightLeft(dot(up,sun), 0.25)·dayColor`, taken out of the beam                                                                                   |
| Thin, sea             | `water.ts:521–529, 552–560`                                            | the same with 0.25 for the body light, and `0.9·min(skyStrength,1)·skylightLeft(·, 0.15)` reflected                                                                                           |
| Deep                  | `skyOverhead·skyView` (`radiance.ts:28`)                               | Zenith radiance at the datum under the eye, ×π and sunColor, **treated as uniform-sky irradiance/π**. Zero unless the air is deep                                                             |
| Enhanced fill         | `skyView·visibilityAmbient`                                            | 3% × staged                                                                                                                                                                                   |
| CPU zenith            | `zenithSkyRadiance(recipe, ΨTable, radius, μs)` (`atmosphere.ts:1037`) | RGB scene units per unit sun color, 32 samples                                                                                                                                                |
| Ψ                     | `psiTableAt` (private)                                                 | **Not irradiance**: the isotropic higher-order source `L₂/(1−f)` per unit σs, averaged over all 4π with no cosine weight. The first-order sky, most of a clear sky's irradiance, is not in it |

**A table baked "beside Ψ" (§5.3/§6.2) means:**

1. A new pure bake in `packages/rendering`. `atmosphere.ts` is at fta 71.8 against the cap
   of 91 (`package.json` `fta:check --score-cap 91`), so a new module is cheaper. It runs
   as a second pass after Ψ, since higher orders need Ψ along each direction: the cosine-
   weighted upper hemisphere of single scattering with phase plus Ψ·σs (inference).
   Expect about the Ψ bake's cost again (inference).
2. `BakeAtmosphereResponse` plus transfers, and **`version: 4 → 5`** (`atmosphereTask.ts:56`),
   with the `atmosphereTask.test.ts` equalities.
3. `AtmosphereScattering` gains the texture, and the CPU table if the hull or CPU needs it.
4. `createAirUniforms` gains a third `texture()` node over its **own** linear 1×1 stand-in
   object (rules 56, 57). The new texture goes into `set(...)`'s signature and `clear()`.
   The callers are `Bodies.tsx:516, 593`, `TerrainPatches.tsx:195`, `WaterPatches.tsx:115`,
   `materials.ts:454`, and the tests `atmosphereSky.gpu.test.ts:108, 474` and
   `materials.gpu.test.ts:318, 852, 944`.
5. If the shell reads it, `materials.gpu.test.ts:401` ("binds exactly its two scattering
   tables") changes.
6. Altitude resolution. Ψ's 16 rows are 6.7 km on Earth, and the boundary layer is 1.2 km.
   A sky-irradiance table that must light a 0.3–2 km cloud base wants finer or warped low
   rows (inference).

---

## 11. Draw order around the air (the composite goes after all of these)

The sort is `installSceneOrder` (`sceneOrder.ts:10–23`): groupOrder, renderOrder, z
(opaque front-to-back, transparent back-to-front), id. Each key is pre-multiplied by −1
under reversed depth, because three reverses the list.

- **Opaque:** galaxy backdrop (`renderOrder −1000`, far depth, `galaxyVolume.ts:554`),
  body spheres (−1 when the tier is `'surface'`, else 0; `bodyUniforms.ts:565`), the star
  disk (opaque, reactive 1), terrain patches.
- **Transparent:** starfield (−2), **shell (0, back side, premultiplied)**, **sea sheets
  (0, `depthWrite`)**, **the deck (1, `Bodies.tsx:353`)**, rings (2), plumes (9/10),
  flare (10), warp (11), cinematic stage (8/11/12), entry traces (index + 1).
- **The deck has no air.** `createCloudMaterial` (`planet.ts:713–789`) is Lambertian:
  `cover·baseColor·sunColor·glow·(0.96·max(incidence,0) + 0.04)·daylight`, with
  `glow = mix(1, haze.limb, smoothstep(0.3, 0, incidence))` and opacity
  `cover.a·opacity·daylight·entry`. It is drawn **after** the shell, so it is neither
  veiled by the air nor lit through `sunThrough`. The volume replaces this (plan §1 and
  §3).

---

## 12. Hook points for the weather work

1. **`air.ts:266` `marchAir`.** Add per-sample cloud taps: `single × cloudSunlight(p)`,
   `multiple (Ψ) × columnDiffuseT(p)` (§6.3). That is a signature change, for example an
   optional `shade(point, height01)` callback. Every caller must take identical taps:
   `materials.ts:368`, `planet.ts:589`, `terrain.ts:1428`, `water.ts:651`, and the
   composite.
2. **`air.ts:711` `airToward`.** A split or span variant for the composite that returns
   the physical throughput beside the cleared T and shares `ORBIT_AIRLIGHT`.
3. **`air.ts:415, 430, 804`.** `.level(0)` reads, or level-0 variants, for use in
   non-uniform loops. Export `psiTableAt` if a cloud reads Ψ.
4. **`air.ts:784`.** A float64-height entry point for the cleared beam (rule 52
   friendly).
5. **`air.ts:141`.** The third table: uniform, stand-in, `set`, `clear`.
6. **`packages/rendering` plus `atmosphereTask.ts` plus `atmosphereLuts.ts`.** The
   sky-irradiance bake, task v5, cache entry and CPU reader.
7. **`terrain.ts:1357–1388`, `water.ts:515–560`, `planet.ts:534`.** Replace
   `skyColor·SKY_FRACTION·skylightLeft` and the deep `skyOverhead` with the table, occluded
   by the cloud column, the §6.2 energy balance. **The sphere gains the same term** (rule
   59). This closes the-air.md's "day's skylight ramp" and "deep sky is one zenith under
   the eye", and the deep blend's dependence on `LIMB_OWN_FROM`.
8. **`water.ts:552–560`.** The reflected sky becomes the probe or the far atlas (§6.5).
9. **`planet.ts:443–464, 617–621`; `bodyUniforms.ts:432–435, 452–480`.** The deck's
   0.55 shadow, `cloudHeight`, the night lights' `(1 − cover·0.85)`, and the deck record
   retire in phase 3. The sphere's cloud material becomes the far march (§5.4).
10. **`Bodies.tsx:576–626`.** A cloud pass needs per-frame air uniforms like the shell's
    (`set` and `lift` per body, sun in the trace's frame). `airLuminance` and `skyOverhead`
    (662–680) are clear-sky CPU columns that a cloud overhead does not change.
11. **`radiance.ts` and `exposure.ts`.** The scene-unit decision (§9), and the emitters'
    conversion including the Enhanced per-body normalization.
12. **`CameraRig.tsx:156–159`.** The hull key × the air's transmittance × `cloudSunlight`.
    The plan wants this on the GPU (§6.4).
13. **`twilight.ts:20`.** `skylightLeft` retires or becomes the table's night fall-off.
    Today's below-horizon law, `0.25·e^(66·incidence)`, is calibrated against a "17 klx"
    day sky the code does not draw.

---

## 13. Gotchas and invariants that apply here

- **Rule 52.** Never subtract planetary radii in a shader. `marchAir`'s
  `length(p) − 1` (~0.4–0.8 m resolution on Earth) is tolerable only because the air's
  scale heights are kilometers. A cloud-shell entry and exit must come from CPU float64
  heights (`cloudShellAltitude`, `packages/rendering/src/cloudShell.ts:8`; the ground's
  `anchorAltitude`, `terrain.ts:453, 583–589`). No screen-space derivatives of planetary
  positions.
- **Rules 56 and 57.** A new table's stand-in is linear both ways and its own object. A
  material that binds two `AirUniforms`, for two bodies, puts two texture nodes over
  `LUT_WHITE` and gets one binding. `materials.gpu.test.ts:269–391` holds stand-in and
  real to one program.
- **Rule 59.** The ground, the sphere and the sea take one cloud shadow, one skylight and
  one air. Today's sphere already lacks the skylight and the fill (§6.3). The the-air.md
  entries "Mars's ground takes a fifth of its light from a sky the sphere does not have"
  and "The terminator steps at the descent gate" are the existing steps. The one GPU
  test that draws both, `surfaceVisibility.gpu.test.ts:93`, holds their _reflectance_ on
  an airless body (Bennu) across camera modes. No test compares the sphere and the ground
  under air or at the gate; the rule's 3.1%/1.5% figures were measured in the browser.
  The plan's "one cloud shadow at the descent gate, within 1%" test would be the first.
- **Rule 60.** `three/webgpu` and `three/tsl` only. `packages/*` imports no three, and
  `atmosphereTask.ts` is in the worker bundle.
- **Rule 61.** Compile-ahead goes through `render/warmup.ts`. A new air-reading pass
  registers there.
- **Rule 25.** Shells about a figured body are round (`bodyUniforms.ts` header). The air
  stretches only giants (`flattening: giant ? shellFlattening : 1`, 546).
- **Rules 28 and 29.** Sea-level units survive distance compression because both radii
  move with `placement.compression`. A cloud shell in render meters must scale the same
  way.
- **Rule 65.** `airOverhead` and the exposure readouts are instruments. A cloud census
  must not throw or write.
- **Rule 68.** Every `pnpm test:gpu` holds the GPU lock. The air's GPU tests
  (`atmosphereSky`, `materials`, `cloudEntry`, `surfaceVisibility`, `water`,
  `enhancedSky`) are GPU jobs.
- **`Loop` outside `Fn`** compiles and draws a vacuum (`air.ts:261–264`,
  `materials.ts:285–294`, `planet.ts:579–585`).
- **Uniform derivative analysis is off** outside Firefox, so plain samples in
  non-uniform loops compile and are undefined.
- **Frames.** The sphere and the shell are in render space, stretched for giants. The
  ground and the sea are in body-fixed axes with the sun rotated on the CPU.
- **Datum against sunk sphere.** Air from the datum, shell stop at the drawn sphere,
  sphere march to the datum.
- **Gray against chromatic.** The shell dims its background by the gray `T̄`. Surfaces
  are dimmed per channel.
- **The tables' ground is the datum sphere.** Terrain never shadows the beam in the
  tables. A cloud top's sun stays up `acos(−√(1 − 1/r²))` past the ground's sunset
  automatically: 3.5° at 12 km.
- **fta cap 91.** `terrain.ts` 75.7, `atmosphere.ts` 71.8, `planet.ts` 71.6, `water.ts`
  69.2, `materials.ts` 67.1, `atmosphereLuts.ts` 58.4, `air.ts` 16.7 (`node_modules/.bin/fta
--json`, read-only).
- **Presets.** Changing the sea's reflected sky or the skylight moves plates. The dark
  ones are skipped without `presets:compare --all` (the-air.md § rig).

---

## 14. Tests that pin the air

| Test                                                                | Holds                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rendering/src/atmosphere.test.ts`                         | Transmittance (95–163); Ψ finite, converged at the ground and under an opaque haze (165–266); **the anchor**: zenith at 60° within 10% of CIE type 12 through E⊥ 133,800 lx, 30/45/70° within 35%, 10° in (1, 2), Koomen 5° to −12° within 2×, −15° under 4.3e-4 cd/m² (268–383); the disk through the air (385–520); the recipe (522–793); the limb (795–902); the detached layer (904–1008); the lift's share (1010) |
| `apps/game/src/render/atmosphereSky.gpu.test.ts`                    | Noon zenith color order (154); aureole (166); **GPU zenith = CPU `zenithSkyRadiance` within 5%** (183) and at −8° within 15% (201); detached layer (220); air from the datum (265); stop at the drawn sphere (286); setting sun (317); Enhanced ring, disk/shell seam within 10%, ground identical under both lenses (358–525)                                                                                         |
| `apps/game/src/render/materials.gpu.test.ts`                        | Every material compiles (142–268); stand-in = real program (269–391); **the shell binds exactly 2 `texture_2d<f32>`** (401); the disk's air: veil over black, vacuum, ring off the disk, cleared = bare + airlight, beam floor and hue, datum endpoint (823–987)                                                                                                                                                       |
| `apps/game/src/render/atmosphereTask.test.ts`                       | Pool bake = main-thread bake; transfer intact; registry (37–93)                                                                                                                                                                                                                                                                                                                                                        |
| `apps/game/src/render/cloudEntry.gpu.test.ts`                       | The deck's coverage reaches 0 under its shell; the rim fades with the nadir (14, 53)                                                                                                                                                                                                                                                                                                                                   |
| `apps/game/src/render/surfaceVisibility.gpu.test.ts`                | The sphere, the ground and the bake keep one reflectance across camera modes on airless Bennu (93); Enhanced fill against photographic, and twilight skylight > 1e-6 past the terminator at `airThickness` 0.4, for the ground and the sea (180–252)                                                                                                                                                                   |
| `apps/game/src/render/enhancedSky.gpu.test.ts`                      | `composeSky` against `airLuminance`; staged hold (49–95)                                                                                                                                                                                                                                                                                                                                                               |
| `apps/game/src/render/water.gpu.test.ts`                            | Full sea mirrors land and sky, plain sea mirrors nothing (138–220)                                                                                                                                                                                                                                                                                                                                                     |
| `packages/rendering/src/exposure.test.ts`, `starVisibility.test.ts` | The calibration and the star thresholds in `SURFACE_LUMINANCE` units                                                                                                                                                                                                                                                                                                                                                   |

What the weather breaks first:

- Any change to the `marchAir` defaults or its sample placement moves the GPU-against-CPU
  zenith (5%) and the disk/shell seam (10%).
- A third table bound by the shell breaks the binding-count test.
- A task change breaks the `atmosphereTask.test.ts` equalities until v5.
- The sea's sky reflection changes `water.gpu.test.ts` and every sea plate.

---

## 15. the-air.md defects the weather closes or meets

| Defect (`design/plans/the-air.md`)                                                 | Line    | Weather                                                                   |
| ---------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| The day's skylight ramp puts too much sky on the ground                            | 146–152 | Closed by §6.2's table (phase 2)                                          |
| The deep sky is one zenith under the eye                                           | 267–272 | Closed by the per-point table                                             |
| At night Enhanced's meter opens to its dark clamp                                  | 22–32   | Met by the overcast night (§6.6)                                          |
| Mars's ground takes a fifth of its light from a sky the sphere does not have       | 118–125 | Met: the sphere must gain the same sky (rule 59)                          |
| The hull's light is a frame behind a cut; the key ignores the air                  | 50–60   | Met by §6.4 (`cloudSunlight` on the hull)                                 |
| The night limb's cities shine through the slant                                    | 229–234 | Met by moonlit and cloud-dimmed cities (§6.6): the cleared T dims nothing |
| Titan's face is drawn through its whole air; `limbShare` also gates clearing       | 259–265 | Met wherever clouds are cleared from orbit                                |
| The sulfuric deck saturates Ψ's transfer; families' depths do not follow their air | 282–295 | Met by plan §14's "who owns Venus-like decks"                             |
| `visibleThickness` weighs the dust at a third of its measure                       | 127–133 | Met: it scales `SKY_FRACTION` and `deepSky`                               |

---

## 16. Open questions

1. **The scene unit (phase 0, §8.3).** Does `SURFACE_LUMINANCE` become E⊥/π (and with it
   which E⊥, 133.3 or 133.8 klx), or stay as the calibration white with emitters converted
   through E⊥/π? Is `SOLAR_LUMINANCE` (108.7 klx at 1 AU) reconciled at the same time?
   How do absolute emitters treat Enhanced's per-body `light = 1`?
2. Does the composite match the shell's 12-sample air at sky pixels and `airToward`'s 4 at
   surface pixels, which needs a sky/surface classification such as far depth? Or do the
   surfaces and the shell move to one sample rule?
3. Under Enhanced from orbit, is the cloud's own scattered light dimmed by the physical
   `T_a(0,t0)` (the identity stays exact) or by the cleared one (it matches surfaces; the
   identity is approximate)? The plan picks cleared, and phase 0 bounds the error.
4. Does Enhanced's ring (`marchLimb`, shell only) need a split at the cloud too, or is
   `T_c·ring` acceptable at the limb at dusk?
5. Where does the sky-irradiance table's altitude axis put its rows (linear 16 like Ψ, or
   warped toward the boundary layer)? Does it include the ground's bounce, which the
   model lacks (ADR-0056: no ground bounce)?
6. Is the transmittance table's lowest row (1.59 km, up to +18% blue at a 5° sun)
   accurate enough for low cloud bases, or does phase 0 warp v?
7. For sulfuric-family worlds and Titan, whose air already carries a deck or haze, do the
   tables or the volume own the cloud (plan §14)? These are exactly the deep hazes where
   `limbShare = 0` turns clearing off.
8. The sea's reflected sky today is 0.9 of the day's light in the authored tint (§6.5
   above). Was that a deliberate look, or the defect §6.5 should close first, before the
   deck is reflected?
