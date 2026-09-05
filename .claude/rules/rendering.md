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
- **A TSL node graph is compiled and run on the real GPU by `pnpm test:gpu`.** Write a
  `*.gpu.test.ts` against `render/gpuHarness.ts` — compile it, read its WGSL, draw it,
  or run it as a compute kernel against the CPU function it ports. Do not write a scalar
  mirror of a shader and test that instead — it passes while the graph it claims to
  describe drifts. The terrain-normals test asserted normals were unit length, which a
  radial normal also is, so it passed before _and_ after the fix.
- **A headless GPU check is not a real one.** The renderer bug that killed a tab on every
  load reproduced only at `devicePixelRatio` 2, and nothing in Node observes presentation.
- **A stand-in `DataTexture` is filtered like the map it stands in for.** The constructor
  defaults to nearest; the WGSL builder reads a nearest texture with `textureLoad` and no
  sampler. **A value swap does not rebuild the program**, so whatever the stand-in
  compiled is what the real map is then read with — point sampled at mip 0. The gradient
  sample has no `textureLoad` path at all, so the ground's white pixel referenced a
  sampler that was never declared, Tint refused the module, and every mapless body's
  ground was a black frame. `materials.gpu.test.ts` holds each stand-in and a real map to
  one program.
- **Never build two texture nodes over one stand-in object.** A texture node's uniform
  hash is its texture's uuid, and the builder hands every later node with that hash the
  first node's binding — so two nodes over one stand-in compile to a single binding, the
  warm-up freezes the program there, and the second node's value swap binds nothing. The
  sphere's relief record read its slopes and its sea mask out of the reflectance that way,
  and an icy moon's 0.8 of albedo was a sea mask of 0.8. One stand-in object per node:
  `RING_WHITE` beside `WHITE`, `BLANK_RELIEF` beside `BLANK_REFLECTANCE`.
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
  else does — the aspect beside it is the viewport's, not the lens's — never
  `filmGauge`/`setFocalLength`, whose angle moves on a resize. The
  terrain predicate takes the lens in **display** pixels, with supersampling divided out.
  ADR-0017.
- **Render compression is radial about the eye, never about the origin.** `placeAt` and
  `placePathInto` both take the eye in render space; `buildScene` computes it once and
  every caller outside it — `scene/OrbitTraces.tsx` is the only one — has to be given the
  same one. The origin is
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

- **Never take a fine lattice coordinate from an absolute float32 direction, and never
  take a lattice decision in a float.** `render/terrainKernel.ts` is a port of
  `drawnElevation` held to a measured bound. A float32 unit vector resolves 6e-8 of a
  radian and a one-meter crater on Luna subtends 3e-7, so every crater rung and grit
  octave reads its tile's frame — the cell and fraction the patch center falls in, from
  float64 — plus the sample's offset, never `direction · cells`. And a cell holding a
  crater is a step: the sphere test compares 48-bit integer sums against
  `floor(cells²)` packed per rung, and existence compares a hash against a `u32`
  threshold, never `toUnit(hash) < density`. Taken in float32, rung 10 counted a crater
  the CPU did not — 44 m on Luna — and the tail was wrong by its own amplitude.
  `terrainKernel.gpu.test.ts` holds the whole field, `terrainBands.gpu.test.ts` each
  band. ADR-0023.

- **Never give two attribute names one `BufferAttribute` object.** Two vertex-rate
  attributes sharing one object is a pipeline that does not build — reported as
  `[Invalid ShaderModule "fragment"] … due to a previous error`, with the real message on
  a channel the page console does not carry. `warmCompile` swallows its rejection, so a
  warm-up making the same mistake fails invisibly first. The same aliasing on an
  instanced attribute builds, which is how it was isolated; the mechanism is a guess and
  the rule is deliberately the wider claim. ADR-0021.

- **Never call `geometry.dispose()` on a mesh holding the shared index.** Use
  `render/groundWear.ts`'s `disposeKeepingSharedIndex`. Every patch geometry references
  the one session-wide index, and three destroys each referenced attribute's GPU buffer
  with no refcount — so one eviction takes the 98 KB index down under every patch
  still drawn, and it re-uploads next frame. The ground, the sea sheet and the orbital
  bake all evict through that one function; a hand-rolled `setIndex(null)` beside a
  `dispose()` is the same two lines until somebody writes only the second. ADR-0021.

- **Never read the drawn ground where the canonical one belongs, or the reverse.**
  `groundElevation`/`surfaceRadius` are what the contact test integrates and what a save
  records; `drawnElevation`/`drawnSurfaceRadius` are that plus the presentational tail
  and are what the material and a composing camera are made from;
  `drawnGroundElevation` is the same with the sea clamp off — the seabed, which is what
  the mesh is built from under the sea's own sheet and only there: a mapped body gets
  no sheet and its mesh keeps the clamp (`HeightfieldRequest.seabed`). Canonical and drawn are 1.25 m apart at worst, the seabed aside, which is a sea's
  depth below. The observatory's stance, `descent.ts` and the scatter field all choose here
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
