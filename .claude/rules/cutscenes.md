---
paths:
  - 'packages/devtools/src/cutscene.ts'
  - 'packages/devtools/src/cutscenes/**'
  - 'packages/rendering/src/cinematic.ts'
  - 'apps/game/src/cinema/**'
  - 'apps/game/src/hud/CutsceneOverlay.tsx'
---

# The cinematic director

Reasoning: ADR-0010, `docs/guides/cinematics.md`, and the hard-won authoring rules in
`CONTEXT.md` § "The cinematic director, and a title sequence as a test target" and
§ "The title sequence, re-cut against its own frames". **Reread both before authoring a
second scene** — the traps below are the index, not the explanation.

- **Pure arithmetic lives in `packages/rendering/src/cinematic.ts`** and is property-tested
  in Node. The director and scripts live in `packages/devtools`. A script's
  `prepare(world)` resolves the stage once; its `sample(frame)` is pure; time derives from
  `renderTime`, never a wall clock. A new scene is a new file exporting a `CutsceneScript`,
  registered in `harness.ts`.
- **A scene is a shot list, not a camera move.** Each shot owns its camera, placed against
  its own subject; cuts hide in darkness, behind a flash, or under a body filling the
  frame. Authored as one continuous spline, a scene becomes a camera crossing astronomical
  units between beats and aiming at whatever lies between — which is what the first
  `tng-intro` was.
- **Choreograph in the frame.** A hull's beats are `(frame, screen x, screen y, range)` via
  `screenOffset` — the same terms a tracked bounding box reports. `screenRoutePosition`
  interpolates range in log space so a four-decade approach does not overshoot the lens.
- **Camera-relative choreography is offset beats, never absolute beats off a moving
  camera.** Never per-frame look-at a hull near the lens.
- **An effect is staging, so a script turns it on.** Anything screen-space belongs in
  `CinematicEffects` with a drive a shot sets, and 0 everywhere else. Derived from geometry
  alone it fires in every other mode: the corona did, for any camera on a body's anti-sun
  line, as a gold halo filling a planetarium frame that never asked for an eclipse.
- **Light is staging.** A key's screen position is a _product_ of two dot products, and
  both must carry the right sign. Whiteouts are honest scene changes, not a fade to hide a
  seam. Ask the font for its cap height rather than guessing it.
- **`tng-intro` is timed against a frame-analyzed reference edit** outside this repository
  at `~/Developer/tng-inertial` — `analysis/timeline.json` is the measured spec,
  `data/frames/` the per-frame imagery. Its measured numbers (credit grid, fade windows,
  the locked camera, the flash envelope) are regression tests in `cutscene.test.ts`.
  **Change them only to make the recreation more faithful, and say so.**
- **The reference audio and any full-sequence render carry third-party rights.** The track
  is never committed: it lives in R2 and `pnpm media:pull` fetches it into the gitignored
  `apps/game/public/media/`. Publishing a render needs a rights check first.
- Drive it with `ir.play('tng-intro')`, `ir.pause()`, and `ir.seekCutscene(1150)` for
  frame-exact stills against the reference.
