# Map: the temporal template (`GalaxyTemporalVolume`) and the noise textures

Repository root: `/Users/jonjaques/.t3/worktrees/inertialref/t3-e896a8db` (branch
`feat/the-weather-stacked-prs`, three `0.185.1`). Paths below are relative to it.
Line numbers are from the tree as read on 2026-11-07. "Inference" marks anything
not read directly off code, tests or docs.

Plan sections this serves: `design/plans/the-weather.md` §1 (bullet "One march
with history exists", lines 83–95), §5.1 (noise bake, 416–421), §5.2 (the march,
423–456), §5.5 (temporal reconstruction, 555–587), §12 (three r185 risks,
1014–1022).

---

## 0. Headline facts (read these first)

1. **Production runs the galaxy at stride 8, not 4.** The class default is
   `stride ?? 4` (`render/galaxyTemporal.ts:82`), but the only production mount
   passes `temporal: { stride: 8 }` (`scene/GalaxyVolume.tsx:46`). So production
   traces **one sixty-fourth** of the history's pixels a frame, over a 64-frame
   phase cycle. The plan's §1 "a sixteenth of its history's pixels a frame" is
   the class default, which only `galaxyTemporal.gpu.test.ts` tests 2–3 exercise.
   ADR-0038 (`docs/adr/0038-the-stars-and-the-diffuse-sky.md:172–181`) states
   the 8×8 pattern correctly.
2. **History is 960×540 at 1080p and 960×600 at 2880×1800**, from
   `resolutionDivisor: 2, maxLongEdge: 960` (`GalaxyVolume.tsx:47–48`) applied
   in `GalaxyVolumeNode.#resizeTarget` (`render/galaxyVolume.ts:399–416`), not
   inside `GalaxyTemporalVolume`. Rays are `ceil(history / stride)`: 120×68 and
   120×75.
3. **The scheme is replacement, not accumulation.** Each frame's own-phase
   pixels take the fresh ray outright; every other pixel takes reprojected
   history clamped to the current coarse rays (or unclamped when exactly
   stationary). There is no exponential blend, no jitter, no variance clip.
4. **No NaN guard, no `pictureEpoch` reset, no `ir.settled()` hook.** All three
   are things §5.5 asks for and the template does not have
   (§8, §9, §10 below).
5. **The template never reads a camera node or a scene depth.** Rays come from
   CPU-uploaded basis vectors; foreground occlusion happens later at full
   resolution in the backdrop's depth test. It runs _before_ the scene is drawn
   (from a `TempNode.updateBefore` triggered by the backdrop), so it cannot see
   this frame's scene depth — the clouds' trace must stop at it (§5.6).
6. **No compute-baked texture, no `Storage3DTexture`, no `StorageTexture`, no
   `textureStore` and no blue-noise texture exist anywhere in the repo.** The
   one 3D texture is the CPU-baked RGBA8 128³ gradient noise
   (`render/noiseTexture.ts`). Compute exists, over storage _buffers_ only.
7. **The history is read upside-down-by-design.** The temporal passes are
   `QuadMesh` draws (v = 0 at the attachment's top) and the history is read
   back through a `PlaneGeometry` (v up); the ray-direction sign compensates.
   A composite that samples the history from another `QuadMesh` at its own
   `uv()` draws the clouds vertically mirrored (§12.4).

---

## 1. Files in this area

| File                                      | Lines | What it is                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/game/src/render/galaxyTemporal.ts`  | 312   | `GalaxyTemporalVolume`: interleaved rays → ping-pong half-float history                                                                                                                                                                                                                                                                                                                                                          |
| `apps/game/src/render/galaxyVolume.ts`    | 557   | `GalaxyVolumeNode` (a `TempNode<'vec4'>`): chooses cube cache / live integral / temporal; sizes targets; holds; `createGalaxyBackdrop`                                                                                                                                                                                                                                                                                           |
| `apps/game/src/render/galaxyKernel.ts`    | —     | the ray march the temporal ray callback calls; `radianceDepth` option makes alpha the emission-weighted distance                                                                                                                                                                                                                                                                                                                 |
| `apps/game/src/render/galaxyStructure.ts` | 121   | `GalaxyStructureTable` (2048² RG16F, GPU-baked once at warm), `acquireGalaxyStructure` refcounted per renderer                                                                                                                                                                                                                                                                                                                   |
| `apps/game/src/render/galaxySkyCache.ts`  | 455   | `GalaxySkyCache`: progressive scissored tile bake into 3 `CubeRenderTarget` slots, IndexedDB archive                                                                                                                                                                                                                                                                                                                             |
| `apps/game/src/render/galaxyCache.ts`     | 305   | `GalaxyCacheSchedule`: CPU publication/cancellation state machine for the cube bake                                                                                                                                                                                                                                                                                                                                              |
| `apps/game/src/scene/GalaxyVolume.tsx`    | 139   | R3F mount: production options, pose source, `warmAtMount`, `engine.galaxyRenderer` report                                                                                                                                                                                                                                                                                                                                        |
| `apps/game/src/render/quadPass.ts`        | 98    | `runQuadPasses`: the one full-screen-quad runner; names every pass                                                                                                                                                                                                                                                                                                                                                               |
| `apps/game/src/render/passTimeline.ts`    | —     | `namePass`, the `ir.passes` labeler                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/game/src/render/noiseTexture.ts`    | 287   | CPU-baked 128³ RGBA8 tiling gradient noise + its CPU reference functions                                                                                                                                                                                                                                                                                                                                                         |
| `apps/game/src/render/noiseNodes.ts`      | 417   | TSL noise: `noiseFetch`, `fbmFetch`, `latticeNoise`, `stripes`, helpers                                                                                                                                                                                                                                                                                                                                                          |
| Tests                                     | —     | `galaxyTemporal.test.ts`, `galaxyTemporal.gpu.test.ts`, `galaxyVolume.test.ts`, `galaxyVolume.gpu.test.ts`, `galaxyVolumeCache.test.ts`, `galaxyVolumeCache.gpu.test.ts`, `quadPass.gpu.test.ts`, `galaxyOrientation.gpu.test.ts`, `galaxyStructure.gpu.test.ts`, `galaxySkyCache.gpu.test.ts`, `galaxyCache.test.ts`, `noiseNodes.gpu.test.ts`, `scene/GalaxyVolume.test.ts`, `packages/devtools/src/harness.test.ts` (settled) |

History: `galaxyTemporal.ts` came in with PR #73 (`622ad8d`, "resolved stars and
diffuse sky stay continuous across scales") and moved onto `runQuadPasses` in
PR #125 (`03ae286`). It has exactly one consumer, `GalaxyVolumeNode`
(`galaxyVolume.ts:61–63, 110, 179–194`).

---

## 2. `GalaxyTemporalVolume` — the exact API

```ts
// render/galaxyTemporal.ts
export interface GalaxyTemporalOptions {
  readonly stride?: number
} // :20–22
/** Physical RGB and its emission-weighted distance; foreground depth stays in the scene. */
export type GalaxyTemporalRay = (
  origin: Node<'vec3'>,
  direction: Node<'vec3'>,
  pixelAngle: Node<'float'>,
) => Node<'vec4'> // :23–28

export class GalaxyTemporalVolume {
  // :42
  readonly stride: number // 1, 2, 4 or 8 (invariant :83–86)
  constructor(ray: GalaxyTemporalRay, options: GalaxyTemporalOptions = {}) // :81
  configure(pose: ObserverPose | null, lens: Lens, version: unknown): void // :179
  sample(): Node<'vec4'> // texture node over the newest history     // :185
  get report(): {
    stride
    refreshed
    resets
    phase
    width
    height
    rayWidth
    rayHeight
    bytes
  } // :188–204
  warm(renderer: WebGPURenderer): Promise<void> // :205
  render(renderer: WebGPURenderer, width: number, height: number): boolean // :215
  dispose(): void // :304
}
```

- `ObserverPose` is `{ position: UniverseVector; orientation: Quat }`
  (`packages/devtools/src/observatory.ts:144–147`). `Lens` and `verticalFov`
  come from `@inertialref/rendering`.
- `ray` is called **once**, in the constructor, to build the ray material's
  `fragmentNode` (`:100–104`). Per-frame change goes through uniforms only.
- `version` is compared by **identity** (`this.#drawnVersion === this.#version`,
  `:235`). `GalaxyVolumeNode` passes `#physicalVersion`, an object replaced by
  `{}` when the field or the resolved population changes (`galaxyVolume.ts:249–255, 296`).
- `render()` returns `false` and draws nothing unless warmed, undisposed and
  configured with a non-null pose and a lens (`:218–219`). `width`/`height` are
  the **history** size; the class derives the ray size itself.
- `sample()` returns `#outputMap = texture(history[1].texture, uv())` whose
  `.value` is swapped to the newest history every render (`:50, 287`).
- `report.bytes` = `8 × (rays.w·rays.h + 2·history.w·history.h)`, 0 once
  disposed (`:198–202`). Surfaced as `ir.galaxy().render().temporal`
  (`GalaxyVolumeNode.diagnostics`, `galaxyVolume.ts:344`;
  `packages/devtools/src/galaxy.ts` `GalaxyRenderReport.temporal`).

### Uniforms (all CPU-written every `render()`)

| Uniform                           | Meaning                                                                                        | Written at |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ---------- |
| `#origin` vec3                    | eye position, `UV.approxMeters(pose.position) / PARSEC` (absolute, float32, parsecs)           | `:261–263` |
| `#right`, `#up`, `#forward` vec3  | `Q.basis(pose.orientation)`                                                                    | `:272–274` |
| `#plane` vec2                     | `(tan(vfov/2)·w/h, tan(vfov/2))`, **w/h of the history**, not the drawing buffer               | `:275–276` |
| `#previousRight/Up/Forward/Plane` | copies of the above at the end of the previous render                                          | `:296–299` |
| `#translation` vec3               | `UV.difference(pose.position, previous.position) / PARSEC` (float64 delta, current − previous) | `:264–271` |
| `#size` vec2                      | history size                                                                                   | `:259`     |
| `#raySize` vec2                   | `ceil(w/stride), ceil(h/stride)`                                                               | `:255–260` |
| `#phase` vec2                     | `(k mod s, floor(k/s))`                                                                        | `:251–254` |
| `#angle` float                    | `vfov / height` — the **history** pixel's angle, not the ray's                                 | `:277`     |
| `#valid` float                    | 0 on a CPU reset, else 1                                                                       | `:250`     |
| `#stationary` float               | 1 only if exactly still (see §6.3)                                                             | `:241–249` |

---

## 3. Allocation

```ts
function target(name: string): RenderTarget {            // galaxyTemporal.ts:30–39
  const value = new RenderTarget(1, 1, {
    type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false,
  })
  value.texture.name = name
  return value
}
readonly #rays    = target('Galaxy current rays')                       // :43
readonly #history = [target('Galaxy history A'), target('Galaxy history B')]  // :44
```

- Format: RGBA16F (`RGBAFormat` default + `HalfFloatType`) = 8 B/texel, linear
  filtering (load-bearing: the resolve bilinearly upsamples the rays), no depth,
  no MSAA, `generateMipmaps` false (the `RenderTarget` default), ClampToEdge.
- Sized lazily each `render()` with `setSize` (`:257–258`); `RenderTarget.setSize`
  reallocates only on change. Both histories always share one size.
- Payload: `rgb` = radiance in `GALAXY_RADIANCE_UNIT` (1000 nW m⁻² sr⁻¹,
  `galaxySkyCache.ts:47`); `a` = emission-weighted distance in parsecs, clamped
  to 65,000 by the kernel because half-float tops out at 65,504
  (`galaxyKernel.ts:709–716`: `moment.div(result.g.max(1e-30)).min(65000)`).

### Sizing in production (`GalaxyVolumeNode.#resizeTarget`, `galaxyVolume.ts:399–416`)

```ts
const maximum =
  this.#cache !== null && !cached && this.#temporal === null
    ? Math.min(this.#maxLongEdge, COLD_LONG_EDGE)
    : this.#maxLongEdge
const divisor = Math.max(
  this.#resolutionDivisor,
  Math.max(size.x, size.y) / maximum,
)
const width = Math.max(1, Math.min(maximum, Math.ceil(size.x / divisor)))
const height = Math.max(1, Math.min(maximum, Math.ceil(size.y / divisor)))
```

`size` is `renderer.getDrawingBufferSize()` (physical pixels). The temporal
history is the volume's own `#target` size (`galaxyVolume.ts:439, 477`).
Pinned by `galaxyVolume.test.ts:223–268` ("caps the physical history while
preserving native scene size through Retina and portrait resizes"):

| Drawing buffer | Divisor | History | Rays (stride 8) | History+rays bytes |
| -------------- | ------- | ------- | --------------- | ------------------ |
| 2880×1800      | 3       | 960×600 | 120×75          | 9,288,000          |
| 1920×1080      | 2       | 960×540 | 120×68          | 8,359,680          |
| 1800×2880      | 3       | 600×960 | 75×120          | —                  |
| 640×360        | 2       | 320×180 | 40×23           | —                  |

Plus the volume's own `Galaxy radiance` target at the same size (8 B/texel).
Without `maxLongEdge` the divisor is `resolutionDivisor` alone (default 4;
`galaxyVolume.test.ts:270–284` keeps reference instruments uncapped: 1440×900
at 2880×1800 with divisor 2). Warm-up sizes the target with the same function
before the first frame (`galaxyVolume.ts:375–378`, test line 235).

Measured (CONTEXT.md:8706–8716, Apple M5 Metal, stride 8 with the cap): 40
queued _moving_-volume draws average 2.23/4.50/6.30 ms (face/edge/interior)
at 1920×1080 and 2.46/5.53/7.40 ms at 2880×1800; interior at Retina was
12.69 ms without the cap. These are galaxy-kernel figures (up to
`GALAXY_MAX_STEPS = 16384` steps a ray, `galaxyKernel.ts:55`), not a cloud
figure.

---

## 4. The interleave schedule

### Which pixels a frame traces

```ts
const rayPixel = uv()
  .mul(this.#raySize)
  .floor()
  .mul(this.stride)
  .add(this.#phase)
  .add(0.5) // :94–99
this.#rayMaterial.fragmentNode = ray(
  this.#origin,
  direction(rayPixel.div(this.#size)),
  this.#angle,
)
```

Ray texel `(i, j)` traces the **history pixel center** `(i·s + φx + ½, j·s + φy + ½)`.
With phase index `k ∈ [0, s²)`:

```ts
this.#phase.value.set(
  this.#phaseIndex % this.stride,
  Math.floor(this.#phaseIndex / this.stride),
) // :251–254
this.#phaseIndex = (this.#phaseIndex + 1) % (this.stride * this.stride) // :290
```

- **Raster order inside each s×s block**: stride 4 visits
  (0,0),(1,0),(2,0),(3,0),(0,1),…,(3,3); stride 8 (production) visits 64
  offsets row by row. Not Bayer, not Halton: the first `s` frames after a reset
  all land on the block's top row. (Inference: for the clouds' stride 2, a
  Bayer order (0,0),(1,1),(1,0),(0,1) spreads the first frames better.)
- `phaseIndex` resets to 0 on every CPU reset (`:237–240`) and advances only
  after a completed draw.
- No sub-pixel jitter: every ray goes exactly through a history pixel center.
  `direction(coord)` = `normalize(forward + right·(2c.x−1)·plane.x + up·(2c.y−1)·plane.y)`
  (`:87–93`).

### How the resolve reads the current rays (`:106–114`)

```ts
const pixel = uv().mul(this.#size).floor().toVar()
const coord = pixel.add(0.5).div(this.#size).toVar()
const currentUv = pixel
  .sub(this.#phase)
  .add(this.stride * 0.5)
  .div(this.#raySize.mul(this.stride))
  .toVar()
const current = this.#currentMap.sample(currentUv).level(float(0)).toVar()
```

An own-phase pixel `p = i·s + φ` lands exactly on ray texel `i`'s center;
any other pixel gets the bilinear blend of the two (four) rays traced through
the history pixels either side — interpolation in history-pixel space. That
bilinear `current` is (a) the whole frame after a reset, (b) the fallback
wherever history is invalid, and (c) the center tap of the clamp.

`ownPhase` (`:148–151`): `pixel.x mod s == φx && pixel.y mod s == φy`.

**Convergence**: after a reset the history is the bilinear upsample of the
coarse rays; every history pixel holds its own exact ray after `s²` frames
(16 at stride 4, 64 in production). Nothing traces more on a reset — the
template has no "immediate regime" (plan §5.5 "Two regimes" is new work).

---

## 5. Reprojection

```ts
const d = direction(coord).toVar()
const previousRay = d.mul(current.a).add(this.#translation).toVar() // :116
const z = previousRay.dot(this.#previousForward).toVar() // :117
const previousUv = vec2(
  previousRay.dot(this.#previousRight),
  previousRay.dot(this.#previousUp),
)
  .div(z.max(1e-6))
  .div(this.#previousPlane)
  .mul(0.5)
  .add(0.5)
  .toVar() // :118–126
const history = this.#previousMap.sample(previousUv).level(float(0)).toVar() // :127–130
```

- The point is `eye + d·current.a`, where `current.a` is the **current**
  (bilinear) emission-weighted distance; `translation = eye − previousEye`
  (float64 `UV.difference` on the CPU, uploaded small), so `previousRay` is the
  vector from the previous eye to that point. It is projected onto the previous
  basis and plane. Nothing absolute enters the reprojection — the
  precision-safe part of the design.
- **No matrices.** No `camera.projectionMatrix`, no view matrix, no camera
  node, no near/far, no TAA/FSR jitter. The basis is `Q.basis(pose.orientation)`;
  the plane is from `verticalFov(lens)` and the history aspect.
- The pose is the **drawn** camera in universe space, built in
  `GalaxyVolume.tsx:123–135`:
  `position: fromRenderSpace(origin, camera.position)`,
  `orientation: Q.normalize(Q.multiply(origin.orientation, camera.quaternion))`
  — so a hull orbit or free look moves the rays.
- **Motion handled**: eye translation (via the distance), rotation (basis
  change, fully reprojected), zoom (plane change, fully reprojected). The
  content is static in its frame: there is no per-sample motion, no velocity,
  no rotating frame. Exposure, ISO and shutter do not touch it (test
  `galaxyTemporal.gpu.test.ts:95–100`).
- `inside` (`:131–136`): `previousUv ∈ [0,1]²` and `z > 0`.
- The distance alpha written to the new history is `current.a` in the moving
  case and `history.a` only when stationary (`:165–173`).

---

## 6. Rejection and resets

### 6.1 In the shader (`:137–147`)

```ts
// A volume spans depths. Reject large parallax instead of treating its mean as a surface.
const parallax = this.#translation.length().div(current.a.max(1))
const valid = inside
  .and(this.#valid.greaterThan(0))
  .and(parallax.lessThan(0.05))
  .and(
    history.a
      .sub(previousRay.length())
      .abs()
      .lessThan(current.a.max(1).mul(0.2)),
  )
```

- **Parallax test**: the eye moved less than 5% of the emission distance.
  The `max(…, 1)` floor is **one parsec**.
- **Depth (disocclusion) test**: the stored distance at the reprojected texel
  agrees with the reprojected point's distance from the previous eye within
  20% of the current distance (floor 1 pc). `history.a` is bilinear, so at a
  depth edge it is a blend.
- Illustrative arithmetic for clouds (inference): with the same 5% rule a
  ship at 7.8 km/s moves 130 m a 60 Hz frame, so any cloud nearer than 2.6 km
  rejects every frame; from 400 km up the deck is ≳390 km away and passes.

### 6.2 On the CPU (`render()`, `:220–240`)

```ts
const resized =
  width !== this.#history[0]!.width || height !== this.#history[0]!.height
const dot = previous === null ? 0 : Math.abs(q·q_prev) // :223–231
const valid =
  !resized &&
  previous !== null &&
  this.#drawnVersion === this.#version &&
  dot > Math.cos(Math.PI / 8)
if (!valid) {
  this.#resets++
  this.#phaseIndex = 0
}
```

Reset on: first draw, `configure(null, …)` (clears `#drawnPose`, `:183`),
resize, version identity change, or a rotation of **45° or more**
(`|q·q'| = cos(θ/2)`, so `dot > cos(π/8)` ⇔ θ < π/4). A translation never
resets on the CPU; the shader's parallax test handles it. A reset sets
`#valid = 0` for that frame, so every pixel takes `current`.

Pinned by `galaxyTemporal.gpu.test.ts:13–68`: 0.02 rad keeps history
(`resets` stays 1 after the cold start), π rad resets (2), resize to 80×48
resets (3), version 1→2 resets (4).

### 6.3 Stationary (`:241–249`)

```ts
this.#stationary.value =
  valid &&
  previous !== null &&
  UV.distance(pose.position, previous.position) < PARSEC * 1e-6 && // ≈ 3.1e10 m
  dot > 1 - 1e-12 &&
  Math.abs(Math.tan(verticalFov(lens) / 2) - this.#previousPlane.value.y) < 1e-8
    ? 1
    : 0
```

When stationary, non-own-phase pixels keep history **unclamped, alpha
included**, so detail finer than the ray grid survives all phases
(`galaxyTemporal.gpu.test.ts:120–148`, a 90-cycle sine held to 0.001 across
all 16 phases). ADR-0038 records why: "Clamp every history sample" was
declined because "the coarse current grid has not measured the fine stationary
feature it is clamping" (`docs/adr/0038…:212–214`). The position threshold is
galaxy scale (0.2 AU); it must be re-chosen in meters for clouds.

---

## 7. The neighborhood clamp and the blend policy

```ts
const lower = current.rgb.toVar(),
  upper = current.rgb.toVar() // :152–160
for (const offset of [vec2(-1, 0), vec2(1, 0), vec2(0, -1), vec2(0, 1)]) {
  const neighbor = this.#currentMap
    .sample(currentUv.add(offset.div(this.#raySize)))
    .level(float(0)).rgb
  lower.assign(lower.min(neighbor))
  upper.assign(upper.max(neighbor))
}
// Keep the branch result in this function's stack. GLSL infers a nested
// select's return type after that stack ends and cannot recover the
// outer texture variables used by its isolated branches.
const resolved = vec4(0).toVar()
If(ownPhase.or(valid.not()), () => {
  resolved.assign(current)
}).Else(() => {
  If(this.#stationary.greaterThan(0), () => {
    resolved.assign(history)
  }).Else(() => {
    resolved.assign(vec4(history.rgb.clamp(lower, upper), current.a))
  })
})
return resolved
```

- **5-tap plus-shaped min/max of the _current_ rays** (bilinear center ±1 ray
  texel in x and y), RGB only. Not a 3×3, not a variance clip, not on the
  history grid, no luminance weighting, no clamp on alpha. Plan §5.5 wants "a
  variance clip of radiance and transmittance over the 3 × 3" — new work.
- **Policy**: own phase or invalid → `current`; else stationary → `history`;
  else → clamped `history.rgb` with `current.a`. No `mix`, no α, no
  accumulation — the noise of a jittered cloud march would not average down
  through this template (inference).
- **The `If`/`Else` into a `toVar` is load-bearing for WebGL.** A nested
  `select` broke the GLSL builder ("temporal-history variables captured outside
  an active TSL stack", CONTEXT.md:8718–8720). `galaxyTemporal.test.ts:6–57`
  builds both programs with the real WebGL node builder in plain Node (no GPU)
  and expects two `void main()` shaders.

---

## 8. NaN and infinity handling

- **None in `galaxyTemporal.ts`.** No finite test, no sanitizing clamp.
- Prevention lives upstream, in the kernel: the distance division is guarded
  (`moment.div(result.g.max(1e-30))`) and clamped under half-float's maximum
  (`.min(65000)`, `galaxyKernel.ts:714`); the resolve floors its divisors
  (`z.max(1e-6)`, `current.a.max(1)`).
- What a NaN ray would do (inference from the code): `previousRay` → NaN, `z > 0`
  false, so the pixel is invalid and takes `current` (NaN); the bilinear
  `current` spreads it to every pixel whose footprint touches that ray texel;
  a stationary history keeps it until that pixel's phase comes round; `min`/
  `max`/`clamp` with NaN are implementation-defined in WGSL.
- WGSL has no `isnan`; compilers may assume NaN and Inf absent and fold a test
  away (gpuweb minutes, via Context7 `/gpuweb/gpuweb`). The repo's own idiom is
  prevention, not detection:
  - `.min(65_504)` before anything sums or weights a half-float read —
    `psf.ts:101–105`, `sensor.ts:283–289` ("Inf × 0 is NaN in the canvas").
  - `x.div(r.max(1e-6))` instead of `normalize(0)` — `flare.ts:242–246`.
  - `bitcast(…, 'uint')` exists in TSL and is used in `starProjection.ts:228`;
    a bit-pattern exponent test is the only detection available, and can still
    be optimized (inference/spec minutes).
- Plan §5.5 requires rejecting every non-finite value. Do it on write (before
  the history target) as well as on read, because the stationary path copies
  history verbatim.

---

## 9. Resets and `pictureEpoch`

- **The galaxy history ignores `pictureEpoch`.** `GameEngine.pictureEpoch`
  (`engine/GameEngine.ts:705–711`, "Temporal image history is presentation
  state, outside the world hash") is bumped by `declareCut()`, which is called
  on sensor mount (`scene/Sensor.tsx:70`), on an observatory stance change
  (`GameEngine.ts:1085`), on a first/third-person toggle
  (`engine/characterController.ts:145`) and by the harness port
  (`GameEngine.ts:1020`).
- Its one reader today is the sensor: `createSensor`'s frame state carries
  `pictureEpoch` (`Sensor.tsx:94`), and `render/sensor.ts:485–495` folds it into
  `pictureKey = [pictureEpoch, mode, stagingLook, processing, historyKey, pinned]`,
  which calls `upscale?.resetHistory()` on change. `historyKey`
  (`Sensor.tsx:99–106`) is `[galaxySeed, observatory target address or 'flight',
galaxyView, heldTime when paused]` — it is how a held-instant scrub resets FSR.
- **What the clouds must do**: pass a reset key that includes `pictureEpoch`,
  the presentation-time jump (a scrub of the held instant, a warp
  discontinuity), the body served, and the weather field's own version. Pass a
  **primitive** (number or string), or a cached object: `version` is compared by
  identity, so `configure(pose, lens, { epoch })` with a fresh literal resets
  every frame.

---

## 10. `ir.settled()` — what it waits for today

`packages/devtools/src/harness.ts:699–744`:

```ts
settled(): { ok: boolean
  galaxy: { pending: boolean; tiles: string; survey: boolean } | null
  terrain: { pending: number; patches: number; deposits: boolean } | null } {
  const galaxy = this.#host.render.galaxyRender()          // engine.galaxyRenderer?.() — GameEngine.ts:1045
  const sky = galaxy === null || galaxy.cache === undefined ? null
    : { pending: galaxy.cache.pending, tiles: `${completedTiles}/${totalTiles}`,
        survey: galaxy.survey?.pending ?? false }
  ...
  ok: (sky === null || (!sky.pending && !sky.survey)) &&
      (ground === null || (ground.pending === 0 && !ground.deposits))
```

- **It does not wait for the temporal history.** It reads only the cube
  cache's `pending`, the star survey and the terrain. From outside the disk
  the cube is not configured (`cubePosition = null`, `galaxyVolume.ts:285–295`
  — the cube serves only `|y| < 1000 pc && r < 30000 pc` when a temporal volume
  exists), so `pending` is false while the temporal path is still converging.
- `GalaxyVolumeNode` keeps drawing while `refining`
  (`galaxyVolume.ts:451–455`): `!cached && temporal !== null &&
stableSubmissions <= GALAXY_SETTLE_SUBMISSIONS + stride²` = 8 + 64 = **72
  submissions** after the pose stops moving, then holds (`:456–463`).
  The report exposes `held`, `temporal.phase`, `temporal.refreshed`,
  `temporal.resets`, and `settled` — but `settled` there means "the kernel's
  sampling law is `settled`" (`sampling === 2`, `:359`), **not** "the history
  converged". Naming trap.
- The capture loop: `scripts/driveSteps.mjs:86–97` polls `ir.settled()` every
  250 ms and needs `ok` twice in a row; `scripts/presets/capture.mjs:269`
  records it with each plate.
- `harness.test.ts:268–317` pins the result with `toEqual` on the whole
  object (`{ ok: true, galaxy: null, terrain: null }` headlessly). Adding a
  `clouds` member changes those expectations.
- The host port: `packages/devtools/src/host.ts:246`
  (`galaxyRender(): GalaxyRenderReport | null`) with its default at `:368`.
  A cloud readout needs its own port method (or a field on an existing
  report) wired in `GameEngine.ts:1030–1050`. Rule 65: the readout must never
  throw or write.

---

## 11. `ir.passes` naming

- `runQuadPasses(renderer, quad, state, passes)` (`quadPass.ts:61–98`) gives
  each draw `draw(label, target, material, face = 0)`, which calls
  `namePass(into, label)` (`:76`) then `renderer.setRenderTarget(into, face)`
  and `quad.render(renderer)`. It restores target, cube face, mip, MRT, tone
  mapping, color space, `autoClear` and the scissor test in `finally`.
  `{ linear: true }` sets MRT null, no tone mapping, working color space.
- `namePass` is a `WeakMap<target, label>` (`passTimeline.ts:150–162`);
  `renderLabel` (`:171–181`) labels a render pass by its target, falling back
  to `"<texture name> W×H"`. Compute passes are labeled from the compute
  node's `name`, joined with `+`, else `'compute'` (`computeLabel`, `:183–189`).
- Galaxy labels: `'galaxy rays'` (the rays target), `'galaxy history'` (both
  ping-pong targets carry the one label), `'galaxy volume'` (the volume's own
  target, `galaxyVolume.ts:481`), `'galaxy structure'` (`galaxyStructure.ts:76`),
  `'galaxy sky'` (`galaxySkyCache.ts:307`).
- Pinned: `quadPass.gpu.test.ts:198–260` expects `'galaxy rays'`,
  `'galaxy history'`, `'galaxy volume'` (stride 8; skipped without
  `timestamp-query`); the optical case (`:185–187`) asserts no fallback
  `W×H` labels. Documented: `docs/guides/harness.md:667–676` lists every label —
  update it with any cloud pass. A label is an aggregation key: constant, never
  built per frame (`.claude/rules/timing.md`; `quadPass.ts:46–48`).

---

## 12. The frame: who draws when, and how the history is read

### 12.1 The hook

`GalaxyVolumeNode extends TempNode<'vec4'>` with
`updateBeforeType = NodeUpdateType.RENDER` (`galaxyVolume.ts:204`). Its
`setup()` returns `outputTexture = passTexture(this as PassNode, #target.texture)`
(`:128–131, 239–241`). The backdrop's `colorNode` includes `nodeObject(volume)`
(`:542`), so three calls `updateBefore` once per `renderer.render` when it draws
the backdrop's render object (three `Renderer._renderObjectDirect`,
`node_modules/.pnpm/three@0.185.1/node_modules/three/src/renderers/common/Renderer.js:3690–3730`, `updateBefore` at 3712).
The backdrop is `renderOrder = -1000` (`:554`), so the nested quad passes are
encoded — and submitted — before the scene pass that contains them.

### 12.2 Order per frame (temporal path, `galaxyVolume.ts:418–516`)

1. `cache.advance(renderer)` only if no temporal or `stableSubmissions > 8`
   (`:423–431`).
2. Size the target (`#resizeTarget`), decide hold vs draw (`:440–463`).
3. `runQuadPasses(renderer, #quad, { linear: true, autoClear: true }, draw => …)`:
   1. if `!cached && temporal`: `temporal.render(renderer, width, height)` —
      itself a nested `runQuadPasses`:
      `draw('galaxy rays', #rays, #rayMaterial)` →
      `#previousMap.value = history[slot]` →
      `draw('galaxy history', history[1 − slot], #resolveMaterial)` →
      `#outputMap.value = history[1 − slot]`, flip `slot`, advance phase,
      copy pose and basis to "previous" (`galaxyTemporal.ts:278–301`);
   2. `draw('galaxy volume', #target, cached ? #cachedMaterial : temporal ? #temporalMaterial : #material)`.
4. `timer.measure('galaxy.draw', …)` under `if (timer.on)` with properties only
   under `timingDetailed()` (`:500–515`).
5. The scene pass draws the backdrop: a `PlaneGeometry(2, 2)` at
   `sceneFarDepth`, `depthWrite = false`, `frustumCulled = false`, colored
   `composeSky(rgb · rgb.g/luminance · RADIANCE_UNIT·1e-9·GALAXY_LUMINOUS_EFFICACY/SURFACE_LUMINANCE)`
   (`createGalaxyBackdrop`, `:533–557`). Foreground occlusion is the
   full-resolution MSAA depth test, not the volume.

### 12.3 How the history is read

`#temporalMaterial.fragmentNode = this.#temporal.sample()` (`:193`, name
`'Galaxy temporal sampling'`): a `QuadMesh` copy of the newest history into the
volume's own `'Galaxy radiance'` target, texel for texel (same size). The
backdrop then samples that target through `passTexture`, bilinearly, at the
drawing buffer. Inference: the copy keeps one binding for the backdrop across
the cube, live and temporal paths, so no program changes when the path does
(rule 56's frozen-program hazard) — it costs one more full pass at history
resolution.

### 12.4 The orientation convention (trap)

three's `QuadGeometry` (`three/src/renderers/common/QuadMesh.js:28–31`) puts
`uv` v = 0 at the attachment's top; `PlaneGeometry` puts v = 0 at the bottom.
The galaxy's `direction()` adds `+up·(2v−1)`, so a `QuadMesh`-written texel at
the top holds the _downward_ ray, and the `PlaneGeometry` backdrop reads it at
the bottom — the two conventions cancel (`galaxyVolume.ts:208–215`). The
harness's `drawGraph` is also a `PlaneGeometry` (`gpuHarness.ts:431–436`),
which is why `galaxyTemporal.gpu.test.ts:28–43` sees "up" at row 0.
`galaxyOrientation.gpu.test.ts` holds the composed rows to the CPU ray, but
only for the **non-temporal** live path (`new GalaxyVolumeNode(field)`).
A cloud composite drawn as a `QuadMesh` (post pass) that samples the history at
its own `uv()` is vertically mirrored; one drawn as a scene object at
`PlaneGeometry` uv is not.

### 12.5 Why this hook does not fit the clouds' trace

The galaxy runs before the scene pass and never needs scene depth. The clouds'
trace must stop at each low-resolution pixel's scene depth (§5.6) and the
composite comes after every opaque and the sea (`render/water.ts`,
`render/seaReflection.ts`). So the trace cannot run from a backdrop-style
`updateBefore` in the same frame unless it reads the **previous** frame's
depth (inference). The placement choice is phase 0's (§5.6).

---

## 13. `GalaxyVolumeNode` — the parts a cloud volume would mirror

```ts
export const GALAXY_RESOLUTION_DIVISOR = 4 // :65
export const GALAXY_SETTLE_SUBMISSIONS = 8 // :66
export const GALAXY_SAMPLING_MOTION_PARSECS = 0.01 // :68
const SAMPLING_ANGLE = 1e-4 // :69
const COLD_LONG_EDGE = 64 // :73
export interface GalaxyVolumeOptions {
  // :75–84
  readonly cache?: GalaxyCacheOptions
  readonly archive?: GalaxySkyStore
  readonly temporal?: GalaxyTemporalOptions
  readonly resolutionDivisor?: 2 | 4
  readonly maxLongEdge?: number
  readonly structure?: boolean | GalaxyStructureTable
}
export class GalaxyVolumeNode extends TempNode<'vec4'> {
  constructor(field: GalaxyField, options: GalaxyVolumeOptions = {}) // :153
  configure(pose, lens, field = this.#field, resolved?): void // :243
  get active()
  get ready()
  get diagnostics(): GalaxyRenderReport // :315–371
  warm(renderer: WebGPURenderer): Promise<void> // :373
  override updateBefore({ renderer }: NodeFrame): undefined // :418
}
export function createGalaxyBackdrop(
  volume,
): Mesh<PlaneGeometry, MeshBasicNodeMaterial> // :533
```

- The temporal ray callback (`:182–192`):
  `integrate(origin, direction, 100000, this.#sampling, GALAXY_MAX_STEP_PARSECS, angle)`,
  returning `vec4(value.rgb / RADIANCE_UNIT, value.a)` with the kernel built
  `radianceDepth: options.temporal !== undefined` (`:175–178`).
- **Hold**: when nothing changed and the settle window has passed it draws
  nothing at all — not the rays, not the history (`:442–463`; the comment
  measures 113–357 ms a draw at a 480×270 target for an unchanging picture).
  Pinned by `galaxyVolume.test.ts:107–168` and `galaxyVolume.gpu.test.ts`.
  Clouds move with `renderTime`, so they can hold only under a held instant
  and a still camera (inference).
- **Warm**: `warmSensorPass(renderer, quad, [{ target, material }, …])` for the
  volume's materials, plus `cache.warm`, `structure.warm`, `temporal.warm`,
  awaited together (`:373–396`). `GalaxyTemporalVolume.warm` warms
  `{ #rays, #rayMaterial }` and `{ history[0], #resolveMaterial }`
  (`galaxyTemporal.ts:205–214`). Rule 61: through `render/warmup.ts`, never
  hand-written.
- **Failure safety**: a throwing draw restores every renderer field
  (`galaxyVolume.test.ts:286–307`); a warm-up resolving after `dispose()`
  cannot revive it (`:309–329`).

---

## 14. `GalaxyStructureTable` — the repo's "bake on the GPU at boot"

`render/galaxyStructure.ts`:

```ts
export class GalaxyStructureTable {
  readonly size: number
  constructor(size = 2048) // RenderTarget(size², HalfFloat, RGFormat, Linear, no depth)  :29–47
  sample(position: Node<'vec3'>): Node<'vec3'> // map.sample(xz/(2R)+0.5).level(float(0)).rg, warpHeight  :49–56
  get ready()
  get bytes() // size² × 4                                   :58–63
  warm(renderer): Promise<void> // warmSensorPass, then one runQuadPasses draw 'galaxy structure'  :65–82
  dispose(): void
}
export function acquireGalaxyStructure(renderer: WebGPURenderer): {
  readonly table
  release(): void
} // :98–121
```

- One fragment-quad bake of a 2D lookup, drawn once after its warm compile;
  `ready` flips inside the draw callback.
- Shared per renderer through a `WeakMap<WebGPURenderer, { table, users }>`
  lease; the last `release()` disposes it (`:92–121`). The star field and the
  galaxy volume both hold it (`GalaxyVolume.tsx:32, 41, 106`,
  `scene/Starfield.tsx:84–93`).
- `sample()` is called **inside the galaxy kernel's `Loop`** and names its level
  — one of only two `.level(` sites in `render/` (with `galaxyTemporal.ts`).
- Template value for the clouds: a boot-time shared bake with a lease, a
  `bytes` readout, and a named pass. It is a 2D render target, not a 3D one,
  and not compute.

---

## 15. `GalaxySkyCache` and `GalaxyCacheSchedule` — the progressive-bake pattern

Relevant to the far atlas, the reflection probe and sliced shadows (§5.4, §6.1)
and to what `ir.settled()` already reads.

- `GalaxyCacheSchedule` (`galaxyCache.ts:48–305`) is pure CPU: `configure(position, field, resolved)`,
  `next(): GalaxyCacheTile | null`, `complete(tile): boolean`,
  `restore(…)`, `selected`, `report` (`pending`, `completedTiles`,
  `totalTiles`, `published`, `cancellations`, …). Publication is
  complete-only (all six faces), a generation counter stops canceled work from
  publishing into a reused slot, three slots (`GALAXY_CACHE_SLOTS`), tiers
  published coarse-first. Unit-tested without a GPU (`galaxyCache.test.ts`).
- `GalaxySkyCache.advance(renderer)` draws at most `tilesPerSubmission` (1–8)
  scissored tiles a submission (`galaxySkyCache.ts:250–325`). Gotchas written
  in it:
  - "GPU load clears ignore scissor": tiles draw with `autoClear: false`, and
    the **renderer's** scissor test must be on as well as the target's
    (`scissor: true` in `runQuadPasses`), or every tile draws the whole face
    (`:298–307`).
  - "CubeRenderTarget inherits a resize that updates image.width, while its six
    images keep their old extent" — replace the target, never `setSize` it
    (`:285–293`).
  - `skyTarget()` sets `generateMipmaps: false` explicitly (`:445–455`).
  - The boot ticket (`trackAtMount('baking the nearby sky', units)`) is
    finished after the runner hands the renderer back (`:309–320`).
- The IndexedDB archive (`galaxySkyArchive.ts`, `engine/galaxySkyStore.ts`)
  persists regenerable cubes as a cache (rule 15 allows a cache, not a save).
  Weather changes with time; an archive buys nothing there (inference).

---

## 16. The tests and what each pins

| Test                                                       | Pins                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render/galaxyTemporal.test.ts:6–57` (plain Node)          | both temporal programs build with the **real WebGL builder** (`forceWebGL`, `createNodeBuilder` spy): no failures, two `void main()` shaders                                                         |
| `render/galaxyTemporal.gpu.test.ts:13–68`                  | stride 2: four renders reproduce the analytic ray to 0.001 at sampled pixels; `refreshed` 4; 0.02 rad rotation keeps history; π rotation, resize, version change each reset; `bytes` 0 after dispose |
| `render/galaxyTemporal.gpu.test.ts:70–118`                 | default stride 4: depth change 100→500 rejects old color (disocclusion); ISO change does not reset; 1000-pc translation rejects (parallax); `configure(null)` then a pose resets                     |
| `render/galaxyTemporal.gpu.test.ts:120–148`                | 16 stationary renders keep a 90-cycle sine to 0.001 on row 24 — the unclamped stationary path                                                                                                        |
| `render/galaxyVolume.test.ts:223–268`                      | 960 cap, Retina/1080p/portrait/small sizes, ray sizes and byte totals at stride 8                                                                                                                    |
| `render/galaxyVolume.test.ts:55–168, 170–221, 286–329`     | settle window, hold, draw counts, warm/resize/dispose ownership, state restoration on throw                                                                                                          |
| `render/galaxyVolume.gpu.test.ts`                          | full-resolution foreground occlusion through the sensor in MSAA and temporal pictures; held frames build no new pipelines (`presented − pipelines ≤ 2`)                                              |
| `render/galaxyVolumeCache.test.ts`, `.gpu.test.ts`         | cube bake bounds (cold 64×36, 408 tiles), reuse under free look, cancellation, held-frame identity after publication                                                                                 |
| `render/quadPass.gpu.test.ts:198–260`                      | `'galaxy rays'`, `'galaxy history'`, `'galaxy volume'` labels in `ir.passes` (needs `timestamp-query`)                                                                                               |
| `render/galaxyOrientation.gpu.test.ts`                     | up-ray at the top of the composed frame, non-temporal path only, 3% against the CPU ray                                                                                                              |
| `render/galaxyStructure.gpu.test.ts`                       | table within 1% of the analytic field; lease sharing                                                                                                                                                 |
| `render/galaxySkyCache.gpu.test.ts`, `galaxyCache.test.ts` | tile coverage, scissor, coarse-sky-while-refining, publication rules                                                                                                                                 |
| `packages/devtools/src/harness.test.ts:268–317`            | `settled()` shape and `ok` logic                                                                                                                                                                     |

**No test pins the `.level(0)` reads** (only `defocus.gpu.test.ts:180` counts
`textureSample(Level)?` calls, for another reason). Plan §5.2 asks for one that
fails without it.

Focused runs: `pnpm vitest run galaxyTemporal` (Node), and
`pnpm vitest run --config apps/game/vitest.gpu.config.ts galaxyTemporal` (GPU;
takes the machine's GPU lock, rule 68; refused beside a rig).

---

## 17. Galaxy-specific vs reusable

| Galaxy-specific (hard-coded)                                                                                                                                                  | Where                        | For clouds                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Units: parsecs (`/ PARSEC` on origin and translation)                                                                                                                         | `:263, 266–270`              | meters or km, eye-relative                                                    |
| Absolute float32 origin passed to the ray                                                                                                                                     | `:263`                       | never (rules 1, 52, 58): eye-relative rays, heights from float64              |
| Parallax < 0.05, depth tolerance 0.2, floors of 1 pc                                                                                                                          | `:138–147`                   | re-derived for meters; add the scene-depth test                               |
| Stationary: 1e-6 pc, `1 − 1e-12`, `1e-8` plane                                                                                                                                | `:241–249`                   | meter-scale thresholds; also requires a held instant                          |
| CPU reset at 45° rotation                                                                                                                                                     | `:236`                       | plus `pictureEpoch`, time jumps, wind outrunning history                      |
| Single RGBA16F payload: RGB + emission-weighted distance                                                                                                                      | `:30–39`, ray type `:24–28`  | needs transmittance and a depth; MRT or a second target                       |
| Distance stored in a half-float, clamped at 65,000                                                                                                                            | `galaxyKernel.ts:714`        | a distance in meters overflows at 65.5 km; km, a reciprocal or a float target |
| No jitter, no blend, 5-tap min/max RGB clamp                                                                                                                                  | `:94–99, 152–173`            | STBN jitter, accumulation, 3×3 variance clip of radiance and T                |
| Static content (no wind, no turning frame)                                                                                                                                    | —                            | reproject in body-fixed axes; move by the wind before the camera              |
| Stride ∈ {1, 2, 4, 8}, raster phase order                                                                                                                                     | `:83–86, 251–254`            | stride 2 for "quarter traced into half"; consider Bayer order                 |
| Names: `'Galaxy current rays'`, `'Galaxy history A/B'`, materials `'Galaxy interleaved rays'`, `'Galaxy physical history resolve'`, labels `'galaxy rays'`/`'galaxy history'` | `:43–44, 105, 176, 283, 286` | new constant names and labels                                                 |

| Reusable as is                                                                                                            | Where                                |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Interleave mapping: ray texel → history pixel center; own-phase replacement; bilinear current at phase offset             | `:94–114, 148–151`                   |
| Ping-pong over two targets with **two distinct texture nodes** whose values swap (rule 57 respected: one node per target) | `:48–50, 284–287`                    |
| Float64 eye delta on the CPU → small float32 `translation`                                                                | `:264–271`                           |
| Previous basis/plane copied after the draw; reprojection without matrices                                                 | `:116–126, 296–299`                  |
| CPU reset bookkeeping (`resets`, `phase`, `refreshed`, `report`)                                                          | `:188–204, 237–240`                  |
| `If`/`Else` into a `toVar` for the GLSL builder, and its Node test                                                        | `:161–174`, `galaxyTemporal.test.ts` |
| `runQuadPasses({ linear, autoClear })` with named draws; `warmSensorPass`                                                 | `:205–214, 278–301`                  |
| Sizing with a long-edge cap (`#resizeTarget`) and the hold logic                                                          | `galaxyVolume.ts:399–416, 440–463`   |
| Readouts with byte totals that return 0 once disposed (rule 65)                                                           | `:198–202`                           |

---

## 18. The noise textures

### 18.1 `render/noiseTexture.ts` — the one 3D texture in the repo

```ts
export const NOISE_GRADIENT_SCALE = 2.5 // :48
export const NOISE_CELLS = 32 // :61  (period; lattice wraps here)
const TEXELS_PER_CELL = 4 // :64
export const NOISE_TEXTURE_SIZE = NOISE_CELLS * TEXELS_PER_CELL // :67 → 128
export function noiseTexture(): Data3DTexture // :78–118, session singleton `held`
export function latticeHash(x, y, z, seed = 0, period?): number // :160–181, u32, Math.imul = WGSL u32
export interface NoiseSample {
  value
  dx
  dy
  dz
} // :184–189
export function gradientNoise(x, y, z, out: NoiseSample, period?): void // :202–287
```

- **CPU-baked** on first use, on the main thread: 128³ texels, RGBA8 =
  **8 MiB**, `x` value and `yzw` analytic gradient ÷ 2.5, each `[-1,1] → byte`.
  `RepeatWrapping` on S/T/R, `LinearFilter` both ways,
  `generateMipmaps = false` — "the bands fade themselves out by the pixel
  footprint before an octave would alias" (`:39–41`). Cube-edge gradient noise
  (12 gradients), quintic fade, ×1.06 range scale.
- **The 19.4 / 11.9 fps figure** (`:53–60`, full context in
  `docs/adr/0026-the-liquid.md:195–217` and CONTEXT.md:6851–6865): a
  **whole-frame** rate at 1920×1200 over DPR 2, standing two meters over the
  sea on Gliese 908 IV with 1,227 patches at level 17: 19.4 fps with every
  octave a fetch of a one-channel 128³ texture, 11.9 once the texture carried
  four channels, 16.3 with five fetches a pixel instead of ten; 96³ and 64³
  measured within a frame of 128³ — "a four-channel texel fetch costs about four
  times a one-channel one at the texture unit whatever the texture's size";
  run-to-run variance about 2 fps. One operating point, a ground material,
  not a march (`CLAUDE.md`: a figure at one point is a figure about that point).
  The plan's choice of one-channel R8 noises (§5.1) rests on it.
- Consumers: `render/terrain.ts:410`, `render/water.ts:328`,
  `render/plumes.ts:277, 387`, each through `noiseSampler(noiseTexture())`.

### 18.2 `render/noiseNodes.ts`

```ts
export type Vector = ReturnType<typeof vec3>; export type Field = ReturnType<typeof vec4>   // :47–49
export const asVector, asField                                                           // :50–51
export const mixPerChannel(a, b, t: Node<'vec3'>): Node<'vec3'>                          // :66–70
export const maxInt(a, b): Node<'int'>                                                   // :73–77
export type NoiseSampler = ReturnType<typeof texture3D>; export const noiseSampler(map)  // :84–85
export function noiseFetch(sampler, point: Vector): Field      // x value, yzw gradient   :94–106
export function fbmFetch(sampler, point, octaves, lacunarity = 2, gain = 0.5): Field      // :117–138
export function bumped(normal, gradient): Vector                                          // :150–153
export const latticeNoise = Fn(([cell, fraction]) => vec4)  // layout 'latticeNoise'      :280–358
export const STRIPES_PER_CELL = 2; export const stripes = Fn(...)  // layout 'gullyStripes' :384–417
```

- **`noiseFetch` samples with no level**: `sampler.sample(uvw)` (`:96`). In a
  fragment shader three emits `textureSample` (implicit derivatives,
  `WGSLNodeBuilder.js:343–372`). Called inside a march `Loop` with an early
  `Break`, that is the plan's §5.2 hazard. It is harmless on today's
  consumers only because the texture has one mip level (inference from WebGPU
  sampling: LOD clamps to the view's single level). **A cloud march must not
  call `noiseFetch`/`fbmFetch` as they are**; it needs a `.level(…)` variant.
- `fbmFetch` unrolls octaves in JavaScript (no WGSL loop).
- `cornerGradient` builds the gradient from hash bits instead of indexing a
  constant array: "A constant array indexed by a runtime value is a stack
  array on Metal: … 85 ms through the table and 19 ms through this, against
  24 ms for the same count of texture fetches, and the spill slowed the whole
  ground material" (`:186–196`). Applies to any per-step Worley neighbor table.
- `latticeNoise` takes the lattice coordinate **split** into a whole `cell`
  (exact, from float64 on the CPU) and a `fraction` (`:173–181`) — rule 58.
  The macro band's split is `groundWear.ts:311–319`; the periodic bands reduce
  the body-fixed coordinate modulo the period on the CPU in float64
  (`terrain.ts:280–302` `GRAIN_PERIOD`, `grainWrap` at `:1569–1572`). Cloud noise
  domains and wind offsets need the same treatment (plan §3).
- `noiseNodes.gpu.test.ts` holds `latticeNoise` to `gradientNoise` (2e-5, ×4
  for the gradient), proves the bands do not close on the texture period, and
  holds `stripes` to a reference. The pattern — a TSL graph against the CPU
  function it ports, bit-for-bit hashes via `Math.imul` — is the one a GPU noise
  bake should be held to (rule: no scalar mirror; `.claude/rules/rendering.md`).

---

## 19. Compute and storage textures

### 19.1 What exists

`rg 'Storage3DTexture|StorageTexture|storageTexture|textureStore'` over `apps`
and `packages`: **no hits**. Every compute kernel writes storage buffers:

| Kernel                    | File                                                                                                    | Shape                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GPU terrain tile producer | `render/terrainKernel.ts` (`storage(...)` `:1043–1061`; `kernel().compute(maxTiles * samples)` `:2763`) | `StorageBufferAttribute`s, `.toReadOnly()` inputs, `wgslFn` primitives (`mix32`, `hash3`, `pcg4d`, `toUnit`, `:210–260`) composed with `uses(...)`; every nested `Loop` named (`:180–184`) |
| Its dispatch              | `render/terrainProducer.ts:342–343`                                                                     | `renderer.compute(kernel.compute, taken.length * kernel.samples)`; readback `getArrayBufferAsync`; an error scope pushed and popped around the dispatch only (`:560–600`)                  |
| Star extinction           | `render/starExtinctionCache.ts:405–485`, warm `:643–655`                                                | `If(instanceIndex.lessThan(count))` guard; warm = `await renderer.computeAsync(compute)` with `count = 0`; CPU fallback when not WebGPU                                                    |
| Star projection           | `render/starProjection.ts:198–231`                                                                      | `.toAtomic()` buffers, `bitcast(…, 'uint')` for an atomic max of a float                                                                                                                   |
| Histogram meter           | `render/meter.ts:31–110`                                                                                | compute reads a render target with `textureLoad(source, xy)`; `count.count` set per dispatch                                                                                               |

Conventions: `Fn(() => { If(instanceIndex.lessThan(n), …) })().compute(n)`;
**guard the index** — a dispatch runs whole workgroups of 64 and WGSL clamps an
out-of-range write onto the last element (`docs/guides/testing.md:423–427`);
GPU tests dispatch through `gpu.compute(kernel)` and read with
`gpu.readBuffer(buffer)` (`gpuHarness.ts:679–686`) — there is no verb to read
back a 3D texture; sample it through `drawGraph` at chosen points (the noise
tests' pattern). No compute node in the repo sets a `name`, so each would read
`'compute'` in `ir.passes` (`passTimeline.ts:183–189`); a bake should name its
node.

### 19.2 three r185 `Storage3DTexture` (read from `node_modules/.pnpm/three@0.185.1/node_modules/three/src`)

- `renderers/common/Storage3DTexture.js`: `extends Texture` (not
  `StorageTexture`); sets `image = { width, height, depth }`, `magFilter` and
  `minFilter` `LinearFilter`, `wrapR = ClampToEdgeWrapping`,
  `isStorageTexture = true`, `is3DTexture = true`; `setSize` disposes on change.
  It **does not set `generateMipmaps`** (the `Texture` default is true) and has
  **no `mipmapsAutoUpdate`** (that is `StorageTexture.js:62`).
- `renderers/common/Textures.js:295–296`: with `generateMipmaps` true,
  `levels = floor(log2(max(width, height))) + 1` (`getMipLevels`, `:502–533`;
  depth ignored) — 8 levels for 128³. Storage textures go straight to
  `backend.createTexture` with no upload and no mip generation (`:306–310`).
  `Bindings.js:407–421` regenerates storage mips only when
  `mipmapsAutoUpdate === true`, which a `Storage3DTexture` never has; and the
  mip generator walks `'2d-array'` layers (`WebGPUTexturePassUtils.js:317–348`).
  So the chain exists and stays unfilled — the plan's "allocates a 3D texture's
  mip chain and cannot fill it". Set `generateMipmaps = false`.
- Sampler: `minFilter: LinearFilter` maps to `mipmapFilter: 'nearest'`
  (`WebGPUTextureUtils.js:172–174, 1223–1233`) with no `lodMaxClamp`, so an
  implicit-LOD read of a minified 3D texture **selects level ≥ 1 and reads the
  unfilled zeros** (inference from WebGPU semantics). The two r185 risks
  compound: unfilled mips plus a plain `sample()` in a loop.
- Tiling noise needs `wrapS/T/R = RepeatWrapping` set by hand (the default
  wrapR is clamp).
- `textureStore(value, uvNode, storeNode)` / `storageTexture(...)`
  (`nodes/accessors/StorageTextureNode.js:296, 309`); a 3D store coordinate
  builds as `uvec3` (`:262`).

### 19.3 An alternative the runner already supports (untested here)

three r185 renders into a `RenderTarget3D` slice: `setRenderTarget(rt3d, slice)`
binds a 3D view with `depthSlice = activeCubeFace`
(`WebGPUBackend.js:633–637, 689`); `RenderTarget3D` is exported from core
(`Three.Core.js:93`) and its texture is a `Data3DTexture` with
`generateMipmaps` false by default (`RenderTarget.js:55, 220`).
`runQuadPasses`'s `draw(label, target, material, face)` passes `face` through
to `setRenderTarget`, so a slice-by-slice fragment bake would be named,
restored and warmed by the existing infrastructure, and `r8unorm` as a
_render attachment_ needs no `texture-formats-tier1` (only _storage_ binding
does). Inference: unverified on this machine; phase 0 would have to measure
it against compute.

---

## 20. The three r185 risks (plan §12) — what the tree already does

| Risk                                                 | Already hit or worked around                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| A plain `sample()` in a loop is undefined            | three emits `diagnostic(off, derivative_uniformity)` outside Firefox/Deno (`WGSLNodeBuilder.js:247–251`; `docs/spikes.md:250–252`). `.level(float(0))` only in `galaxyTemporal.ts:114, 129, 157` and `galaxyStructure.ts:53`. **Plain samples inside loops already ship**: `marchAir` → `crowdedSamples` `Loop` (`air.ts:266, 445–478`) reads `sunTableAt`/`psiTableAt` with plain `.sample()` (`air.ts:415–437`) on mip-less LUTs (`atmosphereLuts.ts:85`); `seaReflection.ts:360–374` samples depth in a `Loop` with `Break`. They work because those textures have one level (inference). Compute stages always get `textureSampleLevel(…, 0)` (`WGSLNodeBuilder.js:369–371`). | as listed                           |
| `Storage3DTexture` allocates mips it cannot fill     | Never used. The repo always sets `generateMipmaps: false` explicitly on its own targets and data textures (`noiseTexture.ts:114`, `galaxySkyCache.ts:450`, `atmosphereLuts.ts:85`, `orbitalBake.ts:280, 287`, `planet.ts:174`, `galaxySkyTransfer.ts:61`)                                                                                                                                                                                                                                                                                                                                                                                                                         | §19.2                               |
| `r8unorm` storage needs tier-1 formats               | three requests **every** feature the adapter offers, `texture-formats-tier1` and `shader-f16` included (`WebGPUBackend.js:225–243`, `WebGPUConstants.js:328–349`), with `featureLevel: 'compatibility'` (`:212`). A GPU test must skip with `adapterOffers('texture-formats-tier1')` (`gpuHarness.ts:329–332`): Dawn-in-Node and CI's paravirtual Metal may lack it (`timestamp-query` is already skipped that way)                                                                                                                                                                                                                                                               | `quadPass.gpu.test.ts:54` precedent |
| TSL emits no f16                                     | `WGSLNodeBuilder.enableShaderF16()` exists (`:1672`) and nothing in three r185 calls it. No `f16` anywhere in the repo. Hand-written WGSL goes through `wgslFn` (`terrainKernel.ts:197–260`); a directive must precede every global declaration (`docs/spikes.md:250–252`)                                                                                                                                                                                                                                                                                                                                                                                                        | —                                   |
| An MRT holds 32 bytes a sample                       | No `requiredLimits` anywhere (`createRenderer.ts:180–193`, `gpuHarness.ts:364–368`). The scene MRT today (`sceneLayout.ts:89–105`): `output` rgba16float + `motion` rgba16float + `meterMask` r8unorm + (temporal picture) `velocity` rg16float + `reactive` rgba8unorm. By the spec's algorithm (Context7 `/gpuweb/gpuweb`: rgba16float and rgba8unorm cost 8 B each; alignment rounding per format) that is about **17 B native, 30 B temporal of 32** (computed; alignments are inference). A cloud attachment in the scene pass, or a trace target with more than 32 B of MRT (e.g. four RGBA16F knots plus a depth), exceeds it                                              | —                                   |
| A post-process quad's camera nodes describe the quad | `QuadMesh` renders with its static `OrthographicCamera(-1, 1, 1, -1, 0, 1)` (`QuadMesh.js:7, 63–68`). The galaxy never reads a camera node: rays from uniforms (§2). Camera nodes appear only in scene-object materials (`sceneDepth.ts`, `seaReflection.ts:326–360`, `planet.ts`, `materials.ts`). The upscaler hands matrices across on the CPU (`upscale.ts:198, 212`)                                                                                                                                                                                                                                                                                                         | —                                   |
| Reversed depth reverses the draw list                | `installSceneOrder` (`sceneOrder.ts:10–25`) multiplies `groupOrder`, `renderOrder` and id by −1 under reversed depth before three's reversal; installed on the harness renderer too (`gpuHarness.ts:371`). "Far" depth is `sceneFarDepth` (0 reversed, 1 otherwise, `sceneDepth.ts:12–14`); the WebGL fallback is logarithmic and not reversed (`createRenderer.ts:195–210`)                                                                                                                                                                                                                                                                                                      | —                                   |
| Compile-ahead through `warmCompile`                  | quad passes: `warmSensorPass` (`warmup.ts:578–615`); post pipelines: `warmPipeline` (`:543–570`); compute: a zero-count `computeAsync` inside a `warmAtMount({ label, units, run })` producer (`starExtinctionCache.ts:643–655`, `Starfield.tsx:84–93`); progressive work: `trackAtMount(label, units)` (`warmup.ts:631`). Rule 61                                                                                                                                                                                                                                                                                                                                                | —                                   |

---

## 21. Blue noise

None. No texture, no generator, no sequence (`rg -i 'blue.?noise|bayer|interleaved gradient|halton'`
finds only star-catalog Bayer designations). The sensor's grain uses a
per-frame `noiseTick` (`sensor.ts:122, 400`; `signature.ts:123–130`), and the
terrain's hashes are `mix32`/`hash3`/`pcg4d` — white, not blue. Plan §5.2's
spatiotemporal blue noise (Wolfe 2022) is wholly new: either a shipped mask set
(the usual 128×128×64 R8 is 1 MiB, against "nothing large ships", §5.1) or a
generator (inference: void-and-cluster at boot is costly). Open question.

---

## 22. What the weather work has to change or hook into here

1. **A cloud temporal volume** — a new class beside `GalaxyTemporalVolume`, or
   the template generalized. Generalizing must keep every galaxy test green
   (§16) and ADR-0038's description true; the galaxy is exercised in production
   only outside the disk or during interstellar travel (`galaxyVolume.ts:285–295`).
   What it adds, per §5.5:
   - stride 2 over a half-resolution history ("trace a quarter, reconstruct a
     half"); at Retina the history cap. With the class's integer stride the
     history is exactly `stride × rays`: a 960×600 cap at stride 2 is 480×300
     rays (+11% over 1080p's 480×270) — or 360×225 rays into 720×450 if "a
     quarter of the CSS pixels" means CSS axes ÷ 4 (open question);
   - a payload wider than one RGBA16F (radiance, transmittance, depth; §5.6's
     four depth knots at trace resolution), so MRT on the trace and history
     passes. `runQuadPasses({ linear: true })` sets MRT null, so the passes
     must set their own MRT inside the callback (the runner restores it);
   - reprojection in **body-fixed** axes (absorbs the turn) with the wind's
     displacement applied before the camera's; translation from float64 deltas
     as now; depth from the transmittance-weighted distance, or the
     half-opacity crossing;
   - rejection: the galaxy's two tests re-derived in meters, plus the trace's
     end depth against the scene's, a 3×3 variance clip of radiance and
     transmittance, and non-finite rejection on write and on read;
   - an immediate regime (no history, every half-res pixel traced at fewer
     steps) after a cut, scrub, resize, presentation-time jump or when motion
     outruns the history;
   - STBN jitter of the march start, indexed by the phase/frame;
   - accumulation or a blend if the jitter is to converge (the template only
     replaces).
2. **Reset key**: `pictureEpoch`, the held-instant scrub (`historyKey`'s
   pattern), the served body, the weather version — as a primitive.
3. **`ir.settled()`**: a clouds readout (phases since the last reset complete,
   the shadow's slices, the cache levels in view) through a new host-port
   member (`packages/devtools/src/host.ts:246, 368`; `GameEngine.ts:1030–1050`),
   included in `ok`; update `harness.test.ts:268–317`. Do not reuse the galaxy
   report's `settled` name for convergence.
4. **`ir.passes`**: constant labels through `runQuadPasses` for every cloud
   quad pass, a `name` on every compute node; extend
   `quadPass.gpu.test.ts`'s name test and `docs/guides/harness.md:667–676`.
5. **Noise bake**: 128³ Perlin–Worley R8 and 32³ Worley R8 at boot, mips off,
   tiling (`RepeatWrapping` × 3, lattice hashed modulo the period as
   `latticeHash(…, period)` does), shared by lease like
   `acquireGalaxyStructure`; warmed through `warmAtMount`; held by a GPU test
   against a CPU reference in the `noiseNodes.gpu.test.ts` pattern; skipped
   where `texture-formats-tier1` is absent if it uses `r8unorm` storage. The
   march reads it with `.level(0)` and a GPU test that fails without it.
6. **The 2D curl field** (§5.1): no 2D noise texture exists either; the same
   bake path applies.
7. **Sizing and budget**: a `#resizeTarget`-style long-edge cap; byte totals
   in a readout (the galaxy declares 42.7–44.1 MB of targets on the ground
   frame, `design/plans/perf.md:396–400`).

---

## 23. What breaks if done naively

1. **Copying the galaxy's absolute origin** (`p / PARSEC` as a float32 ray
   origin) into a planetary march: half-meter quantization at Earth's radius,
   and radius subtraction in the shader (rules 1, 52). Form shell entries from
   CPU heights; keep rays eye-relative.
2. **A half-float distance in meters** overflows at 65,504 m — the limb is
   2,290 km off (§5.4). The galaxy clamps at 65,000 _parsecs_. Inf in alpha
   then poisons `previousRay` and the depth test.
3. **Half-float radiance at night**: the scene unit is 30,000 cd/m²
   (`packages/rendering/src/exposure.ts:4`); a moonlit cloud (~0.06 cd/m²,
   inference from §5.3's 0.25 lx) is ~2×10⁻⁶ of it, under half-float's smallest
   normal (6.1×10⁻⁵). The galaxy picked `GALAXY_RADIANCE_UNIT` for exactly this
   kind of range problem. Plan §8.3 settles the scene unit in phase 0.
4. **Reusing `noiseFetch`/`fbmFetch` inside the march `Loop`**: implicit-LOD
   reads in non-uniform control flow; harmless only while the noise has one
   level. With a `Storage3DTexture` left at `generateMipmaps` true, they read
   unfilled mips — zeros, silently.
5. **Leaving `generateMipmaps` at its default** on a `Storage3DTexture`:
   eight levels of 128³ allocated (about 14% over the base, inference) and
   never filled.
6. **Building the ping-pong over one texture object** (two `texture()` nodes over
   the same target, or a stand-in shared): the builder hands the second node the
   first's binding and the swap binds nothing (rule 57). The galaxy builds
   `#previousMap` over history A and `#outputMap` over history B.
7. **Passing a fresh object as `version`** every frame: a reset every frame,
   no history ever used.
8. **Sampling the history from a `QuadMesh` at `uv()`** for the composite: the
   picture mirrors vertically (§12.4). `galaxyOrientation.gpu.test.ts` covers
   only the non-temporal path; a cloud equivalent should hold rows against a CPU
   ray.
9. **Reading camera nodes inside a quad pass**: they describe the quad's
   orthographic camera. Upload the scene camera's basis/matrices as uniforms.
10. **Running the trace from a backdrop-style `updateBefore`**: it runs before
    the scene pass, with no scene depth for this frame (§12.5).
11. **Expecting `ir.settled()` to cover convergence**: it does not today, for
    the galaxy either; a plate taken at `ok` can be mid-phase.
12. **A nested `select` in the resolve**: the WebGL builder fails; keep the
    `If`/`Else` into a `toVar` and a Node GLSL test like `galaxyTemporal.test.ts`.
13. **A per-step constant-array lookup** (Worley neighbors, gradient tables):
    a stack array on Metal, 85 ms against 19 ms in the measured case
    (`noiseNodes.ts:186–196`).
14. **A new MRT attachment on the scene pass under the temporal picture**:
    30 of 32 bytes are spent (§20); `requiredLimits` is not requested.
15. **Labels built per frame** or compute nodes left unnamed: unbounded
    timing keys (timing rule) or `'compute'` rows in `ir.passes`.
16. **Hand-written compile-ahead** for the new materials or kernels (rule 61),
    or a readout that throws (rule 65), or a GPU test run without the lock
    (rule 68).
17. **A big new module past the complexity cap**: the Stop-hook gate runs
    `fta . --score-cap 91` (`package.json:29`, `scripts/check.mjs:118–129`).
18. **Copying the stationary unclamped path without a held instant**: the
    clouds move with `renderTime`, so "pose unchanged" is not "picture
    unchanged" (inference) — stationarity must include the presentation time.

---

## 24. Open questions

1. Does the clouds' temporal pass generalize `GalaxyTemporalVolume` or sit
   beside it? (Generalizing touches a production path tested at stride 8 only
   by unit tests and one timeline test.)
2. What "a quarter of the CSS pixels" means at Retina in §5.5: 480×300 rays into
   the 960×600 cap at stride 2, or 360×225 into 720×450?
3. Blend policy: keep the galaxy's replacement scheme (sharp, no noise
   reduction) or accumulate with a variance clip (converges jitter, risks
   ghosting) — and over which grid, given ADR-0038's finding that a coarse
   current grid erases detail it never measured?
4. Where does the trace get its scene depth — this frame's, after a split of
   the scene pass (§5.6), or the previous frame's?
5. Compute into `Storage3DTexture` (needs `texture-formats-tier1` for R8
   storage) or fragment quads into `RenderTarget3D` slices (no tier feature;
   untested in r185 here)?
6. STBN: ship a mask set or generate one, and how large?
7. How the depth payload is encoded so a half-float target holds 0–2,290 km at
   reprojection precision — km, reciprocal, log, or a float32 target.
8. Which report and port carry cloud convergence into `ir.settled()`.
