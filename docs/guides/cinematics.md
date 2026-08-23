# Cinematics

How scripted scenes are authored, sampled, and applied. The design intent is
[cinema](../design/cinema.md). The decision is
[ADR-0010](../adr/0010-cinematic-director.md).

---

## A scene is a shot list, not a camera move

Each shot owns its camera, placed against its own subject. Cuts hide in
darkness, behind a flash, or under a body filling the frame. Authored as one
continuous spline, a scene becomes a camera crossing astronomical units
between beats and aiming at whatever sits between them.

Time derives from `renderTime`, never a wall clock. A script's
`prepare(world)` resolves the stage once; its `sample(frame)` is pure.

---

## Where the code lives

| Layer                | Path                                              | What it is                                                                                     |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Pure arithmetic      | `packages/rendering/src/cinematic.ts`             | Easings, fade envelopes, camera routes, screen-space routes, solvers. Property-tested in Node. |
| Director and scripts | `packages/devtools/src/cutscene.ts`, `cutscenes/` | A `CutsceneScript` per file; register it in `harness.ts`.                                      |
| Application          | `apps/game`                                       | `engine.cinematic`, warp-effect quads, the DOM title overlay, the dock's cutscene section.     |

Choreograph in the frame. A hull's beats are
`(frame, screen x, screen y, range)` via `screenOffset` — the same terms a
tracked bounding box reports. `screenRoutePosition` interpolates range in
log space so a four-decade approach does not overshoot through the lens.

An effect is staging. It belongs in `CinematicEffects`, where a shot turns
it on, and it is 0 everywhere else. Do not derive a cinematic look from
geometry alone (for example an eclipse corona from occlusion). At
planetarium range the physical corona is a fraction of a degree past the
limb; a cinema-authored halo is not.

---

## Authoring rules

- Camera-relative choreography is **offset beats**, never absolute beats off
  a moving camera.
- Do not per-frame look-at a hull near the lens.
- Light is staging. A key's screen position is a product of two dot products
  that must both carry the right sign.
- Whiteouts are honest scene changes.
- Ask the font for its cap height rather than guessing it.

The proving scene (`tng-intro`) is timed against a frame-analyzed reference
edit that lives outside this repository. Measured numbers (credit grid, fade
windows, the locked camera, the flash envelope) are regression tests in
`cutscene.test.ts`. Change those numbers only to make the recreation more
faithful, and say so in the commit.

The reference audio is not in git and must not be. Publishing a full-sequence
render needs a rights check first. See [development](development.md).

---

## Related

- [Client](client.md) — camera precedence
- [Harness](harness.md) — `ir.play`, `ir.seekCutscene`
- [Driving](../agents/driving.md) — browser capture gotchas
