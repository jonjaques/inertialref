# ADR-0010: A cinematic director, as presentation over a running world

Status: accepted · 2026-08-21

## Context

The design charter's first pillar says, verbatim, "no cutscene" — its target is
the cutscene that _hides a level swap_: pre-rendered or gameplay-suspending
footage that papers over a loading screen or a state teleport the engine could
not do honestly.

A different thing turned out to be wanted: scripted scenes played _by_ the
engine, over the live world, as an exercise of the renderer and a seam for
future authored moments (arrivals, discoveries, an attract mode). The proving
case is a shot-for-shot study of the 1987 television title sequence, chosen
because a frame-analyzed reference exists for it — 2742 frames at 24000/1001
fps with measured shot boundaries, title fade windows, a credit grid, and
camera-hold constraints — which turns "does the recreation match" from an
opinion into a numeric diff.

The engine's architecture already had almost every seam this needs: a pure
camera rule (`chaseCameraPosition`) read by exactly one component, a plain-data
scene description built around one eye position, presentation-only flags on the
engine singleton, and a harness whose verbs are shared between browser and
headless runner.

## Decision

A cutscene is **presentation borrowed from a running world, returned intact**:

- **A scene is a shot list.** Each shot carries its own camera, aim and hull
  choreography, all local to it, and `sample` picks the shot the frame belongs
  to. Cuts are the vocabulary, not an accident: the frame ranges live in one
  table that the script and its tests both read, and every boundary has to be
  covered by darkness, a flash, a body filling the frame, or a matched
  composition. This replaced a single spline through the whole piece, which is
  what makes a camera cross five astronomical units between beats and drift
  through long stretches aimed at nothing.
- **Pure arithmetic in `packages/rendering`** (`cinematic.ts`): easings, fade
  envelopes, the measured warp-flash and lens-spike shapes, Catmull-Rom routes
  over `UniverseVector` beats, screen-space routes with range interpolated in
  log space, slerped aim routes, and the one- and two-target framing solvers.
  All testable in Node; the title-timing, hull-track and camera-hold
  measurements are asserted by tests.
- **The director and scripts in `packages/devtools`** (`cutscene.ts`,
  `cutscenes/`): `prepare(world)` resolves the stage once against live
  ephemerides; `sample(frame)` is then a pure function of a fractional frame
  number. Time derives from the snapshot's `renderTime` — never a wall clock —
  so playback is deterministic, pause/step-exact, and seekable to a reference
  frame for the verification loop.
- **The host applies the result**: `buildScene` accepts an optional eye
  override (LOD, apparent star brightness, `up` and flare occlusion must all
  follow the cinematic camera), `GameEngine` publishes a render-space
  `cinematic` view on the engine singleton, and `CameraRig` / `ShipModel` /
  the effects layer / a DOM overlay prefer it when non-null.
- **Nothing canonical is decided by a script.** `play` captures the player's
  state, control, assist and clock settings through the same verbs a save-load
  uses; `stop`, the final frame, and Esc restore them; a world replaced
  mid-scene abandons without restoring, because the captured state belongs to
  the discarded world.
- **The game never plays one uninvited.** The boot path is untouched; entry
  points are the dock's cutscene section and `ir.play`, and both are the same
  harness verb.

## Alternatives considered

- **Drive the player entity along the scripted path** (teleport per frame).
  Rejected: it writes canonical state 24 times a second for a purely visual
  outcome, fights flight assist and the contact test, and makes "restore on
  stop" a reconstruction rather than a putback. The camera override touches
  nothing the state hash covers.
- **A general keyframe/timeline asset format** (JSON scenes, tracks, curves).
  Rejected for now: one scene exists, and the vocabulary it actually needed —
  body-anchored standoffs, composition solvers, a wipe recipe — is arithmetic,
  not data. A format invented before a second scene would be an opaque
  abstraction with one caller, which `docs/vision.md` forbids.
- **A `camera` entity kind in the simulation.** Rejected: an entity implies
  canonical state, persistence and networking questions for something that is,
  definitionally, presentation. The nullable engine field answers "where is
  the eye" without inventing a ghost.
- **Post-processing passes for the effects** (velocity-buffer motion blur,
  bloom chain). Rejected on budget: the frame allocates ~3 ms to atmosphere
  _plus_ post, and the effects are needed for seconds, not always. Additive
  camera-space quads on the lens flare's pattern cost one visibility check
  per frame when dormant.

## Consequences

- The charter's pillar survives with its meaning intact: there is still no
  loading to hide and no state change smuggled behind a fade. What changed is
  that "the camera is the ship" now has one sanctioned, reversible exception,
  and it lives behind a null check that is dormant in every ordinary frame.
- The reference edit's measurements are now regression tests: the credit grid,
  the fade windows, the locked-camera constraint and the flash envelope fail
  loudly if a refactor drifts them.
- Scene scripts are code, not data — the same decision `scenario()` made — so
  a new scene is a new file exporting a `CutsceneScript`, and the registry is
  an array.
- The player entity keeps simulating underneath a scene. That is the point
  (stopping restores into a world that never stopped being real), but it means
  a scene's duration is bounded by the player's physical situation being
  restorable — a cutscene started mid-atmosphere returns you to
  mid-atmosphere.
