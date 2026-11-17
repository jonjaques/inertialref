# The frame: what Ben Houston's notes change

Ben Houston has spent five months writing down how to make three.js's WebGPU
renderer draw what shipped games draw: about forty posts at
[ben3d.ca](https://ben3d.ca) since July 2026, most of them with a pull request
to three.js or a repository beside them. This plan is what the game takes from
them, sorted by the part of our frame each lands in, with the code's address,
its license and its state on the day it was read.

It borrows before it builds, by the rule in [the clouds](the-clouds.md) §2: a
setting, then an adapter, then one vendored file with its license, and our own
implementation last.

It is a plan, so it promises. When an item lands its decision moves into an
ADR or the build log and the item here goes.

| Reads with                                                             | For                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------- |
| [The clouds](the-clouds.md)                                            | The renderer most of §2 to §4 serve first             |
| [ADR-0044](../../docs/adr/0044-the-sensor-reconstructs-the-display.md) | The scene pass, its attachments, and reconstruction   |
| [The air](the-air.md)                                                  | The sea and the sky the reflection items read         |
| [Perf](perf.md)                                                        | The boot line and the frame the platform items change |
| [The testing guide](../../docs/guides/testing.md)                      | The GPU suite §9 measures his harness against         |

**Where the claims come from.** A figure of his is his, on his hardware, which
he names only sometimes: the noise figures are an Apple M3's, and no trace
timing names its machine. Nothing in this plan is measured by us unless it
says so. A state ("merged", "open", "fork only") was read from GitHub on
16 Nov 2026. The game pins three 0.185.1; three's releases are r185 (1 Jul
2026), r186 (24 Sep) and r187 (30 Oct), and r188 is unreleased, so "merged
for r188" means on `dev` and in no release.

---

## 1. What his notes confirm, so nobody builds it twice

| He argues for                                                                     | The game already has                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Integer time and one Weyl step per value, never a shared one                      | `render/cloudJitter.ts`: u32 products that wrap, R1's fraction and the two R2 fractions, the constants he lists     |
| GPU tests on Chrome's own Dawn, in Node, with no browser                          | `pnpm test:gpu`: vitest on the `webgpu` addon, numeric assertions on read-back values, under the machine's GPU lock |
| A reflection returns radiance and a coverage, and Fresnel is applied once         | `render/seaReflection.ts` returns the pair; `render/water.ts` mixes it over the sky by coverage                     |
| A bump is a height with a unit, and its slope is taken in the surface's own frame | `bumped()` in `render/noiseNodes.ts`: an analytic gradient in meters per meter, in body-fixed axes                  |
| Few unique material graphs; vary by uniform and texture                           | Every hull is one `MeshStandardNodeMaterial` rebuilt from its glTF (`render/shipMaterial.ts`)                       |
| Key lights live, indirect light cached                                            | One sun, live; the sky's share from the air's tables                                                                |
| Auto-exposure, and a sun and sky in real units                                    | The sensor's meter, ADR-0056 and ADR-0065. His sky prototype is single scattering; ours is past it                  |
| Expected values from a requirement; properties over examples                      | The testing guide's "Compare to the analytic result" and "Prove a regression test can fail"; fast-check in the gate |

## 2. Sampling noise

**What he showed.** Houston Stratified Noise is screen-space noise computed in
the shader: every aligned 8 × 8 block of pixels holds the 64 values k/64 in a
scrambled ordered-dither arrangement, each block shifted by its own hashed
offset, and every frame the pattern advances by an integer step that is
different for each value a pixel needs. Four integer hashes a value, no
texture, no startup. In three's own stochastic reflection and cone-traced GI
under its temporal anti-aliasing, on an M3 at 960 × 720 with a still camera,
it matches a 3.0 MB FAST blue-noise atlas (RMSE 2.982 against 2.981) and beats
it in the second effect (9.26 against 10.18). Its cheaper sibling drops the
hierarchy: a hash per pixel and the same per-value steps.

**The rules that bind any stochastic effect here.**

- **One value a pixel, under a blur:** interleaved gradient noise with a step
  a frame. By his table it beats his own noise and both texture sets for one
  value. That is a march's start jitter, which is what `cloudJitter.ts` draws.
- **Two or more values a pixel:** his noise where flicker and the first frames
  after a cut matter, the hashed sibling where the effect is heavily filtered.
  Each value takes its own step: the R2 pair for two values, the R4 four for
  four. Per-pixel error for two values after 256 frames is 26 times lower with
  separate steps than with one shared golden-ratio step.
- **Never:** one step shared between values, a second copy of gradient noise
  at an offset pixel, or several outputs scaled from one lattice scalar. His
  figure for a gradient-noise pair is an error of 131 × 10⁻³ at every history
  length, where every other sampler is under 30: the error is bias, and no
  history removes it.
- **Time is an integer.** A float frame counter breaks between 10⁵ and 10⁷
  frames.

**What that asks of our tree.** `cloudJitter.ts` draws its second number from
gradient noise "at the transposed pixel with a step of its own". A transposed
read is not an offset copy, so his bias figure is not ours by his argument,
and it is not known to be absent either. The check is his measurement on our
pair: the running mean of two values over 256 frames at one pixel, against the
hashed sibling's. It is one GPU test, and it matters only while the native march
draws. The port's jitter is one value a pixel read from a 128 × 128 × 64
blue-noise volume, the case in which his table puts gradient noise with a
step a frame ahead of the texture, 5.0 against 8.5 under his moving average.
That is upstream's to take, and it is noted here, not patched.

**The code.** `hierarchicalHashedWeyl` is merged into three for r188
([#35429](https://github.com/mrdoob/three.js/pull/35429)) as
`examples/jsm/tsl/utils/HierarchicalHashedWeyl.js`, MIT. The reference in
plain JavaScript, the analysis and every figure are in
[bhouston/houston-stratified-noise](https://github.com/bhouston/houston-stratified-noise),
MIT. Until r188 is adopted the node is one vendored file with its license line
and the pull request's number, and its JavaScript reference is the oracle its
GPU test compares against: every aligned 8 × 8 block holds each of 64 ranks
once, and the histogram over 512 × 512 is exactly 4,096 a bin.

**Taken when** the first effect here needs two random values a pixel. Nothing
does today. The hull's reflection (§6) and a soft cloud shadow are the likely
first.

## 3. Histories, and the rules a temporal filter is held to

His reflection series is about one effect and its rules are general. They bind
the cloud history, the port's and ours, and the sensor's reconstruction.

1. **Radiance is premultiplied by coverage, and the two are filtered with one
   set of weights.** For a cloud that is scattered light and opacity. Nothing
   un-premultiplies before a filter.
2. **A clamp's statistics come from covered samples only.** At a cloud's edge
   the clear sky beside it is otherwise the clamp's lower bound, and the edge
   flickers.
3. **A miss is not a hole.** A pixel that marched and found clear air has an
   answer. A pixel that did not march this frame has none, and only it may be
   filled from its neighbors.
4. **Reproject with the depth of the thing seen,** not of the surface behind
   it, and where two candidates exist read both and choose: "Halfway between
   two places is neither of them."
5. **Count frames per pixel.** The new frame's weight is one over the count,
   and a pixel just uncovered starts at one. No fixed blend factor.
6. **Cap the history where the signal turns over.** His sources cap at 30 and
   32 frames, shorter where the view changes the answer faster.
7. **Clamp against something cleaner than one noisy frame:** a short history of
   four to six frames, or a spatial resolve that already holds four samples.
8. **Thresholds are relative.** Our frame is pre-exposed by
   `sceneRadianceGain`, so a fixed luminance stop is right for one exposure
   and wrong for every other. Standard deviations, or de-exposed radiance.
9. **No inverse-luminance weights.** Trusting dark samples to hide fireflies
   darkens the result; his measured loss in three's own denoiser is 11%.
10. **Noise is independent between pixels.** A sequence that shares a sample
    dimension between diagonal neighbors showed as bands once his denoiser
    stopped blurring them.
11. **An anti-lag fed two populations resets forever.** A pixel that alternates
    between hit and miss, or cloud and sky, never converges. Separate the
    populations by coverage before comparing a short history with a long one.
12. **Skip what has nothing to filter.** One coverage test at the top of a
    pass.

And three from his notes on temporal anti-aliasing:

13. **A wider clip at rest.** A clip box of one standard deviation at rest
    rejects converged sub-pixel detail. Two at rest and a half under fast
    motion measured +2.15 dB on a still view against a supersampled reference
    ([bhouston/three.js#124](https://github.com/bhouston/three.js/pull/124)).
14. **History sampled with Catmull-Rom,** not bilinearly, which blurs a little
    more every frame the camera moves
    ([#35447](https://github.com/mrdoob/three.js/pull/35447), draft). The port
    already resolves this way (`resolve/catmullRom.ts`).
15. **A negative mip bias of about log₂ of the render scale** under
    reconstruction, or textures are sampled a level too blurry. A search of
    `render/upscale.ts`, `terrain.ts` and `shipMaterial.ts` finds no bias. The
    terrain is procedural and carries its own footprint; the hulls' textures
    and the 27 surface maps are the ones a bias would sharpen.

**What that asks of our tree.** These are a review list before they are work.
Each phase of [the clouds](the-clouds.md) that touches the history is read
against 1 to 12, and the port's own resolve is read against them once, on
alpha.9: its notes already move it toward rule 7. Rule 15 is one experiment:
Temporal Quality on `far-shore` and on a hull close-up, with and without the
bias, judged by the blind panel.

**An instrument comes before a change.** His order is the part to copy: add
the view that shows what the current stage gets wrong, then change it, and
compare at equal reach and quality. "Every individual change is correct and
looks like a regression" when a later stage was tuned to hide an earlier one.

## 4. Depth: a pyramid and an upsample

**What he built.** A nearest-depth pyramid, each texel the nearest of the four
under it, built in a compute pass, with reversed depth supported by the pull
request's own text
([bhouston/three.js#155](https://github.com/bhouston/three.js/pull/155), a
draft on his fork, MIT). A ray crosses empty space in a few coarse steps and
takes single-pixel steps near a surface: 27.6 ms of fixed-step march at full
hit rate becomes 2.9 ms on his mirror example at 1920 × 1080. And a joint
bilateral upsample, 87 lines, that brings an effect traced at half resolution
to full against the full-resolution depth, so the result stops at an edge
([bhouston/three.js#110](https://github.com/bhouston/three.js/pull/110), fork,
MIT), at about 1 ms at 1080p.

**Where each would serve here.**

- **The sea's search** (§5), if its instrument says the march steps over
  things.
- **Any layer drawn below display resolution against silhouettes:** the far
  march's atlas, a half-resolution sea reflection, a cloud shadow traced
  coarse. The port resolves its own layer to display resolution, so it is not
  the first client.
- **One depth for many readers.** `render/cloudsDepth.ts` already copies the
  4× MSAA depth to one sample for the port. That copy is level zero of a
  pyramid, and the nearest of the four samples is the conservative choice for
  it.

**What his text does not cover,** and a port of either has to: multisampled
depth, a far plane at 10¹⁰ m, and a thickness that grows with distance, which
the sea's 8% rule has and a room-scale constant does not. Comparing in
reciprocal depth, which is linear across the screen and is what the `motion`
row already carries, is the reading to try first.

**Taken when** §5's instrument or a silhouette defect on a plate asks for it.
Both are vendored files, not dependencies: neither is upstream.

## 5. The sea's reflection

**What he showed.** three's reflection examples find 98%, 82% and 46% of the
hits a one-step-per-pixel march finds within their own ray length, and a
denoiser paints over the rest. He separates a true miss, where the ray left
the screen, from a false miss, where the march stepped over something.

**Ours is the fixed-step kind he measures.** `seaReflection.ts` takes 12 steps
over the on-screen part of a ray reaching 20 km, then 4 bisections. Nothing
scores it against a reference.

- **The instrument first:** a debug view and a GPU test that count, on two
  sea cornerstones, the share of a one-step-per-pixel march's hits the 12
  steps find. A hull over water and a rocky shore are the cases the thickness
  rule exists for.
- **If the share is low,** the pyramid of §4. A jittered march of twenty steps
  was measured here at three and a half times the twelve at 3840 × 2400, so
  more steps is not the route.
- **The contract stays.** Radiance and coverage out, the sky under it, Fresnel
  once. An outdoor frame is mostly true misses, and the fallback carries the
  picture: when the port's sky-and-cloud environment is on
  ([the clouds](the-clouds.md) §3), the fallback is a sky with weather in it,
  which is §6.5 of the weather plan with no march of ours.
- **Not taken:** his denoiser. One mirror ray a pixel has no noise to remove.

## 6. A hull's light from everywhere but the sun

**The defect, by his accounting.** A material asks two questions about bounced
light: what arrives round the reflection direction, and what arrives over the
hemisphere. A hull here has no answer to the first at all. A search of
`apps/game/src` and `packages` finds no `scene.environment`, no
`environmentNode` and no `envMap`. Its only indirect light is an ambient term
at 0.16 and a fill light aimed down the camera's view
(`scene/CameraRig.tsx`). A metal hull over a lit planet reflects the star and
nothing else.

**What to borrow is the outdoor row of his survey.** An open world uses a hero
probe: a small environment cube re-rendered round the camera from a cheap
version of the world, 128² a face in his source. We hold the cheap version
already: the sky in any direction from the air's tables, the planet from the
orbital bake, the star as one direction. Near the ground the port's own
sky-and-cloud environment is the same thing with weather in it.

**The contract is his, and it costs nothing to adopt now.** Each source
answers with light premultiplied by its coverage. A valid black is coverage
one. The environment is last. A source replaces what is behind it and is never
added over it, which is what three's own reflection node gets wrong: its
result is added to an image that already reflected the environment. Under that
contract the ambient term and the fill light are additive writers the cube
replaces, not lights it sits under.

**The route on 0.185 is a node on `scene.environmentNode`.** His two traps
bind it: the query arrives as overrides of the sample's coordinates and level,
so a node that reads our tables samples them with explicit coordinates and an
explicit level; and the two lobes cannot be told apart there. His own
mechanism, a list of sources per question
([bhouston/three.js#169](https://github.com/bhouston/three.js/pull/169)), is
on his fork and not proposed upstream. It is not waited for.

**Each list is a compile.** A source list is read when the shader is built, so
it is fixed per mode, exterior or interior, and never a per-frame switch.

**Size, estimated:** 400 lines. **Done when** a hull in low orbit shows the
planet's limb and the sky in its plating on a plate, the blind panel prefers
it, and the hull's cost on `ir.gpu` moves by under 0.3 ms at 1920 × 1080.

**Interiors wait for r188.** Stations and ship interiors are where the rest of
his series lands: an in-browser unwrapper, a lightmap baker with an "indirect
only" mode, ray-traced radiosity, an SVGF denoiser, seam stitching, a probe
grid re-captured a few probes a frame. Radiosity, the denoiser and seam
stitching are merged for r188; the probe grid in 0.185.1 is WebGL-only; local
reflection probes are a draft. A bake is regenerable, so it is made on entry
from the station's geometry and nothing is persisted (rule 15).

## 7. Materials

- **Do not use `bumpMap` on three 0.185.1.** Its bump node normalizes the
  position derivatives, so relief changes strength with camera distance, with
  device pixel ratio and with viewing angle. A cinematic shot here moves from
  kilometers to meters, and reconstruction changes the render scale, so both
  of his failure axes are exercised by design. The fixes are open for r188
  ([#35330](https://github.com/mrdoob/three.js/pull/35330),
  [#35332](https://github.com/mrdoob/three.js/pull/35332)). Relief from a
  height before then is written with un-normalized derivatives, as `bumped()`
  is.
- **His acceptance test is worth owning.** A linear ramp of known slope, the
  expected normal `normalize(−0.5, 0, 1)`, held under a change of camera
  distance, angle and resolution, and compared in a normal buffer and never in
  a beauty render. It fits `bumped()` as a property in the gate and as one GPU
  test.
- **One look at the sea.** `water.ts:500` shifts the seabed lookup by a
  screen-space difference of height. By his argument that is height a pixel
  and grows as a pixel covers more water. The comment there says the form is
  deliberate. Two distances and two render scales say whether it shows.
- **A graph is a compile.** Thirteen unique material graphs cost him 1.2 s to
  compile against under 0.2 s shared (WebGL, an M2, 2023). The shape is ours
  too: vary by uniform, texture and flag. It is the case against importing
  authored material graphs for structures and interiors; take their textures.

## 8. The three.js ladder

The game is two releases behind, and the port's every release since alpha.7
requires r187. The upgrade is shared with [the clouds](the-clouds.md), phase B.

| Step      | Brings                                                                                                                                                                                                                                                                                                | Breaks or moves                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r186      | GPU-run unit tests of TSL itself ([#34331](https://github.com/mrdoob/three.js/pull/34331)), and the five fixes they led to, merged before it: to `gain` and `pcurve`, `sinc`, `rotate`, `determinant` and `faceForward`. `CountingSort`, an O(N) GPU sort and compaction. Packed integer dot products | `MaterialXNoise.js` is rewritten, and `render/materials.ts` draws the star's granulation with two of its functions: the dark plates move first, so `presets:compare --all` |
| r187      | The port from alpha.7, and alpha.9's fixes to the temporal upscale                                                                                                                                                                                                                                    | Not surveyed. The upgrade's own pull request reads the migration notes for 186 and 187                                                                                     |
| r188      | The noise of §2, the SVGF denoiser, radiosity, seam stitching. Open against it: octahedral normals, the bump fixes, reflection probes                                                                                                                                                                 | `DenoiseNode` is replaced; `bumpScale` becomes a length if #35330 merges. The game sets neither today                                                                      |
| Fork only | The depth pyramid, the joint bilateral upsample, the list of indirect sources, coverage through the denoiser                                                                                                                                                                                          | A vendored file is not followed by an upgrade. Each names its pull request, and is deleted when a release carries it                                                       |

The game imports none of the six functions r186 fixes: a search of
`apps/game/src` and `packages/*/src` for their imports from `three/tsl` finds
nothing. A sixth defect, a temporary's cache reused across sibling branches of
a graph, was still open when he wrote
([#34339](https://github.com/mrdoob/three.js/pull/34339)). Its symptom is a
zero where a value should be, in a graph with branches. It is the first thing
to rule out the next time a branch of ours reads zero for no reason.

**A vendored addon needs rule 60's sanction.** `apps/game` imports
`three/webgpu` and `three/tsl`; an addon file is admitted the way `GLTFLoader`
is, by name, in the rule's own list.

## 9. The platform, the budget and the tests

- **Count bytes a pixel, and bytes a second.** His tiers are sized by what a
  frame stores per pixel and by texture traffic: 16 bytes of G-buffer for his
  recommended tier, about 70 GB/s at native 1080p and 60 fps, against a median
  device's 66 GB/s of read throughput in his survey's benchmark. Our scene
  pass stores `output`, `motion`, `meterMask` and `reactive` at four samples,
  and the second scene pass over the clouds, 3.88 to 5.32 ms at 2880 × 1800,
  is that arithmetic being paid twice. A bytes-a-pixel table of every target
  in the frame goes in [perf](perf.md), with the traffic it implies at both
  sizes. `rg11b10ufloat` is renderable on nearly every WebGPU device in his
  survey, and is half of `rgba16float` wherever a target has no alpha and no
  negative values.
- **Lower the scale first, then step down a tier.** That is the watchdog's
  ladder already. His other half is the one to hold: every optional lever
  doubles the states a release is checked in, so an enhanced mode is one
  predicate.
- **three requests every feature the adapter offers.** `createRenderer.ts`
  names no required feature or limit, so a shader that leans on an optional
  one works on our Macs without anyone having asked for it and fails where it
  is missing. One GPU test builds the device with the features we mean to need
  and nothing else, and draws a frame. The survey's rows say what is safe:
  `shader-f16` on 94.08% of WebGPU devices and 99.85% of Macs,
  `float32-filterable` on 91.22% overall and 58.93% in Safari,
  `texture-formats-tier1` on 93.06% overall and 1.04% in Firefox. A headline
  figure hides a whole browser.
- **No one block format covers our players.** BC is on 99.99% of Windows
  devices and 87.92% of Macs; ASTC on 95.71% of Macs and 0.06% of Windows.
  [Perf](perf.md)'s boot line, 1,569 ms of a 1,843 ms preload warming 27 WebP
  surface maps, has "a GPU-compressed container" as an option: by these
  figures that means a container transcoded at load, or two encodings.
- **Batch adjacent compute.** `renderer.compute([a, b])` is one encoder and
  one submit where two calls are two. He took a language model from 427
  submits a token to one, and his two models decoded 2.2 and 4.7 times faster. Ours is three pairs
  (`meter.ts:100`, `starProjection.ts:418`, and one in the march's composite),
  so the gain is small and is taken where it is free. A batch is one entry on
  the pass timeline, which is checked first.
- **A sort for blended instances.** `CountingSort` from r186 sorts or compacts
  on the GPU in four passes. Rain, plumes and dust need one; additive stars do
  not. Its 4,096 linear depth bins cannot span our far plane, so its bin
  function is ours and bins on log depth.
- **Measure a shader idea before believing it.**
  [webgpu-bench](https://github.com/bhouston/webgpu-bench) (MIT) is 71
  micro-benchmarks on Dawn from the command line. On these machines it is run
  with `--no-report`, always: its default sends the run, with the GPU's
  identity, to his survey. `npx webgpu-bench --filter 'f16-*' --json
--no-report` before an f16 rewrite; the branch and select rows before
  trading one for the other.
- **His test harness against ours.** three's own GPU tests reserve a row for
  each assertion in two storage buffers, run one compute dispatch, and compare on
  the CPU with the component named in the failure. His fuzz form evaluates 256
  hashed inputs in one dispatch. A search of the testing guide and the rigs
  finds no fuzz form here. It is the natural shape for a property on the GPU,
  and it is taken into the rig the next time a kernel gets a property test.

## 10. For the working card, not for the renderer

His process posts are about agents building software, which is how this
repository is built. Four proposals, each a line or a script, and each the
owner's to take or leave:

1. **An expected value comes from a requirement, an ADR, an analytic result
   or a reference, never from running the code under test.** The guide says
   how to prove a test can fail; it does not say where the number may come
   from. A ledger rewritten with `--update` is the honest form of the other
   thing, as long as a green ledger is not read as proof.
2. **A map from each numbered rule to what enforces it:** a lint rule, a
   check stage, a named test, or "review only". Sixty-nine rules, one script,
   and a stage that fails when a rule lands with no enforcer and no mark. It
   also narrows what `invariant-auditor` has to read.
3. **A format check git itself runs.** A file rewritten through the shell
   skips the edit hook and is first caught in CI, and the hooks bind one agent
   harness of several. `core.hooksPath` at a tracked directory binds all of them.
4. **Remove the surprise before writing the rule.** When an agent's first
   guess at a path or a flag is wrong, a rename or a default may cost less
   than a rule every later agent has to read.

## 11. Not taken

| His                                         | Why not here                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| three's `SSRNode` as a pass over the hulls  | On r185 it carries its own environment and adds its result over an image that already reflected one. His series is the case against it                                                     |
| Neural texture compression                  | Unmerged, its half-float types rejected twice, no trainer, and a reviewer measured under 10 fps on an M2 Pro. A block format removes our decode and costs nothing a fragment               |
| Gaussian splats as scenery                  | A splat's color is a capture's. It does not relight at a terminator, and a cloud impostor has to take the sun                                                                              |
| GPU Stratified Annealing, and FAST textures | Textures to ship or 31 s to generate. §2's noise is zero bytes and matches them under a temporal filter                                                                                    |
| A language model in the frame               | 75 tokens a second from a 135M model cannot drive the guide, and it shares the device queue with the frame                                                                                 |
| `git-dedup`                                 | The worktrees already share one object store, and it leaves the LFS objects alone. Its suggested instruction renames `git`, which none of this machine's rules on `git` commands would see |
| `vitest-gpu`, `vitest-screenshot`           | The suite already runs on the same Dawn. The picture ledgers are the image baselines                                                                                                       |
| Lightmaps, probes and SSGI for the ground   | The ground is a streamed mesh under a moving sun and a sky the tables already integrate                                                                                                    |

## 12. The order

| #   | Item                                                                                               | Why here                                                              |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | three 0.187, with the port at alpha.9 (§8)                                                         | Everything else is easier to borrow two releases closer to his code   |
| 2   | The instruments: the sea's hit share (§5), the named-features device test and the bytes table (§9) | Each is a day, changes no picture, and decides whether 5 and 7 exist  |
| 3   | The hull's environment (§6)                                                                        | The one place his survey finds nothing where every game has something |
| 4   | The mip bias experiment (§3, rule 15) and the sea's bump look (§7)                                 | Two plates each                                                       |
| 5   | The depth pyramid and the upsample (§4)                                                            | Only if 2 says the sea steps over things, or a plate shows an edge    |
| 6   | The noise node (§2)                                                                                | With the first effect that needs two values a pixel                   |
| 7   | A transcoded container for the surface maps (§9)                                                   | Perf's boot line; sized there                                         |
| 8   | r188's interior kit (§6)                                                                           | When r188 is released and a station has an inside                     |

## Sources

Fifty of the site's posts were read in full on 16 Nov 2026: every one on
graphics, three.js, GPU testing and building with agents. The ones on React,
startups and hardware were not. The ones this plan draws on:

| Post                                                                                                                              | Gave                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [Introducing Houston Stratified Noise](https://ben3d.ca/blog/houston-stratified-noise)                                            | §2                                                   |
| [GPU Stratified Annealing](https://ben3d.ca/blog/gpu-stratified-annealing)                                                        | §2's method of measuring a sampler; §11              |
| [Jittered Sample Weights](https://ben3d.ca/blog/jittered-sample-weights)                                                          | The accumulator rule below                           |
| [How Games Do Screen-Space Reflections](https://ben3d.ca/blog/how-games-do-screen-space-reflections)                              | §4, §5                                               |
| [How Games Denoise Reflections](https://ben3d.ca/blog/how-games-denoise-reflections)                                              | §3                                                   |
| [Exact Screen-Space Reflections on a Budget](https://ben3d.ca/blog/exact-screen-space-reflections-in-threejs)                     | §4, §5                                               |
| [Four Pipeline Tiers for Three.js](https://ben3d.ca/blog/aaa-quality-on-a-web-budget)                                             | §9's bytes and traffic                               |
| [Building the AAA Lighting Pipeline in Three.js](https://ben3d.ca/blog/building-the-aaa-lighting-pipeline-in-threejs)             | §3's rules 13 to 15, §6, §8                          |
| [Pluggable Indirect Lighting for Three.js](https://ben3d.ca/blog/pluggable-indirect-lighting-in-threejs)                          | §6's contract                                        |
| [How AAA Games Light Indoor Scenes](https://ben3d.ca/blog/how-aaa-games-light-indoor-scenes)                                      | §6's hero probe                                      |
| [Adding Robust Light Baking to Three.js](https://ben3d.ca/blog/adding-robust-light-baking-to-threejs)                             | §6's interiors                                       |
| [Bump Maps Need Units](https://ben3d.ca/blog/bump-maps-need-units)                                                                | §7                                                   |
| [Costs of Material Graphs](https://ben3d.ca/blog/the-costs-of-graph-materials)                                                    | §7                                                   |
| [Fine-Grained Shader Validation in Three.js](https://ben3d.ca/blog/fine-grained-shader-validation-in-threejs)                     | §8, §9                                               |
| [Native GPU Testing for Vitest and Jest](https://ben3d.ca/blog/native-gpu-testing-for-vitest-and-jest)                            | §1, §11                                              |
| [Introducing WebGPU-Bench](https://ben3d.ca/blog/introducing-webgpu-bench)                                                        | §9                                                   |
| [Running LLMs in the Browser with Three.js](https://ben3d.ca/blog/running-llms-in-the-browser-with-threejs)                       | §9's batching                                        |
| [Adding Native Gaussian Splatting Support](https://ben3d.ca/blog/gaussian-splatting-for-threejs) and its two sequels              | §9's sort; §11                                       |
| [Neural Texture Compression in Three.js](https://ben3d.ca/blog/neural-texture-compression-in-threejs)                             | §11                                                  |
| [Web 3D Survey v2](https://ben3d.ca/blog/web-3d-survey-v2), and [web3dsurvey.com](https://web3dsurvey.com) as read on 16 Nov 2026 | §9's shares                                          |
| [Coding Agents Underestimate the Cost of Code They Own](https://ben3d.ca/blog/coding-agents-underestimate-the-cost-of-code)       | The borrowing rule in [the clouds](the-clouds.md) §2 |
| The Rise of "Test Theater", Intent-Driven Testing, Agentic Coding Best Practices, Crafting READMEs for AI, git-dedup              | §10, §11                                             |

**The accumulator rule,** which has no section because nothing here is known
to break it: a sum of many clean samples into a small buffer bands, because
similar samples round the same way. Give each sample a slightly different
weight and the rounding errors cancel. For half floats the weight is
`1 ± i/2048` at sample `i`, with the weight accumulated beside the sample and
divided out at the end; it carries a half-float sum from 256 samples to about
1,024 before it bands, at no memory. `orbitalBake.ts` writes half-float
targets, and the far atlas is baked progressively. Whichever of our bakes sums
more than 256 samples a texel into a half float takes the weight; none is
known to.
