---
paths:
  - 'apps/game/src/render/**'
  - 'apps/game/src/scene/**'
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
- **Render compression is radial about the eye, never about the origin.** `placeAt` takes
  the eye in render space; `buildScene` computes it once and every caller outside it —
  `scene/OrbitTraces.tsx` is the only one — has to be given the same one. The origin is
  mechanism 1's snapped grid point: it lags the camera by up to 4096 m and then jumps, so
  compressing about it leaves a parallax error that sawtooths at the rebase cadence.
  Invisible on a planet filling the frame, and 0.8× its own angular radius on Phobos —
  the small moons appeared to vibrate in their orbits for exactly this reason.
- **The datum sphere has one definition**, `packages/rendering/src/datum.ts`. `buildScene`
  and the boot prebake both call it; when they each typed the formula, they agreed only
  through a three-hop identity nothing asserted, and a rounding step apart is a silent
  full cache miss at boot.
- **Look at the perf tab before optimizing anything**, and before believing a performance
  claim in a design document. The first thing it found was that time warp had never worked
  above 5×.
