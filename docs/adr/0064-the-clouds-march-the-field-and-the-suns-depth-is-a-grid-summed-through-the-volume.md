# ADR-0064: The clouds march the field and the sun's depth is a grid summed through the volume, and the far field marches a layer atlas

Status: accepted · 10 Nov 2026 · amended 12 Nov 2026: a grid cell holds an
opacity and a depth beside it in RG16F, the volume holds its 200 m and 800 m
levels and not its 50 m one, and a march asks for the depth as it forms the
sun. What the passes of
[ADR-0063](0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md)
read. Everything here exists only under `?clouds=1`, and the density and the
light it carries are placeholders: phase 0's images claim nothing about how a
cloud looks.

## Context

The weather is one field at every distance: map coverage, times a genus height
profile, times eroded noise. Three things read it, and each had a cheaper
stand-in on offer.

- **The march.** A step that evaluates the field makes four texture reads. A
  local volume baked from the field makes one, behind max mips that skip empty
  space in three dimensions. Nubis³ and Enshrouded bake theirs, and the plan
  called the bake "likely the largest lever".
- **The sun.** A sample needs the cloud's optical depth toward the sun. Sun-space
  cascades of front depth, mean extinction and maximum optical depth are UE5's
  Beer shadow map. A grid around the eye holding the depth itself, summed
  through the local volume, is Nubis³'s.
- **The far field.** From 400 km a grazing ray crosses some 714 km of a 10 km
  shell, and no step budget at the fine march's resolution resolves it. A far
  ray marches a coarser representation: a three-layer atlas on a cube-sphere,
  the local volume's coarse levels carried out to the planet, or density and
  light cached on spheres at the layers' heights.

Two of the choices are one. The grid is summed through the volume, so the
cache and the sun's depth are a 2 × 2 and `(field, grid)` pays for a volume
only the grid reads.

Phase 0 built every candidate but one, measured them on the Mac mini by rules
fixed before any figure existed, and deleted the losers. The far field's
`levels` candidate was decided on paper, by arithmetic the rule already
contained.

## Decision

**The trace marches the field itself. The sun's optical depth is a
128 × 128 × 32 grid around the eye, summed through a local volume baked from
the same field. Past the handover footprint a ray marches a three-layer
cube-sphere atlas baked from that field.**

### The maps

- **The weather cube** covers the body: six 512² faces with a one-texel gutter
  in one 1,542 × 1,028 atlas, under the tangent warp `u = tan(a·π/4)`, in four
  RGBA8 targets one MRT quad draws (`render/cloudMaps.ts`). A texel is 19.5 km
  on Earth.

  | Target | Holds                          | And                           |
  | ------ | ------------------------------ | ----------------------------- |
  | 0      | Coverage of layers 0–2         | Ice share of the middle layer |
  | 1      | Log in-cloud τ of layers 0–2   | Rain rate                     |
  | 2      | Convective share of layers 0–2 | Deep-convection rate          |
  | 3      | Wind east, wind north          | Wetness, puddles (spare)      |

  τ is stored as `log2(1 + τ)/log2(513)`, to 512 in 2.5% steps, and wind as
  ±50 m/s about ½. Rain, deep convection, wetness and puddles are zero in
  phase 0. One face tile bakes a frame, so the steady cycle is six frames;
  after a jump all six are stale and bake over the next six, nearest the eye
  first.

- **The clipmap** is the same quantities under the eye: six levels of 256²,
  with texels of 250 m to 8 km, in a 2D array of four RGBA8 targets, baked
  **from the cube** (`render/cloudClipmap.ts`). One field feeds every distance,
  so the near march and the far bakes cannot disagree about where a cloud is.
  A level is stored toroidally and redraws only the strips its window's move
  exposed; a frame that rebuilds nothing redraws an eighth of one level for
  time, 48 frames a cycle. A level's outer fifth fades into the next, and the
  second read happens only in that band. The fine march reads the clipmap and
  never the cube, which keeps the trace inside a stage's sampled bindings.
- **A lookup never takes a lattice coordinate from an absolute direction**
  (rule 58). A sample's plane coordinate is the eye's, formed on the CPU in
  float64, plus a difference formed from the sample's offset (`levelPlane` in
  `render/cloudGeometry.ts`).
- **Coverage has three sources, and one recipe.** The fine march, the volume's
  bake and the light taps read the clipmap (`fieldMedium`). The served body's
  far bake reads the cube (`synopticMedium`), because the limb lies past the
  clipmap's ±1,024 km. A second clouded body has no cube and reads the
  placeholder's analytic coverage function (`analyticMedium`).

### The noise

- A 128³ Perlin–Worley base and a 32³ Worley detail, one channel of R8 each,
  baked once at warm-up (`render/cloudNoise.ts`). A 2D curl is folded into the
  base at the bake, so tearing the edges costs a step nothing.
- **Each is a `RenderTarget3D` drawn one fragment quad a slice.** An `r8unorm`
  render attachment is core WebGPU, where an `r8unorm` storage texture needs
  `texture-formats-tier1`. A target's textures have one level, so nothing
  allocates a mip chain the bake never fills.

### The march reads the field

- A step reads the coverage (twice in a clipmap level's fade band), the
  profile, the base noise and the detail noise: four reads, five in a band.
  The detail read is skipped where the footprint is a quarter of a noise cell
  or more.
- The trace binds 12 of a stage's 16 sampled textures and writes all 4 of its
  storage textures, so there is no room for a fifth output.
- `maxSteps` is 192: on `horizon`, 128 against 192 differs by 1.60% radiance
  RMSE (1.61% at Retina) and 192 against 256 by 0.02% (0.01%).

### The sun's depth

- **The grid** is 128 × 128 × 32 cells on the frame of the volume's 200 m
  level: a cell is 400 m, and the window reaches 25.6 km from the eye
  (`render/cloudSunGrid.ts`). Each cell sums one optical depth `τ` in 32
  steps toward the sun through the volume to the top of the layers, and its
  32 heights run from the union's base to its top.
- **A cell holds an opacity and a depth beside it, RG16F, from one sum and
  read in one fetch.** A read filters eight cells, and in broken cloud the
  depth of their mean transmittance and their mean depth are two numbers.
  First order's light wants the first and the light after first order the
  second.

  | Channel | Holds                                                      | Read by                                                   |
  | ------- | ---------------------------------------------------------- | --------------------------------------------------------- |
  | R       | the opacity `1 − e^(−τ)`, on its tangent past a depth of 6 | first order past the taps, the early out's test, `octave` |
  | G       | the depth `min(τ, 64)`, linear                             | the light after first order (`CloudSun.depth`)            |

  Held as depths alone, a read between a clear cell and a cloudy one passes
  `e^(−τ/2)` where half the sun passes the points beside it, and every
  cloud's edge is dark for a cell's width. Held as opacities alone, the
  light after first order reads the shallower mean. Past a depth of six a
  half float has run out of the opacity's steps, so the red channel goes on
  along its tangent for the early out's test, and the depth channel carries
  the depth itself. The cap of 64 keeps a cell a thousand deep from
  outweighing seven clear ones in either channel.

- **The volume** holds the frame's 200 m and 800 m levels, 256² × 32 texels
  each with a guard slice under and over, 68 slices of RG8 in one
  `RenderTarget3D` (`render/cloudVolume.ts`). A texel holds one number, the
  scaled extinction times the cloudy share, `σ′·f`, in sixteen bits over the
  texel's two bytes; the split is linear, so the sampler's filtering of the
  two bytes is the filtering of the number. Every level bakes the resolved
  field. Nothing but the grid reads it.
- **The volume holds no 50 m level.** A grid cell is 400 m, so a 50 m level
  is point-sampled once a cell and once a step of the cell's bake, and the
  200 m level answers within 6.4 km of the eye. The frame
  (`render/cloudFrame.ts`) still lays out a 50 m level that nothing holds.
- **Refresh.** No frame rebuilds the volume or the grid whole
  (`sunSourceStep`, `sunGridStep`). A new field, a moved anchor and a wake
  from idle leave slices holding nothing, and they come back at the frame's
  cap of slices (`CloudBudget.slices`), the volume first, its finest level
  first, and the grid only from a volume that is whole. The grid's weight then
  rises over the `sunRamp` lever's frames. At the cap of eight a rebuild is
  the volume's 68 slices over 9 frames, the grid's 32 over 4, and 16 frames
  of ramp: 29 frames. A whole level or grid is redrawn at the pace of what it
  holds, so a field that stands still is not baked again.
- **The light a sample takes** is `((1 − c) + c·e^(−τ_taps))·e^(−τ_beyond)`:
  the layer's clear share passes, the cloudy share is dimmed by taps over half
  a kilometer toward the sun at most, ended at the level's exit, and the grid
  supplies the depth beyond them (`render/cloudSunlight.ts`). `lightTaps` is 4.
- **Where the grid's weight is under one, the layers' own statistics stand in
  for it** (`render/cloudMix.ts`): past its reach from the eye, from orbit, and
  while it comes back after the field changes.
- **A march asks for the depth as it forms the sun:**
  `deps.sun(at, medium, body, { depth: true })` (`CloudSunOptions`). The
  depth reaches the ray's far end, a grid fetch of its own, so the shipped sun
  forms it only on request, in the block the sun is formed in, and every later
  read, in a branch, a loop or a memoized function, reads that one variable.
  Read from a sun formed without the request it throws by name as the program
  is built. A program that reads `cloud` alone fetches the grid twice in its
  WGSL, and one that also reads the depth four times
  (`cloudSunDepth.gpu.test.ts`).

### The far field

- **The atlas** is six faces × three layers × 258² texels of RGBA8 in one
  1,548 × 774 texture: a layer's cloud fraction, its in-cloud optical depth as
  `log2(τ + 1)/log2(513)`, and its base and top heights quantized over that
  layer's own range (`render/cloudFarAtlas.ts`). A texel is 39 km on Earth and
  24 km on far-shore.
- **It is baked from the field,** 4 × 4 sub-columns by 8 heights a texel, one
  192² block a frame whatever the frame's budget, 45 frames a cycle.
- **A far ray marches it as slabs,** one texel a step and at most 32 steps a
  layer crossing, mixing each column's transmittance by its fraction and
  accumulating the mean and mean square of its visible depth. The sun reaches
  a far sample through the layers above it, read from the atlas.
- **The handover is by footprint, never by altitude.** A ray leaves the fine
  march where a trace texel spans `farFootprint` meters, 800 by default, or
  where its step budget runs out. There is no cross-fade: the ray switches.
- A second clouded body is drawn by its own atlas alone, baked from the
  analytic coverage.

### What the bakes rest on

`cloudPremises.gpu.test.ts` settles on the GPU each three r185 behavior a
format depends on, each read from three's source first and each with a
fallback that would have moved a contract. All held, and no fallback was
taken.

| Premise                                                                                                    | What rests on it                                                                  |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A `RenderTarget3D` slice takes a fragment draw in R8 and RG8, and the warm-up builds its pipeline          | The noise and the volume bake with no tier-1 storage format                       |
| A six-layer 2D-array target takes one MRT quad into four textures                                          | The maps and the clipmap draw one quad a pass                                     |
| A compute and a render issued inside an open render run in the order issued and leave the outer one intact | Every cloud pass runs from inside the second scene pass                           |
| `uniform(…, 'uvec2')` carries both `u32` halves exactly past 2²⁴                                           | The period index stays a `u32` on the GPU (rule 58)                               |
| A storage texture made with `generateMipmaps` off has one level and draws no mip pass                      | The trace and the history; three's default takes 5 levels and 5 passes at 16 × 16 |
| A compute pipeline is counted at its first dispatch, and a warm-up dispatch of zero workgroups builds it   | No kernel compiles on the first drawn frame                                       |

### Memory

Declared from each texture's dimensions, texel size and single level, and held
to the GPU's own figures by `cloudSystem.gpu.test.ts`. The dimensions give
88.2 MB at 1920×1080 and 81.6 MB at 2880×1800 (`cloudBudget.test.ts`). **That
is over the plan's 76 MB at both sizes,** by 12.2 MB at 1080p and 5.6 at
Retina.

| Resource                       | Bytes, 1080p | Bytes, Retina |
| ------------------------------ | ------------ | ------------- |
| Weather cube                   | 25,362,816   | the same      |
| History, at ½, 48 B a texel    | 24,883,200   | 15,552,000    |
| Trace, at ¼, 72 B a texel      | 9,331,200    | 5,832,000     |
| Local volume, RG8 256² × 68    | 8,912,896    | the same      |
| Clipmap                        | 6,291,456    | the same      |
| Far atlas                      | 4,792,608    | the same      |
| Depth copy, R16F               | 4,147,200    | 10,368,000    |
| Base and detail noise          | 2,129,920    | the same      |
| Sun grid, RG16F 128² × 32      | 2,097,152    | the same      |
| Droplets' phase, genus profile | 264,192      | the same      |

A second clouded body adds a second atlas, 4,792,608 bytes, while it is in the
frame.

**The device's own census** counts every texture the device is asked for over
a chain's life under an overcast, with the clouds on less with them off, at
1920×1080 with one served body (a copy of `cloudSystem.gpu.test.ts`'s census,
on the Mac mini). It reads 74,334,796 B against 74,333,156 B declared, 1,640 B
undeclared. Phase 1 lands at or under 77.17 MB on that census; the room left
is spent on phase 2's shadow map first, a target for the composite's air at the history's rate second, and 64
grid heights last.

### What was measured

Campaign 1, at commit `8a01d311`, with every candidate in the tree. The
machine is the Mac mini (Mac18,5, Apple M6, 32 GB), fan-cooled; the browser is
Chrome 157.0.8103.40 on WebGPU over Metal; the build is production, served by
the preview, from a clean tree. The sizes are 1920×1080 at a device pixel
ratio of 1 and 1440×900 at 2, a 2880×1800 buffer. The picture is native with
multisampling and the camera is Enhanced. The world is far-shore V
(`g:milky-way/s:P222_1_0_9/b:4`) with the sun 37.5° up at the ground stances
and 4.4° up under the `orbit` stance. **Every figure here is that machine's.**
The plan's budget basis is perf's Apple M5, on which nothing in phase 0 was
measured, and no factor between the two is known.

A frame cost is `ir.gpu(120)`, the least of three reads, clouds off against
on, interleaved in one boot: five pairs for a steady frame and three for a
forced one. A difference counts when it exceeds twice the spread of the pairs'
deltas and 0.05 ms. Every row that counts was measured on a quiet machine; the
runner took again the six that ended under load. The tables are
[`choices-2026-11-10T05-25-52Z.md`](../../design/plans/weather/phase0/measurements/choices-2026-11-10T05-25-52Z.md), and
each pass's share is in [`passes.md`](../../design/plans/weather/phase0/measurements/passes.md). The cost rows ran with
`lightTaps` 2 and `farFootprint` 400, the defaults of that commit.

The three instruments are headless GPU tests on Earth's record, kept as
[`choices-2026-11-10T05-25-52Z-farCompare.json`](../../design/plans/weather/phase0/measurements/choices-2026-11-10T05-25-52Z-farCompare.json),
[`…-sunAccuracy.json`](../../design/plans/weather/phase0/measurements/choices-2026-11-10T05-25-52Z-sunAccuracy.json) and
[`…-compositeError.json`](../../design/plans/weather/phase0/measurements/choices-2026-11-10T05-25-52Z-compositeError.json).

A figure called landed is campaign 2's, on the code as it stands after the
losers went: commit `bbea04da`, which differs from the landing's `d03b8420` in
`scripts/clouds/` alone, on the same machine, browser and sizes, with the
landed defaults of `lightTaps` 4 and `farFootprint` 800, in
[`landed-2026-11-10T09-05-32Z.md`](../../design/plans/weather/phase0/measurements/landed-2026-11-10T09-05-32Z.md). It
ends by running the three instruments on the landed code, kept beside it as
`landed-2026-11-10T09-05-32Z-*.json`; no figure here reads them.

Four limits bear on the figures below.

- **The fine march takes a step's light source at the step's start.** That is
  exact for a constant medium and a left-endpoint rule for a source that falls
  along the step, so first-order light is biased high. On a uniform slab at
  equal sun and view cosines the bias is `2/(1+e^−τ) − 1` a step, τ the step's
  optical depth. An in-cloud step holds τ at 0.3 only near the eye, where that
  is 15%: the step's floor, 3 m plus 60 m per 16 km, overtakes `0.3/σ` at
  1.5 km under `fair-cumulus`'s σ of 0.035 /m. Past it τ grows with distance:
  +52% at 8 km, where a step is 33 m, and about +100% at the far
  comparison's 55 km handover, where a step is 209 m and τ 7.3. The variable is
  the distance. The far comparison's reference is that march. Its radiance
  errors rank two candidates against one reference and are not a cloud's
  radiance. Phase 1 fixes the march.
- **`ground` in campaign 1 is a clear sky inside a cumulus field:** cloud in
  2.0% of the trace's texels, where `horizon` has 38.6%. No rule below read
  it, and its rows are quoted as a second operating point. At `25df44ab` the
  stance stands one degree north, with cloud in 38.8% of the texels and the
  sun at 37.50°, and the landed figures are taken there.
- **The ladders' images hold the jitter.** A moving capture's noise floor is
  about 2%, and a ladder's rule is 1%.
- **The placeholder's density is uncalibrated and its light is first order
  plus a placeholder sky term.**

What each gate's figure covers:

- **The ladders** were taken twice. Campaign 1's vary one lever each, the
  others at `8a01d311`'s defaults: the sun's depth from cascades, `lightTaps`
  2 and `farFootprint` 400. The `choices` campaign of 10 Nov 2026 took them
  again on the landed set at `51c96da4`, the grid with 4 taps at 800 m (The
  landed set's ladders, below). Both read `horizon` and `inside` alone.
- **The far comparison** scored 400 and 1,600 m for both candidates in
  campaign 1, and the atlas alone at 400, 800 and 1,600 m on the landed code
  at `51c96da4`. No comparison of the two candidates exists at 800 m, the
  default: the spheres were deleted before the instrument scored it.
- **The sun-accuracy lattice** is ±4 km about a 2 m eye, inside the grid's
  window, so its figures describe the sun's depth within 4 km of the eye.
  Each scenario stands at one place, the first maximum of its coverage on a
  Fibonacci sphere: latitude 86.2 to 88.7° in four of the five, and 22.9°
  under cirrus over cumulus.
- **The grid's window** is ±25.6 km. Past it a fine-march sample is lit by
  the taps alone, and no gate scores that band; the far comparison's cases
  lie past it, which is why its reference's light is an upper bound.

#### The cache: the field

The gate: a volume combination's image is within 3% radiance RMSE of the
field's with the same sun depth, over cloud texels, in `ground`, `horizon` and
`inside` at both sizes.

| Scenario  | Size   | Cascades, moving | Grid, moving | Cascades, held | Grid, held | Cloud texels |
| --------- | ------ | ---------------- | ------------ | -------------- | ---------- | ------------ |
| `horizon` | 1080p  | **6.26%**        | **6.27%**    | **6.47%**      | **6.52%**  | 52,774       |
| `horizon` | Retina | **6.59%**        | **6.61%**    | **6.88%**      | **6.88%**  | 33,440       |
| `inside`  | 1080p  | 2.50%            | 1.82%        | 1.34%          | 1.34%      | 129,600      |
| `inside`  | Retina | 1.48%            | 1.67%        | 1.34%          | 1.34%      | 81,000       |
| `ground`  | 1080p  | 1.57%            | 3.16%        | 0.67%          | 0.68%      | 2,737        |
| `ground`  | Retina | 0.56%            | 0.56%        | 0.66%          | 0.66%      | 1,848        |

`horizon` fails for both volume combinations at both sizes, by more than twice
the gate, so the volume is not the march's cache and the decision does not
turn on `ground`. The one `ground` cell over 3% is a moving capture whose own
noise floor is 2.31%; held, it is 0.68%.

The volume is also the dearer march wherever there is cloud in view. Steady
cost against clouds off, in ms, with the spread of the pairs:

| Scenario  | Size   | Field, cascades | Field, grid | Volume, cascades | Volume, grid |
| --------- | ------ | --------------- | ----------- | ---------------- | ------------ |
| `horizon` | 1080p  | 4.91 (0.06)     | 5.11 (0.06) | 5.93 (0.11)      | 5.60 (0.02)  |
| `inside`  | 1080p  | 5.12 (0.04)     | 5.19 (0.04) | 5.92 (0.05)      | 5.58 (0.04)  |
| `ground`  | 1080p  | 6.01 (0.07)     | 6.22 (0.02) | 4.86 (0.03)      | 4.70 (0.04)  |
| `horizon` | Retina | 6.90 (0.03)     | 7.06 (0.04) | 7.70 (0.05)      | 7.43 (0.05)  |
| `inside`  | Retina | 7.98 (0.09)     | 7.93 (0.06) | 8.44 (0.03)      | 8.21 (0.02)  |
| `ground`  | Retina | 7.73 (0.05)     | 7.94 (0.08) | 6.94 (0.25)      | 6.79 (0.14)  |

Under the clear sky of `ground` the volume is 0.8 to 1.5 ms cheaper: its max
mips skip empty air, and the field's march steps through it. That is the
lever the plan expected, and it is real where the sky is empty.

#### The sun's depth: the grid

The gate: a candidate's `T_cloud` is within 3% RMS of a 256-step march of the
field, at in-cloud samples of five scenarios at two suns, at `lightTaps` 2.
Transmittance is absolute, 13,824 samples a case.

| Scenario              | Sun   | In cloud | Mean `T`, reference | RMS at 2 taps, cascades / grid | Bias at 2 taps, cascades / grid | RMS at 4 taps, cascades / grid | Worst sample at 2 taps, cascades / grid | Worst sample at 4 taps, cascades / grid |
| --------------------- | ----- | -------- | ------------------- | ------------------------------ | ------------------------------- | ------------------------------ | --------------------------------------- | --------------------------------------- |
| `fair-cumulus`        | 37.5° | 2,504    | 0.112               | 0.135 / 0.133                  | +0.040 / +0.039                 | 0.043 / 0.046                  | 0.95 / 0.95                             | 0.59 / 0.72                             |
| `fair-cumulus`        | 5°    | 2,504    | 0.030               | 0.074 / 0.069                  | +0.010 / +0.009                 | 0.033 / 0.032                  | 0.85 / 0.84                             | 0.68 / 0.59                             |
| `two-decks`           | 37.5° | 3,046    | 0.165               | 0.191 / 0.192                  | +0.051 / +0.041                 | 0.077 / 0.097                  | 1.00 / 1.00                             | 0.89 / 0.95                             |
| `two-decks`           | 5°    | 3,046    | 0.029               | 0.083 / 0.068                  | +0.013 / −0.002                 | 0.056 / 0.054                  | 1.00 / 1.00                             | 1.00 / 1.00                             |
| `anvil`               | 37.5° | 4,561    | 0.032               | 0.024 / 0.023                  | +0.005 / +0.004                 | 0.009 / 0.009                  | 0.34 / 0.31                             | 0.10 / 0.13                             |
| `anvil`               | 5°    | 4,561    | 0.003               | 0.033 / 0.040                  | −0.001 / −0.003                 | 0.032 / 0.040                  | 0.96 / 0.94                             | 0.90 / 0.94                             |
| `overcast`            | 37.5° | 3,536    | 0.142               | 0.149 / 0.149                  | +0.054 / +0.054                 | 0.022 / 0.022                  | 0.80 / 0.80                             | 0.24 / 0.24                             |
| `overcast`            | 5°    | 3,536    | 0.042               | 0.036 / 0.027                  | +0.003 / +0.003                 | 0.027 / 0.015                  | 0.99 / 0.64                             | 0.99 / 0.64                             |
| `cirrus-over-cumulus` | 37.5° | 3,407    | 0.592               | 0.166 / 0.104                  | −0.042 / +0.023                 | 0.165 / 0.029                  | 0.99 / 0.89                             | 0.99 / 0.61                             |
| `cirrus-over-cumulus` | 5°    | 3,407    | 0.505               | **0.492** / 0.081              | **−0.321** / −0.003             | 0.492 / 0.082                  | 0.99 / 0.96                             | 0.99 / 0.96                             |

Neither candidate passes: at two taps the cascades are within 3% in one case
of ten and the grid in two. The rule's clause for that keeps "the more
accurate" and does not name the aggregate. **Read by the worst case's RMS at
two taps, the gate's own tap count,** the grid's is 0.192 against the
cascades' 0.492, and the grid stays. Under cirrus over cumulus at a 5° sun
the cascades read the cloud a third of full scale too dark, at two taps and at
four.

- **Case by case the cascades are the more accurate in five cells:** at four
  taps 0.077 against 0.097 under two decks at a high sun, 0.043 against 0.046
  under fair cumulus at a high sun and 0.032 against 0.040 in the anvil at a
  low sun; at two taps 0.033 against 0.040 in the anvil at a low sun and
  0.191 against 0.192 under two decks at a high sun.
- **By the worst single sample neither is ahead:** both reach 1.00 under two
  decks. The grid's worst at four taps, the landed count, is 1.00 under two
  decks at a 5° sun and 0.94 or more in four cases of ten (five of ten at two
  taps). Single in-cloud samples take the far end of the transmittance range
  where the RMS is under 0.1.

Most of the two-tap error is common to both candidates and belongs to the
taps: at four it falls to 0.022 under overcast and 0.046 under fair cumulus.
At four taps the grid is within 3% in four cases of ten. Its own misses are
0.097 under two decks at a high sun and 0.082 under cirrus over cumulus at a
low one.

With the cache decided, one combination is left. Had both sun depths passed,
the rule would have weighed what the grid costs against `(field, cascades)`:

| Figure, `(field, cascades)` against `(field, grid)` | 1080p            | Retina            |
| --------------------------------------------------- | ---------------- | ----------------- |
| Steady, `horizon`, ms                               | 4.91 / 5.11      | 6.90 / 7.06       |
| Steady, `inside`, ms                                | 5.12 / 5.19      | 7.98 / 7.93       |
| `fly` at 250 m/s, clear-sky `ground`, ms            | 6.06 / 6.18      | 7.71 / 7.91       |
| `fly` at 7.7 km/s, `orbit`, ms                      | 2.44 / 2.39      | 4.10 / 4.05       |
| **`cut`, `horizon`, ms**                            | **7.83 / 19.69** | **9.37 / 20.97**  |
| **`scrub`, 3 h a frame, `horizon`, ms**             | **9.86 / 14.54** | **11.18 / 15.89** |
| Declared memory, MB                                 | 83.53 / 92.05    | 76.92 / 85.44     |

The reset frame is the larger of `cut` and `scrub`: 19.69 ms at 1080p against
the cascades' 9.86, and 20.97 at Retina against 11.18. Of the cut's 19.69 ms,
12.32 is the grid, 32 slices in one frame, where the cascades' rebuild is
0.84. The cap admits exactly that.

**None of these figures decided anything.** No combination passed both gates,
so the rule's steady, `fly`, reset and memory comparison never ran: the grid's
reset frame, twice the cascades', and its 8.52 MB more were recorded and not
weighed.

#### The sun's depth: the grid's cell and the volume's levels

Taken on the Mac mini's M6 by the sun instrument,
`cloudSunAccuracy.gpu.test.ts` under `IR_CLOUD_MEASURE=1`, at four taps over
its 18 rows, against a march of the field; its document is pinned in
`cloudSunAccuracy.landed.json`. Each rule was fixed before its figure.

- **The 50 m level is cut.** Over the instrument's 22.5 km no row moves by
  more than +0.0006 RMS (two decks under a 37.5° sun, 0.0701 to 0.0706),
  where the rule allowed 0.002. Inside 4 km of the eye the most a row loses
  is 0.0104 (altocumulus under a 5° sun, 0.0450 to 0.0554), where it allowed
  0.015; cirrus over cumulus under a 5° sun gains 0.0046. The volume goes
  from 13,369,344 B to 8,912,896 B, and a rebuild from 102 volume slices to 68.
- **The depth channel lands.** Every first-order row matches the cut's to
  1e-4 RMS, where the rule allowed 1e-3: the depth beside the opacity costs
  first order nothing. The depth the light after first order reads,
  through four taps, is lower through the depth channel in every one of the
  six broken-cloud rows. RMS and bias, depths cut at 16, at suns of 45° and
  15°:

  | Field        | Level  | Opacity channel, 45° / 15° | Depth channel, 45° | Depth channel, 15° |
  | ------------ | ------ | -------------------------- | ------------------ | ------------------ |
  | A climate    | low    | 2.27 / 2.98                | 2.12, +0.46        | 2.90, +0.87        |
  | A climate    | middle | 2.13 / 2.71                | 1.96, +0.39        | 2.59, +0.75        |
  | Fair cumulus | low    | 1.72 / 2.18                | 1.46, −0.20        | 1.97, +0.25        |

  At a sample the early out skipped, where the cell alone answers, the
  climate's low level reads 2.58 and 3.25 through the depth channel against
  4.77 and 5.49 through the opacity, and fair cumulus 2.04 and 2.16 against
  3.89 and 3.87. The margins through the taps, 0.08 to 0.27, are small
  because the taps reach half a kilometer and carry most of the depth.

- **8 of the 18 first-order rows stand within 3%**, at the base and landed
  alike.
- **Cost.** `cloudTraceCost.gpu.test.ts` under the same flag at 1080p and four
  taps, each row the whole frame's busy time with the clouds on less the same
  session's with them off, three takes and their median: no row is dearer
  than the base by more than 2% and two of the timer's ticks. The nearest are
  `inside`, 3.83 to 3.91 ms (+1.9%), and the overcast from 12 km, 4.02 to
  4.10 (+1.8%), taken beside three other processes at full CPU (load 4 to 6);
  on the same program at load 2.7 to 3.0 they read +0.4% and +0.2%.
- **64 heights are measured and not landed.** Through four taps the
  climate's low level reads 2.23 against 2.12 at 45° and 2.82 against 2.90
  at 15°, where the rule asked for 0.4 lower at both; at the sample itself
  they help, 2.58 to 2.50 and 3.25 to 3.08. First order falls by 0.0047 at
  most and rises by 0.0008 at most. They cost 2,097,152 B more, a rebuild
  whole in 38 of the instrument's frames against 34, and no cost row rises
  past 0.8%; the census at 64 heights reads 76,430,308 B declared. Halving the
  spacing moved the depth by +0.11 and −0.08, so the spacing is not what
  limits the union.
- **The far crossing under the horizon splits by place.** Cirrus over
  cumulus under a −1.5° sun, from the reference alone: the RMS the best
  single number for the far crossing leaves at a place is 0.83 of the row's
  0.0888, pooled. At two places of five it is the far field's spread (0.92
  and 1.09 of the place's RMS, the far crossing passing 0.26 and 0.42 of the
  sun); at three it is the bake's near part (0.18, 0.01 and 0.40, the far
  crossing 0.97 to 0.99 clear). Dusk altocumulus is all near part (0.00 of
  0.0497).

#### The far field: the atlas

The rule: the smaller worst-case radiance error, averaged over each far
texel's footprint, across four handover cases at `farFootprint` 400 m, unless
it costs over 0.3 ms more or 2.5 times the memory. Each candidate marches the
whole ray and is scored against the fine march over the same 256 × 144 rays;
errors in radiance are relative to the reference's mean light over the cloudy
bins.

| Case, at 400 m      | Mean `T`: reference / atlas / spheres | Footprint radiance error, atlas / spheres | Footprint `T` error, atlas / spheres | Cloudy bins |
| ------------------- | ------------------------------------- | ----------------------------------------- | ------------------------------------ | ----------- |
| Cirrus over cumulus | 0.477 / 0.646 / 0.645                 | 1.643 / 1.656                             | 0.395 / 0.420                        | 60 of 116   |
| Broken cumulus      | 0.207 / 0.306 / 0.309                 | 0.525 / 0.473                             | 0.360 / 0.359                        | 70 of 156   |
| Anvil               | 0.968 / 0.974 / 0.994                 | 1.625 / 1.633                             | 0.147 / 0.655                        | 28 of 114   |
| Grazing at sunset   | 0.030 / 0.287 / 0.307                 | **0.339 / 2.087**                         | 0.194 / 0.355                        | 4 of 6      |

The atlas's worst case is 1.643 and the spheres' 2.087, so the atlas wins.
Neither exception fires: the spheres' steady cost against the atlas is −0.03
ms on `orbit` and on `horizon` at 1080p and −0.06 and −0.09 at Retina, all
inside the resolution, and their memory is 4.79 MB more: twice the atlas's
bytes.

The same document reads less cleanly than the rule.

- **The far field is decided at 400 m and provisional at the default.** The
  rule was followed at 400 m. 800 m, the landed default, is scored by no
  comparison of the two candidates.
- **The gap is one case, on four bins.** Three cases are within 0.06 of each
  other, and the spheres are ahead on broken cumulus. The grazing case decides
  it, and at 400 m its footprint average is over 4 cloudy bins of 6.
- **Where the handover is by an exhausted step budget the gap closes.** With
  the fine march stopped at 24 steps, the grazing case reads 1.125 for the
  atlas and 1.125 for the spheres.
- **At 1,600 m the spheres are ahead in all four cases:** 0.874 against 0.903,
  0.635 against 0.773, 0.825 against 1.209 and 2.253 against 2.311.
- **"Worst case" compares unlike scales.** Each case's radiance error is
  relative to that case's own mean light over its cloudy bins, which at 400 m
  runs from 8.4 × 10⁻⁵ in the anvil to 3.8 × 10⁻³ over broken cumulus, so the
  worst of the four ranks errors in four different units.
- **The reference marches up to 1,051 steps,** in the anvil, where production
  stops at `maxSteps` 192, so neither candidate is scored against the march
  it hands over from.
- **Both far fields let through more light than the reference.** Mean
  transmittance over broken cumulus is 0.306 and 0.309 against 0.207, and
  0.287 and 0.307 against 0.030 on the grazing ray. Both radiance errors are
  of the order of the reference's own mean light.
- The depth moments, recorded for phase 1's cross-fade: the atlas's mean depth
  is within 1.5 to 8.5 km RMS of the fine march's on three cases and 46.7 km on
  the anvil, where the spheres are 139.8 km off.

**`levels` is decided by its memory.** Reaching the limb from the orbit
stance, 1,830 km of gnomonic plane on far-shore and 2,290 km on Earth, takes a
sixth volume level of 51.2 km texels past the 3.2 and 12.8 km ones, because a
fifth level's window ends at ±1,638 km. The three far levels alone are
3 × 256² × 34 × 2 B = 13.4 MB, 2.8 times the atlas's 4.79 MB, and the whole
six-level volume is 26.7 MB, 5.6 times. The rule excludes a candidate at over
2.5 times, so no measurement of it could have been used.

#### The ladders

Each is the smallest value whose image differs from the next larger one's by
under 1% radiance RMSE in `horizon` and `inside`, the jitter held. `inside`
is under 0.04% on every rung. On `horizon`, 1080p then Retina:

| Lever          | Rungs                                                                                               | Set to                     |
| -------------- | --------------------------------------------------------------------------------------------------- | -------------------------- |
| `maxSteps`     | 64 → 96: 40.59%, 40.76%. 96 → 128: 10.99%, 12.21%. 128 → 192: 1.60%, 1.61%. 192 → 256: 0.02%, 0.01% | 192                        |
| `lightTaps`    | 0 → 2: 2.16%, 2.37%. 2 → 4: 1.04%, 1.14%                                                            | Unset by the rule; 4 ships |
| `farFootprint` | 200 → 400: 0.43%, 4.22%. 400 → 800: 0.01%, 7.18%. 800 → 1,600: 0.01%, 0.01%                         | 800                        |

- **`lightTaps` is unset by the rule.** Two against four is over 1%, by 0.04
  to 0.14 of a percent, and four has no larger rung to be measured against:
  `cloudLevers.ts` offers 0, 2 and 4. Four is what ships.
- **`farFootprint` 800 is read on `horizon` and `inside` and on no orbit
  stance.** At 1080p the ladder passes from 200 m; Retina alone moves the
  default to 800. Two stills of `orbit` exist on the Mac mini, one at the
  campaign's levers and one at the landed defaults (the `stances` batches of
  `05-18-22Z` and `08-45-21Z`, `stances_verify_orbit_1080p-still.jpg`); they
  are not committed. The landed one draws
  the disk with almost none of the cloud texture the first shows. The two
  differ in the footprint, the taps and the sun's depth at once, and nothing
  measured separates them.

#### The landed set's ladders

The `choices` campaign took the three ladders again on the landed code and
defaults, the grid with 4 taps at 800 m, at commit `51c96da4`: 12 of 12 runs
quiet, at 112 to 116 Hz at 1080p and 64 to 72 at Retina. The tables are
[`choices-2026-11-10T11-49-33Z.md`](../../design/plans/weather/phase0/measurements/choices-2026-11-10T11-49-33Z.md).
`inside` is under 0.04% on every rung, as before. On `horizon`, 1080p then
Retina:

| Lever          | Rungs                                                                                                                        | What the rule reads                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `maxSteps`     | 64 → 96: 47.31%, 47.72%. 96 → 128: 12.52%, 14.00%. 128 → 192: 1.82%, 1.84%. 192 → 256: 0.02%, 0.01%. 256 → 384: 0.00%, 0.01% | 192 holds                                          |
| `lightTaps`    | 0 → 2: 2.68%, 3.00%. 2 → 4: 1.03%, 1.13%                                                                                     | Unset: two is over 1%, and four has no larger rung |
| `farFootprint` | 200 → 400: 0.41%, 4.24%. 400 → 800: 0.01%, 7.23%. 800 → 1,600: 0.01%, 0.01%                                                  | 800, set by Retina; at 1080p 200 would pass        |

The same campaign ran the three instruments on that code, kept beside its
tables as `choices-2026-11-10T11-49-33Z-*.json`. The far comparison now scores
the atlas at the default footprint. Footprint-averaged radiance error, the
atlas alone against the fine march, with the cloudy bins:

| Case                | 400 m     | 800 m      | 1,600 m    |
| ------------------- | --------- | ---------- | ---------- |
| Cirrus over cumulus | 1.647, 60 | 0.903, 102 | 0.901, 170 |
| Broken cumulus      | 0.518, 70 | 0.280, 120 | 0.769, 190 |
| Anvil               | 1.627, 28 | 1.566, 44  | 1.213, 77  |
| Grazing at sunset   | 0.618, 4  | 1.518, 10  | 2.269, 20  |

There is no spheres column at 800 m, so these rank nothing. The sun-accuracy
document on that code is the grid's figures in the table above, unchanged.

**What the landed ladders still do not cover:** an orbit stance, where the
landed `orbit` still draws almost none of campaign 1's cloud texture (above);
a rung of `lightTaps` above 4; and any stance but `horizon` and `inside`.

Phase 1 takes all three ladders again, with more rungs and an orbit stance.

#### The passes, by the timeline

Shares from `ir.passes` on the candidate's frames, in ms, for `(field, grid)`
in campaign 1. The landed frame's are beside them.

| Pass              | Plan's target           | 1080p: `horizon` / `inside` | Retina: `horizon` / `inside` | Landed, `ground`, 1080p / Retina |
| ----------------- | ----------------------- | --------------------------- | ---------------------------- | -------------------------------- |
| `cloud maps`      | ≤ 0.05 with the clipmap | 0.03 / 0.04                 | 0.04 / 0.04                  | 0.05 / 0.05                      |
| `cloud clipmap`   |                         | 0.00 / 0.00                 | 0.01 / 0.00                  | 0.01 / 0.00                      |
| `cloud volume`    | ≤ 0.2                   | 0.22 / 0.18                 | 0.23 / 0.19                  | 0.23 / 0.25                      |
| `cloud sun grid`  | ≤ 0.3                   | 0.45 / 0.46                 | 0.42 / 0.46                  | 0.43 / 0.43                      |
| `cloud far atlas` | ≤ 0.1                   | 0.86 / 1.28                 | 0.93 / 1.30                  | 0.90 / 0.91                      |

The volume's bound map, 0.04 to 0.05 ms in those rows, is gone with the
volume's march. As landed, the reset frame on `horizon` is the cut, 20.30 ms
at 1080p and 22.14 at Retina, of which the grid's rebuild is 12.26 and 12.33.
Over the ground stances the grid takes 9.11 to 16.82 ms of a cut. The fly
frames are 6.85 and 8.70 ms on `ground` and 2.18 and 4.08 from orbit, 1080p
then Retina. Each of those is the retake at `f9746fd3`
([`targets-retake-2026-11-10T12-25-50Z.md`](../../design/plans/weather/phase0/measurements/targets-retake-2026-11-10T12-25-50Z.md)):
campaign 2's forced rows ran through the moon's lens (ADR-0063, What was
measured). The far atlas is 0.80 to 1.59 ms on every landed steady row, the
most under `decks`.

#### The fetch rate

A sweep kernel at constant work: every ray takes a fixed number of 4 m steps,
does not stop or exit, reads no sun, air or far field, and makes a set number
of fetches of the base noise a step. 72 cells a size, each accepted only after
its step counter read the fixed count. A least-squares fit of
`ms = α·rays + β·rays·steps + γ·rays·steps·reads`:

| Size   | Format | α, ns a ray | β, ns a ray-step | γ, ns a fetch | Residual, ms | Fetches a second, 1/γ |
| ------ | ------ | ----------- | ---------------- | ------------- | ------------ | --------------------- |
| 1080p  | R8     | 0.052       | 0.0213           | 0.0083        | 0.069        | 1.20 × 10¹¹           |
| 1080p  | RGBA8  | 0.083       | 0.0209           | 0.0083        | 0.061        | 1.20 × 10¹¹           |
| Retina | R8     | 0.050       | 0.0230           | 0.0084        | 0.044        | 1.19 × 10¹¹           |
| Retina | RGBA8  | 0.028       | 0.0229           | 0.0088        | 0.053        | 1.13 × 10¹¹           |

- γ is a rate because it is one read type: the 128³ base noise, which sits in
  cache. Each other type's marginal cost at one read, in ns a ray-step, 1080p
  then Retina: the clipmap 0.0019 and 0.0017, the profile 0.0021 and 0.0008,
  the detail noise 0.0018 and 0.0028, the curl 0.0037 and 0.0028, a second
  clipmap level 0.0070 and 0.0067.
- **R8 against RGBA8 is no difference:** −0.0002 and 0.0000 ns a fetch at two
  and four reads at 1080p, −0.0003 and +0.0003 at Retina.
- β is 2.5 to 2.7 times γ: a step's own arithmetic costs more than one more
  fetch of the base noise.

## Alternatives considered

**The local volume as the march's cache.** One read a step and empty space
skipped by max mips, bricks of 4³ dilated by a texel so no ray direction skips
a cloudy corner. It draws a different horizon, 6.3 to 6.9% from the field's,
with the jitter held or moving, and what in the picture differs is not
isolated. It is 0.8 to 1.5 ms cheaper under a clear sky and 0.3 to 1.0 ms
dearer with cloud in view.

**Sun-space cascades.** Three 512² RGBA16F Beer shadow maps at 12.8, 51.2 and
204.8 km, scrolled toroidally, with the front depth stored as a pair of half
floats because one half float rounds by ±0.5, ±2 and ±8 optical depths at the
cascades' far edges. They cost up to 0.20 ms less a steady frame than the
grid, 8.5 MB less, and half its reset frame. A texel holds one front depth,
one mean extinction and one maximum optical depth, which is one slab along
the sun's ray, and the case they miss is the one with two separated layers
and a low sun: 0.492 RMS, biased by −0.321.

**One channel a cell.** A cell of opacity alone hands the light after first
order the depth of the mean transmittance, the shallower of the two means:
2.27 against 2.12 RMS through four taps in a climate's low level at 45°, and
4.77 against 2.58 at a sample the early out skipped. A cell of depth alone
darkens every cloud's edge for a cell's width. The second channel costs
1,048,576 B and no fetch.

**64 heights in the grid.** Halving the spacing between heights moves the
union's depth by +0.11 and −0.08 where the rule asked 0.4 lower, for
2,097,152 B more, the last claim on the census's room, and twice the grid's
slices a rebuild. The count is a handle
(`CloudSunGrid.heights`) the instrument scores under `IR_CLOUD_SUN_HEIGHTS`.

**The volume's 50 m level.** It costs 4,456,448 B and 34 slices a rebuild,
and buys no row more than 0.0006 RMS over the instrument's reach and 0.0104
inside 4 km.

**The depth formed at its first read, and the depth held up front.** Held
with the sun's other members whether or not a march reads it, the depth's far
end is a fetch Three emits whether or not anything reads it: a program that
reads `cloud` alone fetches the grid six times in its WGSL where it fetched
two, and one such form cost the overcast from 150 km +5.5%, 6.31 ms at load 7
to 8. Formed lazily where it is first read, it escapes the block that formed
it: three forms were built and each was refuted by a CPU build of the WGSL,
through a read in a sibling branch, through a memoized `Fn` called from two
branches, and through a loop that runs no turn, each handing the reader a
depth of zero or of the taps alone. A depth asked for when the sun is formed
is held in that block, so no read can stand outside it, and a read nobody
asked for fails as the program is built rather than reading zero.

**Spheres at the layers' heights.** A cube atlas of fraction, column optical
depth and a cached sun transmittance for each layer, met at two crossings a
layer. Indistinguishable from the atlas in cost, twice its bytes, and 2.087
against 0.339 on a grazing ray at sunset, the case in which a ray runs along
a layer the spheres meet at two points.

**The volume's coarse levels carried to the planet.** Decided by its memory,
above.

**Reading the cube every step.** The cube is the field's source and covers
the body. Its texels are 19.5 km on Earth, and binding it beside the clipmap
does not fit the trace's 16 sampled textures. The clipmap is baked from the
cube, and the march reads the clipmap.

**A fixed in-cloud step.** A step of a few meters takes thousands of steps
through a grazing cirrus. The in-cloud step is 0.3 of an optical depth,
floored at 3 m plus 60 m per 16 km of distance.

**`r8unorm` storage textures written by compute.** One kernel a noise, no
slices. It needs `texture-formats-tier1`, an optional feature, for a bake that
runs once.

## Consequences

- One field is read at every distance, and each cache is baked from it: the
  clipmap from the cube, the volume and the atlas from the field. Nothing is
  authored beside it.
- **A rebuild is spread over 29 frames at the defaults,** and until the grid
  is whole its weight hands the sun's depth to the layers' statistics. At 1×
  under two decks at a 37.5° sun the volume bakes 0.31 slices a frame and the
  grid 0.12.
- **Under the game's own time warp the rebuild is every frame.** Outside the
  `warp` lever, a frame is a jump when the world's step exceeds the frame's
  by more than a second, so at 60 Hz every frame from 100× up (at 120 Hz from
  1,000×) takes the reset path: the immediate regime and a whole grid. On
  Earth's day the sun turns 0.05° a frame from about 720× at 60 Hz, which
  rebuilds the grid every frame by itself. No warp row was recorded: the
  `targets` batch runs `steady`, `cut`, `scrub` and `fly`.
- **The sun's depth misses its 3% in most cases.** At four taps 8 of the
  instrument's 18 rows stand within it, and the worst, cirrus over
  cumulus under a −1.5° sun, is 0.0888 off.
- **The depth the light after first order reads is not a transmittance.**
  `e^(−mean depth)` is darker than the mean transmittance, so first order
  keeps the opacity. The mean depth is biased: +0.25 to +0.87 through four
  taps in a climate's two low levels and in fair cumulus at 15°, and −0.20 in
  fair cumulus at 45°.
- **A march that asks for the depth pays its fetch** whether or not it reads
  it, and a march that reads it without asking does not build.
- **From orbit the fine march's sun past its taps is the layers'
  statistics.** The grid's window is 25.6 km, and past its reach the weight
  is zero.
- **Under the horizon the far crossing is declared at two places of five,**
  where it is the far field's spread, a level's statistics at a place. At the
  other three, and in dusk altocumulus, the error is the bake's near part,
  and a plate of a base lit from under the horizon decides whether the
  bake's steps there change.
- **The frame still lays out a 50 m level** that the volume does not hold.
- **The far field lets through more light than the fine march, and is not
  shown better than the spheres at the default footprint.** Its mean
  transmittance is 1.5 times the reference's over broken cumulus and 9.5 times
  on a grazing ray at sunset. The decision is the rule's, at 400 m, and is
  provisional at the 800 m default.
  `cloudFarCompare` stays in the tree as an instrument of the atlas, and it
  runs again when phase 1 changes the far march.
- **The volume costs 8.9 MB to feed the grid.** A grid summed through the
  field itself was not built.
- **The far atlas's bake is 0.80 to 1.59 ms every frame** as landed, and 0.86
  to 1.30 in campaign 1, against a target of 0.1 with the reflection probe. It draws one 192² block a frame whatever the
  frame's budget, at 16 sub-columns by 8 heights a texel.
- **The clipmap bakes four targets and the march reads one.** Coverage is the
  first; the optical depth, the convective share and the wind are baked and
  have no reader in phase 0.
- **The handover is a switch, not a fade.** Where the two marches disagree the
  ray shows it at one distance. The cross-fade with hysteresis is phase 1's.
- The losers are in the branch's history. Campaign 1 measured them at
  `8a01d311`, and `25df44ab` is the last commit that holds every candidate.
  The spheres go in `c32825bd`, the volume's march and the cascades in
  `c5bfde9e`, and the sweep with its RGBA8 noise in `b7ccee6d`.

## Related

- The maps: [`cloudMaps.ts`](../../apps/game/src/render/cloudMaps.ts),
  [`cloudClipmap.ts`](../../apps/game/src/render/cloudClipmap.ts). The field
  and its three media:
  [`cloudDensity.ts`](../../apps/game/src/render/cloudDensity.ts),
  [`cloudField.ts`](../../apps/game/src/render/cloudField.ts). The sun:
  [`cloudVolume.ts`](../../apps/game/src/render/cloudVolume.ts),
  [`cloudSunGrid.ts`](../../apps/game/src/render/cloudSunGrid.ts),
  [`cloudSunlight.ts`](../../apps/game/src/render/cloudSunlight.ts). The far
  field: [`cloudFarAtlas.ts`](../../apps/game/src/render/cloudFarAtlas.ts).
  The budget:
  [`packages/rendering/src/cloudBudget.ts`](../../packages/rendering/src/cloudBudget.ts).
- The instruments, opt-in by `IR_CLOUD_MEASURE=1`: `cloudFarCompare.gpu.test.ts`
  and `cloudSunAccuracy.gpu.test.ts`. The runner and its batches:
  [the harness guide](../guides/harness.md#measuring-the-weather).
- [ADR-0063](0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md):
  the passes that read these, and the frame's totals.
  [ADR-0066](0066-the-droplets-phase-is-lorenz-mie-at-one-narrow-width-generated-offline.md):
  the phase table.
  [ADR-0056](0056-the-air-is-measured-and-its-gain-is-pi.md): the air the
  light taps read the sun through.
- The decision rules, fixed before measuring:
  [phase 0's design](../../design/plans/weather/phase0/design.md), §8.7.
  What is left: [the weather plan](../../design/plans/the-weather.md).
