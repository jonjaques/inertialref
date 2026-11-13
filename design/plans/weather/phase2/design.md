# The weather, phase 2 (the shadow and the light): design

**State.** This is phase 2's design, by the adviser's ruling of
2026-11-12 (ruling 004). Nothing of it is built.

Read on `origin/weather/phase-1` at `2ecb223a`. M1's second part has merged
there (`5b2d9fd1`: four taps to 500 m ended at the level's exit, the early
out, the strides between levels), with the factor of the sun's higher
orders and ADR-0069 and ADR-0070. M2, X, Y2, L's fourth pass and N are not
merged; §1 says what this design assumes of each.

## 0. How to read this

A package reads its own entry in §8, the laws that entry names (§4 to §6),
§3 for the stores, and nothing else. Each section stands alone.

**Marks.** Every figure carries one:

- **M** measured, with the command or the file and line. A figure from a
  report or a critic's probe is M with its name, not retaken unless said.
- **D** derived, with the arithmetic. **E** estimated.

**Names this design adds.**

| Name            | What it is                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The sun map     | A 2D clipmap of the sun's scaled transmittance through the whole cloud union, for points under the union's base, turning with the level that casts it (§3, §4.1)                         |
| The light map   | Its coarse companion, read over a point's own column: the diffuse light a cloud sends down, stored where it leaves the cloud, and the vertical column's reflectance and cover (§3, §5.1) |
| `cloudSunlight` | The one function a surface and an air step call, carried on the handle (§3)                                                                                                              |
| The flux block  | `t(τ*, μ₀)`: a slab's total transmission of the sun by transport depth, by adding-doubling, a block of the sky table (§5.1)                                                              |
| The sky probe   | A small map of the cloud field's radiance and transmittance by direction about the eye, for the sea's reflection (§5.4)                                                                  |

**The ten laws** are L1 to L4 (§4.1 to §4.4), L5 to L8 (§5.1 to §5.4), L9
and L10 (§6).

---

## 1. What phase 1 leaves, as built

Phase 1's design §0.4 lists nine things phase 2 needs. Each row below is
checked against the code at `02048daa`. Where the row and the code differ,
the code stands.

| §0.4 says phase 1 leaves                                                                                      | The code                                                                                                                                                                                                                                                                                                                          | Phase 2 must build                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A sun optical depth readable at any eye-relative point, `CloudSunDepthNodes.opticalDepth`                     | The export is `depths(offset)`, returning `toSun`, `whole`, `weight`, `behind` (`render/cloudNodes.ts:150-174`, `cloudSunGrid.ts:393-406`). It is free of march state. **But a point under the union's base reads the base slice at its own column:** the height is clamped (`cloudSunGrid.ts:345-349`)                           | The displacement to the base along the sun: 1,430 m, 3.6 cells, at a 35° sun under a 1,000 m base (D)                                                             |
| The same                                                                                                      | The grid's reach is 24 km and it idles from orbit (`cloudSunGrid.ts:116-125, :153`). Its cell is 400 m. At the sample itself with no taps it reads the sun 0.18 to 0.26 RMS off on broken cloud (M: `reports/p1-l.md`, third pass, first table)                                                                                   | A store that serves E1: a frame 80 by 128 km from 400 km (D: 400 km·2·tan 5.7° is 79.9 km of height at an aspect of 1.6)                                          |
| Far column statistics readable from a fragment stage: a fraction, an in-cloud depth, a base and a top a layer | The atlas holds exactly those four, RGBA8, 6 faces of 258² a layer (`cloudFarAtlas.ts:76, :791`), and the second body's march reads it in the composite's fragment (`:79-83`). A texel is 39 km on Earth (D: 10,007 km/256) and 24 km on the cornerstones' world (M: phase 1 design §5.9)                                         | Nothing new in the atlas. It cannot draw a cumulus's shadow: inside 1,024 km §4.2 bakes the field's own statistics, and a fragment reads the atlas only past that |
| The same, in the statistics a march reads                                                                     | `sunStatistics` answers **1 for a sample outside every level** (`cloudMix.ts:345`): the ground is unshadowed by construction. The levels beyond the sample are read at the sample's own column (`cloudMix.ts:44-51`)                                                                                                              | The statistics for a point under every level, with each level read where the sun's ray crosses it                                                                 |
| The sky table with its hemisphere accessor                                                                    | The table holds three blocks: `ln L̄`, `Δ`, `Δ_s` (`packages/rendering/src/skyIrradiance.ts:19-22, :46-51`). **No block holds one side's irradiance.** The CPU has it: `marchSkyFaces(...).above` (`:735-797`), whose comment says the linear form errs 9% to 37% on the datum                                                     | A fourth block, the downward irradiance over π (§5.2). The table's ground is a constant albedo of 0.15 lit by a clear sky (`:59, :676-709`)                       |
| The slab oracle's fluxes and the Monte Carlo slab                                                             | `SLAB_REFERENCE.reflected` (both media, 6 depths, 5 suns, 3 radii) and `.flux` (true medium, black surface, μ₀ 0.7 and 0.4, τ 0.1 to 100) in `slabReference.generated.ts:383-`; `traceRow` in `apps/ingest/src/transport/monteCarloSlab.ts:434`. The path tracer already takes a Lambert ground and a sky (`pathTrace.ts:99-110`) | The column: the slab with the air and a ground (§5.1). No transmitted flux is tabled; conservative slabs give it as one less the reflected                        |
| The scaled medium, one extinction for every transmittance                                                     | Ruled and built (`CloudMedium.sigma`)                                                                                                                                                                                                                                                                                             | Nothing                                                                                                                                                           |
| `cloudFront` read by what draws after the composite                                                           | `CloudFrontHandle` on the engine (`cloudSystem.ts:72-103`, `GameEngine.ts:523-559`). The flare and the hull read no cloud (no match for `cloud` in `flare.ts` or `shipMaterial.ts`). The flare takes a CPU `FlareVisibility` (`flare.ts:310`)                                                                                     | The flare and the hull do not join that reader. They take one CPU number (§4.3), because the flare is already driven from the CPU                                 |
| The cornerstones, the capture set, the step detector, the solar-time solver                                   | `cornerstones.json`; `scripts/weather/capture.mjs`. Not re-read                                                                                                                                                                                                                                                                   | Study stances (§11)                                                                                                                                               |
| The served set as one predicate                                                                               | `cloudsServed(body)` (`packages/rendering/src/weatherScenario.ts:597`). The flag gates the chunk and the layer mask at `App.tsx:280-281, :793, :817` and `pages/paths.ts:370`                                                                                                                                                     | §10                                                                                                                                                               |
| A `'picture'` reset that restarts the history and rebuilds no cache                                           | `cloudFrame.ts:251, :265, :307-309`                                                                                                                                                                                                                                                                                               | The sun map follows the same rule: a `'picture'` reset rebuilds none of it                                                                                        |

**Also found, and not in §0.4's table.**

- **The surfaces' skylight is authored, not tabled:**
  `skyColor·diffuse·skyView·skylightLeft(incidence, 0.25)` on the ground,
  with the same fraction out of the beam (`terrain.ts:1359-1384`), a
  second ramp on the sea (`water.ts:524, :555`), and `skyOverhead` under
  a deep air (`radiance.ts:28`). Row 15 changes three materials' light.
- **The sea reflects one color,** the authored `skyLight`
  (`water.ts:551-559`), with no reflected direction. §5.4 adds one.
- **The air has four marches, not two.** `marchAir` (`air.ts:360-443`) is
  called by the sky's shell at 12 samples (`materials.ts:368`) and by the
  three surfaces through `airToward` at 4 (`terrain.ts:1428`,
  `water.ts:651`, `planet.ts:591`). The composite re-forms both through
  `compositeAir` and `airSegment` over `airMediumAt` (`air.ts:1086`,
  `cloudCompositeAir.ts:169, :222`), 6 samples a sky segment and 4 a
  surface one. The trace forms the blocked air in `sampleAir` and a
  `behind` segment (`cloudMarch.ts:711, :1050`). All four must take one
  shadow or the composite's identity leaves a band (§4.4).
- **The field ends 1,024 km from the eye's foot.** The cover clipmap is six
  levels of 256², 250 m to 8 km (`cloudFrame.ts:323-324`). Past it the
  field is the far atlas alone (§4.2).
- **The deck's sphere shadow** is `cloudShade` at `planet.ts:466`, scaled by
  the `cloudShadow` uniform (`:336`). A served body sets it to zero today
  (phase 1 design §2.4); phase 2 puts `cloudSunlight` in its place.

**What this design assumes of the unmerged packages.**

| Package         | Assumed, by export                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 part two     | `CloudSun.depth` carries two depths for the light after first order (ruling 001); four taps reach 500 m and end at the level's exit; `levelStatistics` has a fifth statistic, the cloudy columns' true mean                                                                                                                                                                                                     |
| L's fourth pass | The grid is RG16F: R the opacity cell (first order, the early out), G the depth held as a depth (the light after first order only). 32 heights (ruling 003). The volume's 50 m level is gone. It also holds the grazing law's question (ruling 002)                                                                                                                                                             |
| M2              | `resolvedSlab` and `statisticalSlab` in `cloudMix.ts` with twins in `packages/rendering/src/cloudOverlap.ts`; the source node takes a slab (the sun's cosine, two scaled depths), a radius, a level and a view; the factor of the sun is in that node. The trace binds 12 sampled textures by the ruling and 13 by a test's comment (`cloudTrace.gpu.test.ts:254-259`); M2's census says, and phase 2 adds none |
| X               | The far march's light calls the same source node. The atlas is paced in blocks of 128. A clear texel holds its level's mean depth                                                                                                                                                                                                                                                                               |
| Y2              | The composite's air runs at the history's rate, held to the per-pixel identity within 1% at the 95th percentile and 5% at worst; or only the exact early out lands. Its target is sized inside ruling 003's room. §9 carries both arms                                                                                                                                                                          |
| N               | The composite splits a sky pixel into its air (`T′`) and what is behind it (`T′^(1/(1 − f_δ))`); the levels' statistics and the CPU field's tables build in a worker, which F's march then runs in                                                                                                                                                                                                              |

If one lands otherwise, the law that reads it is re-read before its
package is briefed.

---

## 2. The slicing

**The question:** the shortest honest path to E1, E2 and E3 passing under
Earth's own climate, with G1 to G4 passing on the way.

**What each picture needs of phase 2,** read from the rubric's §2:

| Picture | Needs                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| E1      | A resolved shadow on the ground from 400 km (L1, L2, L7). Its advisory number is the shadow's offset             |
| E2      | The crop's shadows; the tops' own light. From phase 2: L2 at grazing, L4, L9 for cirrus over cumulus             |
| E3      | Nothing of a shadow's shape (its shadows are under a pixel). The light under cloud at the atlas's scale (L2, L5) |
| G1      | Shadows crossing the ground (L1, L7); the air under them (L4)                                                    |
| G2      | Gray light with no sun (L5, L6); the deck in the sea (L8)                                                        |
| G3      | Underlit bases, which are phase 1's light. Rays when present (L4)                                                |
| G4      | Row 8 on the plate; of phase 2, only that the default is on                                                      |

So the E pictures need three laws of ten (L1, L2, L7), with L4 and L9 for
E2. G2 alone needs L5, L6 and L8.

**The alternatives weighed.**

|             | What it is                                                                                                                                                                        | For                                                                                                                                     | Against                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **W**       | Phase 1 design §0.4 as written, then phase 3 whole                                                                                                                                | Nothing to argue                                                                                                                        | Phase 3's CPU work waits behind G2's laws, which no E picture needs. The resolved probe is built for no cornerstone                                          |
| **A**       | The shadow, then Earth, then the light under a deck (phase 1 design §0.1)                                                                                                         | E pictures a phase sooner                                                                                                               | Refused by phase 1's design for reasons that hold: two unrelated risks in one phase, E2 judged twice, Earth's overcast ground lit by a clear sky for a phase |
| **E-first** | W's content, ordered so the E path's packages go first, with **phase 3's CPU half running beside phase 2** on its own branch, and **the resolved near probe left out of the MVP** | The GPU is the scarce resource and phase 3's first half never takes it. No law moves between phases. Each phase still lands green alone | Two branches merge forward at once. Phase 3's design must be written while phase 2 builds                                                                    |

**This design takes E-first.** Three departures from §0.4, recorded here as
the charter's §2 asks:

1. **The order inside phase 2 follows the E pictures.** The sun map, the
   three materials and the shadowed air are waves 1 and 2; the energy
   balance, the skylight and the reflection wave 3. E1 and E2 forced can
   be looked at when wave 2 merges.
2. **The resolved near probe is out of the MVP** (the plan's §6.5). No
   cornerstone looks at broken cloud over water: G2 is an overcast. Phase
   2 builds the sky probe from the levels' statistics (§5.4), exact for a
   deck, and declares what a broken field's reflection lacks (S4).
3. **Phase 3's design starts when phase 2's reckonings report, and phase
   3's packages that never take the GPU lock may run beside phase 2's
   waves,** on `weather/phase-3`: the measured climate as a second
   `BodyClimate`, the overlap rule, the land mask and row 16's count.
   Nothing of it is served. **This is a schedule, the orchestrator's and
   Jon's to take or leave;** nothing in phase 2's design depends on it.

**The critical path:**

```
R-A, R-B  →  K (census, R-F)  →  sun map S, with surfaces G on the stand-ins  →  air A  →  [look: E1, E2, G1]
K, O's blocks, and M2, X, L4 merged  →  trace T (the ground's share), on its own seat
R-C1; O's column  →  R-C2, R-E  →  O's blocks  →  light map V  →  light H (L5, L6, m)  →  reflection R  →  default D  →  integration
```

The path is six GPU packages in sequence: K, S with G, A, H, R and D.
Each of the last five edits a material the next one reads. T and V fan
out. Nothing on the E path waits for the column or for R-C.

---

## 3. The stores, and who reads which

**A point's sunlight has four answers, by where the point is.**

| Where the point is                              | The answer                                                                                | Read by                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Under the union's base                          | **The sun map**, at the place the point's sun ray crosses the base shell                  | The ground, the sea, the sphere; the air's steps under the base, in the materials and in the composite |
| Under the base, past the map's last level       | **The far atlas's columns**, in the fragment (§4.2)                                       | The same function, by the map's weight                                                                 |
| Inside the union's height range                 | **The grid by its weight, the statistics otherwise**: `CloudSun.cloud`, as phase 1 has it | The trace alone                                                                                        |
| At the eye, for a source narrower than the blur | **The sun at the eye**: one CPU march                                                     | The flare, the hull's key light                                                                        |

**Why a 2D map and not the grid's base slice.** Under the base a point's
sunlight depends only on where its sun ray enters the base shell, and a
2D store can be laid in levels: one store serves 40 m and 400 km.

**The sun map.** `render/cloudSunMap.ts`, a `CloudResource`.

- **Frames.** Seven eye-anchored levels of 512² texels, 62.5 m × 2^k, on
  the base shell, toroidally addressed, laid by `levelFrames`
  (`packages/rendering/src/cloudFrames.ts:283`, which takes the texels and
  the size). Level k spans 32 km × 2^k, to 2,048 km: the clipmap's last
  window, so the map ends where the field does. Read eye-relatively
  through `levelPlane` (rule 58), in the casting level's turned frame
  (§4.1).
- **A texel holds** `B`, the mean scaled transmittance of the whole union
  along the sun's ray through it, as R8: one step is 0.0039, under row
  12's 0.01. 7 × 512² = 1,835,008 B (D).
- **The pick is a real number, and a read blends the two levels either
  side of it:** `λ = log2(4·pixel/62.5 m)`, the point's distance times
  the lens's pixel angle, floored at zero. Where the finer level's window
  does not hold the point, or in its outer fifth, the read fades to the
  coarser. Two fetches always, four in a fade band. No pick sits on a tie
  and none pops: on a descent the blend slides.
- **At E1** `λ` is 2.24 at 1080p (D: four pixels are 296 m; 76% of the
  250 m level, 24% of the 500 m) and 1.51 at the rubric's Retina (177.6
  m: half the 125 m level inside its window, the 250 m level alone past
  it; the kept contrast moves from about 0.96 to 0.94 across that fade,
  E, from §4.1's table). The 250 m level spans 128 km: the Retina
  frame's width, and all but 7 km a side of 1080p's 142 km (D). At 1,024
  texels the map is 7.3 MB.
- **The casting level** is the one with the largest share of the beam
  blocked at the eye's foot, `c̄_j·(1 − T̄_j)`, from one sample of the
  climate a frame on the CPU. It changes only when another level's share
  is a quarter larger, and a change is a field event for the map.

**The light map.** `render/cloudLightMap.ts`: a second array on the same
frames, 128² × 7 levels, RGBA8, texel 250 m × 2^k, 458,752 B (D). Package
V builds it, after R-C1 has judged §5.1's geometry. **It is read over the
point's own column, never at the sun's crossing.**

| Channel  | What a texel holds, over its footprint                                                                                                                                         | Formed                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| R, `D̄`   | The diffuse light the cloud sends down, per unit of the sun's flux on a level face, **at the column where it leaves the cloud**                                                | Along each sun ray, laid at the column of that ray's own in-cloud centroid (§5.1) |
| G, `R̄_v` | The vertical column's reflectance for diffuse light                                                                                                                            | The cover and the level's depth there: no march                                   |
| B, `c̄_v` | The vertical column's cover                                                                                                                                                    | The same                                                                          |
| A, `ĥ`   | The height at which the sun meets cloud over the column, as a share of the union's height, naming the level it meets: H takes `h_c` and that level's base `h_b` from it (§5.1) | The same ray as R                                                                 |

Its pick is `log2(h/250 m) + 0.75` for a base `h` over the point, blended as the
sun map's is; the two levels stand for one kernel (§5.1). The mean beam
at this scale, `B̄`, is the sun map's level two coarser, or its last.
Neither map is bound in the trace.

**The handle carries functions, not textures.** The scene's materials are
built with no cloud system in reach (phase 1 design §4.9). The engine
holds `CloudLightHandle`, made **inside the cloud chunk** when it loads.
It offers `sunlight(offset, footprint)` and `airShadow(step)` as node
builders that close over the maps, the atlas's addressing, the levels'
uniforms (shape, sight, mean depth, heights, turn) and one weight.

- A material imports the handle's type alone, so the `App` chunk does
  not move until §10's flip.
- **A body's materials take the handle only when the body is served**
  (`cloudsServed`, or a rig that forces it). A dry world pays nothing.
- On a served body every read sits in a uniform branch on the handle's
  weight, which is zero until the maps are whole.

**Bindings.** A served surface gains four sampled textures: the two maps,
the far atlas and the sky table, which is on `AirUniforms` already. The
sea gains a fifth, the probe. The shell and the composite gain the two
maps. **The trace gains none.** By a static count the sphere holds ten
today (M: the engineering critic). K takes the compiled counts first.

**Bytes against B12's 80 MB,** one served body, all D:

| Resource                                                                                                         | Bytes          |
| ---------------------------------------------------------------------------------------------------------------- | -------------- |
| The sun map                                                                                                      | +1,835,008     |
| The light map                                                                                                    | +458,752       |
| The sky table's four new blocks, 34 × 16 RGBA16F each: the downward irradiance, the ground share's two, the flux | +17,408        |
| The sky probe, 64 × 32 RGBA16F                                                                                   | +16,384        |
| **Phase 2 adds**                                                                                                 | **+2,327,552** |

**Ruling 003 sets the room.** Phase 1 lands at or under 77.1 MB at 1080p
with one served body, and phase 2's maps are first in line under a stop
at 79.5 MB on the device census. This design asks 3,328 B more than
draft 1's 2,324,224 (the flux as a block) and stays 72,448 B inside the
stop (D). K's first line is the census. If it reads over 77.17 MB the
sun map goes to 384² (1,032,192 B), and E1's 250 m level then spans the
frame's height and not its width.

---

## 4. The sun's laws: L1 to L3

Each law has the same six parts: the form, the oracle, the held-out cases,
the bar, what the oracle cannot see, and who proves it.

### 4.1 L1: the sun map, where the field is resolved

**The form.** For a place `x` on the base shell and the frame's sun `ŝ`:

```
B(x) = mean over the texel of  exp(−∫ f·σ′ ds)      along x + ŝ·s, through the union
cloudSunlight(p).beam = B at x(p),   x(p) = p + ŝ·t,  t the ray's crossing of the base shell
```

- `f·σ′` is the field's own read, `CloudMedium.fraction` times `.sigma`,
  as the trace's transmittance is: one medium for the cloud and its
  shadow.
- **The bake is a march toward the sun,** laid inside the levels as the
  grid's `#stretches` lays them (`cloudSunGrid.ts:416-454`), from the
  field's five textures. It runs as quads through `runQuadPasses`, a
  strip or a block a frame. It is not the trace's kernel and adds
  nothing to it.
- **Its steps are laid by length: at most 125 m of path, and 62.5 m in
  the middle and high levels at the map's 62.5 m level, with no cap a
  level.** A count a level is wrong at a low sun. Point by point against
  160 steps (M: `bake.ts`, §12): steps of 114 m (16 at 50°) leave 0.023
  RMS and +0.0006 in the mean, steps of 126 m (40 at 15°) 0.026 and
  +0.0008; steps of 314 m (16 at 15°) leave 0.112 and **+0.014 in the
  mean**, over this law's own bar. The cap is on the ray's whole count,
  set by S from R-F's time, and a stretch the field's coarser read calls
  clear may be strode, as the march strides it, if the bars hold. Under
  a sun where that cap binds, the figure is declared as S measures it,
  under three levels and under one.
- **A texel is a mean: four rays at 62.5 m and 125 m, sixteen at 250 m
  and 500 m, one at a statistical level.** Against 64 rays (M:
  `bake2.ts`, two suns): four leave 0.004 at 62.5 m, 0.027 to 0.031 at
  250 m and 0.050 to 0.057 at 500 m; sixteen leave 0.006 to 0.007 and
  0.014 to 0.017; one leaves 0.10 at 250 m.
- **The crossing `x(p)` is formed from heights** (rule 52):
  `shellCrossingFrom(body, p, ŝ, base)` (`cloudGeometry.ts`), with `p`
  eye-relative. A point on the ground 600 m up under a 1,000 m base moves
  400 m/tan e, not 1,000 m/tan e.
- **A surface point at or over the base has no crossing ahead.** It reads
  `B` where its ray, followed away from the sun, leaves the base shell
  (the grid's `#farEnd`), raised to the share of the union's height over
  the point: `B^(1 − s)`, `s = (h − base)/(top − base)`: exact at the
  base and the top, the depth taken as even between.
- **The map turns with the level that casts most of the shadow** (§3).
  Each level's lattice turns rigidly about the spin axis and drifts along
  it (`weatherField.ts:35-38, :98-99`). Laid in the body's frame and
  redrawn each quarter texel, a shadow near the eye would hop 15.6 m
  every 1.6 s at a 10 m/s wind (D). So the frames are laid in that
  level's turned frame, a read turns its point by the level's matrix,
  and the window's exposed strips are baked as it scrolls.
- **Pace.** A level is paced by its shadow's speed, the motion the turn
  cannot follow: another level's motion against the casting one, the
  drift's part through the shell, and the sun's turn, which shears a
  level `thickness·Δe/sin²e` (D: 0.37° at 50° and 0.04° at 15° for 15.6 m
  in 1,400 m). It is redrawn each quarter texel of that motion or each
  eighth, whichever is cheaper and holds the turned read's RMS inside
  1.5 times the fresh map's at every level (S). A quarter texel behind,
  fair cumulus at 20 m/s with a drift of 4 reads 0.034 RMS against a
  fresh 0.024 at 62.5 m, and 0.102 against 0.049 at 250 m (R-A). After a field event a level holds nothing
  and returns under a weight, coarsest first, at four rays. A level the
  pick cannot name from the eye's height is not baked. **A level that
  cannot keep its pace inside S's cap is not read:** the pick's floor
  rises to the finest level that can, so under a time warp the map
  coarsens and never lags.
- **Under a `'picture'` reset nothing is rebuilt.**

**What it forbids.** A second medium for the shadow. A read of the grid's
base slice by a surface. A displacement by a level's nominal height: the
march finds where the ray meets cloud. A step count a level. A map held
still under a level that moves.

**The oracle.** A float64 march of `cloudFieldAt` from ground points along
the sun, in Node, its steps laid by length: 25 m or less under a sun of
10°, with its own error given by halving them. A count a level is no
oracle under 15° on three levels: 40 steps a level read 0.26 RMS off 320
at 5° (R-A). Its own error is its quadrature's. It is a twin: the
same field, medium and point sun, so it checks the quadrature and the
texel's mean, and whether the beam is the shadow's light is L5's.

**What a texel's size costs** (M: the same probe, the mean over a texel
against the 50 m field, four cases at suns of 15° to 50°): a 100 m texel
keeps 0.98 to 0.99 of the contrast, 200 m 0.95 to 0.97, and the grid's
400 m cell 0.88 to 0.93. The ground's shadow is nearly binary (6% to 18%
of it reads between 0.1 and 0.9), so a texel's error is an edge's blur,
not a bias.

**Held-out cases.** A sun at 5° and at 10° through three levels, where
the ray's cap binds; cirrus over cumulus, where a ray's steps must fall
inside two levels and not in the gap; a ground point at 0.6 of the
base's height, and one at 0.3 of the way up a level (`B^(1 − s)`,
recorded and not declared: 0.073 to 0.082 RMS through the 62.5 m map,
and bright by +0.020 to +0.023 in the mean, which no bar holds); a place within 2° of the
terminator; five seeded places a regime; a field at 20 m/s with a drift
of 4, the read turned and the map a refresh behind; a warp of 100.

**The bar.** No rubric row holds the shadow's own accuracy. Proposed:

- the map's mean over a 12 km square, 192 texels of 62.5 m, within 0.01
  of the oracle's, at
  every level and case;
- the map's mean within 0.004 of the oracle's over the texels whose
  oracle is under 0.1: each 0.004 of beam in an umbra moves the dark
  third of the ground under kilometer cells by 0.9 to 1.5 points (the
  critic of R-C1);
- a level's RMS against the oracle's mean over the same texels under
  0.03: the bake's own error, apart from the texel's size;
- E1's shadow offset against `h·tan z` (rubric §3.9), recorded.

**What the oracle cannot see.** The bilinear ramp at a shadow's edge, 62 m
wide where the sun's own penumbra is 14 m (D): G1. A fade band crossing
the frame: G6's descent. A shadow lagging its cloud under warp: C7.

**Who proves it.** R-A (§7), before package S.

### 4.2 L2: the sun map, past the resolved field

**The form.** The same march, and the same map. A level whose texel is
past the field's switch reads statistics, because the field's read does:
a read at a footprint is the resolved field up to `cell·4^(dither − 1)`
and the level's measured statistics past it (`RULINGS.md`). The bake reads
the medium at a footprint of its level's texel, with the dither held at
½, and a statistical step passes the crossing's law:

```
T_j = crossingTransmittance(F_j, spreadDepth(τ′_j, k_j)·m, crossingExponent(ℓ_j, c_j), k_j)      cloudMix.ts:184
B   = Π_j T_j        over the levels the ray crosses, each read where the ray crosses it
```

- **Displaced by construction.** Each level is read where the sun's ray
  meets it, because the bake marches the ray, from the cover clipmap's
  texel there and the level's table. The far atlas, whose texel is 24 to
  39 km, serves only past the map.
- **One step a level** for a statistical level: the law is split-invariant
  (phase 1 design §5.9).
- **S may feed a statistical texel its own cloudy share** where the
  cover clipmap holds one, if R-F shows no cost and its twin shows the
  footprint's error fall. It is allowed, not asked.
- **The handover between a resolved level and a statistical one** is a
  map level's fade band, a fifth of a level wide. For a cell of 1,200 m
  the switch is at 600 m, between the 500 m and the 1,000 m levels.
- **Past the last level,** 1,024 km from the eye's foot, the read is the
  far atlas's columns, in the fragment: for each level the atlas's texel
  where the sun's ray crosses the level's middle height (its fraction, its
  in-cloud depth, its base and top, `cloudFarAtlas.ts:791`), through the
  same crossing's law, and the product. Three fetches and three crossings,
  taken only where the map's weight is under one; the last level's outer
  fifth fades to it. This is phase 1 design §0.4's far half, and the
  second body's march already reads the atlas from a fragment
  (`cloudFarAtlas.ts:79-83`). A uniform there would dim a clear desert
  by what the storm tracks block. At E3 an atlas texel is about a pixel
  (E).
- **A sun under the horizon at `x`** follows the grid's rule
  (`cloudSunGrid.ts`, `#bakeNode`): the ray goes down, and where it comes
  back up it takes one statistical crossing of each level there. It
  holds 0 only where it meets the ground. The dip is 1° at a 1 km base,
  and dusk's shafts live in it.

**What it forbids.** A second law of mixing for the shadow: the map's
statistical levels, the atlas's columns and the trace's statistical steps
pass one function. The atlas as a shadow inside the map's reach.

**The oracle.** The same float64 march, averaged over a level's texel: the
resolved field's footprint mean (`reports/p1-depth.md` §7 has the method).

**Held-out cases.** A footprint whose cloudy share is far from its
level's (0.377 and 0.207 against 0.26, `REGISTER.md`); a sun at 1.75°
under a cirrus, where the law reads 0.698 against 0.632 and, at covers
of 0.8 to 1, 0.354 against 0.252 (M: `REGISTER.md`); three levels at
once; the atlas's column against the map's last level, each side of the
handover.

**The bar,** at the level's scale: a statistical level's `B`, and the
atlas's read, within the larger of 10% and 0.01 of the beam of the
level's resolved mean, each ray reading its own cover, for suns of 10°
and over; recorded under 10°, with the grazing figure above as the
declared ceiling: on E2's crop it is ground 40% too bright under cirrus
at the terminator. Every figure R-B took under 10° sits under it. At
the level's scale the law reads +0.2% to +7.9% from 10° on four
weathers; Earth's three levels at place 5 under a 10° sun read +16% of
a beam of 0.065, which is 0.009 (R-B). A level's mean is taken at
30,000 rays or more where the beam is under 0.1: 8,192 read +16%, and
2,048 +35%. **By footprint the law is declared,** as a level's
statistics at a place: no one number for a level meets 10% there, since
a 12 km place of broken cumulus holds a cloudy share of 0.45 where its
level holds 0.38, and the floor is 0.71 to 1.00 of the law's RMS at 30°
and over (R-B). **The handover to the atlas is measured on the GPU at
S6 before its fade is fixed:** on the twin the atlas stands +1.0% to
+7.4% over the map's last level at one place and −4.4% and −14.6% at
another, with the cube's warp not modeled.

**What the oracle cannot see.** The step in sharpness where the map turns
statistical: C1's zoom, E1's frame edge, S5. A ring 1,024 km from the
eye's foot where the map gives way to the atlas: a whole disc, S6.

**Who proves it.** R-B (§7), on L's fourth pass, which holds the question
of whether the grazing error is the law's or the statistics' (ruling
002).

### 4.3 L3: the two forms

**The form.** Phase 1 design §5.1: light on a surface takes the scaled
transmittance; a source narrower than one diffraction takes the unscaled.

```
irradiance:  T′ = exp(−τ′)                 the ground, the sea, the sphere, the hull, the air
the disk:    T_point = Π_j exp(−γ_j·τ′_j),  γ_j = 1/(1 − f_δ) of level j's droplets or ice
```

- **The disk has one reader, the flare, and it is at the eye.** The flare
  is driven from the CPU already (`FlareVisibility`, `flare.ts:310`). So
  the disk form is **one float64 march a frame**:
  `sunAtEye(weather, clock, eye, sun)` in `packages/rendering`, at most 48
  calls of `cloudFieldAt` along the eye's sun ray, laid inside the levels,
  returning both forms. No texture, no readback, no binding.
- **It runs in the worker that holds the field** (N's), a frame behind,
  and the flare reads a number from the handle. On the main thread the
  first call builds the field's tables, 1,415 to 1,459 ms (M: the
  engineering critic, probe 1), and `weatherField.ts` would join `App`.
- **The hull's key light is the irradiance form over four rays** across
  the hull's span, one value, set as a uniform. One ray flickers as the
  flare does.
- **Why not the map or the grid.** A store holds a mean, and the disk form
  of a mean is not the mean of the disk form. On the three cumulus fields
  above, `(mean T′)^γ` less `mean(T′^γ)` is −0.006 at 100 m and −0.036 to
  −0.041 at 400 m, with an RMS of 0.07 (M: the same probe). And a cell
  cannot follow an edge crossing the sun.
- **The disk on the sky** stays the composite's (phase 1, package N); a
  test holds the flare's `T_point` and that disk on a slab to one value.

**What it forbids.** `T′^γ` formed from any filtered store. One `γ` for a
union of droplets and ice.

**The oracle.** Closed form on slabs, `exp(−γ·τ′/μ₀)`; on the field, the
same march at four times the steps. **Held-out:** the eye inside a
cloud's edge; a sun under the eye's horizon from orbit; a thin cirrus,
where `T′` is 0.74 and `T_point` 0.55 at `τ′` 0.3 (D).

**The bar.** Proposed: within 1% of the four-times march on eight seeded
eyes a regime. A cost bar: no task on the main thread, and under 0.1 ms
of the worker's at the 95th percentile a ray: one ray is 0.011 to 0.027
in flight at 150 m/s and 0.12 to 0.13 on frames 1.5 km apart (M: the
engineering critic, probe 1).

**What the oracle cannot see.** The flare's flicker as an edge crosses the
sun at 150 m/s, and whether the flare and the drawn disk dim together:
G5's cast with the sun in frame, a study.

**Who proves it.** No reckoning: the form is closed. Package F's tests.

---

## 4b. The sun's laws, continued: L4

The same six parts as §4. It reads §3's stores and §5.1's parts.

### 4.4 L4: the shadowed air

**The form.** An air step with medium under the union's base takes
`cloudSunlight` on its two lights, each constituent by its own share:

```
single′   = Σ_i single_i · (1 − w_i·(1 − B(x(p_w))))     i: the gas, the haze
multiple′ = multiple · (1 − w̄·(1 − m))                   m = (E↓ − beam)/E_sky(p), §5.1's parts
w_i       = (1 − e^(−(base − z₀)/H_i)) / (1 − e^(−Δz/H_i))   the share of i's column in the step that lies under the base
p_w       = the middle of the step's part under the base;  w̄ the two shares weighted by their scattering
```

- **`w` is a share of the medium, not of a sample or of length.** `z₀` is
  the step's low end, `Δz` its height, `H_i` the scale height
  (`air.hRayleigh`, `air.hMie`). From 400 km a surface's lowest step
  runs 0 to 6.25 km and is sampled 1.56 km up (D: `crowdedSamples`,
  `air.ts:620`, over 100 km of air). Under a 1 km base 22% of that
  step's gas and 57% of its haze are under the base, where a share of
  length is 16% (M: the physics critic, D, the haze at 1.2 km).
- **`single`** (`air.ts:426-431`) takes the beam. **`multiple`** is Ψ,
  baked for a clear sky (`air.ts:432-437`): the air's
  light from every direction but the sun's. Under a layer it takes the
  ratio of the diffuse light there to the clear sky's, `m`, read once a
  march at its lowest step from the light map. `E↓` there carries the
  regional albedo `Ā`, a uniform, so an air step needs no fragment. In
  clear air `m` is exactly one; under a deck of `τ` 30 at a 35° sun it
  is about one (E). **Whether an overcast's air is as bright as that is
  not shown:** the column says, and the 25% bar may be missed by a
  factor (R-C2).
- **`m` lands with package H.** Package A lands the beam and the
  plumbing at `m` = 1. No judged picture is taken between.
- **The level a step reads is the one whose texel is its run along the
  ground,** never finer than the pick by footprint: the mean over the
  step. It cannot band, and it blurs a shaft to the step.
- **Four marches** (§1): the sky's shell, the surfaces' `airToward` and
  the composite's segments take it by one function. The fourth, the
  trace's blocked air, reads no map:
- **Inside the union's height range no march reads the map.** The trace
  forms the blocked air there (`sampleAir`) and may not bind the maps; a
  shadow the scene's air takes and the blocked air does not is a band
  around every cloud. `w` counts medium under the base alone, so the
  identity holds by construction.
- **Inside the union the air takes a mean, if R-C2 lands it:** `φ(z) =
Π_j ((1 − c̄_j) + c̄_j·T̄_j)` over the levels above `z`, from the climate
  at the eye's foot, as uniforms. The scene's marches and `sampleAir`
  form it from the same uniforms, so the identity holds exactly. It
  draws no shaft; it darkens the air under an altostratus. Packages A
  and T build it only then.
- **From over the union a surface's one step under the base stands over
  the surface point,** so it takes the surface's own `B` and `m`: no
  read (§9). The price: the air's shadow is drawn on the ground's, half
  the base's height over `tan e` from its place (D: 0.42 km at 50°
  under a 1 km base).
- **`airShadowTaps` is a lever:** all of a march's steps under the base
  take the read, or 2, or 1 at the path's lowest, in every march alike.

**What it forbids.** A shadow in one march and not in another. A factor
on Ψ that is not one in clear air. A share by length in a medium that
thins with height.

**The oracle.** For row 13, each other: each pair of marches' in-scatter
at row 12's points. For the law, package O's column: the in-scattered
radiance along a level path under a deck and under bands, **and down one
steep path from above,** where `w` is not one.

**Held-out cases.** A path that leaves the shadow half way; a step
astride the base; a low sun; an eye above the union; an altostratus.

**The bar.** Row 13: each pair of airs within 1%. Proposed for the law:
the air's light under a deck of `τ` 10 and 30 within 25% of the column's,
at row 14's three suns, on both paths.

**Declared here, with its figure.**

- **The air inside the cloud levels and over them reads no shadow's
  shape.** Under a climate's three levels, 0.7 to 11.1 km
  (`weatherClimate.ts:296-301`), that is 65% of the gas column, with 8%
  under the base; under an altostratus the air from 0.7 to 3.4 km, 25%
  of the column, is lit by a sun that does not reach it (M: the physics
  critic, D), unless the mean above lands.
- **Shafts are blurred to the step,** from orbit to 6 km. G3 scores rays
  when present (rubric §3.7).

**E2's crop is judged by R-G, not declared** (ruling 004, 7). No march
here reads a top's shadow on the air above it, and a declaration does not
waive a seat's Shadow floor in the crop. From 400 km the limb's air is the
far atlas's columns, so R-G judges the atlas's term before A is briefed:
what it draws in the crop, what it costs at `orbit`, and whether the
trace's blocked air can form it too.

**Who proves it.** R-C2 judges `m`, `w` and the mean on package O's
column, before H. The identity is a GPU figure: package A's first commit
measures the composite's residual meter with the shadow on and off, and
stops if its 95th percentile moves by more than 0.5%. The blocked air
cannot move it; two quadratures of one shadowed stretch can. The bar is
re-read on Y2's merge, whose form does not exist yet.

---

## 5. The light's laws: L5 to L8

### 5.1 L5: the energy balance under a cloud layer

**The form.** Each part is named once, with **where it is read**, per
band, at a point `p` on a surface:

```
t(τ*, μ₀)   the flux block: a slab's total transmission of the sun, by transport depth τ* = (1 − g′)·τ′
d           = t − exp(−τ′/μ₀)           the diffuse part, of the same medium as the beam
r(τ*)       = 2·∫ (1 − t(τ*, μ))·μ dμ   the slab's reflectance for diffuse light

E₁  = μ₀·F(p)·B(x(p))                                      the beam: at the sun's crossing
    + μ₀·F(h_c)·D̄(p)                                       the cloud's diffuse light: under the cloud
    + E_sky(h_b)·(1 − c̄_v(p)) + E_sky(h_c)·(c̄_v(p) − R̄_v(p))  the sky made over the level met: what stands over the point
    + (E_sky(p) − E_sky(h_b))·B̄(p)                             the sky made under it: lit by the beam at the light map's scale
E↓  = E₁ + Ē₁·g,    Ē₁ = K∗K∗E₁,    g = Ā·R̿_up/(1 − Ā·R̿_up),    R̿_up = K∗K∗R_up
R_up = R̄_v + (1 − c̄_v)·R_air          the reflectance over the ground, before the kernel spreads it
beam    = μ₀·F(p)·B(x)                  keeps its direction: the photometric function, the glint
diffuse = E↓ − beam                     the fragment reflects A·skyView·diffuse/π with its own A
```

- **Only the beam belongs to the sun's ray.** A cloud's diffuse light
  leaves its base and falls around its own foot. The sky a point sees
  and the reflector its return meets stand over the point. At a sun of
  elevation `e` the two places are `(base + thickness/2)/tan e` apart:
  1.4 km at 50° and 6.5 km at 15° under a 1.5 km base (D).
- **One kernel spreads every part but the beam:** the irradiance a
  Lambert emitter at height `h` lays on the ground, `K(r) = h²/(π·(h² +
r²)²)`, half of it inside `r = h`. The light map's two levels either
  side of `log2(h/250 m) + 0.75` stand for it, their weights set against
  the kernel itself and not against an oracle: within 0.025 RMS and 0.15
  at worst of its convolution of a step and of a 1 km bar, and 0.03 and
  0.12 on the field's grids at 50° and 30°, with 15° recorded (0.035 to
  0.039). No blend of two bilinear levels holds 0.02; three levels, two
  fetches more, are held in reserve (R-C1).
- **`D̄` is stored where the light leaves the cloud:** each sun ray's
  `d(τ*_ray·μ₀, μ₀)` at the column of the ray's in-cloud centroid. The
  bake lays each ray's deposit at its own centroid's column, never at
  one level's middle height, and V measures both against the exact
  deposit: laid at the middle height, broken cumulus's dark third at
  30° reads +19.0% where the centroid reads +14.9% (the critic of
  R-C1). `R̄_v` and `c̄_v` are the vertical column's.
- **The return is fed by the reach, not by the point, one kernel
  wider.** `Ē₁` is `K∗K∗E₁`, the light spread twice by the kernel, and
  `g` takes the reflectance spread twice, `R̿_up` for `R_up`: a sunlit
  gap over snow is not brightened by a return its dark surroundings
  cannot send. Spread once, the lit-to-dark ratio reads +26.5% on broken
  cumulus at 30° over 0.8 (680 nm); spread twice, +12.8%, and every
  ratio over snow under 14% (R-C1). A light-map level one coarser stands
  for the second spread, two fetches and no byte. Gathered so under an
  air it costs 1.9 to 4.4 points on the dark third and 2.7 to 6.1 on the
  ratio, all inside (the critic of R-C1), and H measures the gather by
  band.
- **`Ā` is the surface's albedo at the scale of the return's reach,**
  where the light crosses a shore over 8 base heights: H reads a coarse
  level of the material's own albedo where it has one, and where it has
  none the fragment's own, declared at 56% at a snow line and 13% at a
  land and sea shore (R-C1). It holds at a snow line; dark ground 1 to
  4 km past one reads −4.7% to −6.3%, because the air's share of the
  return travels farther than the base's kernel, and is declared at 6%
  (the critic of R-C1). The number a frame at the eye's foot serves
  the air's `m` alone. The fragment's own
  `A` in the return draws a step at a shore that the light does not have: 23%
  for 2% between land at 0.30 and sea at 0.06, and 138% for 12% beside
  snow (M: the physics critic, `shore.mjs`).
- **`R_air` is the clear air's reflectance from below,** one number a
  band from the sky table's bake, whose sky block is baked over a black
  ground (§5.2). A table baked over 0.15 leaves a ground of 0.8 5.6% low
  at an air of depth 0.1, 31% at 1 and 55% at 4 (M: the same critic).
- **`F` and `E_sky` at `h_c` as well as at the point:** the light the cloud diffuses
  entered it at `h_c = base + ĥ·(top − base)`, and does not travel the
  slant below, an optical depth of 0.58 at an 11.5° sun (E).
- **The sky is split at `h_b`, the base of the level the sun meets**
  over the point, which the light map's fourth channel names. Under an
  air about half the datum's sky is made under the level, by the beam
  (53% at 50°, 48% at 30°: the critic of R-C1), and over shadowed ground
  that air is in the shadow, so the part made under `h_b` is lit by `B̄`
  and the part made over it keeps the cover's two terms. Under no cloud
  the line is `E_sky(p)` exactly. With a cirrus over cumulus `h_b` is
  the cirrus's base, 9 km; split at the cumulus's base instead, the
  cumulus under the cirrus reads −5.9% and −9.2% in the mean (R-C3).
- **The table is read by transport depth,** with the level's own `g′`:
  ice has its own (`weatherGenus.ts:72`, `slabIce.ts:142`). The
  droplets' table read by scaled depth for `g′` 0.50 is +16% at `τ′` 1
  and +70% at 15; by `τ*` it is within 2% at two depths (M: the physics
  critic, `misc.mjs`, D).
- **Past the map's last level** the three come from the atlas's columns
  (§4.2), whose texel is wider than the kernel.

**What the form measures to,** on the physics critic's Monte Carlo of
boxes over a Lambert ground (M: `l5k.mjs`, §12; the sky is that critic's
assumption, 0.4 of the beam's level flux):

| Case                                                                      | Every part at the sun's crossing (draft 1) | This form                                                |
| ------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| A deck's two edges, 15°, black ground, with the sky: points               | 14% RMS, 76% worst                         | 7% RMS, 39% worst; within 5% past 3 km from the lee edge |
| The same, sun alone: the shadow thrown past the lee edge                  | 4 to 35 times too bright                   | −55% to −4% past 2.5 km, of 0.007 to 0.022               |
| The same over snow at 0.8: the 60 km mean; points                         | −9.9%; 27% RMS, 95% worst                  | +0.4%; 9% RMS, 33% worst                                 |
| Bars 1 km wide, 0.7 thick, every 3 km, sun alone: points at 50°, 30°, 15° | 38%, 14%, 17% RMS                          | 20%, 20%, 25% RMS                                        |
| The bars with the sky: worst point at 50°, 30°, 15°                       | 12%, 26%, 26%                              | 12%, 14%, 18%                                            |
| The bars with the sky: the mean                                           | −3.6%, −7.4%, −19.1%                       | −0.4%, −2.1%, −8.0%                                      |

With that sky the form holds 20% at every point of the bars. Sun alone,
a thin air, it does not, and at 30° and 15° it is no better than draft
1 point by point.

**What it still misses, measured.**

- **A finite cloud's lit side** sends light to the ground toward the sun
  that no column holds. Sun alone at 30° on three grids of the field,
  the dark third reads −17% to −29% and the lit-to-dark ratio +21% to
  +42% (R-C1). The bar holds from a sky of 0.06 of the beam's level flux
  over an albedo of 0.15, and from 0.10 over 0.8 with the wider return:
  declared for a body whose sky is under those.
- **A deck's lee corner, and a cloud as thick as it is wide.** A deck of
  scaled depth 15 reads +28%, +20% and +10% (680, 550, 440 nm) 1.1 km
  in at 15° and +22%, +18% and +13% at 30°, inside 20% at every band
  from 1.7 km in; a cloud 4 km wide and 1.4 km thick reads +22% to +33%
  at 50° and +29% to +48% at 30°, 1.1 km in (R-C1). A ray that clips the
  corner is read as a thin slab.
- **A sun under 5°** leaves the ground under a cumulus field all shadow
  (M: the physics critic, `lowbake.ts`): S1, S2 and G3 rest on `D̄`.
- **Under an air, the form as it stands** (the critic of R-C1's Monte
  Carlo with Earth's air; R-C3). No form met every bar, and this one is
  the best measured (ruling 009). Kilometer cells' dark third reads
  −6.3% to +10.7% on the judged grids, with one cell of 20 at +12.3%
  (fair cumulus, 440 nm, 50°, inside a seed's 0.7); a cirrus of `τ` 0.5
  +1.0% and −0.2%; the square's mean within 2.1%, and −3.3% at worst at
  15°. R-C1's 35 cases of 36 inside the cells' bar hold under a sky made
  wholly over the cloud, which is not the body's.
- **A deck's thrown shadow.** A kilometer inside it at 30° it reads
  +19% to +36% at 550 nm, to +50% at 680 nm, +16% to +30% at 440 nm and
  +14% to +23% over snow; from 1.7 km in under the lee edge, within 9%
  (R-C3). The bright side of the sky made over the level stands behind
  the deck, and no form here carries it without breaking a field of
  cells. No cornerstone holds a deck's shadow edge; study S7 does.
- **Ground close under a base.** The dark third on ground 200 m under a
  base reads −10.6% at 30° and −0.4% at 50° (R-C3).

**The cloud's base and the ground share one balance.** Phase 1's sky table
lights a base from below as over sunlit ground at an albedo of 0.15
(`skyIrradiance.ts:59`): under a deck of τ 30 at μ₀ 0.7 the base draws
32% too bright (D: 0.376 against 0.284). So the table holds its ground
share as two blocks, and the trace scales it by `groundShareAt`: in the
near march the levels' mean total transmission from the climate **at the
eye's foot**, one number a frame on the CPU; in the far march the atlas
column it already holds. One number a body misses by 18% where the
world's mean transmission is 0.68 (M: the physics critic, D). **The
consistency bar, proposed:** under a deck inside a climate whose mean
cover is under a half, the trace's base radiance from straight below,
times π, is within 10% of the ground's `E↓` at an albedo of 0.15.

**What it forbids.** Any part but the beam read at the sun's crossing.
One number at the eye's foot for `Ā`, which is the surface's albedo at
the return's reach, and the fragment's own albedo in the return where
the material has a coarse level of its own. Any light added to shadowed
ground, a lit side's term or a corner's, while this sky stands (ruling
008). A two-stream closed
form. A
beam from one medium and a diffuse part from another. The table read by
scaled depth for a medium that is not the table's.

**The oracle.** Three, for three questions.

- Row 14: the Monte Carlo column (package O), plane-parallel over a
  uniform ground, so it **cannot see where a part is read**.
- The geometry: the float64 path tracer with a ground (`pathTrace.ts`,
  `TraceGround`) on grids of the field, **point by point** along the
  sun, and the critic's Monte Carlo on boxes.
- The table: delta-Eddington is +12.8% to +15.9% at `μ₀` 0.2 against the
  committed reference (M: `eddington.ts`) and +24% to +42% under 0.1 (M:
  the physics critic, `lowsun.ts`). Adding-doubling on the renderer's
  medium is within 3.0% of the true medium on the reference's 48 slabs
  (M) and within 2.8% down to `μ₀` 0.035 (M: `lowsun.ts`).

**Held-out cases.** A deck's edges; bars and boxes at 50°, 30° and 15°; a
shore under a deck, land and snow; a cirrus of `τ` 0.5; an anvil's ice;
a ground at 0.8 of the base's height; a gap of fair cumulus.

**The bar.** Row 14: within 10% of the column, at three suns, two
albedos, `τ` 10 and 30. For the geometry, three bars (ruling 004, 1),
judged under the body's own sky from the sky table, with the sun alone
beside it: a deck up to half a kilometer thick within 20% from 1.7 km in
under a lee edge and from a kilometer in from any other; a field of
kilometer cells at 50° and 30°, the darkest third of the shadowed ground
and the brightest third of the lit, each within 20%, and their ratio
within 25% of the tracer's; and the 12.8 km mean within 10% from 15°. A
cloud as thick as it is wide, and a deck's lee corner inside 1.7 km, are
declared at their figures, and no corner term is built: the one that
mends the boxes breaks the field. No lit side's term is built in phase
2: the bar holds from a sky of 0.06 of the beam over an albedo of 0.15,
and Earth's is 0.155 or more. The term is on file for a thin air.

**Who proves it.** R-C1 on the tracer, which waits for nothing; the
critic of R-C1 and R-C3 under an air, and the critic's re-check of R-C3;
R-C2 on package O's column (§7). Then V bakes the light map and H builds.

### 5.2 L6: the skylight from the sky table

**The form.** The sky table gains a block: `ln(E_above/π)`, the downward
irradiance on a horizontal face over π, by height and the sun's cosine,
**baked over a black ground** (the ground's return is §5.1's `R_air`),
from the quadrature's own sum (`marchSkyFaces(...).above`,
`skyIrradiance.ts:755`). A fragment reads it at its own height and its own
sun:

```
E_sky(p) = π·exp(block₃(μ₀(p), h(p)))·(1 − lift)
```

- It replaces `skyColor·diffuse·skylightLeft` and `skyOverhead` in the
  ground and the sea and gives the sphere the same term (rule 59). The
  fraction taken out of the beam goes with it: the beam already arrives
  through the table's extinction.
- **`lift` is `clearedFromOrbit`** (`air.ts:938`): the sky's irradiance on
  top of a cleared beam is counted twice, so the sky falls with the lift.
- **The rows' mapping is R-E2's,** one for every block: to be set by
  R-E2. The read is clamped to the row under the top, where `E_above` is
  zero, and `darkSkyTable` floors an airless body's block, which would
  otherwise read π of skylight. The bake is off the main thread: on it,
  it takes 189 to 240 ms.
- It closes both of the air's defects (`design/plans/the-air.md:184-190,
:305-310`): the linear ramp, and one zenith under the eye for ground past
  the terminator.

**What it forbids.** A side's irradiance formed as `π·L̄·(1 ± Δ/2)`: that
form errs 9% to 37% on the datum (`skyIrradiance.ts:748-752`).

**The oracle.** Two, for two questions. The fragment's read against the
CPU's read of the same table (a new `skyDownAt`, twin of `skyMomentsAt`):
that is row 15. The table against `marchSkyFaces` at 2,016 directions:
that is the table's own error. Both are the table against itself:
neither sees the ground's albedo or the air's return, which `R_air`
carries and R-E scores on Titan's four optical depths.

**Held-out cases.** A sun 2° to 6° under the horizon; a point at 6 km on
a peak; Titan's air; a body with no air (the term is zero).

**The bar.** Row 15: within 1% at eight points, two past the terminator.
Proposed for the table: within 3% of the fine quadrature for suns over
5.7°.

**What the oracle cannot see.** Every sky scene moves, on purpose (§10).
The day was tuned on the ramp, so a seat can call the new plate worse.

**Who proves it.** R-E (§7), before H, so the size of every guard's move
is known before a plate is taken.

### 5.3 L7: one shadow on three materials

**The form.** The ground, the sea and the sphere call one function, the
handle's `sunlight(offset, footprint)`, built in
`render/cloudSunlightNodes.ts` inside the cloud chunk, with:

- `offset`, the point less the eye, body-fixed meters, as each material
  already forms it: `local − eyeLocal` on the ground and the sea,
  `(pointUnits − eyeUnits)·R` on the sphere;
- `footprint`, the point's distance times the lens's pixel angle.

The function owns the crossing of the base shell, the pick, the blend and
the fade. A material owns nothing of them.

**What it forbids.** A material that displaces its own point or picks its
own level. The deck's `cloudShade` (`planet.ts:466`) on a served body.

**The oracle.** Each other (row 12), and the CPU twin of the map's read.
Three materials can lay a shadow at the wrong place together, so the
crossing has its own test: an analytic box at a known height, its
shadow's edge within a texel of `h/tan e` (§8, G).

**Held-out cases.** A point of the sea under its datum; a point in a
fade band; the descent gate itself; a shadow's edge at the finest level,
where one float32 step of the sphere's position, 0.38 m on Earth (D), is
0.006 of a texel.

**The bar.** Row 12: within 0.01 absolute between any two, at points lit,
in the edge and shadowed.

**What the oracle cannot see.** A seam at the gate: G6's descent.

**Who proves it.** No reckoning. Package G's GPU file (§8).

### 5.4 L8: what the sea reflects

**The form.** The sky probe: a 64 × 32 RGBA16F map over the upper
hemisphere about the eye's foot, by bearing from the sun and by height
over the horizon (crowded toward it), holding the cloud field's light and
transmittance along each direction, `(L_c, T_c)`.

```
probe(ω)   = the levels' crossings along ω, each a statistical step:  statisticalSlab, the crossing's law
reflected  = T_c(ω_r)·skyLight + L_c(ω_r),      ω_r the view mirrored in the wave's normal
glint′     = glint · B(x)
```

- **It is the statistics' march,** the far march's own function
  (`CloudFarField.far`) from the eye's foot, a sixteenth of the map a
  frame. The sun's glint takes the sun map.
- **Its weight falls with the eye's height** to nothing over the union's
  top. Held-out: a deck's edge 5 km sunward; a sun under the horizon.

**Declared here, with its figures.**

- **The resolved near probe is not built** (§2). Over broken cloud the sea
  reflects the field's mean, and no cloud's own shape.
- **The sea's far reflection from orbit is not built.** At E1's nadir the
  sea's Fresnel term is 0.02 (`water.ts`, the glint's `0.02 + 0.98·(1 −
facing)⁵`), so a reflected cloud is 2% of the cloud beside it.
- **The sea's two skies.** The reflected term keeps the authored
  `skyLight` while L6 lights the ground from the table. The cure, the
  probe carrying the air's own radiance behind the cloud's, is held in
  reserve.

**The oracle.** On a deck, the trace's own light along the same direction
from the same eye: one radiance (plan §6.5). In Node, `statisticalSlab`'s
twin against the slab oracle's radiance.

**The bar.** Proposed: on `overcast`, the probe within 10% of the trace
at eight directions.

**What the oracle cannot see.** The horizon line between the sea and the
sky on G2; a broken field in still water, S4. No reckoning: package R's
GPU test against the trace.

---

## 6. A cloud on a cloud: L9 and L10

### 6.1 L9: another cloud's shadow on a cloud

**What is declared.** Under §5.5 a deck's top in a detached block's shadow
reads +150% to +174% in the sun's higher orders, and +34% to +70% under a
thin broken sheet (M: `REGISTER.md`; `reviews/p1-depth-critic.md` §5). A
plain transmittance reads −60% to −100%.

**What is settled.** The sun's depth is in two parts, split at the first
clear stretch along the sun's ray. First order keeps the plain
transmittance of the whole depth. A sample with no far part is untouched,
so the slab gate, row 6 and every isolated cloud read as they do today.

```
τ′_own   from the sample to the first clear stretch       the slab the source is read in
τ′_far   everything past it
S        = source(slab from τ′_own) · M,      M = T_far + (the far part's diffuse share)
```

**What is closed: no form for the far part's diffuse share lands, and
package T builds the ground's share alone (§5.1).** Draft 1's, a slab lying on the sample,
`M = t(μ₀·τ′_far, μ₀)`, rests on the premise §5.1 gives up. On the
physics critic's Monte Carlo (M: `bar.mjs`; a deck top's light from
above in a bar's shadow, of the lit deck's):

| Shape, sun                                            | Monte Carlo    | Draft 1's `M` | Error          |
| ----------------------------------------------------- | -------------- | ------------- | -------------- |
| A bar 1 km wide, 0.5 thick, 0.5 km over the deck, 45° | 0.26 to 0.37   | 0.33 to 0.39  | −11% to +53%   |
| The same bar 3 km over the deck, 45°                  | 0.12 to 0.15   | 0.33 to 0.39  | +124% to +190% |
| Taller than wide, 45°                                 | 0.17 to 0.19   | 0.33          | +75% to +114%  |
| The first bar, 15°                                    | 0.043 to 0.124 | 0.26 to 0.40  | +142% to +661% |
| A sheet of slant depth 0.71, 45°                      | 0.87 to 0.97   | 0.90          | −7% to +8%     |

The declared +150% stands in three thick shapes of four, and E2's sun is
grazing. Two things are in those figures, and R-D takes them apart:

- **The light that reaches the sample:** the far cloud's diffuse light
  by its view factor, which thins with separation, and the sky's. The
  irradiance on the deck in the far bar's shadow is 0.065 to 0.079 of
  the lit deck's (M, the same runs).
- **What the sample's own cloud carries sideways.** The radiance from
  above is 1.4 to 1.9 times that irradiance: a shadow narrower than the
  deck is deep is filled from beside it. A slab's source cannot hold it;
  phase 3's design takes the own cloud's sideways kernel, centered one
  transport free path toward the sun (69 rays of 77 inside ±35% with
  it, 49 without; R-D).

**The candidates R-D judges,** on radiance and on irradiance apart:

|     | The far part's diffuse share                                                                                                                                                                  | Known                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | The slab on the sample: `t(μ₀·τ*_far, μ₀) − T_far`                                                                                                                                            | Draft 1's: inside −11% to +53% at half a width of separation, a floor past it                                                                                                                     |
| b   | The far level's cover about the sample: `c̄_f·d(τ̄*_far, μ₀)`, with `c̄_f` the cover over the sample's own column in a footprint of the separation, from the cover clipmap's level of that texel | The physics critic's. On the radiance of the four thick shapes it reads −60% to −100% in the core (M: my script over that critic's `.out` files): it holds the first thing and none of the second |
| c   | No share: the row stays declared by separation and sun, at R-D's figures                                                                                                                      | The fallback                                                                                                                                                                                      |

A form lands only inside ±35% by separation and by sun, with no weight
fitted on these shapes. None lands: on R-D's two held-out sets, today's
rule falls outside ±35% on 47 rays of 47 and 39 of 39, and the best form
on 11 and 5. T builds the ground's share (§5.1), and the register's row
keeps its figures by separation and sun (`reports/p2-r-d.md`).

**What any form reads.**

- **`t` is the flux block,** one fetch of the sky table where a far part
  exists, by transport depth with the far level's `g′`. The trace binds
  that table once M2 reads it. No closed form: Eddington's is +13% to
  +16% at `μ₀` 0.2 and +24% to +42% under 0.1 (M, §5.1).
- **In the grid** the split takes no new channel, at a price. G, the
  depth for the light after first order, becomes the own depth; the far
  depth is the whole (R) less the own, floored at zero. **But R answers
  the depth of a mean transmittance:** through the march's taps it is
  0.17 to 0.38 under in the mean and 1.7 to 3.0 RMS, and 1.8 to 2.8
  under at a sample the early out skipped (M: `REGISTER.md`, "the sun's
  depth as the light after first order reads it"). On broken cloud,
  a level of 400 m cells or ragged tops, `R − G` keeps 28% to 57% of a
  sheet of 0.3 and reads it as none at up to 65% of samples; a sheet of
  3 keeps 86% to 95% (R-D). That costs nothing while no far share is
  built, since today's rule is right under a sheet, and the grid as
  RGBA16F (+2,097,152 B at 32 heights) is closed for phase 2.

**What it forbids.** A weight chosen on the scenes. Any change to a
sample with no far part. A far cloud's diffuse light delivered whole to
the strip its shadow reaches.

**The oracle.** R2's float64 tracer on the scaled medium (`createTracer`,
`estimator: 'cone'`): independent of any closure, on the right medium.

**Held-out cases.** The two declared scenes and the critic's five shapes
are reproduced first and shape nothing. Then: separations of a half, one
and three widths at 45° and 15°; cumulus tops under the field's cirrus
at 30° and 15°; a congestus's shadow on a neighbor under a 10° sun; a
sheet of scaled depth 0.3, where nothing may darken by more than 5%.

**The bar,** for a form that returns to this law: every ray whose
shadow takes over a third of its light within ±35%, at each separation
and sun; no lit ray more than 15% off the tracer; a thin sheet within
5% of the tracer; the slab gate with the lever on equal to off
within 10⁻³.

**Who proves it.** R-D, before package T. It also says how long a clear
stretch must be to split the depth.

### 6.2 L10: a lit wall, a rim, a top from above

**Phase 2's sun term moves none of them** (D).
Each is the slab's floor on one finite cloud (`REGISTER.md`: a lit wall
−86% to −38%, a top −46% to +37%, a thin rim +66% with the factor). L9
acts only past a clear stretch, and an isolated cloud has none.

**A base from below does move:** L5 couples the sky's ground share to the
light under the layer at the eye's foot, and a base under a deck falls by
about a quarter (D: 0.284 against 0.376).

**Two stores, one cloud.** A cloud's first order reads the grid (400 m,
0.18 to 0.26 RMS on broken cloud) and its shadow reads the map at 62.5 m:
a cloud drawn lit can cast a full shadow. Declared; S1 watches.

---

## 7. The reckonings, before any package

Each but R-F is read-only, on the CPU, in Node, with an oracle for every
claim, and says what its brief ruled out. A physics critic then attacks
the Fable ones on held-out cases chosen before reading them.

| #                             | Law                      | Model, budget                                                     | It must say                                                                                                                                                                                                                                                                                                                                                                                              | Holds up                     |
| ----------------------------- | ------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| R-A                           | L1                       | Opus, 45 min                                                      | The oracle's own error at 40, 80 and 160 steps. The bake's CPU twin against it at the held-out cases, by level, on three levels and at 5°. The turned read against a fresh march, with a drift                                                                                                                                                                                                           | S                            |
| R-B                           | L2                       | Opus, the same thread, 40 min, after L's fourth pass (ruling 002) | A statistical level and the atlas's column against the footprint's resolved mean at suns of 5° to 60°                                                                                                                                                                                                                                                                                                    | S, G's far read              |
| R-D                           | L9                       | Fable, 75 min                                                     | §6.1's seven scenes reproduced. Candidates a and b on radiance and on irradiance, by separation and by sun. The clear stretch that splits a depth. What the grid's shallow depth loses                                                                                                                                                                                                                   | T's far share                |
| R-C1                          | L5's geometry            | Fable, 75 min; waits for nothing                                  | §5.1's table reproduced, then retaken on the tracer with a ground on three grids of the field, point by point, at 50°, 30° and 15°. The lit side's term. The deck's corner. The gather against the exact deposit. The reach of `Ā` and `Ē₁`                                                                                                                                                              | V, H                         |
| R-C2                          | L5's air, L4             | The same thread, 60 min, after O's column                         | The two heights against one. `m` on a level path under a deck and under bands. `w` on a steep path from above. The mean inside the union: what it buys and costs. The flux block's axes. `R_air`                                                                                                                                                                                                         | O's blocks, H, A             |
| R-E                           | L6                       | Opus, 30 min                                                      | The block over a black ground against the fine quadrature on three airs. `beam + sky` at noon against today's ground light, by body. The sky table's bake time                                                                                                                                                                                                                                           | H                            |
| R-G                           | E2's crop (§4.4)         | Fable, 60 min, after R-B                                          | `cloudSunlight`'s far branch at air points 2 to 15 km up, over and past cloud tops, under suns of −2° to 5°, against a float64 march of the field's footprint mean. What it draws along sixteen of the crop's view rays through the tree's air, and the contrast's width in pixels. Its fetches at `orbit` against the packages' 0.50 ms, and whether the trace's blocked air can form it from the atlas | A's brief                    |
| R-F                           | §9                       | In K, two minutes of the GPU lock                                 | One, four and twelve stand-in reads a fragment in the four real materials, at both sizes, against the no-handle graph. A read behind a zero weight. A level's bake at 62.5 m and 500 m, as quads and as one compute pass                                                                                                                                                                                 | Every ceiling of §8          |
| R-E2                          | L6's rows                | Opus `high`, R-E's thread, 30 min                                 | The three blocks the trace reads today, at the heights clouds stand at, against the fine quadrature: a miss over 5% is phase 1's. A row mapping that holds every block, by the square root of the height's share and by the air's optical depth above. The top row's clamp and the error it leaves                                                                                                       | K, H                         |
| The critic of R-C1            | L5's geometry            | Fable `xhigh`, a fresh thread, 75 min                             | The air under the base and over it, in a Monte Carlo of its own, at 50° and 30° over albedos of 0.15 and 0.8. What R-C1 did not run: ice by its own transport depth, a cirrus of `τ` 0.5, ground at 0.8 of the base's height, two levels at once, the wider return through a coarser level, a snow line under broken cloud. The form through the sun map's own error                                     | V, H                         |
| R-C3                          | L5's sky                 | Fable `xhigh`, R-C1's thread, 75 min                              | The sky split at the base of the level the sun meets, on the critic of R-C1's Monte Carlo unchanged: forms a and b fixed, a third its own; kilometer cells' dark third within 12%. Reported: no form inside every bar; a the best measured, its misses declared (§5.1)                                                                                                                                   | H's form, V's fourth channel |
| The critic's re-check of R-C3 | L5's sky                 | Fable, the critic's thread, 30 min, when R-G frees the seat       | Form a on two cases of its own choosing, on its Monte Carlo unchanged: whether a holds R-C1's bars there, and by how much                                                                                                                                                                                                                                                                                | H                            |
| R-S                           | The sky a cloud scatters | Fable, after R-C3 and R-G; its brief when a seat nears            | The sky by direction: the horizon's band, the aureole as light from the sun's side, and the view term's sense on a core; judged on M2's slabs and masks and on a thin cirrus                                                                                                                                                                                                                             | M2's declared sky term       |

**Order.** R-A, R-D and R-C1 first; R-E beside them; R-B on L's fourth
pass; the critic of R-C1, then R-C3 on R-C1's thread; R-G after R-B, on
the Fable seat; the critic's re-check of R-C3 when R-G frees that seat;
R-S after R-C3 and R-G; R-C2 on the column.

**A unit taken in one pass form is not the unit in another:** one
fragment cost 0.50 ms in pass B and 0.10 in the chain form (M:
`reports/p1-read.md` §6). R-F runs where the reads will.

---

## 8. The packages

Every package is briefed under the four common briefs. Its base is
`weather/phase-2`, cut from phase 1's landed tip after window 3. Models
follow the charter's §4.

**Rules for every package of this phase.**

- A budget is a number. Stop and report before exceeding one.
- **A material's cost is read on K's rows:** the real ground, sea, sphere
  and shell over the rig's field, the handle's graph less the no-handle
  graph, both compiled, three takes. A trace's cost is read on the
  march's instrument, which K owns for the phase.
- **A stop is the larger of the entry's ceiling and ruling 002's line,**
  2% and two ticks over the base row's highest take: the takes spread
  0.05 to 0.07 ms (M: ruling 002).
- A declared miss is a plain ceiling test at its figure on every adapter;
  §8's last paragraph says whose. No test sits on a tie. No GPU bound is one
  8-bit step.
- A root-suite test takes under 2 s here; a slow one under 10 s, with one
  hosted run. A changed export of `packages/*` takes the docs stage.
  Each GPU package reports its pipelines and the warm-up's span.
- `presets:compare --all` reports 0 moved, except in the two merges §10
  names. A dry body's material is the base's WGSL, by its hash, until H
  moves the base's skylight on purpose.

### K: the contracts, the census, the instrument

- **Owns:** `render/cloudLight.ts` (the handle), `render/skyBlocks.ts`,
  stubs of `cloudSunMap.ts`, `cloudLightMap.ts`, `cloudSunlightNodes.ts`,
  `cloudLightCost.gpu.test.ts` (the four rows and R-F), the `groundShare`
  uniform and its setter, which calls `groundShareAt` (a stub: one).
  **Granted:** `cloudNodes.ts` (stand-ins `sunMap`, `lightMap`),
  `cloudContracts.test.ts`, `cloudLevers.ts`, `cloudUniforms.ts`,
  `cloudSystemRig.ts`, `GameEngine.ts`, `cloudTraceCost.gpu.test.ts`,
  `skyIrradiance.ts` (seven blocks, the new four dark).
- **First, a census:** the device's bytes at phase 1's landed tip; the
  compiled sampled bindings of the four materials and the composite; the
  warm-up's pipelines and span. A material that would pass 16 with its
  gains (four; the sea five) stops K, which may propose the probe as
  rows of the sky table, or the atlas's read on the sphere alone. **Then
  R-F** (§7).
- **The sky table widens from 102 to 238 columns:** an existing read
  keeps its texel and moves its coordinate, so K compares the
  instruments' documents and says where a value moved by rounding.
  **The rows take R-E2's mapping,** one for every block; the new
  block's read is clamped to the row under the top; `darkSkyTable`
  floors the new block for an airless body; and a test holds that no
  path bakes the table inline, `openSession({ workers: null })` and any
  fallback with no pool among them.
- Opus `high`, on the GPU. No byte but the table's 17,408.
- **Done:** the gate, the docs stage; `cloudContracts cloudSystem
cloudWarm cloudLightCost`; six named stances byte-equal, flag on and
  off.

### S: the sun map

- **Owns:** `render/cloudSunMap.ts`, its GPU test, the CPU twin in
  `packages/rendering` (frames, casting level, schedule, pick, read).
  **Granted:** `cloudSystem.ts`, `cloudLight.ts`.
- **Reads:** §3, §4.1, §4.2. `CloudField.medium`; `levelFrames`,
  `levelPlane`, `shellCrossingFrom`; `layers.turn`; `sunGridStep`'s
  pacing; `crossingTransmittance`.
- Fable `xhigh`, on the GPU. After R-A and R-B.
- **Budget:** 1,835,008 B. At most 8 sampled textures and three bake
  pipelines (four rays, sixteen, one). **Its steady cost is held by the
  schedule's count of texel-rays a frame,** asserted on every adapter
  and set from R-F's figure to 0.05 ms under one level and 0.20 under
  three; an event's frames at most 0.6 ms over. A level past its pace is
  not read (§4.1), tested at warps of 1, 100 and 1,000.
- **Tests on two adapters:** 4,096 seeded texels against the CPU twin,
  scored as the field is (`cloudDensity.gpu.test.ts:522-540`): a median
  and a 99th percentile, the edge texels (0.02 < B < 0.98) apart, bounds
  twice the measured. A bound of one 8-bit step fails by construction:
  6.3% to 11.9% of texels pass it under the field's own error (M: the
  engineering critic, probe 2). An analytic box at 35° and 10°, its edge
  on the base shell within a texel. A 12 km mean within 0.01, and the
  map's mean within 0.004 over the texels whose oracle is under 0.1. A
  statistical level's mean at 30,000 rays or more where the beam is
  under 0.1, against §4.2's bar. The handover to the atlas measured on
  the GPU at S6 before its fade is fixed. Under
  one level with no drift, a ground point's read a second later equals
  the turned field's.
- **Done:** the gate, the docs stage; `cloudSunMap cloudSystem cloudWarm`.

### G: the beam on three materials

- **Owns:** `render/terrain.ts`, `render/water.ts`,
  `createPlanetMaterial`, `render/cloudSunlightNodes.ts` (in the cloud
  chunk: the handle's `sunlight`), `cloudShadow.gpu.test.ts`.
  **Granted:** the scene components that pass the handle.
- **Reads:** §3, §4.1, §4.2, §5.3. K's stand-ins; the levels' uniforms
  (`cloudUniforms.ts`); the atlas's column read (`CloudFarField`).
- Fable `xhigh`, on the GPU: the phase's most-read function. **Beside S
  on the stand-ins; it merges after S.**
- **Budget:** two bindings a material. Two fetches a fragment, four in a
  fade band, three more past the map. §9's ceilings.
- **Tests:** row 12 on the three real materials, watched failing with one
  displacement put back. **The crossing:** after S merges, the analytic
  box through S's map, its shadow's edge on the ground within a texel of
  `h/tan e` at 35° and 10°, watched failing with the crossing at a
  nominal height. The read a stated margin each side of the last fade
  and of a pick's whole number. The no-handle hash.
- **Done:** the gate; `materials terrain water planet cloudShadow`;
  `presets:compare --all` 0 moved.

### A: the shadowed air

- **Owns:** `render/air.ts`, `render/cloudCompositeAir.ts`,
  `cloudLight.gpu.test.ts`, the handle's `airShadow`. **Granted:**
  `cloudComposite.ts` (the wiring), one line at each call of
  `airToward`, the shell's call of `marchAir` (`materials.ts:368`).
- **Reads:** §3, §4.4. Y2's composite air, in whichever form lands. It
  carries `m` as a node that is one until H fills it.
- Fable `xhigh`, on the GPU. After G merges.
- **Budget:** no binding beyond G's. §9's ceilings, the composite's reads
  among them. The residual meter's 95th percentile moves at most 0.5%.
- **Tests:** row 13 on all three pairs, at one tap and at every tap; a
  march with no shadow is the base's WGSL; a step's two shares against
  the CPU twin, a step astride the base among them; the factor exactly
  one inside the union.
- **Done:** the gate; `cloudLight cloudCompositeAir cloudComposite
cloudCompositeError materials`.

### T: the trace's share

- **Owns:** `groundShareAt` (`packages/rendering/src/cloudOverlap.ts`).
  **Granted:** `render/cloudSky.ts` (two more block fetches at each read
  of the sky, which is three today), the far march's use of its own
  column. **If R-C2 lands the mean:** `sampleAir`'s one multiply.
- **Builds the ground's share alone:** no far part's diffuse share
  lands (§6.1), so nothing of the source, the grid or the sun's depth
  is T's.
- **Reads:** §5.1's base, §6.1, §4.4. M2's slabs.
- Opus `high`, the only package in the trace's kernel, on its own seat.
  After K and O's blocks, and after M2, X and L's fourth pass merge.
- **Budget:** no byte, no binding; the two block fetches at each read of
  the sky. The stop is ruling 002's line on every row.
- **Tests:** §5.1's consistency bar.
- **Done:** the gate, the docs stage; `cloudSlab cloudTrace cloudSunDepth
cloudSunAccuracy cloudFar cloudSky`; the instrument before and after.

### O: the column, the flux block, the sky's blocks

- **Owns:** `apps/ingest/src/transport/column.ts`, `slabFlux.generated.ts`,
  `slabFluxRead.ts`, `columnReference.generated.ts`, the new blocks'
  bake in `skyIrradiance.ts`, `R_air`.
- Opus `high`, no GPU, with CPU windows. **Two parts.** The column from
  wave 0: the slab's generator with the air in layers over and under it
  and a Lambert ground, giving the ground's irradiance and the air's
  in-scatter along a level path and a steep one. After R-C2: the flux
  block by transport depth and the sky's blocks over a black ground.
- **Budget:** generated files at most 64 kB; rows generated in a window
  and committed; a test retakes one of at most 10 s.
- **Tests:** no air and a black ground equal the slab's rows; flux
  conserved to 10⁻⁶; `t` and `r` within 1% between nodes; ice within 3%.
- **Done:** the gate, the docs and slow stages, one hosted run.

### V: the light map

- **Owns:** `render/cloudLightMap.ts`, its test and CPU twin.
  **Granted:** `cloudSystem.ts`, `cloudLight.ts`. **Reads:** §3, §5.1.
- Fable `xhigh`, on the GPU. After R-C3, phase 1's landing, K's census,
  S's merge and O's block.
- **Budget:** 458,752 B; one bake pipeline; a schedule's count, as S's.
- **Tests:** the two levels' weights against the kernel's convolution of
  a step and of a 1 km bar, within 0.025 RMS and 0.15 at worst; the CPU twin on §5.1's cases inside
  that table's figures; each ray's deposit at its own in-cloud centroid,
  and the deposit at the level's middle height, both against the exact
  deposit.
- **Done:** the gate, the docs stage; `cloudLightMap cloudSystem`.

### H: the light on the surfaces

- **Owns:** the three materials again, the handle's light, `m` in
  `air.ts`, `render/twilight.ts`, `Ā`, `cloudUnderDeck.gpu.test.ts`
  (row 14), `skylight.gpu.test.ts` (row 15). **Reads:** §5.1, §5.2, §4.4.
- Fable `xhigh`, on the GPU. After A, V and O merge, R-C2, R-E2 and
  the critic's re-check of R-C3.
- **Budget:** two bindings a material; six fetches a fragment; §9's
  ceilings. It moves every scene with a sky, on purpose (§10).
- **Builds §5.1's sky as form a,** split at the base of the level the
  light map's fourth channel names, and adds no light to shadowed
  ground: no lit side's term, no corner's. **Declares** `Ā` at 6% on
  dark ground 1 to 4 km past a snow line, and §5.1's misses under an air
  at their figures.
- **Tests:** the wider return's gather against the exact kernels, by
  band.
- **Done:** the gate; rows 14 and 15; a shore under a deck with no step
  over 5%; L4's 25% as a ceiling; `presets:compare --all` with the moved
  set equal to the set named before the merge.

### R, F, I, D, N2

- **R, the reflection.** Owns `render/cloudSkyProbe.ts` and its test;
  granted the reflected term in `water.ts`, `cloudSystem.ts`,
  `cloudLight.ts`. Opus `high`, on the GPU, after H. 16,384 B, one
  binding, one fetch. Done: the gate; `cloudSkyProbe water`.
- **F, the sun at the eye.** Owns `packages/rendering/src/sunAtEye.ts`,
  its call in N's worker, two numbers on the handle; granted one
  multiply each in the flare and the hull. Opus `high`, after N. No
  main-thread task over a frame; `weatherField.ts` stays out of `App`.
- **I, the instruments and studies.** Owns `shadowOffset.mjs` (E1's
  offset against `h·tan z`), `whiteShare.mjs` (the share of cloud pixels
  at display white beside the references', rubric §3.9),
  `weatherStudies.json`. Opus `high`, no GPU, from wave 0.
- **D, the default.** §10 is its entry. Opus `high`, after R.
- **N2, integration.** The runs of record, the cost table, the register,
  the ADRs, the plates. Opus `high`, last.

**The order.**

| Wave | GPU packages, two seats                             | Beside them                        |
| ---- | --------------------------------------------------- | ---------------------------------- |
| 0    | K                                                   | O's column, I, R-A, R-D, R-C1, R-E |
| 1    | S; G on the stand-ins                               | R-B, R-C2                          |
| 2    | A; T or V, whichever has its reckoning and its base | O's blocks                         |
|      | **Look: E1 and E2 forced, G1, the studies**         |                                    |
| 3    | The other of T and V; H, then R, then D             | F, N2's documents                  |
|      | **Look: G2, G3, G4, the guards**                    |                                    |
| 4    | N2                                                  |                                    |

The path is K, S with G, A, H, R, D. S, V and R each hold
`cloudSystem.ts`, never at once. T alone edits the trace.

**Whose ceiling test holds each declared miss.** S and G: the grazing
law, E1's frame edge, the bake's steps past their cap, a surface inside
a level. A: the air inside and over the levels, shafts to a step, the
air's shadow on the ground's from orbit. V: the lit side, a deck's
corner, the mean at 15°. R: a broken field's reflection, no reflected
cloud from orbit, the sea's two skies. T: another cloud's shadow by
separation, a thin far part in the grid.

---

## 9. The cost, where it hurts

`cloudSunlight` runs at every fragment of a served body's ground, sea and
sphere and at the air's steps, at the drawing buffer's size. **No cost of
phase 2's is measured.** Every figure below is E, from the read
reckoning's kernel; R-F (§7) measures the unit in the real materials
before G, A, V, H and S are briefed.

**The unit.** One read of a plane, a pick and a fetch at each of 129,600
pixels is the sample's arithmetic, 2.0 µs, the layer and frame, 3.1, and
the clipmap's pick and fetch, 5.1: 10.2 µs, 9.3 with the pick written
once (M: `reports/p1-read.md:146-165`, a compute kernel, as the
engineering critic reads it). Take `u` = 9.5 µs. A 1080p buffer is 16
of those pixel counts and the campaign's Retina 40 (D). What a fragment
costs under the scene's multisampling and overdraw is R-F's.

**How many reads.**

- A surface fragment: one beam read (G), and H's six fetches, taken as
  one more `u`.
- A surface's air: 4 steps. From the ground all four can hold medium
  under the base. **From over the union one does, and it takes the
  surface's own reads** (§4.4): none.
- A sky fragment's air: 12 steps, two with medium under a 1 km base at 4°
  to 30° up (D). `m` is one light read a sky fragment.
- The composite's air: 8 samples a surface pixel and 12 a sky pixel
  (`cloudCompositeAir.ts:222-260`). With Y2's form it runs at the
  history's rate: +0.04 ms on `ground` at one tap, +0.13 at every tap.
  With the early out alone, at the buffer's: +0.14 to +0.53 (M: the
  engineering critic's arithmetic).

**The forecast,** ms, each cell 1080p then Retina, Y2's form landed. The
ground stances take half the frame as ground (E).

|                                        | `ground`      | `horizon`     | `inside`      | `orbit`        |
| -------------------------------------- | ------------- | ------------- | ------------- | -------------- |
| G, the beam                            | 0.08, 0.19    | 0.08, 0.19    | 0.08, 0.19    | 0.15, 0.38     |
| A, one tap, with the composite's       | 0.19, 0.40    | 0.19, 0.40    | 0.19, 0.40    | 0.02, 0.05     |
| H, the light and `m`                   | 0.15, 0.38    | 0.15, 0.38    | 0.15, 0.38    | 0.15, 0.38     |
| S and V, the bakes, one level to three | 0.01 to 0.15  | the same      | the same      | 0.01 at most   |
| R, the probe                           | 0.05, 0.12    | 0.05, 0.12    | none          | none           |
| **Sum, one tap, one level, T apart**   | **0.48, 1.1** | **0.48, 1.1** | **0.43, 1.0** | **0.33, 0.82** |

**The ceilings sum to the room.** Each is a whole-frame difference on K's
rows at 1080p. On `orbit`: G 0.20, A 0.05, H 0.20, and S, V and T 0.05
together: **0.50**. On `ground`: G 0.10, A 0.25 at the default taps, H
0.20, R 0.05: **0.60**, with S, V and T on their schedules' counts and
ruling 002's line.

**Against the bars** (D, on `REGISTER.md`'s forecasts after phase 1's
plan).

| Bar                              | Phase 1's forecast         | With phase 2                          | Bar                                    |
| -------------------------------- | -------------------------- | ------------------------------------- | -------------------------------------- |
| B4, `orbit`, Y2's form           | 0.95 to 1.1                | **1.28 to 1.43**, 1.6 at the ceilings | 1.6                                    |
| B4, `orbit`, the early out alone | 1.7 to 1.85                | 2.0 to 2.2                            | 1.6: missed before phase 2 adds a read |
| B1, `ground`                     | 6.6 to 8.0                 | 7.1 to 8.5 at one tap, 8.9 at every   | 5.0, provisional                       |
| B6, `ground`, the whole frame    | 12.5 to 13.9 at the median | 13.0 to 14.4 at the median            | 14.7 at the 95th percentile            |

B4 is a gate. It holds because a surface's air from over the union takes
no read of its own; with one the forecast is 1.41 to 1.56. B6's figures
are medians against a bar on the 95th percentile.

**A dry world pays nothing:** its materials take no handle (§3). K's
instrument holds a read behind a zero weight to ruling 002's line.

**The bake.** A level is 262,144 texels. At 50° through one cloud level
its steps are 16: four rays are 16.8 million reads, 2.65 ms at the
trace's coherent 20.5 µs a pixel count (D), sixteen are 10.6 ms, and
either is two to four times that where reads stand over a sixteenth of a
cell apart (M: the same report). The four resolved levels are about
52 ms in all (E), 2.5 times that at 15° and three times under three
levels. **Steady, the turned map pays for the sun's shear and the
drift under one level:** 0.01 ms a frame at 50° and 0.05 at 15° (E: **on
Earth's day at a warp of one**; the cornerstones' world's day is not
read). Under three levels the others' motion against the casting one
sets the pace: 0.15 at 50° (E). At a warp of 100 a level at 15° is due
every six frames, 1.2 ms a frame, so S's rule drops it: the map
coarsens under warp and never lags. **After a field event** the first
bake, at four rays, is 17 ms at 50° under one level (E): 28 frames at
S's cap; at 15°, or under three levels, 70 to 200, and a capture's
settle waits that long.

**Levers, in order.** `airShadowTaps` at one. The pick written once, as
statements. H's light at a vertex where the mesh is finer than the
light map's texel (never the sphere). The sun map at 384². In reserve,
because each costs a picture: the air's shadow off at Retina, and `m`
from a uniform.

---

## 10. The default turns on, and the flag retires

**What hangs on `?clouds=1`** (M, at `02048daa`): the chunk's import
beside the renderer (`App.tsx:113-125`), the page's `cloudsRequested`
(`:280-282`), the factory's choice (`:793-795`), the overlays' layer on
the camera (`:817`), and the key (`pages/paths.ts:364-370`).

**The chunk graph does not move before the flip.** Every node phase 2
builds for a material lives in the cloud chunk and reaches the material
through the handle (§3). The CPU field reaches the flare through N's
worker and a number on the handle (§4.3). So `App` gains types alone at
G's, A's and F's merges, and the standing ruling "a page without the flag
pays nothing" holds for the clouds until D3. The graph stage holds it, not
the merger's eye (ruling 004, 5). It is breached from `5b2d9fd1`:
`fd929471`'s import into `cloudLevers.ts` puts the mie table on every
page, 57 chunks where 56 stand and about 208 kB gzipped more, and no check
was red (M: the register). The fix, `7af11d48`, carries the graph stage's
rule and merges before anything else; at `2ecb223a` it is not in the tree.

**The skylight is the air's, and it lands on every page at H's merge.**
L6 closes the air's two defects on every body with an air (rubric
§3.8). So the sky table and its bake become the air's own at H: 30,464 B
a body (D: 238 × 16 RGBA16F) and a CPU bake nobody has timed (R-E does).
That is not a cost of the clouds, and the ruling should say so.

**What each costs, by phase 1's records.**

| What a WebGPU boot gains at the flip | Figure                                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The chunk                            | `cloudSystem` 231,005 B raw and 120,624 gzipped, beside an `App` of 591,372 gzipped (M: `reports/merger.md:2395-2397`), and phase 2's nodes, not counted                                                                           |
| The warm-up's span                   | **Not measured.** `warming the clouds` came back empty in six boots and cold compile was never taken (M: phase 1 design, lines 119 and 5755). The trace is one WGSL function of 16,652 lines (M: `REGISTER.md`). N owes the figure |
| Phase 2's pipelines                  | At least nine: three bakes of the sun map, the light map's, the probe's, and a handle's graph of each of the four materials (E; K's census gives the base)                                                                         |
| The hosted runner                    | `cloudSystem.gpu.test.ts`'s warm-up test timed out there on 2026-11-12 (M: `LOG.md`, 18:52). No hosted span exists                                                                                                                 |

**The rule that replaces "a page without the flag pays nothing",** from
D3 on: a session pays the chunk at boot, and the tables, the bakes, the
pipelines and the bytes from the first frame that serves a body. Earth
is not served before phase 3, so the station, the solar system and every
dry world pay the chunk and nothing else. This changes a ruling, so it
needs one **before D is briefed**.

**The order, each merge green.**

1. **D1, lazy by served body,** still under the flag. A test holds a boot
   at the station **with the flag on** to the chunk's fetch alone: no
   table, no pipeline, no byte.
2. **D2, the warm-up's place, by N's figure.** Under 250 ms cold
   (proposed) it stays at mount on every boot. Over, it registers when a served body first comes inside
   the clipmap's reach, B13's first frames are taken there, and Jon
   chooses (§12).
3. **D3, the flip.** `cloudsRequested` goes, the chunk loads on every
   WebGPU boot, the layer is always enabled. Every plate of a wet
   generated world moves.
4. **D4.** The key leaves `paths.ts` and the docs. `engine.clouds` with
   `on: false` stays: it is the budget's A/B and every cast's control.

**Which guards move, and when each is judged.** H's merge moves every
scene with a sky (§5.2), on a dry world too. D3 moves every wet
generated world again. A plate takes one verdict: a scene with no served
body after H, a scene with one after D3, each against its last accepted
plate. Both sets are named before their merge, and `presets:compare
--all` is red on any other moved plate. The overlay guard is taken
after D3. D adds no body to the served set, and Earth keeps its deck
(C11).

---

## 11. The pictures

**What each law's error looks like,** so the first plates are read
against a prediction.

| Law | If it is wrong, the plate shows                                                                                                                                                                          | Where                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| L1  | A shadow off its cloud along the sun's azimuth (the crossing); soft blobs where cells are crisp (the pick); a square of sharper shadow that moves with the eye (a fade)                                  | E1; G1                                |
| L2  | A ring where shadows turn from shapes to a wash; far ground too bright under a low sun (0.70 for 0.63)                                                                                                   | S5; S6                                |
| L3  | A flare lit a moment after the drawn disk is covered, or flickering at an edge                                                                                                                           | G5 with the sun in frame              |
| L4  | An outline under every cloud's base (the identity); a line along a ridge between two airs; shafts that band; an overcast's far shore too clear and dark (`m`); shadows over a dark sea drawn milky (`w`) | G1, G2, G3, E1                        |
| L5  | Umbras too dark by a quarter at E1's sun (the lit side); a bright fringe under a deck's lee edge; long shadows at a low sun gray where they should be blue; a step at a shore if `Ā` is wrong            | E1, G1, S1, S2, G2                    |
| L6  | Every sky scene's ground shifts in level and hue at once; dusk ground too blue                                                                                                                           | Earth at noon and at −6°, Mars, Titan |
| L7  | A seam across the descent where the sphere hands over                                                                                                                                                    | G6                                    |
| L8  | The sea's horizon lighter or darker than the sky over it                                                                                                                                                 | G2                                    |
| L9  | Tops under cirrus chalk white (unshaded, as declared) or dirty gray (over-shaded)                                                                                                                        | E2; S3                                |
| L10 | Nothing new: lit walls dark at a low sun, a thin rim bright                                                                                                                                              | S1, S2                                |

**Checkpoints.** The orchestrator looks at every merge of S, G, A, V, H,
R and D (charter §7), at three stills its report names, and media go on
the pull request. A look council sits at three: **after wave 2** (E1 and
E2 forced, G1, S1 to S5; diagnostic by ruling 001's rule, the first
frame in which a cloud lays a shadow); **after wave 3** (G2, G3, G4, the
guards' two sets, the overlay guard); and **at the phase's end,** by the
rubric with fresh judges: G1 to G4's two confirming rounds, E1 and E2
forced in their one recorded round.

**Study stances.** They gate nothing: no bar, no streak, no verdict.
They live in `weatherStudies.json` (package I) and are taken by
`capture.mjs --only`. On the cornerstones' world unless said.

| #   | Stance                                                                                    | Weather, sun                       | It watches                                                                                                    |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| S1  | G1's place and lens, facing 90° from the sun                                              | `fair-cumulus`, 12° and 5° up      | **Cumulus under a low sun from the ground:** the lit wall (−86% to −38%), the factor of the sun, long shadows |
| S2  | The same, facing the sun; a still and a walk of 120 frames                                | `broken-horizon`, 12°              | The rim (+66%), shafts and their banding (L4)                                                                 |
| S3  | 6 km up, pitch −60°                                                                       | `cirrus-over-cumulus`, 30° and 15° | L9                                                                                                            |
| S4  | G2's shore                                                                                | `broken-horizon`, 35°              | L8's declared miss in still water                                                                             |
| S5  | E1's place, a 60° lens                                                                    | `fair-cumulus`, 50°                | L2: where a shadow turns statistical                                                                          |
| S6  | The wet world's whole disc                                                                | Its own climate                    | The map's handover to the atlas                                                                               |
| S7  | A peak inside the low level, and a deck's lee edge under a 15° sun, if the world has them | `stratocumulus`                    | `B^(1 − s)`; L5's corner and thrown shadow                                                                    |

No cornerstone looks at cumulus under a low sun from the ground, where
phase 1's declared errors are largest. S1 and S2 do.

---

## 12. What needs Jon, what needs the council, what was not verified

**Jon's.**

| #   | The call                                                                                     | The figure                                                                          | I would                                                       |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Every WebGPU boot pays the chunk once the flag retires, and the warm-up if it stays at mount | 120,624 B gzipped before phase 2's nodes (M); the span is not measured              | Flip only on N's figure, lazy by served body (§10)            |
| 2   | The cost with the shadow and the light in                                                    | +0.48 ms on `ground` and +0.33 on `orbit` at 1080p, +1.1 and +0.8 at Retina (E, §9) | Hold B4 at 1.6; set B1 to B3 on window 2's figures plus these |

**Ruled** (the adviser's ruling 004, 2026-11-12).

| #   | Ruling                                                                                                                     | What it binds                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **V waits on R-C1, and the pointwise bar is three bars.**                                                                  | V is not briefed before R-C1 reports, and §5.1's geometry is held to its three bars under the body's own sky from the sky table, with the sun alone beside it                                                                                                                                                              |
| 2   | **T builds the ground's share alone unless R-D lands a form inside ±35%.**                                                 | R-D may propose a third form that reads only what the trace binds, with no weight fitted on a judged shape; the grid as RGBA16F (+2,097,152 B) needs a ruling of its own                                                                                                                                                   |
| 3   | **Y2's form is what holds B4, and its fallback is a miss to argue, not a second plan.**                                    | With the early out alone B4 stands at 2.0 to 2.2 ms after phase 2 against 1.6 (D, §9); Y2's bytes come from L4's census, and its brief prefers a form at 2,073,600 B or under                                                                                                                                              |
| 4   | **The skylight is the air's from H's merge.**                                                                              | The sky table, 30,464 B a body, and its bake are on every page with an air, on the condition that R-E times the bake and it runs off the main thread or under a frame there; the table still counts in B12's census for a served body                                                                                      |
| 5   | **From D3, a session with no served body pays the chunk's fetch and nothing else.**                                        | No table, bake, pipeline or GPU byte, held by D1's test with the flag on; until D3 the standing ruling holds and the graph stage enforces it, and the flip is Jon's at D2                                                                                                                                                  |
| 6   | **G is a Fable package.**                                                                                                  | It writes the phase's most-read function into three materials under rules 52, 58 and 59, inside a ceiling of 0.10 to 0.20 ms, built beside S on K's stand-ins and the analytic box                                                                                                                                         |
| 7   | **The mean inside the levels goes to R-C2 with a landing rule, and E2's crop is not settled by a declaration.**            | The mean lands only if it brings the air under an altostratus inside 25% of the column's, is exactly one under a clear column and is formed from uniforms the scene's marches and the trace's blocked air share; R-G judges the atlas's term for the crop before A is briefed                                              |
| 8   | **The sun map does not join B7's 48 frames as written; it takes a clause of its own, and the council is told in writing.** | Its levels return coarsest first under a weight, each whole within 48 frames at suns of 30° and over under one level (28 at 50°, E) and its figure declared elsewhere (70 to 200 at 15° or under three levels, E); `ir.settled()` waits for all of them, S measures the figures, and the clause's wording is the council's |

**The council's.**

| #   | What                                                                                                                                                                                                                                                               | Figure                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1   | The bars proposed where the rubric has no row: L1 (0.01 in a 12 km mean, 0.03 RMS), L2 (the larger of 10% and 0.01 of the beam at the level's scale, from a 10° sun), L3 (1%), L4 (25%), L8 (10%), L9 (±35%). L5's geometry is set: ruling 004's three bars (§5.1) | §4 to §6                                                                                               |
| 2   | E2's crop shows no shadow's shape on the air over the base                                                                                                                                                                                                         | Judged by R-G before A is briefed, not declared (ruling 004, 7; §4.4)                                  |
| 3   | The resolved near probe is out of the MVP                                                                                                                                                                                                                          | §2; S4 records it                                                                                      |
| 4   | The wording of the sun map's own clause beside B7's "the field is whole", which it does not join as written (ruling 004, 8)                                                                                                                                        | Its first bake is 28 frames under one level at 50° and 70 to 200 at 15° or under three (E), against 48 |
| 5   | Row 14 is held on the renderer's medium, and its column cannot see where a part is read                                                                                                                                                                            | 3.0% from the true medium at 550 nm, 2.8% down to a 2° sun (M)                                         |

**Declared by this design:** §8's last paragraph, each a ceiling test. Not
in a law's own section: E1's outer 7 km a side at the coarser level at
1080p; the bake's steps past their cap under a 12° sun (0.10 to 0.12
RMS and +0.013 to +0.017 in the mean, M: both architects' probes and the
physics critic's); the hull lit as one value.

**Not verified.**

- No cost of phase 2's: `u` is a compute kernel's terms added up.
- The four materials' compiled bindings; the device's census; whether a
  read behind a zero weight is free in a fragment here.
- Every `m`, the air under the layer and §5.1's two heights: E.
- §5.1's form on the field's own clouds, or on any Monte Carlo but the
  critic's (Henyey-Greenstein). Its sky, 0.4 of the beam's level flux,
  is high for a 50° sun.
- Where the CPU can give a regional albedo; the ice rows' `g′`; `hMie`;
  who draws the ground past 1,024 km; the cornerstones' world's day,
  its land over a base, whether it holds a deck's edge.
- The warm-up's span; the sky table's bake time; phase 2's chunk bytes;
  the unmerged packages as §1 assumes them.

**The probes** (this Mac mini, Mac18,5, Apple M6, Node 26.13). Draft 1's
five, 80 s: `shadow.ts`, `eddington.ts`, `eddington2.ts`, `bake.ts`,
`bake2.ts`. Draft 2's, four core-minutes of 40, in `.scratch/p2/crit/`
of worktree `t3-ef50989c-0541563384341158`: `node l5k.mjs
<edge|bars|tall> <sun> <albedo> 2000000 [rows]`, which imports the
physics critic's `mc.mjs` unchanged and scores draft 1's form and
§5.1's (`A`, `K1r`); and a script over that critic's `bar-*.out`. Three
other forms were tried and dropped, each worse on the bars.

---

## 13. Answers to the critics

One row a finding. **A**: accepted and changed. **A+**: accepted, and a
probe of mine carries it further. **D**: declared at its figure. No
finding is refuted.

**The physics critic.**

| #      | Finding                                                                                                                                                  | Disposition                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | L5 reads the diffuse light, the sky's share and the return at the sun's crossing                                                                         | **A+.** §5.1: only the beam is the ray's; one kernel over the point's column for the rest. On your Monte Carlo the deck's edges go from 14% to 7% RMS and snow's mean from −9.9% to +0.4%; the lit side and the corner stay. The light map leaves S for V |
| 2      | L9's `M` lays the far cloud on the sample; Eddington's `t` under a low sun                                                                               | **A.** §6.1: the form is open, T is not briefed, R-D takes separation and 15°. Your candidate reads −60% to −100% on radiance. The flux is a block of the sky table, with no closed form                                                                  |
| 3      | One medium in the flux table; ice                                                                                                                        | **A.** Read by transport depth with the level's `g′`                                                                                                                                                                                                      |
| 4      | `w` is a share of length; the declared miss is larger                                                                                                    | **A.** `w` by constituent (§4.4); the miss restated at three levels; a mean inside the union goes to R-C2                                                                                                                                                 |
| 5      | The return takes the fragment's albedo and no air                                                                                                        | **A+.** `Ā` over the reach, `R_air`, a black-ground sky block; and the return fed by the reach's mean, which takes the strip over snow from +27% to +13%                                                                                                  |
| 6      | The trace's ground share is one number a body                                                                                                            | **A.** `groundShareAt`: the eye's foot, or the atlas's column in the far march; the bar moves to a half-clear climate                                                                                                                                     |
| 7      | Independent columns under-transmit at a low sun                                                                                                          | **D.** −18% sun alone and −8% with your sky at 15°; the mean bar holds from 30°                                                                                                                                                                           |
| 8      | L1 past its cap at 3°                                                                                                                                    | **D** (§12), with your figures                                                                                                                                                                                                                            |
| 9      | The medium holds for flux at a 2° sun                                                                                                                    | Kept, and cited (§5.1)                                                                                                                                                                                                                                    |
| Doubts | `m` under an overcast; `m` and no albedo; a sun under the horizon at `x`; two stores for a cloud and its shadow; the hull's one ray; the sea's two skies | **A:** said and sent to R-C2 (§4.4); `Ā` is a uniform; the grid's rule (§4.2); four rays (§4.3). **D:** §6.2; §5.4                                                                                                                                        |

**The engineering critic.**

| #         | Finding                                                                                                                                       | Disposition                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | The cost instrument draws none of the four materials; "off" is undefined; R-F's unit does not transfer                                        | **A.** K builds four material rows; off is the no-handle graph, compiled; R-F runs in them                                                                                                                      |
| 2         | B4 over its bar on `u` read correctly; ceilings over the room; the composite's reads; Y2's other arm; ceilings under the resolution; two sums | **A.** §9 on `u` = 9.5, both arms, ceilings summing to 0.50 at `orbit`, stops by ruling 002. B4 forecasts 1.28 to 1.43 because a surface's air from orbit takes no read of its own; with one it is 1.41 to 1.56 |
| 3         | The chunk graph moves at G; F's 1.4 s on the main thread; a dry world pays the reads; D1 against D3; pipelines uncounted                      | **A.** Functions on the handle; F in N's worker; a handle only for a served body; D1 holds the chunk alone; pipelines counted. One more: the skylight is on every page at H                                     |
| 4         | The byte room                                                                                                                                 | **A**, by ruling 003; this draft asks 3,328 B more                                                                                                                                                              |
| 5         | The order                                                                                                                                     | **A.** G beside S; T on G's seat; the grants named; no flux swap, since V bakes on O's block; six in sequence; R-B on L's fourth pass; the docs stage                                                           |
| 6         | A bar that fails by construction; no test of the crossing, of the declared misses, of the base under a climate; O's slow rows                 | **A.** A median and a 99th percentile; the analytic box; §8's last paragraph; a deck in a half-clear climate; rows committed                                                                                    |
| 7         | Three picks on ties                                                                                                                           | **A.** Real numbers with a blend; the casting level has a rule and a margin (§3)                                                                                                                                |
| 8         | A stale figure; the trace's binding count                                                                                                     | **A.** The register's current figures (§6.1); M2's census gives the count                                                                                                                                       |
| 9         | Four packages could not build from their sections                                                                                             | **A.** §8 names the reads, the files and the fetches; the sea counts five                                                                                                                                       |
| 10        | S's ceiling at a warp of one                                                                                                                  | **A.** A level past its pace is not read; the figure is marked Earth's day                                                                                                                                      |
| Forbidden | The flux as a block; the local ground share; G beside S; what K may propose; a compute bake; a shadow inside the union                        | **A** to each: §5.1; the far march; §8; §8; R-F times both; the mean, costed by R-C2                                                                                                                            |
| Doubts    | A's bar before Y2's form; a strip's cost; three ray counts; the settle's wall time; G as Opus                                                 | **A.** Re-read on Y2's merge; R-F; three pipelines; §9; G is Fable                                                                                                                                              |
