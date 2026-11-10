# ADR-0063: The weather draws between a scene pass under the clouds and one over them, on compute passes the timeline names

Status: accepted · 10 Nov 2026. The frame of the weather plan's phase 0, built
on [ADR-0044](0044-the-sensor-reconstructs-the-display.md)'s scene pass and in
[ADR-0056](0056-the-air-is-measured-and-its-gain-is-pi.md)'s air. What the
passes read is
[ADR-0064](0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md).
Nothing here exists without `?clouds=1`, and nothing draws until
`engine.clouds.on` is set. What it draws is a placeholder: the density is
uncalibrated and the light is first order, so the figures below are costs and
errors of the passes, and no image says how a cloud looks.

## Context

A volumetric cloud has to be drawn after everything it can stand in front of —
the ground, the sea, the sphere, the atmosphere's shell, the sun's disk — and
before everything drawn over it: rings, plumes, entry and orbit traces, the
flare. The sea is in the way. It is transparent, draws after every opaque, and
writes the depth a cloud ray stops at, and three's `PassNode` exposes no point
between the sea and the world's transparency at which a trace, a history and a
composite could run.

There are two ways through, and a third that rides on the second.

- **A, two scene passes.** Everything under the clouds, then the cloud passes
  and the composite, then everything over them in a second pass that loads the
  first's target.
- **B, a hand-rolled split.** End the scene pass after the sea, submit what
  its encoder holds, run the cloud passes, and resume the pass on a fresh
  encoder written into three's render context.
- **C, riding the sea's own split.** The sea already ends and resumes the
  pass to copy the frame behind it. The cloud passes would run in that break.

Each break of the scene pass stores and reloads every sample of every
attachment, and the scene's target is multisampled, so the break itself has a
price that only the hardware can state.

The scene the clouds are composited over is not bare. Every pixel already
carries the air between the eye and its surface, `scene = L_a(0, D) + T_a(0, D)·S`,
from one of two marches: the shell's, where the pixel is sky, or the surface's
own. A composite that adds a cloud's air beside that draws a band around every
cloud.

Three more constraints shape the passes. The trace writes 72 bytes a texel,
which no 32-byte MRT holds. A WebGPU stage binds 16 sampled textures and 4
storage textures by default, and three asks for no more. And three's
`StorageTexture` allocates a mip chain and regenerates it with unnamed raw
passes after every compute write.

Phase 0 built A and B whole, priced C with B's split run empty, measured them
on the Mac mini by a rule fixed before any figure existed, and deleted B. The
rule's GPU clause keeps A. Its CPU clause, as fixed, fires in two cells, and A
stands as the exception §8.7 allows only with figures, provisional on the CPU
evidence (The placement, below).

## Decision

**The scene is drawn in two passes on every frame the clouds draw: everything
under the clouds on camera layer 0, then everything over them on layer 1,
loaded onto the same target. The frame's cloud work runs from one node inside
the second pass, the trace and the history are compute passes the timeline
names, and the composite adds the cloud to the air each pixel already
carries.**

### The two passes, and the OVER layer

- **Layer 1 is everything drawn over the clouds** (`render/cloudLayers.ts`,
  `OVER_CLOUDS_LAYER`). `markOverClouds` sets it on an object and every
  descendant, a `Group` included: a group that fails the layer test sets no
  order for its children, so marking only the meshes reorders them. The marked
  objects are the rings, the entry traces, the orbit traces, the plumes, the
  flare, the warp, the reentry sheath and the pad dust.
- **On a frame the clouds draw,** the scene pass takes layer 0 alone
  (`scenePass.setLayers(UNDER_CLOUDS_LAYERS)`), and `CloudOverPassNode`
  renders the scene again with the camera on layer 1 alone, `autoClear` off,
  into the scene pass's own target and MRT (`render/cloudOverPass.ts`). Load
  ops for color and depth follow from `autoClear` off, so the overlays land on
  what the first pass drew and are depth-tested against it. The pass is named
  `scene over clouds` on the timeline. One target and one MRT object make the
  two passes one render context, so an overlay draws with the pipeline its
  boot warm-up built.
- **The second pass sits in the sensor's dependency sum** right after the
  scene's term and before the upscaler and the optics. Its node is `vec4(0)`:
  it is there for its order and binds nothing.
- **On any other frame there is one scene pass.** `setLayers(null)` returns
  the pass to the camera's own mask, which tests both layers, and the second
  pass is inactive.
- **The marks, the camera's mask and the lights' masks exist only under the
  flag.** Without `?clouds=1` nothing is marked. With it, the camera tests
  layer 1 from its creation, in `<Canvas onCreated>`, because `compileAsync`
  drops an object whose layers the camera's do not test: a mask the camera
  learns of later leaves every boot warm-up compiling nothing on a marked
  object, and its pipelines build on its first drawn frame. The lights test
  every layer, because three keeps a light in a render's set only when its
  layers pass the camera's: a light on layer 0 alone leaves the second pass
  dark, and every overlay builds a second, unlit pipeline there.
- **A served body's deck yields.** When the lever serves a body that has a
  cloud deck, that deck hides, read off the last frame's report. `deck:
'hidden'` hides every deck whatever `on` is, which is how Earth's cost is
  priced against the deck it replaces.

### One node drives the frame's cloud work

- **`CloudFrameNode` lives in the composite's material**
  (`render/cloudFrameNode.ts`). Its `updateBefore` runs at the composite's
  draw, which is the first draw of the second pass, and issues every cloud
  pass there. Each is an ordinary three render or compute with its own
  encoder, submitted as it finishes, so the GPU runs them after the first
  scene pass and before the second's own draws. The trace therefore reads
  this frame's depth, with the sea in it.
- **It is inert outside a frame.** `compileAsync` runs `updateBefore` while
  warming, and a warm-up must run no cloud work.
- **It puts the renderer back after a throw.** `keepRenderer` restores the
  render context, the call depth, the target, the MRT and `autoClear`. With
  the restore removed, the second pass's overlays land nowhere.
- **Per-frame state is built inside `sensor.render()`,** in `beginFrame`,
  after the exposure is known and before the upscaler's jitter goes on. So
  `ir.gpu()` and `ir.passes()`, which hold the loop and call the chain,
  measure real work with live uniforms. A held loop never cuts, scrubs or
  flies, so the `force` lever makes held frames take those paths: `reset`,
  `cut`, `scrub`, `warp` and `fly`.

The frame, as the timeline names it:

```
scene                      layer 0: backdrop, spheres, ground, hull, sea, shells
  scene after copy         the same pass, resumed after the sea read the frame behind it
scene over clouds          layer 1, loaded onto the scene's target; inside it, before its first draw:
  cloud maps               quad    one face tile of the weather cube
  cloud clipmap            quad    strips of the clipmap
  cloud volume             quad    8 slices
  cloud sun grid           quad    4 slices
  cloud far atlas          quad    one block
  cloud far second         quad    one block, with a second clouded body
  cloud depth              quad    the scene's depth, as distance along each ray
  cloud trace              compute a quarter of the display's axes
  cloud history            compute a half
  the composite, then the rings, traces, plumes, flare, warp, sheath and dust
upscaler, optics, canvas
cloud residual             compute, after the frame, under composite: 'residual'
```

A steady frame is 19 passes more than a frame without clouds. A frame that
rebuilds everything is about 80 more: the clipmap in 3, the volume in 34, the
grid in 32, and the trace and the history four times each.

### Compute for the trace and the history, quads for the bakes

- **The trace, the history, the step counter and the residual meter are
  compute passes,** each named with `ComputeNode.setName`. A compute stage
  reads every texture at level 0 by construction, and the trace's 72 bytes a
  texel go to four `rgba16float` storage textures.
- **Every storage texture is made by one helper,** `cloudStorageTexture` in
  `render/cloudNodes.ts`, which turns `generateMipmaps` off. Three's default
  at 16 × 16 has 5 levels and spends 4 passes regenerating them after each
  write.
- **The depth copy and every bake are fragment quads** through
  `runQuadPasses`, each its own named pass with its own timestamp pair.
- **Every read inside a loop names its level.** Three turns WGSL's
  derivative-uniformity check off outside Firefox, so a plain `sample()` in a
  loop compiles on Chrome with an undefined result. GPU tests compile the
  media and the march as fragment materials and fail on a bare
  `textureSample(`, beside a variant with one plain read that shows the
  assertion can fail.
- **The trace is at a quarter of the smaller of the render and CSS axes,**
  long edge at most 480: 480 × 270 at 1920×1080 and 360 × 225 at 2880×1800.
  It binds 12 of the stage's 16 sampled textures and writes all 4 storage
  textures. The history is at twice that.
- **The trace's steps** start at 50 m out of cloud and grow 1% a step to 1 km.
  In cloud a step is 0.3 of an optical depth, floored at 3 m plus 60 m per
  16 km of distance. A step never crosses a layer's boundary, and a ray exits
  once its transmittance falls under 1%. A layer's partial cover mixes once a
  segment, maximum-random: the clear share passes and the cloudy share goes
  through the segment's whole depth. A GPU test holds a layer's transmittance
  and light unchanged as its steps are split.
- **The history** reprojects through the cloud's own depth in body-fixed axes,
  with the wind applied first, and keeps a texel only when the frame does not
  contradict it: parallax, the kept depth, and the scene's depth now in front.
  It clips radiance and transmittance to the 3 × 3 neighborhood's variance and
  guards every read and write against a non-finite value. A stride-2
  interleave refreshes each history pixel every fourth frame.
- **Jitter** is interleaved gradient noise with an R1 frame offset behind
  `traceJitter`, standing in for a spatiotemporal blue-noise mask.

### The immediate regime

After a cut, a scrub, a resize or a jump there is no history to converge on.
**The frame then traces every history pixel in four dispatches,** one for
each interleave phase, each at the trace's own extent and a quarter of
`maxSteps`, each followed by a history kernel that writes that phase's pixels
fresh. Every history pixel is written exactly once and nothing is written
outside a texture.

### The composite

The trace outputs three things relative to the span's start `t₀`: the cloud's
own light `L_c`, attenuated by the air in front of it inside the span; its
transmittance `T_c`; and the **blocked air** `B`, the air light behind cloud
that the cloud hides, which is negative or zero. The composite draws

```
identity:  out = T_c·scene + (1 − T_c)·L_a(0, t₁) + T'_a(0, t₀)·L_c + T_a(0, t₀)·B
thin:      out = T_c·scene + (1 − T_c)·L_a(0, d₁) + T'_a(0, t₀)·L_c
```

premultiplied over the scene, with `d₁` the cloud's mean depth.

- **No cloud, no change.** With `T_c = 1` and `L_c = B = 0` the source is zero
  and the pixel is the scene's, bit for bit, whatever the air's quadrature and
  whatever the exposure. A GPU test holds it after `setSceneExposure` at a
  gain other than 1.
- **The class is the shell's own depth test.** A pixel is sky where the
  scene's depth lies at or past the air's outer far wall, within 2 × 10⁻³, or
  at the depth copy's clamp. It is never tested against the shell's ground
  branch: the drawn sphere's facets are inscribed, up to about 120 m inside
  the analytic sphere on Earth, so against that branch every sphere pixel seen
  from orbit reads as sky, speckled where rounding crosses back. The trace
  classes its own texel by the same test.
- **The composite reproduces the air the pixel already carries, by class.** A
  sky pixel takes the shell's rule: no beam clearing, the physical
  transmittance, six crowded samples on either side of `t₀` where the shell
  takes twelve. A surface pixel takes `airToward`'s rule: four and four, the
  beam cleared by `clearedFromOrbit·ORBIT_AIRLIGHT`, and the cloud's light
  dimmed by `T'_a = mix(T_a, 1, cleared)`, as a surface's is under Enhanced
  from orbit. `cloudCompositeAir.gpu.test.ts` holds each split march to
  `marchAir` over the same segment to 10⁻⁵.
- **`B` takes the class's beam and the physical transmittance.** The air it
  cancels was accumulated through the physical throughput in the scene's own
  march, so an opaque cloud at `t₀` gives `L_a(0, t₀) + T'_a·L_c` exactly.
  Dimmed by `T'_a` it subtracts more air than the scene ever drew, and built
  with the cloud's own beam it matches neither class: under Enhanced from
  orbit those differ by about 10% under a high sun and by more than 100% near
  the terminator.
- **Where the scene stands in front of part of the cloud, the share in front
  weights the whole cloud term.** Where no history texel's end depth matches
  the pixel's, the share of the cloud in front of the scene's depth comes from
  the trace's depth moments, a mean and a deviation of opacity-weighted depth,
  through a logistic that approximates the normal CDF. It multiplies the
  light, the blocked air and the opacity together. Applied to the
  transmittance alone it leaves `L_c` and `B` whole, and every ridge in front
  of distant cloud wears the cloud's light.
- **Beside `output`** the composite writes its opacity to `reactive` and its
  own motion, inverse view depth and opacity to `motion`, and leaves
  `meterMask` alone. It discards where nothing draws.
- **A second clouded body** is drawn in the composite by its far march alone,
  in the thin form, behind the served body's cloud.
- **`composite: 'residual'`** makes the composite inert and runs a meter after
  the frame, which reads the scene as built and histograms what the forms
  would have left. **The identity is the default everywhere.** The thin form
  is allowed in a regime only where its error against the identity is under 1%
  at the 95th percentile and under 5% at worst in every measured frame,
  Enhanced off and on. On the landed code that allows it from orbit and
  nowhere else (the residuals below). It draws a second clouded body's far
  march, and whether phase 1 draws `orbit` through it is phase 1's.

### The knots, and what a transparent object sees

The span's total cannot tell an object between two clouds what stands in
front of it, and a transmittance curve alone cannot say where the light came
from: a lit cloud in front of a dark one and the reverse draw the same curve.
**The trace writes four knots of a curve by depth,** each holding the
transmittance in front of it and the light the cloud scatters in front of it,
recorded where a segment closes under 0.98. `cloudFront(screen, distance)`
(`render/cloudFront.ts`) returns the pair at a depth. An additive object
multiplies its light by the transmittance; an alpha-blended one replaces its
color with `T·color + L` and keeps its alpha. `cloudFront.gpu.test.ts` puts
one of each between two independently lit slabs, lit in front and dark
behind, then the reverse, and holds both to the analytic value within 2%.

### What was measured

The machine is the Mac mini (Mac18,5, Apple M6, 32 GB, 12 cores), fan-cooled.
**Every figure here is that machine's.** The plan's budget basis is perf's
Apple M5, on which nothing in phase 0 was measured, and no factor between the
two is known.
The browser is Chrome 157.0.8103.40 on WebGPU over Metal, and the build is
production, served by the preview from a clean tree. The sizes are 1920×1080
at a device pixel ratio of 1 and 1440×900 at 2, a 2880×1800 buffer. The
picture is native with multisampling, and the camera is Enhanced. The world is
far-shore V, with the sun 37.5° up at the ground stances and 4.4° up under
`orbit`.

Three sets of rows decide the placement: campaign 1's at `8a01d311`, whose
tables are
[`choices-2026-11-10T05-25-52Z.md`](../../design/plans/weather/phase0/measurements/choices-2026-11-10T05-25-52Z.md),
and two repeats at `25df44ab`, with each cell's three samples in
[`placement-repeats.md`](../../design/plans/weather/phase0/measurements/placement-repeats.md). The two commits differ in
`scripts/clouds/` alone. Every
row that counts was measured on a quiet machine. A frame cost is `ir.gpu(120)`,
the least of three reads, clouds off against on, five pairs interleaved in one
boot; the spread is the pairs' own.

A figure called landed is campaign 2's, on the code after B went: commit
`bbea04da`, which differs from the landing's `d03b8420` in `scripts/clouds/`
alone, on the same machine, browser and sizes, with the landed defaults. Its
tables are [`landed-2026-11-10T09-05-32Z.md`](../../design/plans/weather/phase0/measurements/landed-2026-11-10T09-05-32Z.md),
and every pass's share of both campaigns' frames is in
[`passes.md`](../../design/plans/weather/phase0/measurements/passes.md). Each of its rows records the rate it presented
at: `memory` at 81 to 89 Hz at 1080p and 49 to 51 at Retina, `error` at 96 to
120 and 58 to 83. All 86 of its rows were measured quiet, each batch on its
first attempt.

**Campaign 2's `cut`, `scrub` and `fly` rows and its `pair-neighbor` rows were
taken again,** because they ran through the moon's lens: one page served every
far-shore run of a size, the `pair-moon` stance fits the flight lens to its
rise and keeps it, and a `visit` stance set none. The clouds-off base gives it
away: `ground` at 1080p read 5.87 ms steady and 6.92, 7.29 and 7.21 under
`cut`, `scrub` and `fly`. The runner's stances now start from the preset's
picture, and the retake at `f9746fd3`, whose frame differs from `bbea04da`'s
only in what a frame whose cloud work throws draws, ran each of those rows
again with `pair-moon` first at each size as the control. `pair-neighbor`
right after it reads a base of 5.88 ms, against `ground`'s steady 5.87, and
every forced row's base is within 0.62 ms of its scenario's steady one, where
campaign 2's were up to 4.27 ms off it. Its
tables are
[`targets-retake-2026-11-10T12-25-50Z.md`](../../design/plans/weather/phase0/measurements/targets-retake-2026-11-10T12-25-50Z.md):
40 of 40 runs quiet, at 104 to 120 Hz at 1080p and 64 to 120 at Retina. Every
`targets` figure here is campaign 2's steady and Earth rows and the retake's
forced and `pair-neighbor` rows.

#### The placement

The rule, fixed before measuring: A wins unless B's steady frame is cheaper by
more than 0.2 ms at Retina on two of `horizon`, `inside` and `orbit`. A also
loses on the CPU, if its `sensor` span's mean exceeds B's by more than 0.3 ms
on any of the three at either size, or its late frames over a 3 s window
exceed B's by more than 2 on `horizon` or `inside`.

Steady cost of the clouds against clouds off, ms, B then A, campaign 1 with
the spread:

| Scenario  | 1080p: B / A              | Retina: B / A             | The split run empty, 1080p / Retina |
| --------- | ------------------------- | ------------------------- | ----------------------------------- |
| `horizon` | 4.91 (0.04) / 4.91 (0.02) | 6.79 (0.47) / 6.88 (0.05) | 1.04 (0.08) / 2.45 (0.03)           |
| `inside`  | 5.12 (0.05) / 5.14 (0.07) | 7.98 (0.07) / 8.00 (0.08) | 0.98 (0.10) / 2.42 (0.02)           |
| `orbit`   | 3.08 (0.04) / 3.08 (0.03) | 5.66 (0.02) / 5.66 (0.01) | 1.02 (0.01) / 2.49 (0.03)           |

**B is cheaper nowhere.** Its largest lead is 0.09 ms, on the one row whose
spread is 0.47. The two repeats read the same: at Retina, B then A, 6.87 and
6.90 against 6.90 and 6.92 on `horizon`, 7.85 and 7.98 against 7.87 and 8.01
on `inside`, 5.67 and 5.69 against 5.67 and 5.68 on `orbit`. Across all three
sets no cell moves by more than 0.14 ms.

**The CPU clause, as fixed, fires in two cells.** Each cell has three samples:
campaign 1's row and two repeats. Clouds on, A against B:

| Cell              | `sensor` mean, A − B, each sample, ms | Their mean, ms | Late frames in 3 s, A / B, each sample | Fires as fixed                          |
| ----------------- | ------------------------------------- | -------------- | -------------------------------------- | --------------------------------------- |
| `horizon`, 1080p  | +0.28, +0.10, +0.10                   | +0.16          | **18 / 0**, 0 / 0, 0 / 0               | **Late frames, in campaign 1's sample** |
| `inside`, 1080p   | −0.18, −0.03, +0.21                   | +0.00          | 1 / 0, 0 / 0, 0 / 0                    | No                                      |
| `orbit`, 1080p    | +0.09, +0.22, −0.23                   | +0.03          | 0 / 0, 0 / 0, 0 / 0                    | No                                      |
| `horizon`, Retina | −0.29, −0.27, +0.17                   | −0.13          | 0 / 0, 0 / 0, 0 / 1                    | No                                      |
| `inside`, Retina  | **+1.51, +3.51, +4.64**               | **+3.22**      | 21 / 28, 20 / 19, 25 / 25              | **`sensor`, in every sample**           |
| `orbit`, Retina   | −0.31, −0.22, +0.01                   | −0.17          | 0 / 0, 0 / 0, 0 / 0                    | No                                      |

- **At Retina inside a cloud, A's `sensor` mean is above B's in all three
  samples:** 10.71, 13.63 and 11.57 ms against 9.20, 10.12 and 6.93, which is
  ten times the clause's 0.3 ms on their mean.
- **On `horizon` at 1080p, campaign 1's sample counts 18 late frames under A
  against none under B,** which is the late-frame clause's 2 nine times over.
  Neither repeat counts one under either placement.
- **This record first read the clause with two conditions §8.7 does not
  state:** the `sensor` clause only where A's mean also exceeds twice the
  larger of the two placements' sample standard deviations, and the
  late-frame clause only where A's median exceeds B's by more than 2 and A's
  least exceeds B's greatest. That reading was fixed after campaign 1's result
  was in hand and before the repeats arrived. Under it no cell fires, and
  Retina inside a cloud clears by 0.06 ms: 3.22 against 3.28, on samples
  pooled across two presentation rates. On the paired differences' own
  standard deviation, 1.58 ms, twice is 3.17, and the cell does not clear.

**A stands as an exception, provisional on the CPU evidence.** The figures
that argue for it:

- **The GPU cost is equal.** B is cheaper in no cell by more than the
  resolution, above.
- **The longer span is not shown to cost a frame.** In the cell where the
  `sensor` clause fires, A delivers 132, 133 and 132 frames in the 3 s window
  against B's 130, 131 and 130, and its late frames, 21, 20 and 25, are no
  worse than B's 28, 19 and 25.
- **The 18 late frames did not recur.** Both repeats of that row count 0
  under A and 0 under B.
- **The 1080p cells show no difference in the span:** the three means are
  +0.16, +0.00 and +0.03 ms.
- **B's own defects stand.** It draws the instruments' inks under the clouds
  (Alternatives, below), and it reaches under three's public surface. The
  rule's GPU clause prices the two at 0.2 ms.
- **The second traversal is not needed on a frame with nothing drawn over the
  clouds,** and phase 1 takes it off those frames (Consequences).

Phase 1 takes the Retina `inside` cell again at one presentation rate, and
both placements exist at `25df44ab` for it.

- **The three samples a cell are two presentation rates.** Campaign 1's
  profiles all ran capped at 60 frames a second: the clouds-off side delivered
  179 to 182 frames in every 3 s window at both sizes. The repeats, started by
  hand, ran the same clouds-off frames at 109 to 120 a second at 1080p and at
  64 to 78 at Retina, which is the GPU's own pace there. The `sensor` span and
  the late-frame count follow the rate: a clouds-off `horizon` at 1080p is 6.80
  to 7.12 ms in the campaign and 3.05 to 3.07 in the repeats. `ir.gpu`'s
  difference does not. **The cause of the cap is not established:** neither a
  dark display nor a campaign's detached launch reproduces it.
- **On the two repeats alone the `sensor` clause still fires** at Retina
  inside a cloud, +3.51 and +4.64 ms, and the late-frame clause fires nowhere.

**C is reconsidered in phase 1.** The rule sends it there if the split run
empty costs over 0.1 ms at Retina, and it costs 2.42 to 2.49 ms, and 0.98 to
1.04 at 1080p.

#### The frame's passes

Shares from `ir.passes`, ms. The first two columns are campaign 1's rows under
A, which ran the cascades for the sun's depth, `lightTaps` 2 and `farFootprint` 400. The landed frame takes four taps from the grid and hands over at 800 m,
so its trace is not expected to equal these; the second pass, the history and
the depth copy read none of the three.

| Pass                   | Plan's target                         | 1080p: `horizon` / `inside` / `orbit` | Retina: `horizon` / `inside` / `orbit` | Landed, `ground`, 1080p / Retina |
| ---------------------- | ------------------------------------- | ------------------------------------- | -------------------------------------- | -------------------------------- |
| `cloud trace`          | ≤ 1.2                                 | 1.79 / 0.92 / 0.10                    | 1.41 / 0.60 / 0.07                     | 3.72 / 3.09                      |
| `cloud history`        | ≤ 0.3                                 | 0.28 / 0.28 / 0.27                    | 0.17 / 0.18 / 0.17                     | 0.27 / 0.18                      |
| `scene over clouds`    | ≤ 0.3, with the depth copy            | 1.53 / 2.09 / 1.74                    | 3.89 / 5.05 / 4.34                     | 1.70 / 4.15                      |
| `cloud depth`          |                                       | 0.10 / 0.09 / 0.12                    | 0.22 / 0.23 / 0.27                     | 0.11 / 0.28                      |
| **The clouds, steady** | ≤ 2.9 on the ground, ≤ 1.6 from orbit | **4.91 / 5.14 / 3.08**                | **6.88 / 8.00 / 5.66**                 | see below                        |

- **In campaign 1 the second scene pass is the largest cloud cost in the
  frame:** 31 to 56% of the clouds' cost at 1080p and 57 to 77% at Retina. A
  break with nothing drawn in it, which is what the split run empty prices, is
  1.0 and 2.4 ms.
- **As landed, with four taps, the trace overtakes it at 1080p** on `ground`,
  `horizon`, `decks` and both pairs: 3.72 ms against 1.70 on `ground`, and up
  to 4.75 against 1.96 on `pair-moon`. Inside a cloud and from orbit the second
  pass is still the larger at 1080p, and at Retina it is the largest pass on
  every steady row, 3.88 to 5.32 ms.
- **The trace costs no more at Retina than at 1080p,** because it follows the
  CSS axes: 3.09 ms against 3.72 on the landed `ground`. What grows with the
  buffer is the second scene pass and the depth copy.
- **In the immediate regime the four trace dispatches cost 2.4 to 2.5 times
  the steady one:** 4.40 to 4.53 ms on a cut of `horizon` at 1080p and 3.49 to
  3.85 at Retina, in campaign 1's rows that march the field.

The landed frame, the clouds against clouds off, ms, with the spread of the
pairs:

| Row                                                       | 1080p                   | Retina                  |
| --------------------------------------------------------- | ----------------------- | ----------------------- |
| `ground`, under cumulus, steady                           | 7.12 (0.02)             | 8.91 (0.46)             |
| `horizon`, steady                                         | 5.67 (0.02)             | 7.70 (0.04)             |
| `inside`, steady                                          | 5.07 (0.01)             | 7.70 (0.06)             |
| `decks`, steady                                           | 7.55 (0.01)             | 9.79 (0.06)             |
| `orbit`, steady                                           | 3.03 (0.06)             | 5.54 (0.02)             |
| Two clouded bodies, from the moon (`pair-moon`)           | 9.38 (0.02)             | 10.21 (0.01)            |
| Two clouded bodies, on the ground (`pair-neighbor`)       | 7.18 (0.07)             | 8.84 (0.27)             |
| A reset frame: the larger of `cut` and `scrub`, `horizon` | 20.30 (0.02), the `cut` | 22.14 (0.04), the `cut` |
| `fly` at 250 m/s, `ground`                                | 6.85 (0.16)             | 8.70 (0.34)             |
| `fly` at 7.7 km/s, `orbit`                                | 2.18 (0.29)             | 4.08 (0.27)             |
| Earth on the ground, against its deck hidden              | 6.19 (0.10)             | 7.83 (0.07)             |
| Earth's deck alone, on the ground                         | 0.06 (0.02)             | 0.02 (0.01)             |
| Earth from orbit, against its deck hidden                 | 3.00 (0.01)             | 5.57 (0.01)             |
| Earth's deck alone, from orbit                            | 0.13 (0.02)             | 0.30 (0.00)             |

Campaign 1's `ground` is a clear sky inside a cumulus field, cloud in 2.0% of
the trace's texels, and no rule read it. The landed `ground` stands one degree
north, under cumulus.

- **The scrub is the cheaper reset as landed:** 15.01 ms on `horizon` at
  1080p and 16.64 at Retina, against the cut's 20.30 and 22.14. Over the
  ground stances a cut is 19.40 to 24.68 ms at 1080p and 20.79 to 26.17 at
  Retina, and 35.10 and 30.64 with two clouded bodies from the moon.
- **With the clouds on, the frame is 11.92 to 12.99 ms at 1080p** on `ground`,
  `horizon` and `inside`, inside a 60 Hz frame, and **21.72 to 23.20 ms at
  Retina,** outside it. Clouds off, the same frames are 5.87 to 7.47 and 13.21
  to 15.50.
- **The four scenarios campaign 2 named as two operating points were the
  moon's lens, not the rate.** Its summary named `ground` and `horizon` at
  1080p and `decks` and `orbit` at Retina, each with rows at two rates, and the
  rows apart were the ones taken after `pair-moon`, which drew another lens's
  frame. With those rows retaken, no scenario's rows are two operating points.
  A Δ above is `ir.gpu()`'s, which does not follow the rate.
- No row forces `reset`, the immediate regime alone: `targets` runs `steady`,
  `cut`, `scrub` and `fly`. The four dispatches' share on a cut, above, is the
  figure for it.

#### Memory

The frame path's textures, declared from their dimensions and held to the
GPU's own figures by `cloudSystem.gpu.test.ts`:

| Texture                   | 1080p    | Retina   |
| ------------------------- | -------- | -------- |
| History, 48 B a texel     | 24.88 MB | 15.55 MB |
| Trace and its knots, 72 B | 9.33 MB  | 5.83 MB  |
| Depth copy, R16F          | 4.15 MB  | 10.37 MB |

The whole system's bytes are in ADR-0064.

#### Cold compile

Three boots with `?clouds=1` and three without, at each size, each on a
deleted Chrome profile. **The OS's Metal shader cache is not cleared:** it
lives outside the profile, in the user's cache directory, so each figure is a
fresh Chrome profile with the OS cache possibly warm.

| Figure                                                                               | 1080p                                                              | Retina                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| The whole warm-up, with the flag less without, the medians                           | +183.50 ms: 2,700.60 to 2,810.70 against 2,490.60 to 2,587.00      | −64.90 ms: 2,688.10 to 2,829.40 against 2,626.50 to 2,772.70 |
| The largest of the first five lever-on frames, against the median of the last thirty | 50.80 to 66.80 ms against 16.65 to 16.70, presented at 81 to 89 Hz | 75.00 to 92.50 ms against 25.00, presented at 48 to 51 Hz    |
| Pipelines the system holds, render and compute                                       | 10 and 8                                                           | 10 and 8                                                     |

Each figure is three boots a side, all quiet, and the ranges are the boots'.
A cold boot takes no stance: its first lever-on frame is read at the preset the
page boots to.

- **The flag's cost to the warm-up is inside the boots' own spread.** At 1080p
  every boot with the flag is slower than every boot without; at Retina the
  medians fall the other way.
- **The boot's `warming the clouds` span was not recorded.** The runner looks
  for it on the boot timeline, and the field is empty in all six boots with the
  flag, so the warm-up's difference is the only figure for it.
- **The first frames with the clouds on are a hitch:** the largest of the
  first five is 3.0 to 4.0 times the steady frame at 1080p and 3.0 to 3.7 at
  Retina. That is the size of the caches' first build, which a forced cut
  prices at 19 to 26 ms of GPU on the ground stances, and it is not shown to be
  a compile: no row times the two apart.
- Campaign 1's report, with every candidate's pipelines built, held 15 render
  and 17 compute.

`cloudWarm.gpu.test.ts` holds the first frame of every lever set to no new
render or compute pipeline. Three compiles a compute pipeline at its first
dispatch, so a census of render pipelines alone would pass with every kernel
compiling in the first frame. The first-frame figure is read as an interval
overrun and moves with the presentation rate; the row records its rate.

#### The composite's residuals

On analytic slabs (`cloudCompositeError.gpu.test.ts`, campaign 1's copy
[`choices-2026-11-10T05-25-52Z-compositeError.json`](../../design/plans/weather/phase0/measurements/choices-2026-11-10T05-25-52Z-compositeError.json)):
Earth's air, a slab of 5 km⁻¹ at 100 m, 500 m and 2 km thick, at five view
angles, against a 512-sample joint march of air and cloud. Relative luminance
error, the worst of the fifteen cases:

| Class, Enhanced's clearing | Identity | Thin   | The identity's algebra alone | Its quadrature residual |
| -------------------------- | -------- | ------ | ---------------------------- | ----------------------- |
| Surface, 0                 | 0.0088   | 0.0088 | 0.00008                      | 0.0088                  |
| Surface, 1                 | 0.0037   | 0.0038 | 0.0047                       | 0.0012                  |
| Sky, 0 or 1                | 0.0028   | 0.0028 | 0.0010                       | 0.0028                  |

- With no clearing the identity's algebra is exact, and what is left is
  quadrature: the composite's two segments against the scene's one march.
- With Enhanced's clearing on a surface the algebra is inexact by up to 0.47%,
  because `mix(T, 1, cleared)` does not compose over segments.
- **One slab cannot separate the two forms:** they agree within 0.0004
  everywhere here. They differ where cloud spreads along the span, which is
  the scene as built.

On the scene as built, the `error` batch: thin against the identity over cloud
texels, as the share over 1%, the 95th percentile and the worst; the
identity's light residual at the 95th percentile; and the cloud texels whose
class at the center of their trace footprint differs from the class at one of
its corners. Each cell is Enhanced off / on.

| Scenario                    | Size   | Thin, over 1% | Thin, 95th percentile | Thin, worst     | Identity's light, 95th percentile | Class disagreements |
| --------------------------- | ------ | ------------- | --------------------- | --------------- | --------------------------------- | ------------------- |
| `sunset`                    | 1080p  | 70.2% / 70.2% | 27.4% / 27.4%         | 100.0% / 100.0% | 0.4% / 0.3%                       | 288 / 287           |
| `sunset`                    | Retina | 70.0% / 70.0% | 31.6% / 31.6%         | 100.0% / 100.0% | 0.4% / 0.4%                       | 325 / 324           |
| `fog`                       | 1080p  | 39.3% / 39.5% | 4.2% / 4.2%           | 10.0% / 10.0%   | 1.2% / 1.2%                       | 126 / 112           |
| `fog`                       | Retina | 38.9% / 39.1% | 4.9% / 4.9%           | 11.5% / 15.4%   | 1.2% / 1.2%                       | 0 / 0               |
| `orbit`                     | 1080p  | 0.0% / 0.0%   | 0.1% / 0.1%           | 0.4% / 1.0%     | 0.4% / 0.9%                       | 433 / 433           |
| `orbit`                     | Retina | 0.0% / 0.0%   | 0.1% / 0.1%           | 1.0% / 1.8%     | 0.3% / 0.9%                       | 335 / 335           |
| `horizon` from a 2.4 km eye | 1080p  | 38.2% / 36.8% | 3.7% / 3.2%           | 20.5% / 17.8%   | 0.1% / 0.1%                       | 392 / 392           |
| `horizon` from a 2.4 km eye | Retina | 37.8% / 37.7% | 3.7% / 3.7%           | 17.8% / 17.8%   | 0.0% / 0.0%                       | 336 / 336           |

- **The rule allows the thin form from orbit and nowhere else.** From orbit
  its 95th percentile is 0.1% and its worst 0.4 to 1.8% in all four rows. At
  sunset, in fog and on the horizon from 2.4 km its 95th percentile is 3.2 to
  31.6% and its worst 10.0 to 100.0%, in every row. The identity's own light
  residual is 1.2% at the 95th percentile at worst, in fog.
- **"From orbit" is one stance:** `orbit`, 400 km over far-shore V with the sun
  4.4° up, at two sizes and two cameras. No other altitude, sun or body was
  measured, so the regime the rule names is that stance's.
- **A second clouded body always composites through the thin form**
  (`cloudComposite.ts`, the second body's branch), wherever the eye is: the
  neighbor's disk seen from the ground in `pair-neighbor` among them. That is
  a distant disk through near air, a geometry in none of the four scenarios
  above, so the `error` batch says nothing about it.
- **The ring Enhanced draws at sky pixels within 2° of the limb is dimmed by
  `T_c` even in front of a cloud:** from orbit under Enhanced its 95th
  percentile and its worst are both 100%, over 183 limb samples at 1080p and
  111 at Retina. Enhanced off draws no ring, and the limb reads 0.0%.
- **The display-referred pair is uncontrolled, and no figure here reads it.**
  The batch also compares a screenshot under the identity with one under the
  thin form, and the pair contradicts the meter in every scenario with
  Enhanced off. In fog at 1080p 42.0% of pixels differ by over 3%, where the
  meter puts 2.7% of cloud texels over 5%; on the horizon from 2.4 km at
  Retina it is 100.0% against 2.9%; from orbit the shots differ by 0.0680 RMSE
  at 1080p and 0.1114 at Retina, where the meter puts the thin form within
  0.1% at the 95th percentile. With Enhanced on from orbit they differ by
  0.0006 and 0.0007. The two shots are two frames, and nothing holds the
  automatic meter, the interleave's phase or the exposure between them, so
  the pair does not isolate the composite's form.

## Alternatives considered

**B, the hand-rolled split.** It ends the scene pass with a one-texel
framebuffer copy, submits the first half, swaps a fresh encoder into three's
render context and resumes. It was built, tested and measured, and is cheaper
in no cell by more than the resolution. It has a defect A does not: the
entry-trace inks are opaque, opaque instruments always draw before every
transparent object, and the composite must follow the transparent sea, so the
inks end up under the clouds. Making them transparent switches on
`Line2NodeMaterial`'s viewport read, which is another split. And it reaches
below three's public surface, the sea's class of internals plus one write,
which is the code a three upgrade breaks first.

**C, riding the sea's split.** It would save one break, and only on a frame
with the full sea in view. It reads a depth from before the sea's own write,
and it needs the cloud passes encoded on the scene's own encoder, which is raw
WebGPU. It was not built. Its saving is at most what the split run empty
costs, and that is 10 to 25 times the 0.1 ms under which it could not have
paid, so the rule hands it to phase 1 rather than closing it.

**A fragment pass with an MRT for the trace.** An MRT holds 32 bytes a sample
unless `requiredLimits` asks for more, and the trace writes 72. A fragment
stage also reads with implicit derivatives, and every read in the march's loop
would have to name its level.

**The immediate regime at the history's extent.** One dispatch over every
history pixel wants trace textures at the history's size, 28.0 MB more at
1080p and 17.5 MB at Retina, or it stores out of bounds. One kernel writing
the history and the knots together needs five storage textures where a stage
allows four.

**The class by the shell's ground branch.** It is the test that reads most
naturally, "did the ray hit the sphere", and it classes the whole disk as sky
from orbit.

**The cloud's own beam for the blocked air, or `B` dimmed as the cloud's light
is.** Each is one fewer thing to carry through the trace, and each is a bias
over every cloud that neither residual names.

**The depth-moment share on the transmittance alone.** It is the first reading
of the moments, and it lights every silhouette in front of distant cloud. The residual
meter cannot see it, because it runs with the composite inert, so a GPU test
holds it: a near opaque quad in front of a far slab reads back as the quad
alone.

**A second clouded body's far march in the sphere material.** One pipeline
serves every body's sphere, so a far march there is in every body's program.
In the composite it changes no sphere pipeline, and the cloud over the limb
comes with it. Whether it moves is phase 1's.

**Keeping the losers behind levers.** A selectable loser is a second model
kept alive, its pipelines compile at every boot, and its tests run in every
GPU suite. The branch's history holds them.

## Consequences

- **The clouds are not inside the plan's budget at either size.** As landed
  they cost 5.07 to 7.55 ms at 1080p on `ground`, `horizon`, `inside` and
  `decks`, 7.12 under cumulus, against the ground's 2.9, and 3.03 from orbit
  against 1.6; at Retina 7.70 to 9.79 and 5.54. Campaign 1, at its levers, read
  4.9 to 5.1 on `horizon` and `inside` and 3.1 from orbit. The second scene
  pass alone spends the orbit row. A frame with nothing drawn over the clouds
  needs no second traversal, and phase 1 takes it off those frames by drawing
  the composite as a term of the sensor's chain there; it also measures a
  second pass that drops its samples once resolved.
- **The first frames with the clouds on are a hitch** of 50.80 to 66.80 ms at
  1080p and 75.00 to 92.50 at Retina, the caches' first build. A reset plan
  that covers a cut has to cover the first frame too.
- **Every object drawn over the clouds has to be marked.** An overlay a later
  change forgets to mark draws in the first pass, under the composite, and is
  veiled by cloud it stands in front of. That is rule 69, and it applies only
  under the flag.
- **A is provisional on the CPU evidence.** The placement rule's CPU clause,
  as fixed, fires at Retina inside a cloud in all three samples and on
  `horizon` at 1080p in campaign 1's, and A stands as an argued exception
  (The placement). Phase 1 takes the Retina cell again at one presentation
  rate; both placements exist at `25df44ab`.
- **A reset frame is dear.** ADR-0064 has its figures: the grid's whole
  rebuild is most of it, and the four trace dispatches are the rest.
- **Declared, and not corrected in phase 0:**
  - **Velocity under temporal FSR.** The `velocity` row has no blend, so the
    composite writes its motion where it draws and discards where it does not:
    a threshold edge. Clouds do not ship under a temporal picture until the
    upscaler reads the masked `motion` instead.
  - **A hull carries no air of its own,** so a hull seen through thin cloud
    far off takes a residual of `T_c·L_a(0, t₁)`.
  - **Enhanced's ring in front of a cloud** is dimmed by the cloud's
    transmittance.
  - A sphere fragment's air ends on the datum under it, not at its sunk mesh's
    depth, and the shell's gray transmittance is not the product of its
    segments' means.
  - `cloudFront` returns span-relative quantities and ignores the air in front
    of `t₀`. Nothing in the scene calls it yet: the rings, plumes and traces
    draw over the clouds undimmed.
  - The deck's yield lags the served body by one frame.
- **Under a forced path the picture is wrong and the cost is real.** Under
  `fly` the rays and the caches follow a synthetic eye the camera does not.
  Under `cut` every frame is the first after a teleport, which bounds a real
  cut's later frames from above.
- **WebGL has no cloud system.** The sensor builds none, and the report says
  `available: false`, `reason: 'webgl'`.
- **The fine march takes a step's light source at the step's start,** which
  biases first-order light high. It moves no cost here. Phase 1 fixes the
  march.

## Related

- The passes: [`cloudOverPass.ts`](../../apps/game/src/render/cloudOverPass.ts),
  [`cloudLayers.ts`](../../apps/game/src/render/cloudLayers.ts),
  [`cloudFrameNode.ts`](../../apps/game/src/render/cloudFrameNode.ts),
  [`cloudSystem.ts`](../../apps/game/src/render/cloudSystem.ts). The trace and
  the history: [`cloudTrace.ts`](../../apps/game/src/render/cloudTrace.ts),
  [`cloudMarch.ts`](../../apps/game/src/render/cloudMarch.ts),
  [`cloudHistory.ts`](../../apps/game/src/render/cloudHistory.ts). The
  composite:
  [`cloudComposite.ts`](../../apps/game/src/render/cloudComposite.ts),
  [`cloudCompositeAir.ts`](../../apps/game/src/render/cloudCompositeAir.ts),
  [`cloudFront.ts`](../../apps/game/src/render/cloudFront.ts). The levers:
  [`cloudLevers.ts`](../../apps/game/src/render/cloudLevers.ts).
- Rule 69 in [the invariants](../agents/invariants.md#rule-69).
- Measuring it: [the harness guide](../guides/harness.md#measuring-the-weather).
- [ADR-0064](0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md):
  what the passes read.
  [ADR-0044](0044-the-sensor-reconstructs-the-display.md): the scene pass, the
  `reactive` attachment and reconstruction.
  [ADR-0037](0037-the-enhanced-camera.md): the clearing the composite
  reproduces. [ADR-0062](0062-one-gpu-lock-for-every-job-and-a-rig-held-to-its-point-and-tree.md):
  the lock every measurement here held.
- The decision rules, fixed before measuring:
  [phase 0's design](../../design/plans/weather/phase0/design.md), §8.7. What
  is left: [the weather plan](../../design/plans/the-weather.md).
