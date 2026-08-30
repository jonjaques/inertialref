---
paths:
  - 'apps/game/src/render/**'
  - 'apps/game/src/scene/**'
  - 'apps/game/src/engine/**'
  - 'apps/game/src/hud/controls.ts'
  - 'packages/rendering/**'
  - 'packages/devtools/src/observatory.ts'
---

# Rendering

Reasoning: `AGENTS.md` § "The rules that actually matter",
`docs/guides/testing.md`, ADR-0003.

- **Anything you put in a frame is asked for at `clock.renderTime`.** `clock.time` is the
  integer tick. The two differ by up to one tick and the gap sawtooths, so measuring
  against the wrong one is a vibration at the frame/tick beat, scaled by the subject's own
  radius. `terrainStreamer` and the observatory each learned this the hard way.

- **`figure: null` means round, not unknown, and a body that has one must not also be
  flattened.** The mesh from `shapeGeometryFor` already carries all three measured
  half-extents; `flattening` is `polarRadius / radius`, which it has already spent, so
  applying both squashes the body twice — 26% on Phobos. `Bodies.tsx` branches once on
  whether it got a mesh. ADR-0013.

- **A shape model is a radius grid in Three's own sphere UV layout, and that is
  load-bearing.** It is what lets an equirectangular albedo map fit an asteroid through
  the same material as Mars. `buildShapeMesh` reproduces `SphereGeometry`'s vertex order,
  UVs and duplicated seam column exactly; changing any of them rotates every small body's
  texture by an amount nobody can name.

- **Never import from `three` in `apps/game`.** It is `three/webgpu` and `three/tsl`. Both
  share `three.core.js`, so `Mesh` is the same class either way and nothing breaks loudly
  — but only `three/webgpu` carries the node system, and a material taken from `three` is
  a classic material the renderer converts behind your back.
- **`packages/rendering` may not import Three.js at all.** It is arithmetic: camera
  routes, LOD, placement, easings, composition solvers. `pnpm graph` enforces this half.
  That split is the whole reason any of it is testable in Node.
- **A TSL node graph cannot be evaluated in Node, so shader code is verified on a GPU or
  not at all.** Do not write a scalar mirror of a shader and test that instead — it passes
  while the graph it claims to describe drifts. The terrain-normals test asserted normals
  were unit length, which a radial normal also is, so it passed before _and_ after the fix.
- **A headless GPU check is not a real one.** The renderer bug that killed a tab on every
  load reproduced only at `devicePixelRatio` 2.
- **Terrain is sampled in body-fixed axes** — see `.claude/rules/determinism.md`.
- **Compile-ahead goes through `render/warmup.ts`.** `warmCompile` owns the visibility
  toggle (`compileAsync` skips invisible objects, silently), the `WebGPURenderer` cast and
  the swallowed rejection; producers `register` so the boot progress total is the sum of
  what registered rather than one step's own count. Registration is idempotent by label
  because StrictMode does everything twice.
- **The lens has one producer, and the field of view is derived from it.**
  `engine.lens` resolves the camera's own precedence — a script's lens, then the flight
  one — and every consumer reads it. Focal length, gauge and zoom are canonical; the angle
  is one line of arithmetic from them, and an angle cannot carry the aperture, focus and
  exposure `docs/design/art.md` commits to. `CameraRig` writes `camera.fov` and nothing
  else does — never `filmGauge`/`setFocalLength`, whose angle moves on a resize. The
  terrain predicate takes the lens in **display** pixels, with supersampling divided out.
  ADR-0017.
- **Render compression is radial about the eye, never about the origin.** `placeAt` takes
  the eye in render space; `buildScene` computes it once and every caller outside it —
  `scene/OrbitTraces.tsx` is the only one — has to be given the same one. The origin is
  mechanism 1's snapped grid point: it lags the camera by up to 4096 m and then jumps, so
  compressing about it leaves a parallax error that sawtooths at the rebase cadence.
  Invisible on a planet filling the frame, and 0.8× its own angular radius on Phobos —
  the small moons appeared to vibrate in their orbits for exactly this reason.
- **`placement.scale` is the drawn radius, not a factor.** A unit sphere wants it;
  anything with its own metric geometry wants `placement.compression`, the
  dimensionless ratio beside it. Terrain patches are true meters from their anchor,
  and multiplying them by a radius put them 10^12 m away — the two fields are
  adjacent and only one of them reads like a factor. ADR-0015.
- **The datum sphere has one definition**, `packages/rendering/src/datum.ts`. `buildScene`
  and the boot prebake both call it; when they each typed the formula, they agreed only
  through a three-hop identity nothing asserted, and a rounding step apart is a silent
  full cache miss at boot.
- **Never subtract two planetary radii in a shader, and never take a screen-space
  derivative of a planetary position.** One float32 step at Earth's radius is half a
  meter, so `length(anchor + local) − radius` is quantized to that and the morph walks
  it across the steps every frame — a coastline warping several times a second from two
  kilometers up. Use `(2(a·l) + l·l)/(|p| + |a|)`. A derivative of the same sum is a
  tenth noise and biased per patch; take it analytically from the patch-local step. And
  `local` is linear across a triangle, so `dFdx(local)` is constant over the whole
  triangle: a fade measured that way steps per polygon, where distance times the lens's
  pixel angle does not. ADR-0020.

- **Never give two attribute names one `BufferAttribute` object.** Two vertex-rate
  attributes sharing one object is a pipeline that does not build — reported as
  `[Invalid ShaderModule "fragment"] … due to a previous error`, with the real message on
  a channel the page console does not carry. `warmCompile` swallows its rejection, so a
  warm-up making the same mistake fails invisibly first. The same aliasing on an
  instanced attribute builds, which is how it was isolated; the mechanism is a guess and
  the rule is deliberately the wider claim. ADR-0021.

- **Never read the drawn ground where the canonical one belongs, or the reverse.**
  `groundElevation`/`surfaceRadius` are what the contact test integrates and what a save
  records; `drawnElevation`/`drawnSurfaceRadius` are that plus the presentational tail and
  are what the mesh, the material and a composing camera are made from — 1.25 m apart at
  worst. The observatory's stance, `descent.ts` and the scatter field all choose here
  rather than in `packages/universe`, which is why this bullet is in two rules. ADR-0021.

- **Never give a varying an attribute's name.** Both become identifiers in the generated
  WGSL; the redeclaration surfaces as `[Invalid ShaderModule "vertex"]` with the real
  message on a channel the page console does not carry, and a planet that draws nothing.

- **The ground and the sphere behind it are one body, so they shade alike.**
  `render/terrain.ts` and `render/planet.ts` share the lunar-Lambert split, the
  terminator and the archive's photograph. A descent crosses the eight-pixel gate
  between them — 3.1% apart on Mars, 1.5% on Earth — so anything added to one side is
  a step at the switch. The aerial veil is the case that proves it and the least
  obvious: the atmosphere shell is a back-side sphere, so it survives the depth
  test only _outside_ the silhouette, and everything the air does in front of
  the ground happens in the surface material. Skylight comes _out of_ the direct
  beam rather than beside it, and where a photograph exists it supplies the
  albedo.

- **Look at the perf tab before optimizing anything**, and before believing a performance
  claim in a design document. The first thing it found was that time warp had never worked
  above 5×.
