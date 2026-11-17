# The clouds: takram's renderer, made the game's

The cloud renderer is takram's. Their volumetric clouds draw in our scene
through `three-clouds-webgpu`, the unofficial WebGPU port, with no change to it
([build log, 14 Nov 2026](../../CONTEXT.md)). This plan makes that renderer the
game's own: its presets and tunables in the picture's settings, its shadow on
our ground and sea, our weather in its map, our air in its light. And it
retires the march phases 0 and 1 of [the weather](the-weather.md) built, one
piece at a time, as each piece loses its last reader.

The weather plan still says what the weather is: a function of time, with
storms, rain and night riding on it. This plan says what draws it.

It is a plan, so it promises. When a phase lands, its decision moves into an
ADR and the section here goes.

| Reads with                                                                                                             | For                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [The weather](the-weather.md)                                                                                          | The field, the pictures, and everything the clouds do to others |
| [The frame](the-frame.md)                                                                                              | The sampling, history and upsample rules both renderers share   |
| [ADR-0063](../../docs/adr/0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md)           | Where a cloud composite stands in the frame, and rule 69        |
| [ADR-0065](../../docs/adr/0065-a-scene-unit-is-the-sun-above-the-air-and-the-sensors-white-is-half-a-stop-under-it.md) | The scene unit the port's luminance is scaled to                |
| [ADR-0056](../../docs/adr/0056-the-air-is-measured-and-its-gain-is-pi.md)                                              | Our air, which the port's light does not yet read               |
| [Perf](perf.md)                                                                                                        | The frame the clouds have to fit in                             |

**Where the numbers come from.** Every cost here is the Mac mini's (Mac18,5,
Apple M6, 32 GB): the production build, Chrome, WebGPU, on cornerstone
`weather-g1-fair`, the whole frame with the clouds on less the same page with
them off, `ir.gpu(135)` read three times and the least kept. No figure is the
MacBook Air's. A size is an estimate of mine in lines of our own code, made
from reading the port's source and not from building the thing, and it is
marked as one.

---

## 1. What draws today

- **Two renderers stand behind one flag.** `?clouds=1` builds the native march
  and `?clouds=takram` builds the port, in the same slot of the frame, under
  the same `engine.clouds` levers. A page holds one or the other. Without the
  flag neither chunk loads, and nothing draws on `main`.
- **The adapter is four modules and no shader.** `render/clouds.ts` builds the
  port's pass and takram's atmosphere and draws the port's resolved layer as
  the first opaque of the scene pass over the clouds. `render/cloudsFrame.ts`
  puts our eye in the port's world: a point of the body's datum stands on
  Earth's equator in ECEF, and the eye keeps its true height, heading and sun,
  in float64. `render/cloudsDepth.ts` copies the scene's 4× MSAA depth to one
  sample. `render/cloudsTunables.ts` is the port's 174 tunables and five
  presets as a table, written through `engine.cloudTunables`. Together they
  are 1,893 lines, with 430 of tests.
- **The native march is 41 modules and 45 test files,** 54,463 lines with
  their tests, under `render/cloud*.ts`.
- **What the port costs,** at 1920 × 1080 and at 2880 × 1800, against a frame
  that costs 5.2 and 11.9 ms without clouds:

  | Row                            | 1920 × 1080 | 2880 × 1800 |
  | ------------------------------ | ----------- | ----------- |
  | The native march               | 7.87 ms     | 8.86 ms     |
  | `lowEnd`                       | 2.49        | 5.63        |
  | `low`                          | 4.50        | 7.10        |
  | `medium`                       | 10.22       | 16.39       |
  | `high`                         | 19.82       | 26.60       |
  | `ultra`                        | 54.89       | 70.12       |
  | `high`, `shadow.maxFar` 200 km | 9.10        | 16.61       |

  The port marches a quarter of the buffer on each axis and resolves at the
  whole of it, 720 × 450 into 2880 × 1800. The native trace is 360 × 225 into
  720 × 450.

- **What the port does not do here.** It draws almost nothing from 400 km. Its
  weather is a stock 512² map tiled round the globe. Its light and its haze
  are Earth's. No cloud shadows our ground or sea. A cloud writes no motion
  vector and no transmittance for a transparent object in front of it. It has
  no compile-ahead. §5 takes each in turn.

## 2. Borrow, then patch, then fork

**The port stays a dependency for as long as it serves.** Its source is 25,075
lines of TypeScript. Owning a line costs four times: writing it, testing it,
understanding it again when a new agent takes over, and extending a design
that encoded one screen's needs
([Houston, "Coding Agents Underestimate the Cost of Code They Own"](https://ben3d.ca/blog/coding-agents-underestimate-the-cost-of-code)).
A copy of the port in this tree is 25,000 lines every later change pays for,
and the port's author ships a release a week: alpha.6 on 30 Oct 2026, alpha.9
on 15 Nov. A fork stops receiving those.

So a gap is closed by the first of these that closes it:

1. **A setting.** `shadow.maxFar`, `maxRayDistance`, a texture input, an
   experimental switch. The port has 174 tunables and a table of experimental
   options, and most gaps in §5 start as one of them.
2. **The adapter.** A module of ours beside the four, on the port's public
   surface: `cloudShadowAt`, `localWeatherTexture`, `prepareShadow`, the
   atmosphere's parameters.
3. **A patch.** `pnpm patch` on the pinned release, for a change of a few
   lines, with the same change offered upstream. A patch is refused by the
   next release that moves under it, which is the signal to look again.
4. **A fork,** vendored under `packages/`, with the MIT text beside it. Only
   when a gap needs a change to the march's own shader that no input reaches,
   and after the size of the change is known. A fork is recorded in an ADR,
   because it is the decision to stop receiving upstream's fixes.

**"Integral" is about our side of the seam, not about copying theirs.** The
adapter carries no upstream's name. The engine has one cloud system, one set
of levers and one settings table. The cornerstones, the plates and the cost
rows are taken with this renderer. A reader of `apps/game` meets "the clouds".

**The dependency is young, and that is priced.** The port is an alpha with one
maintainer. Its release archives are pinned by URL and their SHA-256 sums are
in `pnpm-workspace.yaml`. The geospatial fork build is vendored as a file,
because pnpm refuses a tarball URL below the direct dependencies. takram's own
packages are the stable part: `@takram/three-geospatial` is MIT, at 1,773
stars, and the port tracks it file by file with citations in its source.

## 3. What the port ships that the game takes

Each row is something the weather plan asked the native march to grow. The
port has it, most of it behind a switch that is off. None is judged here; the
phase that turns one on takes its picture and its cost.

| The port has                                                       | Behind                                              | Serves, in [the weather](the-weather.md)          |
| ------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------- |
| Five quality presets and 174 tunables                              | `qualityPreset`, `engine.cloudTunables`             | §9, the budget; the picture's settings            |
| A quality governor: steps a level down on late frames, back up     | `QualityGovernor`                                   | §12, the Retina ground is already late            |
| Four cloud layers with density profiles, and cloud-type presets    | `cloudLayers.*`, `applyCloudTypePreset`             | §5.1, the genera; §4, the regimes                 |
| Beer shadow cascades, and the sun's transmittance at any point     | `shadow.*`, `cloudShadowAt(worldPosition)`          | §6.1, one shadow                                  |
| Shadows past the cascades                                          | `experimental.distantCloudShadows`                  | §6.1, the sphere from orbit                       |
| Light shafts                                                       | `lightShafts`, the shadow-length march              | §2, underlit at dusk; §6.3, the shadowed air      |
| Ground bounce on cloud bases                                       | the secondary ground march                          | §5.3, the ground lights the base                  |
| An environment of sky and cloud for reflections and image lighting | `experimental.cloudEnvironment`                     | §6.5, what the sea reflects; a hull's environment |
| Skylight by direction                                              | `experimental.directionalSkylight`                  | §6.2, under a deck                                |
| Weather that evolves, and procedural weather                       | `experimental.evolvingWeather`, `proceduralWeather` | §4.5, texture moves with the wind                 |
| Reprojection through the wind                                      | `experimental.windReprojection`                     | §5.5, reproject through the cloud's own motion    |
| Rain shafts                                                        | `experimental.rainShafts`                           | §7.1, rain far off                                |
| Lightning                                                          | `experimental.lightning`                            | §7.4                                              |
| Moonlight                                                          | `experimental.moonlight`                            | §6.6, night                                       |
| A cirrus deck                                                      | `experimental.cirrusDeck`                           | §5.1, cirrus                                      |
| A convective profile                                               | `experimental.convectiveProfile`                    | §5.1, dense tops and thin bases                   |

## 4. Ours: what stays and what goes

A native module goes when nothing reads it, and not before. The gate on each
row is the phase of §6 that removes its last reader.

| Ours                                                                                                                                                                            | Verdict                                                                                                  | Goes with   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------- |
| The weather as a function of time: `weatherField`, `weatherGenus`, `weatherClimate`, `weatherScenario`                                                                          | **Stays.** It is the plan's own subject, and the port has no climate                                     | —           |
| The maps and the field read: `cloudMaps`, `cloudField`                                                                                                                          | **Stays, with a new reader.** They feed the port's weather map (§5.2)                                    | —           |
| The frame's contract: `cloudSystem` (its interfaces), `cloudLevers`, `cloudLayers`, `cloudOverPass`                                                                             | **Stays.** The port's system is built on them, and rule 69 is theirs                                     | —           |
| The cornerstones, the capture, the instruments, the panel's tools (phase 1's K, U, I and J)                                                                                     | **Stay.** They judge a picture, whoever drew it                                                          | —           |
| The scene unit and the `motion` row (ADR-0065, phase 1's V)                                                                                                                     | **Stay**                                                                                                 | —           |
| The far field: `cloudFarAtlas` and the far march                                                                                                                                | **Stays until orbit is settled** (§5.4). The port draws nothing from 400 km as shipped                   | G, or never |
| The front handle and its knots: `cloudFront`, `cloudKnots`                                                                                                                      | **The interface stays; the knots go** unless the port grows a transmittance by depth (§5.6)              | H           |
| The march: `cloudMarch`, `cloudTrace`, `cloudDensity`, `cloudProfile`, `cloudNoise`, `cloudJitter`, `cloudGeometry`, `cloudMix`, `cloudKinds`                                   | **Goes**                                                                                                 | J           |
| Its light: `cloudPhase`, `cloudSky`, `cloudSunGrid`, `cloudSunlight`, `cloudVolume`, `cloudClipmap`, `cloudSource`, `cloudRadiance`, and the Mie tables in `packages/rendering` | **Goes.** The glory and the cloudbow go with the tables; they return as their own work if a picture asks | J           |
| Its history and composite: `cloudHistory`, `cloudComposite`, `cloudCompositeAir`, `cloudDepth`, `cloudFrame`, `cloudFrameNode`, `cloudUniforms`, `cloudNodes`                   | **Goes**                                                                                                 | J           |
| Its references: `cloudPathTrace`, the slab rig, the statistics tables, and their GPU tests                                                                                      | **Goes with the march.** A reference for a renderer we do not own is upstream's to hold                  | J           |
| Phase 1's open packages that build the native light: the reference transport, the phase tables, the higher orders, the irradiance table                                         | **Stopped.** No further radiometric package is started ([the weather](the-weather.md) §10)               | Now         |

Three rules of ours are copied into the adapter today to keep the page's chunk
count: the served body, the true sun, and the over-blend. When the march goes
they have one home again.

## 5. The gaps, each with its route

### 5.1 One shadow

**The defect.** No cloud shadows the ground, the sea, the sphere, the hull or
the flare. Shadows are what the ground most lacks.

**The route is the adapter.** `cloudShadowAt(worldPosition)` answers the sun's
transmittance through the port's cascades at any point of its world. Our
terrain, water and sphere materials take a `cloudSunlight` term, each through
the same node, so rule 59 holds: a term on the ground is a term on the sphere.
The point handed in goes through the frame matrix `cloudsFrame.ts` already
builds.

**What has to be true first.** The cascades are fitted to the camera's far
plane, and ours is 10¹⁰ m. As shipped a texel spans thousands of kilometers.
`shadow.maxFar` 200,000 gives real self-shadowing and takes `high` from 19.82
to 9.10 ms, so the range is ours to set per stance: it follows the eye's
height, and from orbit `experimental.distantCloudShadows` is the candidate.

**Size, estimated:** 300 lines of ours and no fork. **Done when** one shadow
crosses the descent gate with no step, on a cast, and the ground under a
cumulus reads darker than the ground beside it by the transmittance the port
reports, within 5%, in a GPU test.

### 5.2 Our weather in its map

**The defect.** The port reads a stock 512² weather map, tiled a hundred times
round the globe. At G1 its texels show as square-footprint cells 400 to 800 m
across, and the same weather stands over every place and every world.

**The route is the adapter.** `localWeatherTexture` is an input. Our maps
already bake coverage and genus round the eye from the field. A module renders
them into the port's channel layout, one channel a layer, and sets the repeat
so one tile spans our window. The cloud-type presets map from our regimes. The
port's own detail noise stays: it is what makes its clouds read as clouds.

**What is not known.** Whether the port's shadow cascades and its far field
tolerate a map that is a window round the eye and not a globe. The first
experiment is the map alone, at G1 and at one stance 500 km from it.

**Size, estimated:** 400 lines of ours and no fork. **Done when** two
cornerstones 500 km apart draw different skies from one field, a scrub of the
clock moves the weather, and no square cell shows at G1 at device resolution.

### 5.3 Our air in its light

**The defect.** The light on a cloud and the haze in front of it come from
takram's atmosphere at Earth's parameters. Far clouds meet our horizon in
another color, and a generated world's clouds are lit by Earth's sky.

**Three routes, cheapest first.**

1. **Parameters.** takram's atmosphere is Bruneton's, precomputed from a set
   of parameters: scale heights, scattering and absorption coefficients, the
   sun's irradiance. Our air has the same quantities per body (ADR-0056). The
   adapter builds the port's atmosphere from the body's record and not from
   Earth's defaults. The planet stays Earth-sized in the port's world, so
   height-dependent terms follow our scale heights and the horizon's geometry
   stays Earth's. No fork.
2. **The composite.** The port's own aerial perspective on a cloud is turned
   off, and our composite applies our air in front of the cloud, as ADR-0063's
   identity does for the native march. This needs the cloud's depth from the
   port's layer. A patch if the layer does not carry it.
3. **Our tables in its march.** The port's sun and sky terms read our
   transmittance and irradiance tables. This is the fork, and it is the last
   resort: it is the one gap that reaches into `lighting/sunSkyLight.ts`.

**Size, estimated:** 250 lines for the first, 300 more for the second, and the
third is not sized until the first two are judged. **Done when** the blind
panel cannot pick the cloud's horizon color from the ground's at G1 and at
G3, and a generated world with a red sky draws red-lit clouds.

### 5.4 Orbit

**The defect.** From 400 km the port draws almost nothing. Its march ends at
`maxRayDistance`, 200 km in every preset but `lowEnd`.

**The route starts as a setting.** `maxRayDistance` is a tunable. The first
experiment raises it past the limb's 2,290 km at E1 and reads the picture and
the cost. If the march holds, orbit is a preset row and the far atlas has no
reader. If it does not, the far atlas stays for orbit and the two renderers
hand over by pixel footprint, as §5.4 of the weather plan already requires of
any pair, and the handover is the work.

**The showcase is one unbroken descent.** Whichever route is taken, the proof
is a cast from 400 km to standing with no frame that steps.

**Size:** one rig session to decide. A handover, if it comes to one, is
estimated at 600 lines and is the largest item here.

### 5.5 Settings, presets and the frame budget

**The defect.** The presets are reachable only from the console, and the one
that looks right, `high`, costs more than the whole frame beside it.

**The route is ours.** The five presets become the cloud row of the picture's
settings, and the tunables a panel under the instruments. The default preset
is chosen per machine by measurement, not by name: the mini's is the dearest
that holds 60 Hz at 1920 × 1080 with `shadow.maxFar` set, and the Air's is the
dearest that holds a steady 30. The port's `QualityGovernor` is tried against
the presentation watchdog's own ladder, and one of the two steps the clouds:
two governors on one frame chase each other.

**A setting changes at run time, and three things about that are measured**
(build log, 16 Nov 2026). A write lands only after a frame
the port drew, or presets without `accurateSunSkyLight` fail to compile. A
layer's `shadow` flag is a uniform, and the shadow pass's cost follows it only
at the next graph rebuild. `preset('low')` on a page that drew `high` reads
12.36 ms where a page built at `low` reads 9.61. The panel is not shipped
until a preset reached by any path costs what it costs from boot.

**Size, estimated:** 500 lines, most of it the panel. **Done when** every
preset is one click, each has a measured row on both machines, and a preset
round trip returns the frame to its cost within 3%.

### 5.6 Motion, and what draws in front of a cloud

**The defect.** A cloud writes no motion vector, so temporal reconstruction
has no velocity for it, and the port's `reactive` share is unwritten. Nothing
reads the cloud in front of a transparent object: a ring or a plume beyond a
cloud draws over it.

**The route.** The port resolves its own history at display resolution, so
under temporal reconstruction the cloud layer is composited after the
upscaler and not before it, and needs no velocity. That is a change to where
the composite stands and it is measured against ADR-0063's placement before it
is taken. For transparents, the front handle answers from the port's layer
depth where it has one, and otherwise an object over the clouds stays marked
for the over pass, which is rule 69 as it stands.

**Size:** not estimated; the first step is a measurement. [The frame](the-frame.md)
§3 has the history rules both paths are held to.

### 5.7 Boot and the first frame

**The defect.** The port's pipelines build on the first frame drawn. With
`high` drawing during boot the cover lifts 34 s after the page attaches at
1920 × 1080, and not within 90 s at `ultra`. `low`, `medium` and `lowEnd` do
not compile on a first frame at all, and the adapter works round it by
building at `high` and writing the preset a frame later.

**The route.** Version first: alpha.7 moves the port to three 0.187, and the
compile failure is tried again there before anyone hunts it in 0.185. Then a
warm-up through `render/warmup.ts` that draws the port's passes off screen
behind the cover, at the preset the page will use. The four baked textures
are 2.86 MB of download, 2.10 MB of it `shape.bin`; brotli on the files is
measured before any other format is considered.

**Done when** the cover lifts within the boot budget [perf](perf.md) holds
for the page without clouds, plus two seconds, at `high`.

### 5.8 The grain

**The defect.** Under a slow turn of 2.4° a second the temporal upscale shows
grain, and the cast runs at 38.4 fps against the rig's 40 fps all-clear.

**The route is the version.** alpha.9's notes name a grid of dots, one every
four pixels, under `temporalUpscale`, fixed by blending the fresh texel with
its own clipped history; a clip against four neighbors in place of nine; and
streaks when the render height is not a multiple of four. None of that is
tried here. The cast is taken again on alpha.9 before any work of ours.

## 6. The order

Each phase lands green on its own, with its picture and its numbers, as a pull
request into `the-weather`.

| Phase | Lands                                                                                                                                                                                              | Done when                                                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | **The name.** Landed. The adapter's modules and types carry no upstream's name. `?clouds=takram` stays the selector until phase C                                                                  | No type, module or engine field of ours says takram; the gate and the bundle checks pass                                                                                                                  |
| B     | **The version.** three 0.187 across the workspace, and the port at alpha.9 with fork build 8. [The frame](the-frame.md) §8 has what else the upgrade carries                                       | `pnpm check`, `pnpm test:gpu` and `pnpm presets:compare --all` pass; the cost table is taken again; the slow-turn cast is taken again; the first-frame compile is tried                                   |
| C     | **The default.** `?clouds=1` builds this renderer, and the native march answers `?clouds=march`. The cornerstones' ledger and plates are taken with this renderer. The presets are in the settings | Every `weather-g*` cornerstone has a plate from this renderer; §5.5's three run-time defects are closed or bounded; a preset is one click; the port's targets have a declared memory figure at both sizes |
| D     | **One shadow** (§5.1)                                                                                                                                                                              | §5.1                                                                                                                                                                                                      |
| E     | **Our weather** (§5.2)                                                                                                                                                                             | §5.2                                                                                                                                                                                                      |
| F     | **Our air,** routes 1 and 2 (§5.3)                                                                                                                                                                 | §5.3                                                                                                                                                                                                      |
| G     | **Orbit** (§5.4), and the descent                                                                                                                                                                  | A cast from 400 km to standing with no frame that steps                                                                                                                                                   |
| H     | **Motion and the front** (§5.6), **boot** (§5.7)                                                                                                                                                   | §5.6, §5.7                                                                                                                                                                                                |
| J     | **The march retires.** The modules of §4 marked J are deleted with their tests, `?clouds=march` with them, and `CLOUD_MODULES` shrinks to what is left                                             | Nothing imports a deleted module; the page's chunk count is re-stated; ADR-0064 is superseded by the record of this renderer                                                                              |

There is no phase I: beside a numbered phase the letter reads as a numeral.
C comes before the shadow because every later phase is judged on plates, and
plates of a renderer nobody defaults to are plates nobody looks at. J comes
last because the far field and the front handle have readers until G and H.

**What is recorded when.** Phase C writes the ADR that says the cloud renderer
is the port's, what the adapter owns, and which of ADR-0063 to ADR-0066 it
keeps: the frame's two passes and the scene unit stand, and the march's and
the droplets' records are superseded when J lands.

## 7. The traps already paid for

The build log's entries of 14 and 16 Nov 2026 hold them with their numbers.
The ones a later phase would otherwise find again:

- The port's composite assumes three's `QuadMesh`, whose v is 0 at the top. A
  plane's uv draws the sky's clouds on the ground.
- A preset that turns `accurateSunSkyLight` off fails to compile on a first
  frame on three 0.185, silently in the picture, and makes the frame cheaper.
  A cost row is refused when the console holds a `THREE.TSL` error.
- A figure is read after the page's own loop has turned. Read straight after
  back-to-back `ir.gpu` frames, the march is rebuilt and the shadow atlas
  keeps the last preset's size: `high` after `low` reads 21.94 ms with no page
  frame between, and 24.93 with sixty.
- A chain is built beside the one still drawing. Anything the page holds for
  "the" cloud context is held per context.
- A lazy chunk that imports a module the page also loads re-partitions the
  page's chunks. The adapter takes `cloudsServed` as an argument.

## 8. Open, and whose

- **The selector's name.** `?clouds=takram` is the one place the upstream's
  name still selects something. Phase C removes it. If the word should go
  sooner, the selector takes a neutral value in phase A.
- **Earth's deck.** The weather plan keeps Earth's textured deck until a
  volume can draw Earth with its shadow and its light. That rule stands; this
  renderer reaches Earth after phase E gives it Earth's climate.
- **What goes upstream.** The far-plane fit of the shadow cascades and the
  first-frame compile are defects any consumer with a large far plane meets.
  Offering them to the port's author is cheaper than carrying a patch.
- **The glory.** It leaves with the Mie tables. "Over the deck" is one of the
  weather's pictures, and it is judged without a glory until someone asks for
  one.

## Related

- [The weather](the-weather.md) — the field, the pictures, the phases above the renderer
- [The frame](the-frame.md) — sampling, history, upsample and the three.js upgrade
- [three-clouds-webgpu](https://github.com/johnfewell/three-clouds-webgpu) (MIT) — the port, with `docs/EXPERIMENTAL.md` for every switch in §3
- [takram three-geospatial](https://github.com/takram-design-engineering/three-geospatial) (MIT) — the original, and the atmosphere
- [The look council](look-council.md) — the protocol the pictures are judged by
