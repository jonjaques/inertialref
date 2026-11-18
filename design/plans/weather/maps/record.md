# Map: records, frames, time and data ingest

The data the weather field is a function of — `(body, place, renderTime)` — for
`/Users/jonjaques/.t3/worktrees/inertialref/t3-e896a8db/design/plans/the-weather.md`
§3, §4, §4.8, §10 phase 3 and §11.

Repository root below is `/Users/jonjaques/.t3/worktrees/inertialref/t3-e896a8db`
(branch `feat/the-weather-stacked-prs`, HEAD `c2a50f1`). Every `file:line` was read
at that commit. **[inference]** marks a claim not read directly off code or docs.
Nothing in the repository was modified to produce this map.

---

## 0. The facts an implementer cannot skip

1. **A generated body's record has `appearance.clouds: null`, hard-coded**, in
   `proceduralAppearance` (`packages/universe/src/system.ts:1259`) and in
   `makeSmallBody` (`system.ts:1933`). Only Venus and Earth carry a `CloudLayer`
   (`solar/bodies.ts:527`, `:574`). Every reader of `appearance.clouds` treats non-null
   as "draw the textured deck", and a mapless deck is an **opaque** shell tinted by
   `appearance.color` (`render/planet.ts:714-717`, `render/bodyUniforms.ts:474`).
   Setting `clouds` on a generated world without changing those readers paints the
   whole planet white (§1.6).
2. **"Wet" is not one flag.** It is `body.surface.seaLevel !== null` (a standing
   sea) plus `body.surface.grammar.liquidKind` (`'water' | 'hydrocarbon' | 'magma' |
null`). Running liquid is `grammar.liquid` and `grammar.drainage`, both 0..1. Every
   generated record carries a rotation (`rotationPeriod`, signed), a tilt (`axialTilt`)
   and two temperatures (`grammar.temperature` and `grammar.groundTemperature`).
   Sol's own `SolarBody.temperature` (Earth 288 K) is **dropped** when the `Body` is
   built (§1.3).
3. **The pole is a tilt about +X of the parent's frame, with no direction**
   (`frames.ts:295-304`). The season and the local solar time come only from the
   sun's direction in body-fixed axes at the presentation instant. That direction is
   computed today in three places, two of them in render space (§2.4).
4. **The presentation instant is `engine.snapshot.renderTime`**, not
   `clock.renderTime`. The snapshot is built from a cutscene's held epoch, else the
   observatory's held or live time, else `clock.renderTimeAt(alpha)`
   (`engine/GameEngine.ts:1588-1595`). Time is seconds after J2000 and can reach
   `TIME_LIMIT = 3.15576e12` s in a held picture (`devtools/src/heldTime.ts:18`).
5. **The existing deck drift is not reduced before upload.** `drift: time /
deck.rotationPeriod - time / body.rotationPeriod` (`bodyUniforms.ts:483`) is a
   float64 difference of rates, which avoids cancellation, but the result is an
   unbounded count of turns. On Earth that is −584 turns in 2026 (2.4 km steps in
   float32) and −2.25 × 10⁶ turns at the time limit (quarter-turn steps). The pattern
   to copy is the wave clock (`render/water.ts:199-208`, `:685-689`) with its closure
   test (`render/water.test.ts:25`), not the deck (§4).
6. **Nothing the weather does may enter `world.stateHash()`, a save, or
   `GENERATION_VERSIONS`.** The hash covers tick, seed, structures and
   `CanonicalEntity` only (`simulation/src/world.ts:1385-1391`). A presentational
   change to a generated value "rides along" without spending `SYSTEM_ALGORITHM`, and
   the haze families are the precedent (`universe/src/versions.ts:53-66`). It rides
   along only if it consumes **no draw from the body's `rng` stream** (§5).
7. **Never add a weather field to `SurfaceParameters` or `SurfaceGrammar`.**
   `surfaceIdentity` is their full text (`universe/src/surfaceIdentity.ts:55-62`). It
   keys the heightfield archive (`workers/src/heightfieldCache.ts:67-75`) and the
   drainage memo, so a new field misses every archived tile and every memo (§7.6).
8. **Earth's ground is generated and disagrees with its photograph about where the
   land is** (ADR-0020, `docs/adr/0020-the-face.md`
   lines 81-90). Orography and land/ocean statistics for Earth cannot come from
   `drawnElevation`, the drainage graph or the generated sea datum. Earth ships
   slopes and an ocean mask (`earth_normal.webp`), not heights. Mars ships no
   elevation at all (§7.4).
9. **The ingest has no netCDF/HDF reader.** Its one devDependency is `sharp`
   (`apps/ingest/package.json`), and `fetchSource` decodes everything as UTF-8 text
   (`apps/ingest/src/sources.ts:113-155`). An ISCCP-H file needs a binary download
   path (copy `textures.ts:92-108`) and a reader decision (§6.6).
10. **Committed data is plain git, not LFS**, except `*.glb`, `*.blend` and
    `data/audio/masters/**` (`.gitattributes`). `data/textures/` is 25 MB of WebP
    with a `manifest.json` and a `LICENSE.md`, and prettier checks the manifest
    (§6.4).

---

## 1. The body record (`packages/universe`)

### 1.1 Types, and what the weather reads from each

All in `packages/universe/src/system.ts` unless noted.

| Type / field                                 | Where                                    | Meaning                                                                                                                    | Weather use                                                                        |
| -------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Body`                                       | `:211-248`                               | The record                                                                                                                 | —                                                                                  |
| `Body.radius` / `polarRadius`                | `:236`, `:226`                           | Equatorial `a` / polar `c`, meters                                                                                         | Shell heights; flattening = `polarRadius/radius`                                   |
| `Body.figure: BodyFigure \| null`            | `:238`, type `:177-209`                  | **Null means round, not unknown** (rule 27)                                                                                | A figured body's shells are round (`bodyUniforms.ts:348`, rule 25)                 |
| `Body.rotationPeriod: Seconds`               | `:242`                                   | Sidereal, **signed**; negative is retrograde                                                                               | Coriolis sign, jets, cyclone handedness, deck drift                                |
| `Body.axialTilt: Radians`                    | `:243`                                   | Magnitude only. Retrograde lives in the sign of the period; Venus is 2.64°, not 177.36° (`solar/bodies.ts:490-496`)        | Season amplitude                                                                   |
| `Body.orbitalPeriod`                         | `:241`                                   | Uses `G(M+m)`                                                                                                              | Season rate; a lock is `tidallyLocked(body)` (`devtools/src/dossier.ts:1617`, ±1%) |
| `Body.elements: OrbitalElements`             | `:240`                                   | Epoch 0 = J2000. Node and anomaly are drawn from the seed for Sol's planets (`solar/system.ts:250-273`)                    | Why calendar ≠ drawn season (§2.2)                                                 |
| `Body.atmosphere: Atmosphere \| null`        | `:244`; `physics/src/rigidBody.ts:74-81` | `{surfaceDensity kg/m³, scaleHeight m, ceiling m}`, isothermal (`atmosphericDensity`, `:84-93`)                            | Column mass, pressure proxy. No temperature, no wind                               |
| `Body.surface: SurfaceParameters`            | `:245`, type `:133-160`                  | `{seed, maxElevation, roughness, seaLevel, grammar}`                                                                       | Wetness, temperature, orography                                                    |
| `SurfaceParameters.seed: Seed`               | `:134`                                   | `deriveSeed(bodySeed, 'surface')`. **`Body` has no seed field of its own**                                                 | Root of any weather seed (§5)                                                      |
| `SurfaceParameters.seaLevel: number \| null` | `:147-148`                               | Datum as a fraction of `maxElevation`; null = no standing sea. Meters: `seaDatumElevation(surface)` (`regions.ts:298-303`) | The "wet surface" gate                                                             |
| `SurfaceGrammar` (`grammar.ts:167-275`)      |                                          | Derived, plain data, posted to workers                                                                                     |                                                                                    |
| `.temperature: Kelvin`                       | `grammar.ts:175`                         | Equilibrium, flat Bond 0.2 (`equilibriumTemperature`, `:401-402`)                                                          | Condensation class (plan §4.3, Sudarsky)                                           |
| `.groundTemperature: Kelvin`                 | `:183`                                   | `surfaceTemperature(eq, airMass)` greenhouse fit (`:423-430`): Mars 213, Earth 286, Venus 739                              | Surface temperature profile (phase 4)                                              |
| `.airMass` (kg/m²), `.air` (0..1, log)       | `:193`, `:208`                           | `surfaceDensity·scaleHeight`; `air = log10(1+airMass)/6`                                                                   | Rain and dust gates                                                                |
| `.liquidKind: LiquidKind \| null`            | `:250`; type `:287`                      | `'water' \| 'hydrocarbon' \| 'magma'` by ground temperature (`liquidKind()`, `:324-328`)                                   | Water clouds want `'water'`                                                        |
| `.liquid`, `.drainage`, `.biota` (0..1)      | `:259`, `:261`, `:272`                   | Running liquid; valley carving; biosphere                                                                                  | Rain-capable, valley fog                                                           |
| `.gravity`, `.meanRadius`, `.density`        | `:170-174`                               | —                                                                                                                          | Deformation radius, scale heights                                                  |
| `BodyAppearance` (`:382-415`)                |                                          | Presentation: what a body looks like                                                                                       |                                                                                    |
| `.clouds: CloudLayer \| null`                | `:392`; type `:282-293`                  | `{altitude: Meters, rotationPeriod: Seconds (the deck's sidereal period), opacity}`                                        | §1.6                                                                               |
| `.haze: HazeLayer \| null`                   | `:394`; type `:311-380`                  | `height, color, limb, thickness, aerosolHeight, aerosolAngstrom, ozone, aerosolDepth?, aerosolAlbedo?, detached?`          | The air's tables. **No family name** (§1.4)                                        |
| `.liquid: LiquidAppearance \| null`          | `:414`; `appearance.ts:29`               | Liquid color, absorption, glow                                                                                             | Sea reflection                                                                     |
| `.texture: string \| null`, `.maps`          | `:384-385`                               | Manifest key. `maps` is `[]` for Sol (`solar/system.ts:96`), so "which maps exist" is the manifest's business              | Mapped versus generated                                                            |
| `.color`, `.pigment`, `.geometricAlbedo`     | `:389`, `:396`, `:405`                   | —                                                                                                                          | Mapless deck tint today                                                            |

`RenderBody` (`packages/rendering/src/scene.ts:62-150`) carries `rotationPeriod`
(`:118`), `orientation` (body-fixed axes into render axes, `:413`), `trueRadius`,
`flattening`, `figure`, `appearance` (the whole `BodyAppearance`, `:461`) and
`sunlight`. **It carries no `surface`, `axialTilt`, `atmosphere` or `elements`.**
The full `Body` comes from `engine.bodyFor(address)` (`engine/GameEngine.ts:1338-1344`).
The orbital bake reads it the same way (`render/orbitalBake.ts:228`, `:262`), and
`Bodies.tsx:270` hands it in. `BodySnapshot` (`simulation/src/snapshot.ts:332-349`)
carries the address, radii, `rotationPeriod`, `appearance`, `position`, the spin
`orientation`, `atmosphereCeiling`, `atmosphereScaleHeight` and `relief`.

### 1.2 How generated bodies are built (`system.ts`)

- `generateSystem` (`:1568-1722`) builds observed planets first (`makeObservedPlanet`,
  `:1377-1547`), then projected ones (`makePlanet`, `:776-904`), then debris
  (`makeSmallBody`, `:1761+`). Sol branches at `:1578` to `solarSystem`.
- **Seeds are by address** (rule 4): `seed = deriveSeed(systemSeed, 'b:<index>')`, one
  `Rng` per body (`:785-786`). The draw order inside that stream is load-bearing. Every
  later draw (tilt, rotation, moons) sits downstream of an earlier one.
- The temperatures are `temperature = equilibriumTemperature(insolation(star, a))`
  (`:833`, `:1455`) and `groundTemperature` inside `surfaceGrammar` (`grammar.ts:550`).
  A moon gets its **parent's** equilibrium temperature (`:646`, `:684`).
- The sea is `makeSurface` (`:571-626`). `drawnSea` is drawn only when an atmosphere
  exists and the body is solid (`:579-582`, a 40% chance, datum 0.15–0.55). It is then
  _read_ against the ground temperature by `readDrawnSea` (`grammar.ts:355-364`):
  `seaLevel` is null where `liquidKind(groundTemperature) === null`.
- The rotation:
  - Planets: `max(hydrostaticSpinFloor, U(0.25, 3) d)`, retrograde 6% (`:866-870`).
  - Moons: 70% locked to the orbit, else `U(0.4, 30) d` (`:694-696`).
  - Observed planets inside 0.1 AU: locked (`:1467-1473`).
- The tilt: planets take `planetTilt(gaussian(0, 0.35))`, up to 1.5 rad (`:898`,
  `:1005-1009`); moons take `|gaussian(0, 0.15)|` (`:738`).
- **The appearance** is `proceduralAppearance(rng, kind, radius, surface, atmosphere)`
  (`:1219-1293`):
  - `rings` draws from the body `rng` (`:1227-1237`).
  - Every color draws from a **separate stream** `palette = new Rng(deriveSeed(surface.seed, 'appearance'))`
    (`:1248`). The comment at `:1238-1247` says why: a draw from `rng` would move the
    rotation, tilt and moons, which is a system version.
  - `clouds: null` (`:1259`).
  - The haze is `hazeFor(palette.fork('haze'), grammar)` for non-giants, and
    `KIND_HAZE[kind] + GIANT_AEROSOL` for giants (`:1250-1252`). Its height is
    `min(ceiling, 0.02 R)` for a rocky body and `0.008 R` for a giant (`:1268-1270`).
- **A generated wet world** is `seaLevel !== null && grammar.liquidKind === 'water'`
  **[inference: no helper exists]**. Readers today test `seaLevel !== null` alone:
  `worldQuery.ts:145`, `:192` (`hasSea`); `render/terrain.ts:1500`;
  `rendering/src/terrainMesh.ts:573`. The plan's §4.3 condensation class wants the
  temperature too.

### 1.3 Sol (`solar/bodies.ts`, `solar/system.ts`)

`SolarBody` (`bodies.ts:104-173`) has `temperature: Kelvin` (the mean surface or
1-bar temperature, `:149-150`), `haze: SolarHaze | null` (`:78-96`) and
`clouds: SolarClouds | null` (`:98-102`, the same three fields as `CloudLayer`).
`buildBody` (`solar/system.ts:209-369`) maps it to a `Body`:

- **The appearance:** `clouds: body.clouds` and `haze: body.haze` pass straight through
  (`solar/system.ts:100-102`).
- **The temperature is dropped.** The grammar is built from
  `equilibriumTemperature(L/(4πd²))` (`:299-301`), and
  `measurement.equilibriumTemperature` is `null` (`:348`). `SolarBody.temperature` is
  never read for a `Body`. Earth's `groundTemperature` comes out of the fit at about
  286 K (`grammar.ts:441-442`).
- **The sea:** `seaLevel = body.name === 'Earth' ? 0.55 : null` (`:156`). **Earth is
  the only Sol body with a sea.** Titan has methane `liquid`, drainage and rivers, but
  no sea datum. `hadOcean` is Earth-only too (`:174`).

| Body    | `clouds`                                                                               | `haze` (key fields)                                                                                                                       | Atmosphere `{ρ₀, H, ceiling}` | Rotation, tilt                | Maps (`data/textures`)                         |
| ------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------- | ---------------------------------------------- |
| Earth   | `{12_000 m, 25.5 h, 0.92}` (`bodies.ts:574`)                                           | `{100 km, thickness 1, aerosolHeight 1_200, Ångström 1.3, ozone 300}` (`:549-563`)                                                        | `{1.217, 8_500, 100_000}`     | 23.93447 h, 23.4393°          | albedo, night, **clouds**, normal (GEBCO)      |
| Venus   | `{60_000 m, −4.2 d, 1}` (`:527`)                                                       | `{90 km, thickness 1, aerosolHeight 15_900, Ångström 0}`, **no `aerosolDepth`**; the deck is the cloud layer's (`:504-515`)               | `{65, 15_900, 250_000}`       | −5,832.5 h, 2.64°             | albedo, **clouds** (SSS `4k_venus_atmosphere`) |
| Mars    | `null` (`:644`)                                                                        | `{100 km, thickness 0.0066, aerosolHeight 11_100, aerosolDepth 0.3, aerosolAlbedo 0.93, Ångström 0}` (`:596-633`)                         | `{0.02, 11_100, 120_000}`     | 24.6229 h, 25.19°             | **albedo only** (SSS 8k)                       |
| Titan   | `null`, deliberately: "an opaque shell at 200 km sits over 96% of a haze" (`:392-394`) | `{600 km, thickness 2.7, aerosolHeight 70 km, aerosolDepth 4.3, aerosolAlbedo 0.95, Ångström 1.5, detached {16, 2.4, 0.02}}` (`:359-391`) | `{5.4, 21_000, 600_000}`      | 15.945 d (locked), tilt 0     | none                                           |
| Jupiter | `null` (`:756`)                                                                        | `{570 km, 0.3, 27 km}`                                                                                                                    | `{0.16, 27_000, 1.5e6}`       | 9.925 h, 3.13°                | albedo (bands, jet shear `flowRate` 2.5e-7)    |
| Saturn  | `null` (`:807`)                                                                        | `{480 km, 0.3, 59.5 km}`                                                                                                                  | `{0.19, 59_500, 2e6}`         | 10.656 h, 26.73°              | albedo, ring                                   |
| Uranus  | `null` (`:860`)                                                                        | `{200 km, 0.45, 27.7 km}`                                                                                                                 | `{0.42, 27_700, 8e5}`         | −17.24 h, 82.23° (supplement) | albedo (`flowRate` 2.5e-6)                     |
| Neptune | `null` (`:904`)                                                                        | `{200 km, 0.45, 19.7 km}`                                                                                                                 | `{0.45, 19_700, 7e5}`         | 16.11 h, 28.32°               | albedo (`flowRate` 2.5e-6)                     |

Moons default to `clouds: null`, `haze: null`, `axialTilt: 0` and locked rotation
(`bodies.ts:197-237`). `minorMoons.ts:96`, `smallBodies.ts:230` and `:284` are all
null.

### 1.4 "Haze family" is not on the record

The record never names a family. `hazeFor` (`appearance.ts:296-325`) picks one of
`HAZE_FAMILIES` (`:207-294`) by ground temperature and copies its fields: color, limb,
`aerosolScale` (into `aerosolHeight = aerosolScale·scaleHeight`, `system.ts:1279`),
`angstrom`, `aerosolDepth?` and `aerosolAlbedo?`. A family is recognizable only by its
values:

- **Sulfuric:** `aerosolDepth 8`, `aerosolAlbedo 0.98`, coldest 450 K (`:233-247`).
- **Dust:** `aerosolDepth 0.4`, `aerosolAlbedo 0.93`, well mixed, 150–900 K (`:218-232`).
- **Violet:** `aerosolDepth 0.25`, `aerosolAlbedo 0.9` (`:270-283`).
- **Tholin:** aloft, Ångström 1.5, under 170 K, no depth.
- **Methane:** under 230 K, no depth.
- **Rayleigh:** a boundary layer, Ångström 1.3, no depth.
- **Green:** 200–500 K.

The air's tables read `haze.aerosolDepth`, `.aerosolAngstrom`, `.aerosolAlbedo`,
`.ozone`, `.detached` and `.thickness` (`rendering/src/atmosphere.ts:443+`,
`:590-595`). Plan §4.3's condensation class has to be derived from `grammar.temperature`,
not from a family field. Plan §14 says a condensable species "beside the haze family" waits
for later work, and adding one is a record field, which is a system version (plan §11).

### 1.5 The rules that bind the record (15, 17, 26, 27, and 5)

- **Rule 15** ("never persist anything regenerable", `docs/agents/invariants.md:219-222`):
  the weather is regenerable from `(seed, place, t)`. No weather value goes in a
  `SaveGame` (`protocol/src/save.ts:223-245`), which stores `seed, galaxy, tick,
generation, catalog, entities, structures, mutations` and nothing about appearance.
- **Rule 17** ("never store what the catalog can derive", `:231-235`): a temperature
  profile, the condensation class, the jet count and a lock are derived functions of
  `Body`. Plan §11 says the same: "stores nothing (rule 17) and spends no version". The
  record rule extract agrees: "Derive; do not add a field for what the panel can
  compute" (`.claude/rules/record.md`).
- **Rule 26** (`:291-304`): a field nothing has measured is a `Fact` row with a null
  value and a reason written **in the universe's voice**. `dossier.test.ts:145-146`
  bans `/generator|generated|procedural|not modeled|this build|codebase|engine|TODO|implement/i`
  in reasons. The weather touches three rows:
  - `Cloud deck` (`devtools/src/dossier.ts:1200-1212`) prints `None` when
    `appearance.clouds === null`. **"None" is an answer, not no data** (`record.md`),
    so a world the volume draws clouds on while its record says `None` is a dossier
    that lies.
  - `Circulation` is pending with the reason "the deck's turn rate is known; its
    weather is not. No jet streams, no seasonal bands and no storms with positions"
    (`:1218-1223`). It becomes false at phase 3 or 4.
  - `Pole direction` is pending with the reason "Which way the axis points … is what a
    season depends on, and it has not been fixed" (`:983-987`). It stays true: the plan
    reads the season from the sun.

  The planetarium's source table lists `Circulation` as "Bands and a jet profile on
  `CloudLayer`" and `Surface temperature` as "A greenhouse model …"
  (`docs/design/planetarium.md:710-714`). A phase that fills a row updates that table
  in the same change.

- **Rule 27** (`:306-313`): `figure: null` is round. The cloud and atmosphere shells
  are round about a figured body (`bodyUniforms.ts:24-31`, `:346-348`, rule 25).
- **Rule 5**, with `versions.ts:53-66`: a presentational change to a generated value
  does not spend `SYSTEM_ALGORITHM` ("A haze is presentation: no frame, no terrain and
  no contact test reads it … It rides along"). `SYSTEM_ALGORITHM` is `system@4`
  (`:66`), `TERRAIN_ALGORITHM` is `terrain@7` (`:175`), and the manifest is
  `GENERATION_VERSIONS` (`:186-192`). Pictures carry the generation manifest and
  **refuse to open on a mismatch**
  (ADR-0033, `docs/adr/0033-presets-hold-a-photographic-instant.md`
  lines 52-53). A weather bump would orphan every preset, and `versionDrift` in
  `protocol/src/net.ts` would split multiplayer.

### 1.6 Every reader of `appearance.clouds` (what changing it does)

| Reader                       | `file:line`                            | What it does with non-null                                                                                                                    |
| ---------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Body residency, per draw     | `scene/Bodies.tsx:410-416`             | `materialize(star, appearance.clouds !== null, rings)` builds a cloud shell mesh (`:350-355`, `renderOrder = 1`)                              |
| Boot and jump warm-up        | `scene/Bodies.tsx:731`                 | `clouded: body.appearance.clouds !== null` compiles the deck's pipeline through `warmCompile` (rule 61)                                       |
| The deck's uniforms          | `render/bodyUniforms.ts:446-485`       | Lift ≥ 0.4% R (`:458`), entry fade, `cloudShellAltitude`, tint, sunset color, opacity, drift                                                  |
| The sphere's cloud height    | `render/bodyUniforms.ts:433-436`       | `cloudHeight = altitude/trueRadius`. `cloudShadow` is gated on `maps.clouds`, the texture (`:432`)                                            |
| The deck material's fallback | `render/planet.ts:714-717`, `:785-787` | No map gives `WHITE`, an **opaque** texel: "a mapless deck … at zero opacity" is avoided by design, so a mapless deck is a solid tinted shell |
| Dossier                      | `devtools/src/dossier.ts:1200-1212`    | "Cloud deck: N km, turns in P"                                                                                                                |
| Sol mapping                  | `universe/src/solar/system.ts:100`     | Passes through                                                                                                                                |

**Implication [inference]:** phase 1 (a generated wet world) has two choices.
(a) Leave `clouds: null` and key the volume on a derived predicate. The dossier's
`Cloud deck: None` row is then false, so it has to read the same predicate. (b) Give
generated wet worlds a `CloudLayer` and change the four render readers so a body
without a `clouds` map does not get the textured deck. Either way `Bodies.tsx`,
`bodyUniforms.ts` and the dossier change together. Earth keeps its deck until phase 3
(plan §10), so the deck path survives through phase 2 for Earth and Venus.

---

## 2. Frames: axes, tilt, spin and the sun in body-fixed axes

### 2.1 Conventions

- Axes are right-handed, +Y up, the reference plane is XZ and forward is −Z
  (`.claude/rules/determinism.md`). **Body-fixed +Y is the pole**
  (`terrain.ts:816-820`, `frames.ts:516`).
- `geodeticDirection(lat, lon) = (cos lat cos lon, sin lat, −cos lat sin lon)`
  (`frames.ts:517-529`). Its inverse is `directionToGeodetic` with
  `lon = atan2(−z, x)` and `lat = asin(y)` (`:532-543`).
- `compassBasis(lat, lon, heading)` is the one answer to "which way is east"
  (`:569-586`). `east = (−sin lon, 0, −cos lon)` is the direction longitude increases
  along, `north = (−sin lat cos lon, cos lat, sin lat sin lon)`.
- **The equirectangular map layout** (`SphereGeometry`'s) is
  `u = atan2(up.z, −up.x)/(2π)` and `v = 1 − acos(up.y)/π`
  (`render/terrain.ts:1146-1148`). Equivalently `u = 0.5 + lon/(2π)` (mod 1) and
  `v = 0.5 + lat/π`: longitude 0 sits at the map's center, which is Greenwich on
  Blue Marble. Textures wrap S with repeat and clamp T (`render/planetTextures.ts:148-149`).
  **An ISCCP 1° cell** (columns at 0.5°E…359.5°E, rows at 89.5°S…89.5°N) maps to
  `lon = ((λ°E + 180) mod 360) − 180` **[inference from the two formulas above]**.

### 2.2 The tilt about +X, and no pole direction

```ts
// packages/universe/src/frames.ts:295-304
function spinEvaluator(body: Body): (t: Seconds) => LocalPose {
  const tilt = Q.fromAxisAngle(vec3(1, 0, 0), body.axialTilt)
  const rate = (2 * Math.PI) / body.rotationPeriod
  return (t) => ({
    position: Vec.ZERO,
    orientation: Q.multiply(tilt, Q.fromAxisAngle(vec3(0, 1, 0), rate * t)),
    ...
```

- The `bf:` frame is the child of the body's inertial `b:` frame
  (`installSystemFrames`, `:433-489`). `rate·t` is float64 on the CPU, so there is no
  precision issue at any t.
- For a planet, `b:` sits in system axes (`planeTilt = 0`). The spin axis is
  `R_x(ε)·Ŷ = (0, cos ε, sin ε)`, so the equator's node line on the reference plane is
  the system **X axis** for every planet in every system. The solstices fall where the
  body→star direction is ±Z and the equinoxes where it is ±X **[inference: algebra on
  the formula above]**.
- For a moon, the `b:` orientation is the **parent's** tilt (`orbitEvaluator`
  `:273-285`, with `installBody(moon, frame, body.mu, body.axialTilt)` at `:481-482`).
  The moon's own tilt is applied about +X again inside that frame.
- **No right ascension or declination of the pole exists.** The dossier says so
  (`:983-987`) and plan §11 keeps it for later. With Sol's node and mean anomaly drawn from
  the seed (`solar/system.ts:250-273`), Earth's position on its orbit at J2000 is
  arbitrary relative to the X axis, **so a calendar month and the drawn season
  disagree by an arbitrary phase** (plan §4.1).

### 2.3 The season and the local solar time from the sun **[inference: formulas, not in the code]**

Given `s` = the unit vector body→star in **body-fixed** axes at `t = snapshot.renderTime`:

- Sub-solar latitude `δ = asin(s.y)`; sub-solar longitude `λs = atan2(−s.z, s.x)`
  (the `directionToGeodetic` convention).
- The season's trend is `sign(δ(t + Δ) − δ(t))`, with Δ a small fraction of
  `orbitalPeriod`. It is a pure function of t, so it costs two evaluations and stores
  nothing.
- Local solar time at longitude λ: the hour angle is `h = λ − λs`. For a prograde
  rotator the ground moves toward +longitude (`R_y(+θ)` carries `lon 0` to `lon θ`),
  so λs decreases with time and `LST = 12 h + sign(rotationPeriod)·h/(2π)·24 h`.
  Check this with a property test (LST increases with t at a fixed place) before
  trusting the sign for retrograde bodies.
- An equivalent "climatological month" for Earth's ISCCP lookup can come from the solar
  longitude `Ls ∈ [0, 2π)`, with `sin δ ≈ sin ε · sin Ls` and the branch chosen by the
  trend, or as an angle in the parent's orbital plane, Ls = 90° at body→star = +Z.
  Northern spring (Ls = 0) is around March 20, so
  `monthPhase ≈ 2.6 + 12·Ls/(2π)` months since January 1. At `ε ≈ 0` there are no
  seasons and the annual mean is the honest lookup.
- Moons: compute `s` from the moon's own `bf:` pose, which carries both tilts.
  Titan's season is then Saturn's, through the chain.
- A lock is `tidallyLocked(body)` (`dossier.ts:1617-1621`); the solar day is
  `synodicDay(rotation, year)` (`:1643-1654`). **Both live in `packages/devtools`
  (layer 6)**, so code in `packages/rendering` (layer 5) or `packages/universe`
  (layer 3) cannot import them (`.claude/rules/packages.md`). Move them down rather
  than copy them. The sun's longitude gives local solar time without `synodicDay`
  at all.

### 2.4 How the sun's direction is obtained today (three producers)

| Producer                                   | `file:line`                                                         | Axes                                                                                                          | Precision                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `bodyUniforms` → `sun`                     | `render/bodyUniforms.ts:359-362` (`normalize(keyLight − position)`) | **Render** space (compressed)                                                                                 | From `placement.position`s. The sphere, deck and shell use it with `normalWorld`                                                         |
| Terrain and sea                            | `scene/TerrainPatches.tsx:175-185`, `scene/WaterPatches.tsx:98-106` | **Body-fixed**: `Q.rotate(Q.conjugate(state.orientation), normalize(star.placement.position − state.center))` | Render-space positions, rotated by the patch set's orientation                                                                           |
| `sunDirection(world, system, frame, time)` | `devtools/src/maneuvers.ts:107-121`                                 | **Any frame's axes**: `Q.rotateInverse(pose.orientation, UV.difference(star, pose.position))`                 | Float64 universe positions at an explicit time. The observatory has its own `#starDirection` (`observatory.ts:1746-1764`) at `this.time` |

- Render space is the universe rotated by the render origin:
  `orientationToRenderSpace(origin, q) = conj(origin.orientation)·q`
  (`spatial/src/origin.ts:90-91`). A body→star vector built from **placed**
  (compressed) positions is not parallel to the true one for a body far from the eye,
  because compression is radial about the eye (rule 28) **[inference: geometry; no
  test measures it]**. The climate lookup (δ, LST) should use the float64 form
  (`sunDirection` with `bodyFixedFrameId(body.address)` at the snapshot's instant).
  The lighting keeps the render-space one.
- **The lighting and the climate can disagree by that compression error on a distant
  body.** It does not matter for a 1° climatology, but say so in the code.

---

## 3. Time: `renderTime`, the presentation instant, and warp

### 3.1 The clock (`packages/simulation/src/clock.ts`)

- `TICK_RATE = 64` (`:24`), exact in binary. `time = tick/64` (`:146-148`).
- `renderTimeAt(alpha) = time − (1 − alpha)·TICK_DURATION` (`:204-206`): one tick
  behind, plus alpha. `renderTime` (`:199-201`) is "the instant presentation is drawn
  at".
- **The epoch is J2000.0**: simulation time is seconds after 2000-01-01 12:00 UTC
  (`shared/src/units.ts:123-138`, `SIMULATION_EPOCH_UTC_MS`). A fresh session starts at
  tick 0 (`clock.ts:138`; no `startTick` in `openSession`). Bundled presets hold
  `time` 0 or about 1.2 × 10⁵ s (`devtools/src/pictures.json`).
- The large values come from a held date, a save's tick and warp: the planetarium's
  UTC date selection (2026 is about 8.2 × 10⁸ s, `water.ts:201`), `?t=`, a restored
  save, and warp (100,000× for a day of wall clock is 8.6 × 10⁹ s). The held-instant
  bound is `TIME_LIMIT = 3.15576e12` s, 100,000 years (`devtools/src/heldTime.ts:18`).
  **Design every reduction for |t| ≤ 3.2 × 10¹²** (float64 ulp there is 4.9 × 10⁻⁴ s).
- Rule 2: wall clock enters canonical code only at `clock.plan` (`:242`). The weather
  is presentation, but plan §3 needs it to be a pure function of `t`. **Never read
  `performance.now()` or `engine.presentationTime` into the field**, or two clients
  and a scrub stop agreeing.

### 3.2 The presentation instant

```ts
// apps/game/src/engine/GameEngine.ts:1579-1596, abridged; the comments are the map's, not the source's
if (
  this.harness.cutscene.status() === null &&
  this.harness.observatory.target !== null
)
  this.harness.observatory.advanceTime(delta) // a held clock advances first
const cinematic = this.harness.cutscene.sample(this.world.clock.renderTime)
const shot = snapshot(
  this.world,
  undefined,
  cinematic?.presentationTime ??
    (cinematic === null && this.harness.observatory.target !== null
      ? this.harness.observatory.time // held instant, or live renderTime
      : undefined),
) // → clock.renderTimeAt(alpha)
this.snapshot = shot
```

- `snapshot(world, alpha, presentationTime = world.clock.renderTimeAt(alpha))`
  (`simulation/src/snapshot.ts:280-292`) evaluates every **analytic** body and station
  pose at that instant (`:314-323`, `:359-363`) and returns it as
  `WorldSnapshot.renderTime` (`:179`, `:384`). Integrated entities keep their own
  history (`:283-284`).
- **The weather reads `engine.snapshot.renderTime`.** It already reaches the frame:
  - `Bodies.tsx:386` puts `renderTime: engine.snapshot?.renderTime ?? 0` into the
    `BodyFrame` (`render/bodyUniforms.ts:40-50`, "never `clock.time`").
  - `WaterPatches.tsx:118` calls `water.setTime(engine.snapshot?.renderTime ?? 0)`.
  - `Sensor.tsx:97` reads `time: engine.snapshot?.renderTime ?? 0`.
- ADR-0033 lines 89-94: "The observatory, body snapshot, terrain, water, **clouds**,
  orbit traces and the object dossier all use that presentation instant." Rule 38
  (`invariants.md:445-462`): never `clock.time`, a 1/64 s step that sawtooths.
- `HeldTime` (`devtools/src/heldTime.ts:23-89`): `time` is the held instant, or the
  live `renderTime` when released. `set()` pauses (`:65-74`), and `advance(seconds)`
  adds `seconds·scale` while unpaused (`:81-87`). Observatory accessors:
  `time` (`observatory.ts:402-404`), `heldTime` (`:405-407`), `setTime` (`:408-411`),
  `timeScale`/`timePaused` (`:386`, `:383`), `advanceTime` (`:397-399`).
- **A cutscene holds a constant instant.** `MARS_PAD_SITE.presentationTime =
1133.52…` (`devtools/src/cutscenes/marsLanding.ts:27-29`) is fed as
  `presentationTime` for the whole shot, so weather keyed on the snapshot instant
  **freezes during that cutscene** while the camera moves (open question §11.4).

### 3.3 Cuts, scrubs and the presentation clock that is not the weather's

- `engine.presentationTime` (`GameEngine.ts:700`) accumulates
  `min(0.1, delta)` of wall clock every frame (`:1541`). It drives camera adaptation
  (ADR-0033 lines 102-107) and **is not simulation time**: it advances while the
  simulation is paused. The weather must not use it.
- `engine.declareCut()` increments `pictureEpoch` (`:706-711`), meaning "temporal image
  history is presentation state, outside the world hash". In the observatory it is
  called on a focus to a new target or an un-eased focus
  (`devtools/src/observatory.ts:1016`), on `clear()` (`:1038`), on `viewGalaxy`
  (`:801`) and on composing an orbit placement (`:1313`). It is also called on
  cutscene cuts (`cutscene.ts:244`, `:258`, `:316`, `:391`), on the on-foot, surface
  and maneuver arms and on the sensor mount.
  **`observatory.setTime` does not declare a cut** (`:408-411`).
- **A photographic-time scrub** is detected by the sensor through its `historyKey`.
  The key joins the galaxy seed, the target address, the galaxy view and
  `observatory.timePaused ? observatory.heldTime : ''` (`Sensor.tsx:100-107`, consumed
  at `render/sensor.ts:257`, `:490`). The weather's caches (maps, history, wetness)
  need the same two signals, `pictureEpoch` and a held-time key, **plus a jump test on
  `renderTime`** for live scrubs and warp changes **[inference]**. Plan §3 says the
  caches "rebuild after a cut or a scrub".

### 3.4 The warp factor (plan §4.6's fade key)

| Source                                                                                     | Where                                                       | Same on every client?                                               |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `snapshot.timeScale` (the world clock's request)                                           | `simulation/src/snapshot.ts:181`, `:386` ← `clock.status()` | Yes                                                                 |
| `world.clock.achievedTimeScale`                                                            | `clock.ts:164-166`                                          | **No**: a ratio of ticks run to wanted, so it depends on frame time |
| `observatory.timeScale` (photographic rate, ≤ `MAX_TIME_SCALE = 100_000`) and `timePaused` | `heldTime.ts:21`, `observatory.ts:383-395`                  | Yes                                                                 |
| A cutscene's held instant                                                                  | rate 0                                                      | Yes                                                                 |

The rate the **picture** moves at is the observatory's (`paused ? 0 : scale`) when a
target holds time, else the world clock's `timeScale`, and 0 under a held cutscene
epoch. `snapshot.timeScale` alone is wrong in the planetarium **[inference from the
plumbing above]**. "A held preset is at 1×" (plan §4.6) is true only while paused;
an unpaused held clock runs at `observatory.timeScale`.

---

## 4. Float64 decides, float32 draws: the reductions that exist

| Quantity                                 | Where (CPU, float64)                                                                                                 | What is uploaded                                                                                                                 | Guard                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **The wave clock**                       | `render/water.ts:685-689`                                                                                            | `waveTime = s − floor(s/6400)·6400`; `surfPhase = frac(s/SWELL_PERIOD)`                                                          | `WAVE_CLOCK_PERIOD = 6_400` is chosen so every drift × period is a whole number of `WAVE_PERIOD` (`:199-208`); `water.test.ts:9-35` holds it |
| Grain and wave domain origin             | `grainWrap` `render/terrain.ts:1569-1572`, `waveWrap` `water.ts:183-186`; set in `groundWear.ts:300-304`, `:341-345` | The anchor reduced modulo `GRAIN_PERIOD = NOISE_CELLS` wavelengths, so under 45 m; the shader adds `positionLocal/λ`             | `GRAIN_PERIOD` doc `terrain.ts:280-302`: patch-local is exact but discontinuous, body-fixed is continuous but quantized                      |
| Macro lattice split                      | `groundWear.ts:310-321`                                                                                              | `macroCell` (an integer, exact in float32) and `macroOffset` (under 4 km)                                                        | —                                                                                                                                            |
| Terrain tile frame (rule 58)             | `writeTileFrame` / `writeAxisFrame`, `universe/src/terrainKernel.ts:1014-1063`                                       | Per rung and per axis: `cell = floor(center·cells + offset)` (asserted under 2²⁴) and `fraction`; header `[face level i j]`      | `MAX_TILE_LEVEL = 23` (`:101`); `TILE_STRIDE`; `terrainKernel.gpu.test.ts`                                                                   |
| The eye's height over the deck (rule 52) | `cloudShellAltitude` `rendering/src/cloudShell.ts:8-19`; used `bodyUniforms.ts:465-470`                              | `eyeAltitude = hypot(x, y/f, z) − radius` in the shell's frame                                                                   | `cloudShell.test.ts:6` (property, 1e-6 at radii up to 10⁸)                                                                                   |
| Patch anchor                             | `groundWear.ts:296-299`                                                                                              | `Math.fround(anchor)`, `anchorAltitude = hypot − datumRadius`                                                                    | —                                                                                                                                            |
| **The deck drift: unreduced**            | `bodyUniforms.ts:483`                                                                                                | `drift = t/T_deck − t/T_body` **in turns, unbounded**; the shader adds it to `uv.x` (`planet.ts:729`); `RepeatWrapping` folds it | `bodyUniforms.test.ts:240-243` checks only `t = 3600`                                                                                        |
| The giants' band shear: raw time         | `planet.ts:354` `uv.x + time·flowRate·jets`                                                                          | `time = renderTime` (float32)                                                                                                    | Tolerated: at about 10⁻⁷ turn/s, 64 s of float32 time is invisible (plan §3)                                                                 |
| The star's churn: raw time               | `render/materials.ts:150` `time·0.003`                                                                               | `renderTime` (float32)                                                                                                           | None                                                                                                                                         |

**What the deck drift does at large t** (Earth: `1/91 800 − 1/86 164.09` is
−7.125 × 10⁻⁷ turn/s, or −22°/day relative to the ground):

| t                     | drift (turns) | float32 step (turns) | At Earth's equator           |
| --------------------- | ------------- | -------------------- | ---------------------------- |
| 3,600 s (the test)    | −0.0026       | about 2 × 10⁻¹⁰      | —                            |
| 8.2 × 10⁸ s (2026)    | −584          | 6.1 × 10⁻⁵           | 2.4 km jump every 86 s at 1× |
| 3.16 × 10⁹ s (100 yr) | −2,249        | 2.4 × 10⁻⁴           | 9.8 km                       |
| 3.16 × 10¹² s (limit) | −2.25 × 10⁶   | 0.25                 | 10,000 km                    |

The fix is `turns − Math.floor(turns)` in float64 before upload, with each rate's term
reduced separately for exactness at the limit. It belongs wherever any weather offset
is formed.

**Also a defect: the sphere's cloud shadow ignores the drift.** `planet.ts:452-464`
samples `cloudMap` at `shadowUv` with no `drift` term, while the deck samples at
`uv.x + drift` (`:729`). The shadow and the deck are out of register by `frac(drift)`
turns. That offset is 0 at t = 0, where most bundled presets sit, about 26° at t = 10⁵ s, and it sweeps a whole turn every 16 simulated days (22° a day)
**[inference from reading both graphs; not measured]**.
Phase 2 replaces this shadow with `cloudSunlight`.

**The recipe for the weather's offsets** (plan §3 and §4.5) **[inference, from the
patterns above]**:

- Each octave's phase is `frac(t/T_k)` in float64, uploaded as a float under 1. The
  shader adds `k/3 + ψ(x)` and `fract`s.
- The **period index** `n = floor(t/T_k + k/3 + ψ)` that picks a seed is a lattice
  decision.
  - With 1 km cells and `L/T ≈ 10 m/s`, T is 100 s, so n is 8.2 × 10⁶ in 2026 (under
    2²⁴) but 3.2 × 10¹⁰ at the limit, **past u32**.
  - Upload the CPU's `floor(t/T_k)` as two u32 halves (or modulo a hash period) and let
    the GPU add only the small `ψ`-driven carry. Hash with `pcg4d`
    (`procedural/src/lattice.ts:67`) on integers, never `toUnit(hash) < p` in float.
    The kernel stores the threshold as a u32 (`terrainKernel.ts:341-353`).
- The noise's spatial domain is the eye's **body-fixed** position reduced modulo the
  noise texture's period times its cell size, on the CPU, plus the sample's offset from
  the eye (the `grainOrigin` pattern). A 128³ or 32³ R8 texture is periodic by
  construction.
- Shell intersections are formed from heights (`cloudShellAltitude`), never as
  `length(p) − R` (rule 52).

---

## 5. Determinism and canonical state

- **What `world.stateHash()` reads** (`simulation/src/world.ts:1385-1391`):
  `t=<tick>`, `seed=<seedText>`, every structure as JSON, and
  `canonicalEntityLine(entity)` for each `CanonicalEntity`. The entity fields are
  `id, kind, name, state, mass, thrusters, control, flightAssist,
ballisticCoefficient, landed, character, rails` (`simulation/src/entityState.ts:31-50`).
  No body record, appearance, haze or cloud. Body records are regenerated from
  `seed + GENERATION_VERSIONS + catalog version`.
- The planetarium's design promise is that `observatory.test.ts` compares
  `stateHash()` across a session of flying around (`.claude/rules/react-shell.md`,
  rule 37). The weather must write nothing through `World`'s verbs (rule 12).
- **Presentation** here means anything no frame, no terrain and no contact test reads.
  It enters no hash, no save and no version. It may lag, and it may be approximate
  under warp (plan §3). It rides along with whatever version is current
  (`versions.ts:53-66`; ADR-0027 lines 115-124). The camera's own presentation state
  (`engine.presentationTime`, adaptation, `pictureEpoch`) is "outside the world
  hash" (`GameEngine.ts:705`; ADR-0033 lines 102-107).
- **What would make the weather canonical by accident** (each one breaks plan §3):
  1. A draw from a body's `rng` stream. It moves every later draw, which means the
     tilt, the rotation and the moons, and spends `SYSTEM_ALGORITHM`. Fork from
     `deriveSeed(surface.seed, 'appearance')` or a new label (`system.ts:1238-1248`).
  2. A field added to `SurfaceParameters` or `SurfaceGrammar` (§7.6).
  3. Wind or rain read by `World`, a ship or a contact test. That is rule 53's split:
     the CPU form would become canonical, the drawn and the canonical kept apart (plan
     §3, "and not before").
  4. A wall-clock read (rule 2), or order-dependence such as first-evaluated caches
     feeding the field (rule 4).
  5. A presentation switch written directly. A weather toggle, if one is added, is an
     `engine.presentation` stance field (`engine/presentation.ts:69-149`, rule 7).
- **Seeds for the weather [inference]:**
  `deriveSeed(body.surface.seed, 'weather')` and its labels (`procedural/src/seed.ts:55-74`).
  It is pure per address, and the same on every client for a universe seed. Earth's
  surface seed comes out of the Sol system seed, so Earth's events and texture differ
  per universe seed. Its climatology does not. Cell hashing is
  `pcg4d(i, j, k, lane)` on integer cell indices (`lattice.ts:67`), as `craters.ts` and
  the drainage lattice do (`drainage.ts:244`). A field value is never read off the
  nearest cyclone (rule 11): sum the kernels, each of which reaches zero inside its
  margin.

---

## 6. Ingest (`apps/ingest`)

### 6.1 Layout and commands

`apps/ingest/src/main.ts` dispatches on `process.argv[2]` (`:531-562`; the help
string is at `:559`):

| Command                      | Root script                                                                 | Writes                                                                                           | Cache                                                    |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `fetch` / `report` / `build` | `catalog:fetch` / `catalog:report` / `catalog:build` (`package.json:42-44`) | `data/catalog/{stars-150ly.irsc, stars-sky.irsc, manifest.json, LICENSE.md}` (`main.ts:294-351`) | `.data/raw/` (`sources.ts:111`)                          |
| `textures`                   | `textures:build` (`:45`)                                                    | `data/textures/*.webp`, `manifest.json`, `LICENSE.md` (`main.ts:409-428`)                        | `.data/textures/` (`textures.ts:90`); **no `--refresh`** |
| `solar`                      | `solar:fetch` (`:46`)                                                       | `data/reference/solar-system.json`                                                               | —                                                        |
| `shapes`                     | `shapes:build` (`:47`)                                                      | `data/shapes/`                                                                                   | `.data/shapes/` (`shapes.ts:50`), `--refresh`            |
| `audio:*`                    | `audio:fetch` / `audio:build` / `audio:report` (`:48-50`)                   | `data/audio/`                                                                                    | `.data/audio/…`                                          |

A new climatology command needs:

- a branch in `main.ts`, and its line in the help string at `:559`;
- a root script beside `package.json:42-50`;
- an output directory constant beside `main.ts:56-59`;
- a `docs/guides/catalog.md` section, the doc that describes every data directory,
  including "Planetary surface maps" (its lines 384-450). **That file already exists,
  so editing it needs no `wings.mjs` change.** A _new_ file under `docs/` does (rule
  46).

### 6.2 Sources and caching

- `Source` (`sources.ts:26-36`) is `{key, name, url, file, license, gzip?,
minimumBytes}`. `fetchSource` (`:113-155`) caches into `.data/raw/<file>` and
  **decodes the payload as UTF-8 text**. It validates before caching (minimum size,
  not an XML error body; `:164-185`) and on every cached read, naming the remedy
  (`--refresh`). It returns `{text, sha256, bytes, cached}`. The rule is "Record the
  digest, do not enforce it" (`:17-23`), because upstream changes weekly.
- `textures.ts` has its own **binary** `download()` (`:92-108`): a `Buffer`, cached in
  `.data/textures/`, no validation, no refresh. A netCDF ingest wants
  `fetchSource`'s validation discipline on top of `textures.ts`'s binary handling.
- `.data/` is gitignored (`.gitignore:66-69`): "34 MB of HYG to produce a 460 KB asset".

### 6.3 Manifests, licenses and committed outputs

- The texture manifest (`textures.ts:36-54`) is
  `{generated (date), attribution[], textures: [{body, map, file, width, height,
bytes, license, credit, source (URL), sha256 (of the output, 16 hex)}]}`.
  `buildTextures` **deletes any `.webp` the manifest no longer names** (`:343-346`).
  That orphan rule is how retiring Earth's cloud map in phase 3 removes
  `earth_clouds.webp`.
- The `LICENSE.md` beside each output is generated (`main.ts:430-447` for textures,
  `:363-398` for the catalog). Catalog guide: "`data/catalog/manifest.json` records
  the digest of exactly what was used … `data/textures/`, `data/shapes/` and
  `data/reference/` follow the same contract with their own manifests"
  (`.claude/rules/catalog.md`).
- `textures.test.ts:78-97` holds the shipped file to its manifest entry: source URL,
  byte count, and sha256 of the bytes. Copy that shape for the climatology.
- The catalog's version digests the **packed output**, not the source
  (`main.ts:162-185`), because it is a generation input. **A climatology is not a
  generation input.** It must not enter `GENERATION_VERSIONS`, the catalog version,
  `versionDrift` or a picture's manifest. A re-ingest may change a plate. ADR-0033
  lines 127-130: "A preset restores a view, not a screenshot".
- Earth's current cloud map: source `TEXTURE_SOURCES` entry `earth/clouds`
  (`textureSources.ts:139-148`), `cloud_combined_2048.jpg` through `luminanceToAlpha`
  (`textures.ts:240-266`) to `data/textures/earth_clouds.webp` (1,331,220 B, 2048 ×
  1024). Venus's deck is `sss('venus', '4k_venus_atmosphere.jpg', 4096, 'clouds')`
  (`:338`).

### 6.4 Committed-size and repository rules

- LFS covers only `*.glb`, `*.blend` and `data/audio/masters/**` (`.gitattributes`).
  `.lfsconfig` excludes the masters from default fetches because LFS bandwidth is
  metered. **`data/textures/` is plain git**: 25 MB, the largest file
  `luna_normal.webp` at 7.5 MB. The other directories: `data/catalog` 920 KB,
  `data/shapes` 1.0 MB, `data/reference` 560 KB, `data/models` 50 MB (LFS `.glb`).
- **Prettier checks every committed JSON except `data/reference/`**
  (`.prettierignore`, last entry). `pnpm check` includes `format:check`
  (`prettier -c .`, `package.json:16`). A manifest written by the ingest through
  `writeFileSync` fires no format hook. `JSON.stringify(x, null, 2)` puts each array
  element on its own line, and prettier collapses a short numeric array onto one, so a
  manifest with a short array (bin edges, a month list) fails CI. Run prettier on it or
  avoid short arrays **[inference: prettier's JSON array behavior; the existing
  manifests contain only long-string arrays]**.

### 6.5 How committed data reaches the game, Node and the service worker

- Browser textures:
  `import manifest from '../../../../data/textures/manifest.json'`
  (`render/planetTextures.ts:11`) and
  `import.meta.glob('../../../../data/textures/*.webp', {query: '?url', import: 'default', eager: true})`
  (`:38-42`). Everything is preloaded at boot (`preloadAllTextures`, `:238-247`). Data
  maps are `NoColorSpace` (`:101-107`): "do it anyway and every cloud edge moves".
- Browser binary: `import volumeUrl from '../../../../data/catalog/stars-150ly.irsc?url'`
  then `fetch` (`engine/catalogAsset.ts:18-35`). The `?url` asset is hashed, and the
  service worker caches `/assets/` cache-first (`apps/game/public/sw.js:5-6`, `:36`).
- Node: `readFileSync(new URL('../../../data/catalog/…', import.meta.url))`
  (`apps/headless/src/catalog.ts:20-24`). **`packages/*` decode bytes and never fetch
  them** (no DOM lib, no Node lib, no `TextEncoder`; `.claude/rules/packages.md` and
  `catalog.md`).
- **Implication [inference]:** plan §4.2's statistics are "counted on the CPU over the
  sphere and over simulated years". A WebP is decodable only by `sharp`, which is an
  ingest devDependency, so the climatology wants a **binary format with a decoder in
  `packages/*`** (like `readCatalog`), read from disk in Node tests and fetched as a
  `?url` asset in the browser. The GPU textures are then built from the decoded arrays.
  A `DataTexture` stand-in must be linear (rule 56), with one stand-in object per
  texture node (rule 57).

### 6.6 ISCCP-H, as far as can be verified from here

**Verified on the web on 2026-11-07** (NCEI THREDDS and the Hamburg ICDC mirror; not
in the repository):

- The HGM aggregation's dimensions are `lat = 180`, `lon = 360`, `time = 408`,
  `cldbin = 10`, `cloud_irtype = 3`, `cloud_type = 18`
  (THREDDS `cdr/isccp_hgm_agg/ISCCP-H_Aggregation_Basic_Gridded_Monthly_(HGM)_best.ncd`).
- The variables include `cldamt` (mean cloud amount) and `cldamt_types`, whose
  `cell_methods` is "area: mean time: mean within days time: mean over days".
- The labels are in `cloud_type_label` (18 VIS/IR types) and `cloud_irtype_label`
  (3 IR types).
- The grid is 1° equal-angle, longitudes 0.5°E…359.5°E and latitudes 89.5°S…89.5°N.
- HGM is the monthly average of the 3-hourly HGH. Files are netCDF, CF-compliant,
  about 30 MB per month.
- NCEI gives the record as July 1983–June 2017 (the mirror says to June 2015). The data
  are free to use and redistribute.
- ERDDAP dataset ids `iscpp_hgm_by_cloud_type`, `iscpp_hgm_by_cloud_irtype` and
  `iscpp_hgm_by_satpos` (NOAA's spelling) expose the label tables, not the grids.

**Not verified:**

- whether the files are netCDF-3 or netCDF-4/HDF5;
- the exact name of each per-type variable beyond `cldamt_types`;
- whether 18 types are the plan's 9 split by phase (liquid/ice) **[inference]**;
- whether HGM keeps per-UTC-hour slots (the diurnal cycle) or only the monthly mean;
- whether a land fraction or surface-type variable exists.

The NCEI "HGM/HGH Basic Variable List" PDF answers all five.

**MODIS Level 3, the plan's alternate:** the MOD08_M3 and MYD08_M3 atmosphere monthly
products are HDF-EOS2, which is HDF4 **[inference: not checked here]**, and no Node
reader exists for that. A reader decision is part of phase 3 either way. Candidates:
`h5wasm` for netCDF-4/HDF5, `netcdfjs` for classic only, a THREDDS NCSS subset, or an
offline Python step like `apps/ingest/models/*.py`.

### 6.7 What phase 3 touches in this area

**[inference: a shape, not a decision]**

1. A source table like `textureSources.ts`: pinned URLs, license
   (`'public-domain'`-style), credit.
2. A binary download into `.data/<dir>` with validation and `--refresh`.
3. The climatology reduction: mean annual cycle by month, per type, at 1°. The overlap
   rule `c_seen/(1 − c_above)` falls back to the zonal mean past `c_above > 0.9`
   (plan §4.2). It is done in the ingest, in float64, and tested in
   `apps/ingest/src/*.test.ts`.
4. The **diurnal phase moves from UTC to local solar time per column**
   (`LST = UTC + λ/15 h`). The simulation's local solar time comes from the drawn sun
   (§2.3), never from UTC.
5. The output goes to `data/<climate>/` with `manifest.json` (sources, retrieved
   digests, output digests, generated date) and `LICENSE.md`.
6. A decoder in `packages/rendering` or `packages/universe`, with Node and browser
   loaders.
7. A `docs/guides/catalog.md` section.
8. Retiring the deck: drop `TEXTURE_SOURCES` `earth/clouds`, and `buildTextures`
   deletes the orphan. Then Earth's `clouds` record, the lift
   (`bodyUniforms.ts:449-459`), the `cloudShadow` path (`planet.ts:443-464`) and
   `cloudEntry.gpu.test.ts` go too, while Venus still uses all four.

Size **[inference, arithmetic]**: 64,800 cells × 12 months × 9 types at one byte each
is 7.0 MB raw. Adding the three levels' in-cloud τ and a diurnal amplitude and phase
roughly doubles it. That is comparable to `luna_normal.webp` and fine as plain git
once compressed. A full 3-hourly UTC climatology would be about 8× that, which argues
for reducing it to a harmonic in the ingest.

---

## 7. Elevation and drainage, for orography and valley fog (plan §4.8)

### 7.1 Which field (rule 53)

| Function (all `packages/universe/src/terrain.ts`)     | `file:line` | What                                                                                                                             |
| ----------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `groundElevation(surface, dir)`                       | `:566-582`  | **Canonical**: what the contact test integrates and saves record; clamped to standing water                                      |
| `drawnElevation(surface, dir, finest?)`               | `:431-440`  | **Drawn**: canonical plus the presentational tail, clamped up to any ocean; at most `drawnDivergence` (1.25 m) away (`:452-455`) |
| `drawnGroundElevation(surface, dir, finest?)`         | `:407-413`  | Drawn with the sea clamp off: the seabed                                                                                         |
| `elevationAt(surface, dir, finest?)`                  | `:93-106`   | The band stack before the clamp                                                                                                  |
| `landformAt(surface, dir)`                            | `:501-516`  | Before the drainage carve                                                                                                        |
| `datumRadius(body, dir)` / `surfaceRadius(body, dir)` | `:814-840`  | The datum; a spheroid's flattening is deliberately ignored (`:806-812`)                                                          |

The weather is presentation, so it reads the **drawn** field (`drawnElevation`; over
the sea it is the datum). At 25–150 km cells the drawn and canonical fields differ by
at most 1.25 m, but rule 53 is about category, not magnitude. All of these take a
`BodyFixedDirection` (rule 10: `bodyFixedDirection`, `geodeticDirection` or
`regionDirection`). A CPU sample costs tens of microseconds: a crater walk is 10 µs
(`terrain.ts:86`), so a 6 × 64² grid is about a second of main thread **[inference]**.
Do it in a worker or through the producer.

### 7.2 The drainage graph: a ready-made coarse elevation and valley map, wet worlds only

- `drainageGraph(surface): DrainageGraph | null` (`drainage.ts:841-854`) is memoized
  by `WeakMap` and by `surfaceIdentity` (string cache, `DRAINAGE_CACHE_LIMIT = 12`,
  `:835`). It builds in **57–103 ms in the browser** (`:858-861`).
  `seedDrainageGraph(surface, graph)` (`:870-880`) hands a worker-built graph to this
  thread.
- It is **null unless `drains(surface)`** (`:269-271`): `!bareGround(surface) &&
grammar.drainage > 0`, which requires running liquid. In Sol only Earth and Titan
  have graphs (`versions.ts:146-149`). **Mars has none.**
- `DrainageGraph` (`:94-139`) carries, per node of a cube-sphere lattice of `cells = 64`
  per face edge (`DRAINAGE_SHAPE.lattice`, `drainageShape.ts:26`; 24,576 nodes, mean
  cell about 144 km on Earth **[arithmetic]**):
  - `positions` (unit directions, jittered), `elevation` (**the macro landform,
    meters**), `filled` (spill level), `receiver`, `area` (upstream cells), `order`
    (Strahler), `floor` (channel floor), `lake` (standing water or NaN), `sea`
    (Uint8), `popOrder`, `neighbors`, `cellMeters`, `reach`;
  - the segment records `segments`, `cellStart` and `cellSegments`.
- Below the lattice, `drainageRefinement(graph)` (`:920`) adds creeks down to a cell of
  a couple of kilometers (ADR-0054; the `TERRAIN_ALGORITHM` 7 note at
  `versions.ts:154-174`). Its records are the same layout and are what
  `drainageLookup` and `carveDrainage` walk (`:1099`, `:1178`).
- The GPU already holds the graph for the terrain producer as `KernelSurface.drainage:
KernelDrainage | null` (`universe/src/terrainKernel.ts:332-339`, `:421-433`), packed
  per `SurfaceParameters` by `surfaceKernel(surface, seabed)` (`:446-462`).
- Plan §4.8 wants "the drainage graph's valleys hold radiation fog at dawn".
  **[inference]** The lattice (`order`, `area`, `filled − elevation`) resolves basins
  at about 144 km. Fog at the clipmap's 250 m wants the refined channels or the tiles'
  `water`/`cover.wet`.

### 7.3 Producer tiles: what the orbital bake already asks for

- `Heightfields.submit(surface, request, lane)` (`workers/src/heightfields.ts:44-50`)
  takes a `HeightfieldRequest` `{region, resolution, border?, seabed?}`
  (`terrain.ts:874-889`).
- It returns a `HeightfieldResponse` (`workers/src/tasks.ts:292-305`) with
  `elevations` (`(65 + 2·2)²` floats, meters relative to the datum,
  `HEIGHTFIELD_RESOLUTION = 65`, `HEIGHTFIELD_BORDER = 2`, `terrain.ts:851`, `:872`),
  `cover` (`COVER_CHANNELS = 8` bytes a vertex: `bright, dark, mineral, ice, wet,
biota`; `cover.ts:36-83`, `:548`), `water` (NaN where none), `morph`,
  `minElevation` and `maxElevation`.
- **The orbital bake** (`render/orbitalBake.ts`) asks for the 96 level-2 tiles of a
  **mapless, non-giant** body once its disk passes `BAKE_ANGLE = 0.01` rad
  (`wantsBake`, `bodyUniforms.ts:261-264`; `BAKE_LEVEL = 2`, `orbitalBake.ts:88`). That
  is about 40 km a sample on an Earth-size body.
- The bake builds patches and draws two cubes, `albedo` 512² and `relief` 256²
  (slopes RG plus the sea mask B, half float; `OrbitalBakeMaps`, `:132-149`). **The
  elevations are held only in `BakeWork.fields` while the bake runs (`:155-171`) and
  are then discarded.**
- A weather orography map for generated worlds could keep those tiles' elevations, or
  ask for coarser ones through the same host (`OrbitalBakeHost`, `:213-229`)
  **[inference]**. Generated mapless bodies are exactly phase 1's bodies.

### 7.4 Mapped bodies: the photograph is the ground's albedo, not its shape

- ADR-0020 lines 81-90: "the generated field and the photograph disagree about where
  Earth's land is — that disagreement _is_ the mapped-body carve-out". Earth's streamed
  ground is the generated band stack with `publishedRelief` (`solar/system.ts:131-145`,
  `:198`). Its continents are not the photograph's. The ground wears the photograph's
  albedo and switches off its invented ocean.
- **For Earth (phase 3), orography and land/ocean** (the diurnal clock's land 15–18 h
  versus ocean 06–09 h; the 0.72 ocean and 0.55 land cover tests) **must come from
  real data.** The ISCCP climatology already carries the 1° orographic and land
  statistics. What ships today:
  - `earth_normal.webp`: 4096 × 2048, RG = slopes, B = ocean mask below 0.008 of the
    GEBCO range (`textureSources.ts:149-168`, `textures.ts:220-230`). The mask is in **blue**, as the code writes it (`textures.ts:210-230`, `planetTextures.ts:53`); the comments at `textureSources.ts:55` and `:79` and `docs/guides/catalog.md:458` still say alpha.
  - The GEBCO_08 source, 21600 × 10800, land-only height, already downloaded into
    `.data/textures/earth_elevation.png` by `textures:build`. It is the cheapest source
    for a coarse real-elevation channel **[inference]**.
- **Mars (phase 6)** has only `mars_albedo.webp` (SSS): no normal map, no elevation.
  Its generated Tharsis is not where the photograph's is. The Arsia Mons cloud
  (plan §4.7) needs ingested MOLA elevation or the real coordinates of the volcanoes
  (open question §11.6).
- **Generated worlds** have no photograph, so the generated field _is_ their ground,
  and §7.1–7.3 apply directly.

### 7.5 What the cover already claims about rain and temperature

- `cover.ts:257-310` (biota):
  - Temperature by latitude is `local = grammar.groundTemperature · cos(lat)^0.25`
    (`zenithPower`, `:144`), with no season.
  - **A static moisture field** is
    `rain = noise3(sketch.seeds.rain, dir·rainCycles(5))·0.5 + 0.5` (`:279-287`, with
    `rainFloor 0.3`), damped toward the river corridors.
  - It is ported to the GPU (`render/terrainKernel.ts:2708`).
- The biomes of a generated world are therefore already painted under a fixed
  "rain" map and a fixed latitude temperature. **[inference]** If the climate's
  precipitation or temperature disagrees, the forests stand in the deserts. Read the
  cover's seed and law, or make one function both read. **Do not make the cover read
  the weather**: the cover is in every tile and the archive keys tiles on
  `TERRAIN_ALGORITHM` and `surfaceIdentity` only (`heightfieldCache.ts:36-37`,
  `:67-75`), so a changed cover would serve stale tiles with no version moving. The
  plan's wet ground lives in the clipmap's spare channels (plan §4.8, §7.3), which is
  consistent with this.

### 7.6 Never on the surface

`SurfaceParameters` and its `grammar` are the identity of three caches: the drainage
memo, the survey and the heightfield archive (`surfaceIdentity.ts:3-17`, `:55-62`).
A weather field there moves every key, rebuilds every drainage graph and misses every
archived tile on every machine. The survey keys on it too (`surveySites.ts:662`). It
would also ride into every worker's structured-clone payload. Weather quantities are
derived functions of `Body`, memoized by `WeakMap` like `BY_SURFACE`
(`drainage.ts:832`) **[inference: placement]**.

---

## 8. Draw order and frame order (what this area feeds)

- **Per frame** (`GameEngine.#step`, `:1540+`):
  1. `world.advance(delta)` (ticks);
  2. `observatory.advanceTime(delta)` if it holds a target;
  3. `cutscene.sample(clock.renderTime)`;
  4. `snapshot(world, undefined, presentationTime)`;
  5. observatory and on-foot presentation, then the frame owner (`frameOwner.ts`);
  6. scene build and draw.

  Weather evaluation belongs after `snapshot` and reads only `engine.snapshot`.

- **Per body** (`Bodies.tsx:403-627`):
  - the sphere (`renderOrder 0`, or −1 when the tier is `surface`,
    `bodyUniforms.ts:565`);
  - the deck shell (`renderOrder 1`, transparent, `depthWrite false`; `Bodies.tsx:353`,
    `planet.ts:771-772`);
  - the rings (`renderOrder 2`, `Bodies.tsx:362`);
  - the atmosphere shell, a back-side sphere.

  Stars are drawn after all bodies (`:640-661`), then `airLuminance` and
  `skyOverhead` (`:662-680`).

---

## 9. Hook points

| Where                                                                                                                       | What the weather does there                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/universe/src/system.ts:1259` (`proceduralAppearance`)                                                             | Whatever a generated wet world's record says about clouds. Draws only from a forked stream off `surface.seed` (`:1248`)  |
| `packages/universe/src/solar/bodies.ts:574`                                                                                 | Earth's `CloudLayer` (retires or changes meaning at phase 3); `:527` Venus keeps its deck (plan §14)                     |
| `packages/universe/src/frames.ts:295-304`                                                                                   | The spin law the season derives from. Do not change it: it is canonical (versions.ts `system@4`)                         |
| `packages/devtools/src/maneuvers.ts:107-121`                                                                                | The float64 body-fixed sun direction at an explicit time. Move it down a layer for the weather, or call it from the host |
| `apps/game/src/engine/GameEngine.ts:1588-1595`                                                                              | Where `snapshot.renderTime` is decided (cutscene, observatory, clock)                                                    |
| `apps/game/src/engine/GameEngine.ts:706-711`                                                                                | `pictureEpoch` / `declareCut()`, the cache-rebuild signal for cuts                                                       |
| `apps/game/src/scene/Sensor.tsx:100-107`                                                                                    | The `historyKey` pattern for detecting a held-time scrub                                                                 |
| `apps/game/src/render/bodyUniforms.ts:446-485`                                                                              | The deck's uniforms: the lift, the unreduced drift, the entry fade. This is where Earth's deck retires                   |
| `apps/game/src/render/bodyUniforms.ts:40-50` (`BodyFrame`)                                                                  | Carries `renderTime` and `eye` into per-body arithmetic in Node, so weather uniforms can be computed and tested there    |
| `apps/game/src/scene/Bodies.tsx:410-416`, `:731`                                                                            | Gates the deck mesh and its warm-up on `appearance.clouds !== null`                                                      |
| `apps/game/src/render/water.ts:199-208`, `:685-689`                                                                         | The period-reduction pattern to copy, and `water.test.ts:25` the closure test to copy                                    |
| `packages/universe/src/terrainKernel.ts:1014-1063`                                                                          | The tile-frame pattern (rule 58), for any fine lattice on the GPU                                                        |
| `packages/rendering/src/cloudShell.ts:8-19`                                                                                 | The CPU height over a shell (rule 52)                                                                                    |
| `packages/universe/src/drainage.ts:841`, `:94-139`                                                                          | The coarse elevation and valley graph on wet generated worlds                                                            |
| `apps/game/src/render/orbitalBake.ts:155-171`, `:213-229`                                                                   | Tiles a mapless body already fetches. Their elevations are discarded today                                               |
| `apps/ingest/src/main.ts:531-562`, `textureSources.ts:139-148`, `textures.ts:325-365`                                       | The new ingest command; retiring `earth/clouds`; the orphan deletion                                                     |
| `apps/game/src/render/planetTextures.ts:11`, `:38-42`; `engine/catalogAsset.ts:18-19`; `apps/headless/src/catalog.ts:20-24` | Browser and Node loader patterns for a committed artifact                                                                |
| `packages/devtools/src/dossier.ts:1200-1223`; `docs/design/planetarium.md:710-714`                                          | The `Cloud deck` and `Circulation` rows, and the source table (rule 26)                                                  |

---

## 10. Gotchas (rule numbers in brackets)

1. **[plan §3; rules 15, 17]** No weather value in a save, the hash, `GENERATION_VERSIONS`, the
   catalog version or `versionDrift`. Presets refuse a manifest mismatch (ADR-0033),
   so a version bump for weather orphans every preset.
2. **[5]** A presentational change to generated values rides along only if it takes
   no draw from the body's `rng`. Fork from `deriveSeed(surface.seed, …)` as the
   palette does (`system.ts:1238-1248`).
3. **[ADR-0045, cache identity]** Nothing on `SurfaceParameters` or `SurfaceGrammar`:
   `surfaceIdentity` keys the archive, the drainage memo and the survey.
4. **[38, ADR-0033]** Use `engine.snapshot.renderTime`, never `clock.time`, never
   `clock.renderTime` directly in the planetarium, and never
   `engine.presentationTime`.
5. **[plan §3]** Reduce every time offset by its period on the CPU, in float64,
   with |t| up to 3.2 × 10¹² s. **Do not copy `bodyUniforms.ts:483`.** It uploads an
   unbounded turn count: 2.4 km steps on Earth in 2026, a quarter turn at the time
   limit.
6. **[58]** A period index or cell index used as a hash input is an integer. Upload it
   as u32 halves; at large t it exceeds 2²⁴, and eventually 2³². Compare hash
   thresholds as u32, never `toUnit(hash) < p` in float.
7. **[52]** Shell intersections come from heights (`cloudShellAltitude`), never
   `length(p) − R`; screen-space derivatives of planetary positions are not used.
8. **[10]** Sample the weather in **body-fixed** axes. The sphere and deck shade in
   render axes (`bodyUniforms` `sun`), the ground and sea in body-fixed axes
   (`TerrainPatches.tsx:180-183`). Rotate with the conjugate of the body orientation.
   Inertial sampling leaves the weather behind as the body turns.
9. **[28, 29]** Render-space body→star directions are distorted by radial compression
   on distant bodies. The climate lookup uses the float64 universe-space sun. Metric
   march geometry uses `placement.compression`, never `placement.scale`.
10. **[25, 27]** A figured body's shells are round. `figure: null` means round. Use
    `shellFlattening` (`bodyUniforms.ts:348`), not `body.flattening`, everywhere a
    shell reads one.
11. **[53, ADR-0020]** The weather reads the drawn ground. On Earth (and Mars) the
    generated ground is not the photographed one: orography and land masks there come
    from real data.
12. **[26]** Turning on clouds for a world whose dossier says `Cloud deck: None`, or
    leaving the `Circulation` reason in place once storms exist, puts a false row on
    screen. Reasons stay in the universe's voice (`dossier.test.ts:145-146`).
13. **[56, 57]** A climatology bound as a `DataTexture` keeps a linear stand-in, one
    stand-in object per node. A nearest stand-in freezes point sampling into the
    warmed program.
14. **[61]** The deck's pipeline is warmed per body on `appearance.clouds !== null`
    (`Bodies.tsx:731`). New weather materials go through `warmCompile` and `register`
    in `render/warmup.ts`.
15. **[3]** No `performance.` and no wall clock anywhere in `packages/*`, which a test
    greps (`apps/headless/src/coreHostApis.test.ts`). A weather module in packages is
    a pure function of `t`.
16. **[4, 11]** Cyclones are a function of their cell index, enumerated without
    order-dependence. No property is read off "the nearest" cyclone or cell.
17. **[ingest]** `fetchSource` is text-only. `textures.ts`'s download has no
    validation and no refresh. netCDF-4 and HDF4 need a reader the repository does not
    have. A written manifest must pass `prettier -c`.
18. **[cutscene]** The Mars landing holds one presentation instant for the whole shot.
    Weather keyed on it freezes while the camera flies.
19. **[packages layering]** `tidallyLocked`, `synodicDay` and `sunDirection` are in
    `packages/devtools` (layer 6). The weather's home (rendering, layer 5; or universe,
    layer 3) cannot import them. Move them down instead of copying them.
20. **[cover]** The biosphere already assumes a static rain field and a cos^0.25
    latitude temperature (`cover.ts:262`, `:279-291`). The climate should agree with
    them and must not change them; the tile archive would not notice.

---

## 11. Open questions

1. Phase 1: does a generated wet world get a `CloudLayer` on its record, or does the
   volume key on a derived predicate with the dossier reading the same one? Either way
   the deck readers in §1.6 change together.
2. Which predicate is "wet" for the first volume:
   `seaLevel !== null && liquidKind === 'water'`, or `grammar.liquid > 0` (rivers
   without a sea), and what happens for hydrocarbon (Titan-like) worlds before plan §14's
   condensables land?
3. The climatology's month index for Earth: Ls from the drawn sun (needs the trend, and
   undefined at ε ≈ 0) versus sub-solar latitude alone. And what a body with ε ≈ 0
   uses.
4. Cutscenes hold a presentation instant (Mars landing): should the texture layer
   still advance on `clock.renderTime` there, which would break "one instant" (rule
   38), or freeze?
5. Which rate keys the warp fade in the planetarium? `snapshot.timeScale` is the
   world clock's, and the observatory runs its own `timeScale`/`timePaused`. Neither
   is in the snapshot.
6. Earth and Mars orography: ingest a coarse GEBCO or ETOPO height for Earth (the
   GEBCO source is already cached by `textures:build`) and a MOLA product for Mars, or
   author the Tharsis volcanoes as sites?
7. ISCCP-H specifics: netCDF-3 or netCDF-4, per-type variable names, whether HGM keeps
   UTC slots for the diurnal cycle, the land fraction, and whether 18 types are 9 × phase.
   Answered by the NCEI HGM/HGH Basic Variable List. MODIS L3's HDF4 makes the
   alternate harder, not easier.
8. Where the weather's pure functions live: `packages/rendering` (presentation
   arithmetic, the home of `cloudShellAltitude` and `atmosphereRecipe`) or a new
   layer-5 package. Not `packages/universe`, whose generation outputs are canonical
   inputs **[inference]**.

---

## 12. Tests that pin this area

| Test                                                    | Pins                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/game/src/render/bodyUniforms.test.ts:240-243`     | Deck drift = difference of the two rates (at t = 3600 only; a large-t reduction test is missing)                       |
| `apps/game/src/render/bodyUniforms.test.ts:96-146`      | The figure branch: shells round about a figured body; the deck altitude against a round shell                          |
| `apps/game/src/render/bodyUniforms.test.ts:201-227`     | No cloud shadow without an image; a mapless deck tinted, a mapped one white                                            |
| `packages/rendering/src/cloudShell.test.ts:6`           | `cloudShellAltitude` to 1e-6 m at radii up to 10⁸ (property)                                                           |
| `apps/game/src/render/cloudEntry.gpu.test.ts:14`, `:53` | Coverage clears on descent without a culling step; the grazing rim fades with the nadir (GPU; needs the lock, rule 68) |
| `apps/game/src/render/water.test.ts:25`                 | Every wave drift closes on `WAVE_PERIOD` over `WAVE_CLOCK_PERIOD`: the template for weather periods                    |
| `apps/game/src/render/terrainKernel.gpu.test.ts`        | The tile frame and the field against the CPU (rule 58)                                                                 |
| `apps/game/src/render/materials.gpu.test.ts`            | Stand-ins and real maps compile to one program; binding counts (rules 56, 57)                                          |
| `packages/devtools/src/dossier.test.ts:124-156`         | Reasons in the universe's voice                                                                                        |
| `packages/devtools/src/observatory.test.ts`             | `stateHash` unchanged across a planetarium session (rule 37)                                                           |
| `packages/universe/src/universe.test.ts`                | Seeds derived from the address path (rule 4)                                                                           |
| `apps/headless/src/solarSystem.test.ts`                 | Sol's transcribed record against JPL (`data/reference/solar-system.json`)                                              |
| `apps/headless/src/moduleGraph.test.ts`                 | `versions.ts` stays a leaf (TDZ cycle)                                                                                 |
| `apps/headless/src/coreHostApis.test.ts`                | No `performance.` in `packages/*`                                                                                      |
| `packages/universe/src/drainage.test.ts`                | The drainage graph's construction                                                                                      |
| `packages/workers/src/heightfieldCache.test.ts`         | Archive keys (`TERRAIN_ALGORITHM`, namespace, `surfaceIdentity`, request)                                              |
| `apps/ingest/src/textures.test.ts:78-97`                | The manifest records source URL, byte count and sha256 of the shipped bytes                                            |
