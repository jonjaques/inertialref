---
paths:
  - 'apps/game/src/render/**'
  - 'apps/game/src/scene/**'
  - 'packages/rendering/**'
---

# Rendering

Reasoning: `AGENTS.md` § "The rules that actually matter",
`docs/guides/testing.md`, ADR-0003.

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
- **Look at the perf tab before optimizing anything**, and before believing a performance
  claim in a design document. The first thing it found was that time warp had never worked
  above 5×.
