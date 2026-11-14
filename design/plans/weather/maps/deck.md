# Map: the cloud deck today, and everything that retires or changes

Area owner's map for `design/plans/the-weather.md` (§1, §5.4 last paragraph,
§10 phases 1 and 3, §11). Worktree:
`/Users/jonjaques/.t3/worktrees/inertialref/t3-e896a8db` at `c2a50f1`
(branch `feat/the-weather-stacked-prs`, clean). All paths below are relative
to that root. Line numbers are as of that commit.

Read-only survey: nothing was run on the GPU, no browser, no rig. Every
number marked **(computed)** is arithmetic from the code and the records,
done in Python for this map. Every claim marked **(inference)** is from
reading code and was not observed in a frame. Treat inferences as leads to
check, not as facts.

---

## 0. The facts an implementer needs before touching anything

1. **There are two decks, not one.** Earth (`altitude 12_000`, `25.5 h`,
   opacity 0.92, NASA map with luminance moved into alpha) and **Venus**
   (`altitude 60_000`, `−4.2 d`, opacity 1, a Solar System Scope color image
   with alpha 255 everywhere). Phase 3 retires _Earth's_ deck. Plan §14 says
   Venus keeps what it draws. So `createCloudMaterial`, the deck mesh in
   `Bodies.tsx`, `BodyTextures.clouds`, the `'clouds'` map kind, the sphere's
   `cloudShadow` term and `cloudEntry.gpu.test.ts` all stay alive after phase
   3 unless Venus's ownership is decided separately (§14: the air's tables or
   the volume, never both).
2. **The descent gate is a switch, in display pixels, with no hysteresis:**
   the streamed ground exists only while
   `maxElevation · pixelsPerRadian(lens, viewport) / (|eye − center| − radius) ≥ 8`
   (`apps/game/src/engine/terrainStreamer.ts:1032-1040`). At the gate a nadir
   display pixel is always `maxElevation / 8`: 1,237.5 m on Earth
   **(computed)**. Above it the sphere alone draws; below it the ground draws
   over the sunk sphere. Today only the sphere carries a cloud shadow.
3. **The deck is measured from the sunk sphere, not from sea level, and it is
   oblate while the ground is round.** Earth's shell is `sunk · 1.004` =
   15.6 km over the datum at the equator (not 25.5 km), and it dips _under_ the
   round datum poleward of 58.4° latitude **(computed)**. The air is already
   round over terrain; the deck is not. A volume shell must be round over
   terrain and measured from the datum.
4. **The sphere's cloud shadow does not follow the deck it claims to be
   from.** It samples the undrifted map (`planet.ts:463`, no `drift`), at the
   record's 12 km rather than the drawn shell's height, and its east–west sun
   offset has the opposite sign to its north–south one **(inference)**.
5. **The deck's drift sign is probably reversed** relative to the periods in
   the record (Earth's deck would move east over the ground at 28.6 m/s where a
   25.5-hour deck lags west; Venus's would move prograde) **(inference)**. No
   test pins the on-screen sense. Do not copy the deck's `u + drift`
   convention into the weather's advection without checking it.
6. **The deck writes its opacity into the `reactive` attachment** through
   `sensorRadiance(material, false, false, 'alpha')` (`planet.ts:753-758`),
   union-blended (`sensorMrt.ts:60, 71-91`). The plan's composite takes over
   that job for clouds it draws (§5.6); Venus's deck keeps writing its own.

---

## 1. The lifecycle, end to end

### 1.1 The record (canonical-side data, presentational in meaning)

| What                                                                                                                               | Where                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `SolarClouds { altitude: Meters; rotationPeriod: Seconds; opacity: number }`                                                       | `packages/universe/src/solar/bodies.ts:98-102`                                                                               |
| `SolarBody.clouds: SolarClouds \| null`                                                                                            | `bodies.ts:168`                                                                                                              |
| Moon default `clouds: null`                                                                                                        | `bodies.ts:232` (the `moon()` helper)                                                                                        |
| Titan: `clouds: null`, "No cloud sphere: an opaque shell at 200 km sits over 96% of a haze that falls off over 60"                 | `bodies.ts:392-394` (Titan record starts `bodies.ts:333`)                                                                    |
| Venus: `clouds: { altitude: 60_000, rotationPeriod: -4.2 * DAY, opacity: 1 }`                                                      | `bodies.ts:524-527`                                                                                                          |
| Venus's haze, with "The cloud deck is the cloud layer's to draw. What the shell carries is the haze around it" (no `aerosolDepth`) | `bodies.ts:504-515`                                                                                                          |
| Earth: `clouds: { altitude: 12_000, rotationPeriod: 25.5 * HOUR, opacity: 0.92 }`                                                  | `bodies.ts:574`                                                                                                              |
| Mercury, Mars, Jupiter, Saturn, Uranus, Neptune: `clouds: null`                                                                    | `bodies.ts:477, 644, 756, 807, 860, 904`                                                                                     |
| `CloudLayer { altitude; rotationPeriod; opacity }` (the universe-wide type)                                                        | `packages/universe/src/system.ts:282-293`                                                                                    |
| `BodyAppearance.clouds: CloudLayer \| null`                                                                                        | `system.ts:392`                                                                                                              |
| `TextureMap` includes `'clouds'`                                                                                                   | `system.ts:264-265`                                                                                                          |
| Sol bodies: `appearanceOf` copies `clouds: body.clouds`                                                                            | `packages/universe/src/solar/system.ts:86-120` (line 100)                                                                    |
| Generated bodies: `proceduralAppearance(...)` returns `clouds: null`                                                               | `system.ts:1219-1292` (line 1259); called from `makeMoon` `system.ts:732`, `makePlanet` `:893`, `makeObservedPlanet` `:1536` |
| Generated small bodies: `clouds: null`                                                                                             | `makeSmallBody` `system.ts:1761`, literal at `:1933`                                                                         |
| Sol small bodies and minor moons: `clouds: null`                                                                                   | `solar/smallBodies.ts:230, 284`; `solar/minorMoons.ts:96`                                                                    |

The record's `altitude` is read three ways, and they disagree with each
other (see §4): as the floor input to the lift, as the sphere's shadow height
(`cloudHeight`), and as the dossier's "Cloud deck" figure.

`packages/universe/src/versions.ts:52-66` is the precedent for changing a
presentational appearance field: the haze families moved on every generated
world and `SYSTEM_ALGORITHM` stayed at 4 ("A haze is presentation: no frame,
no terrain and no contact test reads it… It rides along"). A generated
world's weather would ride along the same way; rule 5 still applies to
anything a frame, terrain or contact reads.

### 1.2 The snapshot and the render body

- `BodySnapshot.rotationPeriod` exists for the deck: "a cloud deck's drift is
  _relative to the surface_, and the surface's own turn rate is not
  recoverable from the orientation" (`packages/simulation/src/snapshot.ts:120-125`).
  `BodySnapshot.appearance` carries the record (`:126-127`), `relief` is
  `body.surface.maxElevation` (`:136, :348`).
- `buildScene` (`packages/rendering/src/scene.ts`): `sphereRadius =
sunkSphereRadius(body.radius, body.relief)` (`:372`), `placeAt(...)` with
  that radius, `trueRadius: body.radius` (`:437`), `rotationPeriod`
  (`:438`, doc `:112-117` repeats the deck reason), `flattening:
body.polarRadius / body.radius` (`:439`), `appearance: body.appearance`.
- `sunkSphereRadius(radius, relief) = max(radius·0.9, radius − max(0, relief))`
  (`packages/rendering/src/datum.ts:42`). Earth: 6,378,137 − 9,900 =
  6,368,237 m. Venus: 6,051,800 − 6,900 = 6,044,900 m.
- `placement.scale = radius · factor`, `placement.compression = factor`
  (`packages/rendering/src/placement.ts:195-196, 209-210`); `scale` is the
  **sunk** drawn radius in render meters.

### 1.3 The map

| Step           | Where                                                                                                                                          | What                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source, Earth  | `apps/ingest/src/textureSources.ts:139-147`                                                                                                    | `cloud_combined_2048.jpg`, NASA, public domain, `transform: 'luminance'`, width 2048                                                                                                                                                                                                                                                                             |
| Source, Venus  | `textureSources.ts:334-338`                                                                                                                    | `sss('venus', '4k_venus_atmosphere.jpg', 4_096, 'clouds')`; `sss` always sets `transform: 'image'` (`:92-106`), so **no alpha is made**                                                                                                                                                                                                                          |
| Conversion     | `apps/ingest/src/textures.ts:240-266` `luminanceToAlpha`                                                                                       | RGB set to 255, alpha = grayscale value; WebP quality 82 (`:68`)                                                                                                                                                                                                                                                                                                 |
| Orphan cleanup | `textures.ts:336-348`                                                                                                                          | files the manifest no longer names are deleted from `data/textures/`                                                                                                                                                                                                                                                                                             |
| Manifest       | `data/textures/manifest.json`                                                                                                                  | `earth_clouds.webp` 2048×1024, 1,331,220 B; `venus_clouds.webp` 4096×2048, 106,036 B, CC BY 4.0                                                                                                                                                                                                                                                                  |
| Loader         | `apps/game/src/render/planetTextures.ts`                                                                                                       | `MapKind` includes `'clouds'` (`:49`); `BodyTextures.clouds` (`:56`); `NO_TEXTURES.clouds: null` (`:64`); `COLOR_SPACE.clouds = NoColorSpace` (`:101-107`, data not color); `RepeatWrapping` in S, clamp in T, mipmaps, `LinearMipmapLinearFilter`, max anisotropy (`:145-155`); `texturesFor(key, anisotropy)` assembles the set (`:177-204`, clouds at `:199`) |
| Boot           | `preloadAllTextures` (`planetTextures.ts:238-247`) fetches every manifest entry; `preload.ts:175-187` `renderer.initTexture` one per macrotask | the cloud maps are resident for the session; nothing is released                                                                                                                                                                                                                                                                                                 |
| Attribution    | `TEXTURE_ATTRIBUTION` (`planetTextures.ts:77`) from the manifest; ingest writes it (`textures.ts:352-365`)                                     | Venus's CC BY credit is the Solar System Scope line                                                                                                                                                                                                                                                                                                              |

Retiring Earth's map is: drop the source at `textureSources.ts:139-147`, re-run
the ingest so the manifest and the orphan cleanup remove `earth_clouds.webp`,
and keep the attribution lines that still apply.

### 1.4 `bodyUniforms` — every per-frame number, in Node

`apps/game/src/render/bodyUniforms.ts`, `bodyUniforms(body, frame, maps, star)`
(`:338-575`). Its header (`:14-31`) states the figure branch rule.

- `BodyMaps.clouds: boolean` — the map exists (`:56-62`; set in
  `Bodies.tsx:441` as `maps.clouds !== null`).
- `PlanetUniforms.cloudShadow`, `.cloudHeight` (`:79-80`), computed at
  `:432-436`:

  ```ts
  cloudShadow: maps.clouds ? 0.55 : 0,
  cloudHeight: appearance.clouds === null ? 0
    : appearance.clouds.altitude / Math.max(body.trueRadius, 1),
  ```

  So the sphere's shadow projects from the **record's** altitude as a fraction
  of the true (equatorial) radius: Earth 0.0018814 (12 km), Venus 0.0099144
  (60 km).

- `CloudUniforms` (`:92-103`): `scale: Vec3`, `entryDistance`, `eyeAltitude`,
  `baseColor`, `sunsetColor | null`, `opacity`, `drift`. Built at `:446-485`
  only when `appearance.clouds !== null && placement.tier !== 'point'`:

  ```ts
  const lift = Math.max(deck.altitude / Math.max(body.trueRadius, 1), 0.004)
  const shell = placement.scale * (1 + lift)          // sunk radius × (1 + lift)
  scale: oblate(shell),                                // {x: s, y: s·shellFlattening, z: s}
  entryDistance: placement.scale * lift * 0.25,
  eyeAltitude: cloudShellAltitude(Vec.sub(frame.eye, position), orientation,
                                  shell, shellFlattening),
  baseColor: maps.clouds ? WHITE : appearance.color,
  sunsetColor: appearance.haze?.limb ?? null,
  opacity: deck.opacity,
  drift: time / deck.rotationPeriod - time / body.rotationPeriod,
  ```

  `shellFlattening = figured ? 1 : body.flattening` (`:348`, rule 25). Earth is
  not figured, so its deck is **oblate** by 0.99665. Compare the air at
  `:541-546`: `scale: giant ? oblate(mesh) : {round}`, `flattening: giant ?
shellFlattening : 1` — "Round over terrain: the streamed terrain is
  spherical and a walker's altitude is read against it" (`:508-518`).

- `time = frame.renderTime` (`:350`), which `Bodies.tsx:386` sets from
  `engine.snapshot?.renderTime ?? 0` — the presentation instant (ADR-0033,
  which names "clouds" among the readers of that instant). `drift` is formed
  in float64 and uploaded **without reduction by its period**: Earth's grows
  at −7.125e-7 turns/s, Venus's at −2.708e-6 turns/s **(computed)**. Plan §3
  requires every time offset reduced on the CPU before upload.
- `STAR_APPEARANCE.clouds: null` (`:267-279`) — stars never get a deck.
- `renderOrder: placement.tier === 'surface' ? -1 : 0` for the body mesh
  (`:565`).

**Numbers this produces (computed, near field, compression 1):**

|                                              | Earth              | Venus                |
| -------------------------------------------- | ------------------ | -------------------- |
| Record altitude / true radius                | 0.0018814          | 0.0099144            |
| `lift`                                       | 0.004 (floor wins) | 0.0099144 (own wins) |
| Sunk sphere radius                           | 6,368,237 m        | 6,044,900 m          |
| Shell radius (equator)                       | 6,393,710 m        | 6,104,832 m          |
| Shell over the sunk sphere                   | 25,473 m           | 59,932 m             |
| Shell over the datum (equator)               | **15,573 m**       | **53,032 m**         |
| Shell flattening                             | 0.99665            | 1                    |
| `entryDistance`                              | 6,368 m            | 14,983 m             |
| Coverage fades between (over datum, equator) | 21.9 → 15.6 km     | 68.0 → 53.0 km       |
| Drift, turns per day                         | −0.0616            | −0.234               |

### 1.5 The deck material

`createCloudMaterial(): CloudMaterial` — `apps/game/src/render/planet.ts:713-789`;
interface `:682-699`; doc `:701-712`.

| Uniform / field                                            | Default                                                                         | Written by `Bodies.tsx`                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `map` (TSL `texture(WHITE)`) via `setTexture(map \| null)` | `WHITE` (`:717`; `WHITE` is `pixel(255,255,255,255)`, linear, `:113-127, :140`) | `material.setTexture(maps.clouds)` `:542`              |
| `sunDirection: {value: Vector3}`                           | (1,0,0)                                                                         | `:546` when the key light exists                       |
| `sunColor`                                                 | white                                                                           | `:547` (`keyColor × (visibility ? 1 : body.sunlight)`) |
| `sunIntensity`                                             | 1                                                                               | **never written**                                      |
| `opacity`                                                  | 1                                                                               | `:550`                                                 |
| `entryDistance`                                            | 1                                                                               | `:543`                                                 |
| `eyeAltitude`                                              | 1                                                                               | `:544`                                                 |
| `drift`                                                    | 0                                                                               | `:551`                                                 |
| `baseColor`                                                | white                                                                           | `:545`                                                 |
| `sunsetColor`                                              | (1, 0.55, 0.28)                                                                 | `:548-549`, only when the body has a haze              |

The graph:

```ts
const drifted = vec2(uv().x.add(drift), uv().y)      // :728-729
const cover = map.sample(drifted)                     // :730  (plain sample, mip by derivatives)
const incidence = dot(normalize(normalWorld), normalize(sunDirection))
const daylight = smoothstep(-0.22, 0.12, incidence)   // :737  wider than the ground's
const glow = mix(vec3(1), sunsetColor, smoothstep(0.3, 0.0, incidence))   // :747-751
material = sensorRadiance(new MeshBasicNodeMaterial(), false, false, 'alpha')  // :753-758
colorNode = cover.rgb · baseColor · sunColor · sunIntensity · glow
            · (max(incidence,0)·0.96 + 0.04) · daylight            // :759-765
const entry = smoothstep(0, entryDistance, eyeAltitude)               // :769
opacityNode = cover.a · opacity · daylight · entry                    // :770
transparent = true; depthWrite = false                                // :771-772
// side: default FrontSide, blending: default NormalBlending
```

What it does **not** have: no air in front of it (`airToward` is not called),
no `sunThrough` transmittance (reddening is the authored `sunsetColor` alone),
no Enhanced `clearedFromOrbit`, no visibility gain, no shadow of its own, no
moonlight. Its opacity goes to zero on the night side (`daylight`), so a night
deck is not black — it is absent, and the sphere dims cities under it instead
(§1.10).

### 1.6 The mesh, in `Bodies.tsx`

`apps/game/src/scene/Bodies.tsx`.

- `BodyVisual.clouds: Mesh | null`, `.cloudMaterial: CloudMaterial | null`
  (`:85-95`).
- **Built once per visual**, in `materialize(star, clouded, ringed)`
  (`:328-377`): `if (clouded) { cloudMaterial = createCloudMaterial(); clouds =
new Mesh(spheres[0]!.geometry, cloudMaterial.material); clouds.renderOrder =
1; container.add(clouds) }` (`:348-355`). `clouded` is
  `appearance.clouds !== null` at the first draw (`:410-416`) or at build-ahead
  planning (`:731`). A body whose record gains a deck later never gets a mesh
  without re-materializing; one that loses it keeps a hidden mesh.
- **Per frame**, in `draw()` (`:403-627`), deck block `:532-553`:
  `visible = uniforms.clouds !== null`; position copied from the body mesh;
  quaternion = the body's orientation (the same object the sphere uses);
  `scale = values.scale` (oblate shell); `geometry =
geometryFor(body.placement.angularRadius)` — the sphere tiers
  `SPHERE_TIERS` (`:156-161`: 512 segments at ≥ 0.06 rad, 256 at ≥ 0.012, 96 at
  ≥ 0.002, else 32); then the uniform writes in §1.5 through the compare-first
  setters (`:790-803`).
- The sphere's cloud uniforms are written in the planet block:
  `planet.setTextures(maps)` (`:489-493`, the cloud map rides in `maps`),
  `setNumber(planet.cloudShadow, …)`, `setNumber(planet.cloudHeight, …)`
  (`:525-526`).
- **Build-ahead**: one visual a frame from `residency.buildAhead` (`:746-748`),
  every part including `visual.clouds` compiled through `warmCompile(warmRenderer(gl,
engine.sceneLayout(gl)), {object, camera, scene})` (`:749-767`); paused under
  a cutscene (`:712`).
- **Residency**: `hide` sets `visual.clouds.visible = false` (`:237-242`);
  `retire` removes and disposes the deck's material, catching Three's
  `Nodes.delete` throw (`:122-140`).
- The frame loop is `useTimedFrame('bodies', …)` (`:314`); the orbital bake
  advances first at priority −0.25 (`:312`).

### 1.7 Boot warm-up

`apps/game/src/render/preload.ts:112-127` `buildWarmGroup()` adds one
`new Mesh(sphere, createCloudMaterial().material)` (`:118`) beside the planet,
atmosphere, star and ring archetypes, compiled under the "compiling the sky"
producer (`:224-238`) and held for the session (disposing it would evict the
pipelines). Rule 61: any new cloud pass registers through `render/warmup.ts`
(`warmCompile` `:221`, `beginWarmup` `:513`, `trackAtMount` `:631`).

### 1.8 Draw order

Three draws opaques, then transparents. Both lists are sorted by
`installSceneOrder` (`apps/game/src/render/sceneOrder.ts:10-24`): groupOrder,
renderOrder, then depth (transparents far-first), then id — with the order
keys pre-reversed because three r185 reverses the whole list under reversed
depth (plan §12 names this risk).

| Order   | Object                                 | Pass                                                                          | Notes                                                                        |
| ------- | -------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| −1000   | galaxy volume                          | transparent                                                                   | `galaxyVolume.ts:554`                                                        |
| −2      | starfield sprites                      | transparent                                                                   | `scene/Starfield.tsx:52`                                                     |
| −1 or 0 | body sphere (`createPlanetMaterial`)   | opaque                                                                        | −1 at the `surface` tier, `bodyUniforms.ts:565`                              |
| 0       | streamed ground (`terrain.ts`)         | opaque                                                                        |                                                                              |
| 0       | atmosphere shell (`materials.ts:257…`) | transparent, `BackSide`, premultiplied `(One, OneMinusSrcAlpha)` (`:417-442`) | survives only outside the silhouette                                         |
| 0       | sea sheet (`water.ts`)                 | transparent, `depthWrite = true` (`:336-337`)                                 | draws after every opaque; generated bodies only (a mapped body has no sheet) |
| **1**   | **cloud deck**                         | transparent, `depthWrite = false`, FrontSide, NormalBlending                  | `Bodies.tsx:353`; depth-tested against sphere, ground and sea                |
| 1…n     | entry traces                           | transparent                                                                   | `scene/EntryTrace.tsx:53`                                                    |
| 2       | rings                                  | transparent, DoubleSide                                                       | `Bodies.tsx:362`                                                             |
| 8–12    | cinematic stage, plumes, flare, warp   |                                                                               | overlays                                                                     |

Consequences today: the deck is composited **over** the atmosphere shell's
limb glow and over the sphere's own aerial veil, unveiled itself — clouds sit
in front of the air (inference about the visible result; the order is fact).
The sea's screen-space reflection copies the frame mid-pass at the sheet's
draw (`seaReflection.ts` header), before the deck draws, so no deck can
appear in the sea; the sea's sky is the `skyColor`/`skyOverhead` uniforms
(`water.ts:283, 515-560`).

### 1.9 The reactive attachment (ADR-0044)

- `sensorRadiance(material, overlay = false, instrument = false, reactive:
number | 'alpha' = …)` (`apps/game/src/render/radiance.ts:95-112`): with
  `'alpha'` it assigns `reactiveCoverage = output.a`.
- `reactiveCoverage = property('float', 'ReactiveCoverage')`
  (`apps/game/src/render/sensorMrt.ts:40`); the MRT writes
  `reactive: vec4(reactiveCoverage, 0, 0, output.a)` (`:60`) with the `union`
  blend `(One, OneMinusSrcAlpha)` (`:71-91`), so opaque geometry replaces the
  mask and translucent coverage combines.
- The row exists only in temporal pictures: `{ name: 'reactive', channels: 4,
storage: 'byte', blend: 'union' }` (`sceneLayout.ts:104`); the sensor hands
  it to FSR as `reactive: temporal ? scenePass.getTextureNode('reactive') :
null` (`sensor.ts:199`; consumer `upscale.ts:76, 422, 443`).
- ADR-0044 text: "atmosphere, clouds and rings write their alpha; water writes
  0.3" (`docs/adr/0044-the-sensor-reconstructs-the-display.md:86-89`).
- So the deck's per-pixel reactive is `cover.a · opacity · daylight · entry`.

### 1.10 The shadow on the sphere, and the night lights

`createPlanetMaterial()` (`planet.ts:275-676`), one graph for every body (one
pipeline per archetype, header `:57-65`).

- `const cloudMap = texture(CLEAR)` (`:279`); `CLEAR = pixel(255, 255, 255,
0)` (`:143`) — its own linear stand-in (rules 56, 57); swapped in
  `setTextures` by `cloudMap.value = maps.clouds ?? CLEAR` (`:663`).
- Uniforms `cloudHeight`, `cloudShadow` (`:333-334`, interface `:252-254`).
- The projection (`:443-464`):

  ```ts
  const upwards = max(dot(geometric, light), float(0.12))
  const reach = cloudHeight.div(upwards) // fraction of radius
  const cosLatitude = max(sin(surfaceUv.y.mul(Math.PI)), float(0.15))
  const shadowUv = vec2(
    surfaceUv.x.sub(
      dot(light, east)
        .mul(reach)
        .div(cosLatitude.mul(2 * Math.PI)),
    ),
    surfaceUv.y.add(dot(light, north).mul(reach).div(Math.PI)),
  )
  const cloudCover = cloudMap.sample(shadowUv).a
  const cloudShade = oneMinus(cloudCover.mul(cloudShadow))
  ```

  `light·east·reach` is the flat-layer offset `h·tan z`. Clamped at
  `upwards = 0.12` the reach is at most 100 km on Earth (5.1 texels of the
  2048 map) and 500 km on Venus **(computed)**.

- Where it lands: `lit = daylight · ringShade · cloudShade` (`:504`), which
  multiplies `diffuse` (`:534`) and the sea glint (`:557-563`). The aerial veil
  (`:589-594`) is shaded by the rings and **not** by the clouds.
- The night lights read the same sample: `.mul(oneMinus(cloudCover.mul(0.85)))`
  — "A city under cloud is not visible from orbit" (`:617-625`). The streamed
  ground draws no night lights at all, so cities are another sphere-only term.
- Venus: its map's alpha is 1 everywhere, so the sphere under Venus's deck is
  uniformly × 0.45; it shows only where the deck's `daylight` lets the
  surface through near the terminator and when the deck is faded on descent,
  by which time the ground (no shadow) has taken over.

---

## 2. Every place that reads cloud data

| Reader                            | What it reads                                                                                                                                                      | Line                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `bodyUniforms`                    | `appearance.clouds` (altitude, period, opacity), `maps.clouds`, `appearance.haze?.limb`, `appearance.color`, `rotationPeriod`, `flattening`, `figure`, `placement` | `bodyUniforms.ts:432-436, 446-485`                                                |
| `Bodies.tsx`                      | `appearance.clouds !== null` to build a deck; `maps.clouds` for the map; the `CloudUniforms` and `PlanetUniforms` cloud fields                                     | `:410-416, 441, 489-493, 525-526, 532-553, 731`                                   |
| Deck material                     | `map`, `drift`, `opacity`, `entryDistance`, `eyeAltitude`, sun, colors                                                                                             | `planet.ts:713-789`                                                               |
| Sphere material                   | `cloudMap`, `cloudHeight`, `cloudShadow` (shadow and night lights)                                                                                                 | `planet.ts:279, 333-334, 443-464, 504, 617-625, 663`                              |
| Boot warm group                   | `createCloudMaterial()`                                                                                                                                            | `preload.ts:118`                                                                  |
| Texture loader                    | `'clouds'` map kind, color space                                                                                                                                   | `planetTextures.ts:49, 56, 64, 101-107, 199`                                      |
| Planetarium dossier               | "Cloud deck": `'None'` or `kilometers(altitude)`, note `turns in ${period(                                                                                         | rotationPeriod                                                                    | )}` | `packages/devtools/src/dossier.ts:1200-1210` |
| Dossier "Circulation" no-data row | "the deck's turn rate is known; its weather is not. No jet streams, no seasonal bands and no storms with positions"                                                | `dossier.ts:1218-1222`                                                            |
| `cloudShellAltitude`              | eye, orientation, radius, flattening                                                                                                                               | `packages/rendering/src/cloudShell.ts:8-19`, exported `rendering/src/index.ts:39` |

Nothing in `engine/`, `hud/`, `planetarium/`, `state/`, the flare
(`flareMath.ts`) or the hull's light (`CameraRig.tsx`) reads cloud data.
`render/terrain.ts` and `render/water.ts` carry no cloud term. The galaxy's
`LOCAL_CLOUDS` and `localClouds.generated.ts` are molecular clouds, unrelated.

---

## 3. The descent gate between sphere and ground

### 3.1 Where and how the handover happens

`TerrainStreamer.update` (`apps/game/src/engine/terrainStreamer.ts`):

```ts
const { lens, viewport } = this.lensView ?? DEFAULT_LENS_VIEW // :1030
const eye = this.#eye(surface, spinPose, bodyPose.position, camera) // :1032
const height = Math.max(1, eye.distance - eye.radius) // :1033
if (
  (eye.relief * pixelsPerRadian(lens, viewport)) / height <
  TERRAIN_RELIEF_PIXELS
) {
  this.#forget()
  return // :1034-1040
}
```

- `TERRAIN_RELIEF_PIXELS = 8` (`:278`, doc `:252-277`: "The cost is a switch
  rather than a fade").
- `#eye` (`:1406-1421`): `relief = body.surface.maxElevation` (peak-to-datum;
  Earth 9,900 m = 19,800/2 via `publishedRelief: body.relief / 2`,
  `solar/system.ts:198, 202`), `radius = body.radius` (equatorial),
  `distance = |camera − center|`. Height is over the round datum radius.
- The lens view is the engine's per-frame `{lens, viewport}` in **display**
  (CSS) pixels, set by `GameEngine.ts:1790` (`this.#terrain.lensView = view`).
  `pixelsPerRadian = viewport.height / (2·tan(vfov/2))` (`packages/rendering/src/lens.ts:177-178`).
  Supersampling and render scale are divided out (ADR-0044: "Selection and lens
  angles remain display-referred").
- `#forget()` (`:1723-1750`) drops patches, selection, pose, palette, lens
  view and standing; there is **no hysteresis**: the predicate is re-evaluated
  every frame.
- With no patches, only the sphere draws. With patches, the ground draws over
  the sunk sphere (sphere `renderOrder −1` once the body's tier is `surface`,
  i.e. angular radius ≥ 0.12 rad, far above the gate).

**Gate figures (computed, flight lens 65°):**

| Body  | maxElevation | Gate height, 1080 px tall | 1800 px tall | Nadir display pixel at the gate |
| ----- | ------------ | ------------------------- | ------------ | ------------------------------- |
| Earth | 9,900 m      | 1,049 km                  | 1,748 km     | 1,237.5 m                       |
| Venus | 6,900 m      | 731 km                    | 1,219 km     | 862.5 m                         |
| Mars  | 14,700 m     | 1,558 km                  | 2,596 km     | 1,837.5 m                       |

The nadir footprint at the gate is `maxElevation / 8` whatever the lens or
the viewport — the gate is already a footprint rule. The streamer's own
comment (`:263-265`) says "2,000 km of altitude" for Earth; at the baseline
lens and viewport the predicate gives 1,049 km.

### 3.2 What the ground does near the gate

`render/terrain.ts:651-671`: every detail band is zero by 0.9 of the gate's
footprint, so on the ground side of the switch only the terms the sphere also
draws remain:

```ts
const gateFootprint = maxElevation
  .mul(pixelAngle)
  .div(max(displayPixelAngle, 1e-12).mul(TERRAIN_RELIEF_PIXELS))
const gate = oneMinus(
  smoothstep(gateFootprint.mul(0.25), gateFootprint.mul(0.9), footprint),
)
```

`pixelAngle` is the per-sample angle and `displayPixelAngle` the display one,
both set by `TerrainPatches.tsx:144-150` (`terrain.setPixelAngle(display *
perSample, display)`).

### 3.3 What each side carries for clouds today

|                        | Sphere (above the gate)                    | Ground (below)                                                                                 | Sea sheet (below, generated bodies) |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| Deck mesh over it      | yes                                        | yes (depth-tested)                                                                             | yes                                 |
| Cloud shadow           | `× (1 − 0.55·cover)` on the beam and glint | **none**                                                                                       | **none**                            |
| Cities dimmed by cloud | `× (1 − 0.85·cover)`                       | no cities at all                                                                               | —                                   |
| Skylight               | none separate: the beam is the whole light | `SKY_FRACTION = 0.33` × columns taken **out of** the beam (`terrain.ts:1359, 1374-1383, 1640`) | same (`water.ts:464-468, 515-530`)  |

So a descent through the gate over a cloudy region of Earth brightens by up to
`1/0.45` in one frame where the map's alpha is 1 (rule 59, the other way
round, as plan §1 says).

### 3.4 Traps for "one cloud shadow at the gate, within 1%" (phase 2)

1. **The skylight share.** The sphere has no skylight term; the ground's
   `direct` is the beam × (1 − 0.33·columns) and its `thin` ambient is the
   rest. A shadow that multiplies the sphere's `lit` and only the ground's
   `direct` leaves the shadowed ground brighter by the skylight share. The plan's
   §6.2 energy balance (clear-sky share over the clear fraction) has to be
   matched by whatever the sphere does.
2. **Lookup coordinates differ.** The sphere reads maps by mesh UV and the bake
   by `normalize(positionLocal)` on an **oblate** mesh — a parametric latitude;
   the ground reads by its round body-fixed direction. On Earth the two differ
   by up to 0.096° (10.7 km at 45° latitude), about 9 display pixels at the gate
   **(computed)**. A field evaluated by each side's own coordinate will not
   agree at a point to 1%; the test has to fix one body-fixed direction for the
   drawn point on both sides.
3. **The drawn points differ.** At the same pixel the sphere's fragment is on
   the sunk, oblate sphere (9.9 km to 31 km under the datum on Earth) and the
   ground's is on the round terrain, so the sun ray from each crosses the cloud
   field at a different place by roughly that depth × tan(sun zenith) (inference
   from the geometry).
4. **No hysteresis.** A hover at the gate can flip between the two each frame.
   The plan's §5.4 far/near handover is footprint-based with hysteresis; the
   ground/sphere gate is footprint-based without it.
5. **Drift and sign.** Today's sphere shadow has no drift and a mirrored
   east–west offset (§5). Copying its projection into `cloudSunlight` copies
   both.

---

## 4. Geometry the plan states loosely (computed from the code)

- **"25.5 km over Earth"** is the shell's height over the **sunk sphere**. Over
  sea level it is 15.6 km at the equator, and it varies with latitude because
  the shell is oblate while the ground and the air are round:

  | Latitude (geocentric)     | 0°       | 27°      | 45°     | 60°    | 70°      | 90°      |
  | ------------------------- | -------- | -------- | ------- | ------ | -------- | -------- |
  | Deck over the round datum | 15,573 m | 11,137 m | 4,827 m | −525 m | −3,368 m | −5,864 m |

  It crosses the datum at 58.4°. Above the gate this is invisible (sphere and
  deck are both oblate). Below the gate the round ground should hide the deck
  poleward of that latitude **(inference, not observed)**.

- **The entry fade** is the band `[0, entryDistance]` of `eyeAltitude` _above_
  the shell — a quarter of the lift — not the last quarter of the descent to
  the ground. Earth: full at ≥ 21.9 km over the equatorial datum, zero at
  15.6 km. A walker at the North Pole at sea level reads `eyeAltitude` =
  +5,885 m in the shell's metric (`smoothstep` ≈ 0.98) while the deck geometry
  there is 5.9 km under the feet **(computed)**.
- **The shadow height is not the drawn height.** `cloudHeight` is
  `altitude / trueRadius` (12 km for Earth); the drawn shell is 15.6 km over
  the datum and 25.5 km over the sunk sphere.
- **ADR-0060 (`docs/adr/0060-…md:209`)**: "Seen from the station's own
  altitude, Earth's cloud map shows its texels" — 19.6 km texels at 400 km,
  about 49 display pixels at nadir at the flight lens **(computed)**.

---

## 5. Flagged inferences about the deck's motion and its shadow

Each is from three r185's `SphereGeometry` (`x = −r·cos φ`, `z = r·sin φ`,
`φ = 2πu`, `uv.y = 1 − v` with `v = 0` at +Y; read in
`node_modules/.pnpm/three@0.185.1/.../SphereGeometry.js`) and
`spinEvaluator` (`packages/universe/src/frames.ts:295-304`: orientation
`tilt · R_y(2πt / rotationPeriod)`, positive about local +Y for a positive
period). Together: increasing `u` is the shader's `east = cross(north, up)`
(`planet.ts:370-372`) and the prograde direction.

1. **Deck drift sense.** Sampling `cover(u + drift)` shows texel `u₀` at
   `u = u₀ − drift`. With `drift = t/T_deck − t/T_body`, a feature moves over
   the ground at `−drift` per unit time. Earth: +7.1e-7 turns/s, eastward
   28.6 m/s at the equator, where a 25.5 h deck should lag westward. Venus:
   +2.7e-6 turns/s, prograde 103 m/s, where Venus's clouds superrotate
   retrograde. `bodyUniforms.test.ts:240-243` pins the _value_ of `drift`, not
   the on-screen sense.
2. **Giant band flow, same convention.** `flowUv = vec2(u + time·flowRate·jets, v)`
   (`planet.ts:351-356`) moves features toward −u; `jets = cos(8·lat)·0.6 + 0.4`
   is +1 at the equator, so the equator lags, where the comment says "The
   equatorial jet leads" and Jupiter's and Saturn's equatorial jets are
   prograde. Plan §14 leaves the giants alone; this only matters if the weather
   copies the convention.
3. **Shadow offset, east component.** The north term samples toward the sun
   (`v + …`), the east term away from it (`u − …`). By the layout above the
   east term should be `u + …`. Magnitude: at most 100 km (5 texels) on Earth,
   near the terminator.
4. **Shadow without drift.** The sphere samples `cloudMap` at `shadowUv` with no
   `drift`. The deck and its shadow coincide only while `drift` is near a whole
   number of turns (renderTime ≈ 0 at a session's start); after one simulated
   day on Earth they are 22° of longitude apart.

A two-frame capture of Earth's deck at 1,000× and a still at a low sun would
settle 1, 3 and 4 (not done here: no rig was run).

---

## 6. Venus, Titan, the giants, generated worlds — what differs, what to leave alone

| Body                                                                        | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | What the weather work must not do                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Venus**                                                                   | Deck at 60 km (53.0 km over its datum), round (flattening 1), −4.2 d, opacity 1, color map with alpha 255 (opaque by day, absent by night), sphere × 0.45 underneath. Its haze (90 km, aerosol scale 15.9 km, no `aerosolDepth`) is "the haze around" the deck.                                                                                                                                                                                                                                                                                                                      | Keep its deck through phase 3 (§14). Do not also put Venus's clouds in the volume or the air's tables, which "counts the cloud twice" (§14). Retiring the 0.4% lift does not touch Venus (its own 0.99% wins).                                                                                                     |
| **Titan**                                                                   | No deck (`bodies.ts:392-394`); the haze is the sky: `aerosolDepth 4.3`, `aerosolAlbedo 0.95`, a detached layer (`:359-391`). Plate `titans-haze`. The cloud sphere was removed in `22b9933` (#181) after a look-council round.                                                                                                                                                                                                                                                                                                                                                       | No volume, no deck. Methane weather is a §14 decision.                                                                                                                                                                                                                                                             |
| **Giants** (Jupiter, Saturn, Uranus, Neptune; generated gas and ice giants) | `clouds: null`. The bands are the albedo map (Sol only; generated giants are a flat `KIND_COLOR` tint with limb darkening, and `wantsBake` excludes giants, `bodyUniforms.ts:261-264`). `tuningFor` (`bodyUniforms.ts:195-216`): lunarLambert 0.1, terminator 0.22, limbDarkening 0.72, saturation 1.3/1.15, `flowRate` 2.5e-7 turns/s gas (≈112 m/s on Jupiter) and 2.5e-6 ice (≈389 m/s on Neptune). The warp is the UV shear in §5.2, integrated against `time = renderTime` in float32 (not reduced; at 1e-7 turns/s invisible, §3). Oblate air (`flattening: shellFlattening`). | "A giant's bands are its face" (§14). No volume on a giant: no surface, no gate (giants have `relief: 0`, so `maxElevation` 0 and no ground ever streams). Plan §4.3's jet counts (~20 for Jupiter) are for a generated world's climate, not for a giant's drawing.                                                |
| **Sulfuric-family generated worlds** (≥ 450 K)                              | "The cloud deck is the sky, eight optical depths of bright droplets" — `aerosolDepth: 8`, `aerosolAlbedo: 0.98` in the air's tables (`packages/universe/src/appearance.ts:233-246`; ADR-0056 `:244-252`; `design/plans/the-air.md:284-295`). `clouds: null`.                                                                                                                                                                                                                                                                                                                         | Not a "wet world". Exclude from phase 1, or the deck is drawn twice.                                                                                                                                                                                                                                               |
| **Dust, tholin, methane, violet families**                                  | Their aerosols are the sky in the tables (`appearance.ts:207-275`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Same: the volume must not stack a second cloud on an aerosol the tables already carry.                                                                                                                                                                                                                             |
| **Generated rocky worlds with water**                                       | `clouds: null`; `appearance.liquid` from `liquidAppearance(grammar.liquidKind, …)` (`system.ts:1291`), `LiquidKind = 'water' \| 'hydrocarbon' \| 'magma'` (`grammar.ts:287, 324`); `SurfaceParameters.seaLevel` null for a dry world (`system.ts:147`). The sphere wears the orbital bake (`planet.ts:294-305`), `cloudShadow` 0, `cloudMap` CLEAR.                                                                                                                                                                                                                                  | This is phase 1's target. Do not give it a `CloudLayer` to reuse the deck: `materialize` would build a mapless deck over the opaque `WHITE` fallback — an opaque tinted shell. The mapless-deck path ("Titan's, and every procedural world's", `planet.ts:694`, `bodyUniforms.ts:471-473`) has no live user today. |

---

## 7. Tests that pin deck behavior

`pnpm test` (in the Stop gate and `pnpm check`) runs the Node tests;
`pnpm test:gpu` runs the `*.gpu.test.ts` files and is **not** in the gate.

| Test                                                                                                                    | Pins                                                                                                                                                                          | Phase 1 (volume on a generated world, Earth keeps its deck)                                                                        | Phase 3 (Earth's deck retires, Venus keeps its)                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/rendering/src/cloudShell.test.ts:6-27`                                                                        | `cloudShellAltitude` within 1e-6 m of the height, eye on the polar axis, radius 1e3–1e8, flattening 0.5–1, height ±1 m, any rotation about X                                  | Unchanged; reuse the function per layer. Add a property for whatever shell helper the volume adds (round over terrain).            | Unchanged (Venus still uses it).                                                                |
| `apps/game/src/render/bodyUniforms.test.ts:41-88` fixture                                                               | an Earth-shaped body with `clouds: {altitude 12_000, opacity 0.8, rotationPeriod 80_000}`, flattening 0.9966, scale 6.4e6                                                     | —                                                                                                                                  | Fixture can stay as a generic deck.                                                             |
| `bodyUniforms.test.ts:97-110` "flattens a spheroid and every shell around it by the same ratio"                         | **deck scale y/x = 0.9966 (oblate)**; air round, `flattening 1`                                                                                                               | A volume shell record wants the opposite assertion: round over terrain, like the air.                                              | Rewrite if the deck record is dropped for rocky bodies; keep if only Venus (round) remains.     |
| `:119-129` "flattens nothing about a figured body"                                                                      | deck round about a figured body (rule 25)                                                                                                                                     | —                                                                                                                                  | Keep while the deck exists.                                                                     |
| `:131-145` "measures a figured body's deck altitude against a round shell"                                              | `eyeAltitude ≈ 1000` (3 dp)                                                                                                                                                   | —                                                                                                                                  | Keep.                                                                                           |
| `:189-199` "takes the tuning for a rocky world under air"                                                               | `cloudShadow === 0.55` with a cloud map                                                                                                                                       | —                                                                                                                                  | Changes when `cloudSunlight` replaces the term (phase 2) or stays as Venus's.                   |
| `:201-207` "scales no relief, glint, lights or cloud shadow it has no image for"                                        | `cloudShadow === 0` without a map                                                                                                                                             | A generated world with weather has no map but casts a shadow from phase 2 on: this assertion becomes wrong for it.                 | Same.                                                                                           |
| `:220-227` "tints a mapless deck and leaves a mapped one white"                                                         | `baseColor`                                                                                                                                                                   | —                                                                                                                                  | Keep while the deck exists.                                                                     |
| `:240-243` "drifts its deck by the difference of the two rates"                                                         | `drift = 3600/80000 − 3600/86164` (15 dp) — the unreduced value                                                                                                               | —                                                                                                                                  | Keep for Venus; a period reduction changes the expected value.                                  |
| `:290-297` "draws no shell at a point"                                                                                  | `clouds === null` at tier `point`                                                                                                                                             | —                                                                                                                                  | —                                                                                               |
| `:380-394` star as a body                                                                                               | `clouds === null`                                                                                                                                                             | —                                                                                                                                  | —                                                                                               |
| `apps/game/src/render/cloudEntry.gpu.test.ts:14-51` "lets a descending eye leave cloud coverage without a culling step" | radius-100 sphere, `entryDistance` 1 (default), sun +Z, eye at 4, 2, 1, 0.5, 0.1, 0.001, −0.001 over the shell: `> 0.9`; equal at 4 and 2 (5 dp); `0.1 < level(0.5) < 0.9`; ` | level(0.001) − level(−0.001)                                                                                                       | < 0.001`; `level(−0.001) === 0`                                                                 | —   | Keep for Venus; it is the "no culling step" guard. |
| `cloudEntry.gpu.test.ts:53-88` "fades the grazing rim with the nadir before crossing the deck"                          | 140° lens at heights 0.5, 0.1, 0.001: max red ≤ `smoothstep(height) + 0.001` and > 0                                                                                          | —                                                                                                                                  | Keep for Venus.                                                                                 |
| `apps/game/src/render/materials.gpu.test.ts:162-172`                                                                    | planet, deck and ring materials compile                                                                                                                                       | Add every new cloud material and pass here.                                                                                        | Keep.                                                                                           |
| `materials.gpu.test.ts:328-357` "the planet" stand-in signature                                                         | binding count and read set equal with stand-ins and with `{albedo, normal, night, clouds, ring}` + a bake; `clouds: linearPixel()` at `:335`                                  | Any texture node the sphere gains (far atlas, shadow) needs its own linear stand-in and must be in this comparison (rules 56, 57). | If `BodyTextures.clouds` is removed the call at `:335` changes; while Venus keeps it, it stays. |
| `materials.gpu.test.ts:366-377` "the clouds"                                                                            | deck stand-in (`WHITE`) and a linear map compile one program                                                                                                                  | —                                                                                                                                  | Keep for Venus.                                                                                 |
| `apps/game/src/render/radianceReactivity.gpu.test.ts`                                                                   | the `'alpha'` reactive mode writes the material's opacity; union over a hidden background                                                                                     | The composite's reactive write should get the same kind of test.                                                                   | —                                                                                               |

No test pins: the 0.004 lift itself, the deck's height over the datum, the
oblate deck against round ground, the on-screen drift sense, the sphere
shadow's direction or drift, the deck's draw order against the air, the
dossier's "Cloud deck" row (`packages/devtools/src/dossier.test.ts` has no
assertion on it), or any record field (`packages/universe` has no test on
`clouds`).

---

## 8. What else holds the deck's look

- **Plates** (`apps/game/public/presets/*.jpg`, ledger
  `apps/headless/src/pictureLedger.json`, `pnpm presets:compare`, which takes the
  GPU lock): `blue-marble` (Earth, 14,402 km), `night-side` (Earth's night,
  where the deck is absent but the sphere's city dimming reads the map),
  `earthrise` and `solar-crescent` (Earth seen from Luna). All move in phase 3.
  Generated-world plates `centauri-daybreak` (313 km), `tau-ceti-moonrise`,
  `far-ringrise`, `far-shore` (80 m), `tau-ceti-dusk` (120 m) move in phase 1
  only if their world is chosen as wet. `scripts/presets/compare.mjs:66-75`
  tuned its noise floor against JPEG ringing "on Earth's clouds".
- **Cutscenes** that hold an instant over Earth (`packages/devtools/src/cutscenes/tngIntro.ts:2100`
  describes "lit cloud" in a framing).
- **Docs that describe the deck** and go stale when it changes:
  `docs/concepts/rendering.md:428-435` (map table: "coverage in alpha, on its
  own shell — and its shadow, on the surface"); ADR-0037 `:255-261` (the
  descent clearing, "This is not a volumetric cloud model"); ADR-0044
  `:86-89` (clouds write their alpha); ADR-0033 `:92` (clouds read the
  presentation instant); `docs/agents/invariants.md:280-289` rule 25 and
  `.claude/rules/rendering.md` (the cloud deck's shells on the figure's side of
  the branch); `docs/design/planetarium.md:712` ("Circulation: Bands and a jet
  profile on `CloudLayer`"); `docs/guides/catalog.md:454` (luminance to alpha);
  `apps/game/src/render/output.ts:105-108` (the DPR comment counts "a cloud deck
  over it"); `apps/game/src/render/materials.ts:641-646`. Per the documents
  rule, a phase that lands moves its decision into an ADR and writes these in
  the present tense.

---

## 9. What each phase has to change or hook into, in this area

### Phase 1 — the volume on a generated wet world; Earth keeps its deck

- **Which bodies.** The predicate is new and presentational: a water liquid
  (`appearance.liquid?.kind === 'water'` or `grammar.liquidKind`) and a sea
  (`surface.seaLevel !== null`), excluding the haze families whose aerosol is
  already the sky (§6). Do not express it by setting `appearance.clouds` in
  `packages/universe` — that builds the deck in `Bodies.tsx:350-355` and makes
  the dossier claim a deck at an altitude.
- **Per-frame CPU inputs belong in `bodyUniforms`** (`bodyUniforms.ts:338`),
  beside `CloudUniforms`, so they are tested in Node: layer base/top shells
  measured from the **datum** (`trueRadius · compression`, the air's
  `seaLevel`, `:536`), round over terrain (flattening 1, as the air's `:546`),
  eye height over each from `cloudShellAltitude(eye − center, orientation,
radius, 1)` (rule 52), every time offset reduced by its period in float64
  before upload (§3, and unlike `drift` at `:483`), all at `frame.renderTime`.
- **Which body the trace serves** ("one body's volume a frame", §5.5):
  `Bodies.tsx:577-626` already walks every body's shell and picks the air the
  eye stands in (`standingIn`, `airOverhead`, `standingAir`); the served-body
  choice can sit beside it.
- **Far march in the sphere material** (§5.5: "draws its far march in its
  sphere material"): `createPlanetMaterial` is one graph for every body, so the
  far march is a uniform-switched term every body's pipeline carries; it hooks
  where `cloudShade` is today (`planet.ts:443-464, 504`) and into the veil
  (`:589-594`) if the air in front is to see it. Note the sphere material
  shades only fragments on the disk: cloud tops overhanging the limb — the
  parallax the 0.4% lift was for (`bodyUniforms.ts:449-457`) — need fragments
  outside the silhouette, which today only the atmosphere shell (`BackSide`)
  and the deck mesh have.
- **No shadow on one side only.** Phase 1 has no `cloudSunlight`; the
  generated world's sphere and ground both carry none, which is consistent
  across the gate. Adding a shadow to the sphere's far march in phase 1 would
  open a step at the gate (rule 59).
- **Reactive.** The composite writes cloud opacity into `reactive` with union
  semantics (§1.9); the row is null outside temporal pictures (`sensor.ts:199`).
- **Compile-ahead** through `render/warmup.ts` (rule 61) and `preload.ts`'s
  producers; new texture nodes get their own linear stand-ins (rules 56, 57)
  and join `materials.gpu.test.ts`'s signature tests.
- **Earth during phase 1:** nothing changes. Leave the lift in place: without it
  Earth's deck (measured from the sunk sphere) falls to 2.1 km over the datum at
  the equator and under the round ground at low latitudes **(computed)**.

### Phase 2 — the shadow and the light (touches this area)

- `cloudSunlight(point)` replaces `cloudShade` on the sphere (`planet.ts:464,
504`), joins the ground at `terrain.ts:1374-1383` (`direct`, `thin`) and
  `:1408-1412` (glint), and the sea at `water.ts:515-530` (`diffuseLight`),
  `:552-560` (sky reflection) and `:565-571` (glint). The orbital bake is safe
  by construction: bake mode returns `baked`, not `lit` (`terrain.ts:1463-1468`),
  though the graph is still evaluated.
- Venus's sphere keeps a shadow from its own deck (uniform 0.45 today) or the
  new function answers for it; Earth's step at the gate stays until phase 3
  unless `cloudSunlight` reads Earth's deck map meanwhile (open question).
- The gate test: §3.4's five traps.

### Phase 3 — Earth: the deck, its map and its lift retire

| Retires                              | Where                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Earth's deck record                  | `bodies.ts:574` (and the dossier row it feeds, `dossier.ts:1200-1210`)                            |
| Earth's map                          | `textureSources.ts:139-147`; `data/textures/manifest.json` and `earth_clouds.webp` via the ingest |
| The 0.4% floor                       | `bodyUniforms.ts:449-458` (Venus unaffected)                                                      |
| The sphere's shadow from Earth's map | `planet.ts:443-464` uses for Earth (Venus may still use it)                                       |
| Earth's plates                       | `blue-marble`, `night-side`, `earthrise`, `solar-crescent` re-taken                               |

| Stays (Venus)                                                                                   | Where                                                            |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `createCloudMaterial`, `CloudMaterial`                                                          | `planet.ts:682-789`                                              |
| The deck mesh                                                                                   | `Bodies.tsx:85-95, 122-140, 237-242, 348-355, 532-553, 731, 754` |
| `CloudUniforms`, the drift, the entry fade, `cloudShellAltitude`                                | `bodyUniforms.ts:92-103, 446-485`; `cloudShell.ts`               |
| `'clouds'` map kind, `BodyTextures.clouds`, `BodyMaps.clouds`                                   | `planetTextures.ts:49-66, 101-107, 199`; `bodyUniforms.ts:56-62` |
| The warm archetype                                                                              | `preload.ts:118`                                                 |
| `cloudEntry.gpu.test.ts`, the deck halves of `materials.gpu.test.ts` and `bodyUniforms.test.ts` | §7                                                               |

Also in phase 3: the night lights' `oneMinus(cloudCover·0.85)` (`planet.ts:621`)
loses Earth's map; plan phase 5 ("cities under cloud") needs the volume's
column there instead, or the night side brightens by up to 1/0.15 under
cloud in the meantime.

---

## 10. Invariants and constraints that apply here

- **Rule 52** — no planetary radii subtracted in a shader: the deck's
  `eyeAltitude` is the model (`cloudShellAltitude` in float64,
  `bodyUniforms.ts:465-470`). Shell entry and exit distances in a march are
  formed from CPU heights, not two radii (plan §5.2).
- **Rule 59** — the ground and the sphere shade alike across the eight-pixel
  gate: today's cloud shadow is a sphere-only term; phase 1 must not add one to
  one side; phase 2 closes it (§3.3, §3.4).
- **Rule 25 / 27** — the figure branch: shells are round about a figured body
  (`bodyUniforms.ts:348`); `figure: null` means round. The deck is the shell
  that gets this right for figures and wrong for terrain (oblate Earth deck
  over round ground).
- **Rules 56 and 57** — every texture node in the sphere or a cloud pass gets
  its own linear stand-in; `materials.gpu.test.ts` holds the binding count.
- **Rule 61** — compile-ahead through `render/warmup.ts`.
- **Rule 60** — `three/webgpu` and `three/tsl` only in `apps/game`; nothing in
  `packages/*` imports three (`cloudShellAltitude` lives in
  `packages/rendering`, which is arithmetic).
- **Rule 15 / 17** — the weather stores nothing; a climate derived from the
  record is computed at load, never packed or saved.
- **Rule 5** — a presentational appearance field rides along (versions.ts
  precedent); anything a frame, the terrain or a contact reads spends a
  version.
- **Rule 65** — any cloud readout added to `ir.*` or a census must not throw
  into or write the frame.
- **Rule 68** — GPU tests and rigs take the machine's GPU lock; the deck's GPU
  tests are not in the gate.
- **ADR-0033** — clouds read the presentation instant (`frame.renderTime`),
  never `clock.time`.
- **ADR-0044** — reactive coverage is union-blended; `max` would keep an
  occluded overlay's rejection (`sensorMrt.ts:71-75`).
- **Art direction continuity items 1–3** (`docs/design/art.md:361-…`):
  hysteresis, cross-fade, far representation generated from the near one. The
  ground/sphere gate today has none of the first two.

---

## 11. Gotchas, collected

1. Phase 3 is Earth's deck, not the deck: Venus uses every piece of the
   machinery.
2. The deck's altitude is measured from the sunk sphere; the air from the
   datum. Mixing the two moves a shell by the body's whole relief (9.9 km on
   Earth).
3. The deck is oblate, the ground and the air are round: 21 km of
   pole-to-equator disagreement on Earth.
4. The sphere's shadow uses the record's 12 km, the drawn deck stands at
   15.6 km over the datum; neither is the weather's 10 km shell.
5. The sphere's shadow is not drifted and is mirrored east–west (inference).
6. `drift` is unreduced and its on-screen sense is probably reversed
   (inference).
7. The deck has no air in front of it and is drawn after the air, so it covers
   the limb glow and the disk's veil; a volume composited through the air's
   tables will look different on every Earth plate even with identical cover.
8. The deck is transparent at night (opacity × daylight); the sphere dims cities
   by 0.85 × cover instead. Removing the map un-dims them.
9. `materialize` reads `appearance.clouds !== null` once; a record that changes
   mid-session does not add or remove a deck mesh.
10. The descent gate has no hysteresis and is in display pixels; its nadir
    footprint is `maxElevation / 8` for every lens.

---

## 12. Open questions for the implementers

1. Who owns Venus's clouds after phase 3: the deck as it is, the volume, or
   the air's tables (§14)? Until that is decided, phase 3 cannot delete the
   deck machinery.
2. In phase 2, does Earth's ground take a shadow from the deck's map (closing
   today's gate step a phase early) or stay unshadowed until phase 3?
3. What is the "wet world" predicate for phase 1, and which generated plates
   does it touch?
4. Does Earth's record keep a cloud field after phase 3 for the dossier (and
   if so, what does it say — cover, genus, top height), or does the planetarium
   read the climatology?
5. Which body-fixed direction does the phase-2 gate test evaluate the field at,
   given the sphere's parametric lookup and the ground's geocentric one?
6. Are the deck's drift sign and the sphere's east–west shadow sign real
   defects (inference, §5)? A capture would say; neither is pinned.
7. Where do cloud tops overhanging the limb get their fragments once the deck
   mesh retires: the atmosphere shell's material, a dedicated shell, or the
   composite alone?
