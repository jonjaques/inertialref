# CONTEXT.md — InertialRef build log

Working memory for agents: what actually exists, what was decided and why, and
which mistakes have already been made and must not return. Update it when a
package lands or a decision changes.

Scope and principles are in [`docs/vision.md`](docs/vision.md); the remaining
work is in [`docs/roadmap.md`](docs/roadmap.md); the reasoning behind each
foundational decision is in [`docs/adr/`](docs/adr/).

## Current state

Milestone 1 — the vertical architectural proof — is **complete**: 12/12 capability checks pass in Node and in Chrome. Multiplayer is
deferred to a later phase; only the seams exist (ADR-0008).

Verified in Chrome, in **both dev and the production build**: the harness on
`window.ir`, terrain streamed from a worker pool, landing on a generated
surface, a sphere-of-influence frame transition mid-flight, and a save
round-tripping through IndexedDB to an identical state hash. With the preview
server **stopped**, the page still loads from the service worker and passes
12/12 — offline-first demonstrated rather than asserted. The browser runs
~1.25M simulation ticks/s for one entity; the headless runner does ~100–105k ticks/s
including frame resolution.

| Package         | Layer | State                                                                           |
| --------------- | ----- | ------------------------------------------------------------------------------- |
| `shared`        | 0     | done — units, brands, invariants, structured logging                            |
| `spatial`       | 1     | done — UniverseVector, frame graph, floating origin                             |
| `procedural`    | 1     | done — PRNG, hierarchical seeds, noise, algorithm versions                      |
| `physics`       | 2     | done — Kepler, rigid body, atmosphere, thrusters                                |
| `universe`      | 3     | done — addressing, star catalogue, generation, terrain, frames                  |
| `simulation`    | 4     | done — clock, entities, flight, streaming, snapshots                            |
| `protocol`      | 4     | done — validation combinators, wire and save schemas                            |
| `workers`       | 5     | done — typed tasks, ports, pool, four tasks                                     |
| `persistence`   | 5     | done — save/restore, migration chain, store port                                |
| `net`           | 5     | done — authority port, local authority; remote + channel are H4                 |
| `rendering`     | 5     | done — LOD, depth compression, terrain meshing                                  |
| `devtools`      | 6     | done — inspection, twelve capability checks, harness, `openSession`             |
| `apps/game`     | —     | done — React + R3F client on `WebGPURenderer`/TSL, worker pool, IndexedDB saves |
| `apps/headless` | —     | done — Node runner, ~100–105k ticks/s, `pnpm sim --self-test`                   |

## Decisions that are expensive to reverse

Full reasoning is in `docs/adr/`. The short version:

1. **Positions are sector + offset, not doubles.** int32 sector index per axis
   plus a double offset inside a 2^40 m sector. Sub-millimetre everywhere in a
   249,000 ly of the origin. The power-of-two sector size makes carrying exact, so
   crossing a sector boundary adds zero error.
2. **Frames are not a precision mechanism.** The coordinates already are.
   Frames carry the semantics of motion and give rendering a local origin. A
   frame-local `Vec3` is only precise near its own frame — there is a test that
   documents that limit rather than hiding it.
3. **Seeds derive down a path of labels**, never along a shared stream. Golden
   vectors lock the PRNG output; changing them is deliberate and comes with an
   algorithm-version bump.
4. **Identity is an address**, and the address is also the seed path and the
   text form used in saves, logs and the harness. A body's index is the ordinal
   it was **issued** at, not its orbital position (ADR-0009) — so a newly
   confirmed exoplanet can be added without renaming every world outward of it.
   Adopted in pre-alpha because it is a generator change now and an unresolvable
   migration once any save corpus exists.
5. **64 Hz fixed tick**, because 1/64 is exact in binary. Wall clock only
   decides how many steps to run.
6. **Orbits are analytic**, not integrated. Bodies have no interpolation error
   at any time warp, and an unloaded system can still answer where its planets
   are.
7. **Ships integrate only in non-rotating frames.** Landed ships are attached
   kinematically to a surface frame instead.
8. **Render compression keys off distance to the _surface_.** Keying off the
   centre put a planet's datum sphere 30 km from the terrain it represents.
9. **A save is a reference, not a copy** — under 700 bytes for a flown session.

## Conventions worth knowing before editing

- **Axes: right-handed, +Y up.** System reference plane is XZ, forward is −Z.
  Textbook orbital mechanics is +Z up, so `physics/frameConvention.ts` converts
  once at that boundary and nowhere else.
- **SI internally.** Presentation units are branded and only exist for display.
- **Terrain is sampled in body-fixed axes.** Sampling it in inertial axes leaves
  the mountains behind as the planet rotates; this was a real bug.
- `packages/*` must run unchanged in the browser, a worker and Node. The root
  `tsconfig.json` gives them no DOM lib, which is how that is enforced.
- No TS project references: a referenced project may not disable emit. Three
  independent tsconfig projects, plus `pnpm graph` for the dependency layering.

## Commands

```bash
pnpm dev         # ONE command: vite on 5173 and wrangler on 8787, /api proxied
pnpm dev:client  # just vite      pnpm dev:server  # just wrangler
pnpm preview     # build, then the real Worker over the real dist — production
pnpm test        # vitest, node environment only
pnpm typecheck   # five tsconfig projects
pnpm lint        # oxlint
pnpm graph       # dependency layering + cycle check
pnpm brand       # re-render every brand artefact from design/brand/brandmark.svg
pnpm build       # optional media pull, typecheck, vite build
pnpm check       # all of the above
pnpm vitest run <substring>   # single test file
pnpm run deploy:worker        # pnpm build, then wrangler deploy

pnpm catalog:report           # build the star catalogue and print the counts
pnpm catalog:build            # ...and write data/catalog
pnpm media:pull               # the cutscene audio, from R2 (never committed)
```

## The architecture pass (19 Aug 2026)

An architecture review found eight areas of friction; all eight were addressed.
The load-bearing changes:

- **`openSession` owns assembly** (`devtools/session.ts`). The seven steps of
  standing up a world, a ship, a pool, a store and a harness had five copies —
  the client, the headless runner, the capability checks, the harness's own
  target search and the devtools tests — and they had already drifted: the
  client spawned at 2.5 body radii, everything else at 3. `GameEngine` now takes
  its adapters as arguments instead of constructing `IndexedDbSaveStore`,
  a browser `WorkerPool` and a console sink directly, which is what makes
  `apps/game` testable in Node at all. It has tests now; it had none.
- **`HarnessHost` split** into `SimulationHost` and an optional
  `PresentationHost`. The headless runner used to stub three of eight members,
  one of them by throwing.
- **`BodyFixedDirection` is a branded type.** `surfaceRadius` cannot be called
  with inertial axes any more. See the bug list below.
- **`groundElevation` is the single owner of the sea clamp**, so physics and the
  terrain mesh cannot disagree about where the ground is.
- **The worker boundary decodes.** `host.ts` validates the envelope instead of
  checking a discriminant and passing `payload as never`; the save schema's
  `kind` is decoded as its four literals rather than cast.
- **Landedness is a consequence, not a parameter.** `teleport` lost its `landed`
  argument.
- **Player input goes through `World`** (`setControl`, `setFlightAssist`,
  `killRotation`) rather than `entities.update`, so the door that skips the
  interpolation and landed-set resets is no longer as wide as the one that
  does not.
- **`stateHash` hashes what it claims**: angular velocity, control and flight
  assist are in it now.
- Three speculative config seams in `rendering` (`SceneConfig`,
  `PlacementConfig`, `LodThresholds`) collapsed to constants — six signatures
  lost a parameter no caller ever supplied.
- **The two `WorkerPort` adapters agree.** The inline transport now
  `structuredClone`s messages and honours its transfer list; it did neither, so
  a payload holding a `Map`, a class instance or a function passed every Node
  test and threw `DataCloneError` in Chrome. Making it throw exposed a second
  gap: `WorkerPool` left the job in `#active` with nobody settling its promise,
  so the caller hung and the failure surfaced later as an unhandled rejection
  from `terminate`. Both are fixed and tested.
- **`pnpm graph` enforces the no-vendor-SDK rule.** It discarded every
  non-workspace edge before looking, so the rule was documented as enforced
  while nothing enforced it. It now rejects any third-party runtime dependency
  in `packages/*` — of which there are, and should be, none.

## Navigation and the dev dock (19 Aug 2026)

Milestone 1 proved the architecture and left the game unplayable in one specific
way: a session opened in orbit above the first landable body of Sol and there
was no way, from inside the running game, to learn that anywhere else existed.
Every driving verb took an address and nothing produced one.

- **`ir.targets()` is the missing question.** `packages/devtools/travel.ts` walks
  the loaded systems and the star survey into one flat listing — address, name,
  what it is, how far away, whether you can land on it — with a depth of 0, 1 or
  2 so the flat list renders as the containment tree the addresses already
  describe. A loaded system stays in the listing however far you fly, because a
  debug tool that drops the place you came from strands you.
- **`ir.goTo()` is the only lenient address parser in the codebase.** It takes
  `SOL`, `s:SOL/b:2` and `b:2`-relative-to-here, and dispatches to `orbit` or
  `goToSystem` rather than reimplementing either. `parseAddress` stays strict:
  an address whose meaning depends on who is asking is fine at a debug prompt
  and nowhere else.
- **The viewing altitude is one body radius, clamped to 0.9 of the sphere of
  influence.** A "circular orbit" placed outside the SOI is reframed to the
  parent — `stepFlight` leaves at 1.05 × SOI — so the verb that promised to park
  you somewhere would instead fling you across the system, and only for the
  small moons. There is a test that walks every body of a system and checks the
  frame still holds after a minute; it was confirmed to fail by raising the
  altitude to 40 body radii. Both numbers were settled by looking at the screen
  rather than by argument: a quarter radius fills the frame edge to edge with no
  limb visible, and half the SOI is _inside the surface_ of a planet orbiting at
  0.005 AU, which collapsed the clamp onto its floor and parked the ship 10 km
  up.
- **Arriving somewhere points the nose at it.** `orbit` aims along the track,
  which is right for flying and wrong for arriving: you teleport into orbit and
  see empty space, which reads as a planet that failed to load. Naming a _system_
  arrives at its first planet for the same reason — 40 AU out in the dark, a red
  dwarf is a sub-pixel point and travelling looks like a no-op. `distanceAu`
  asks for the hold-off explicitly.
- **The overlay became a dock.** Two tabs — navigate and telemetry — sharing one
  panel, every section collapsible and remembered in `localStorage`, and a
  toolbar so pause, time warp, assist and save/load are not keyboard-only. The
  panel calls the harness and nothing else, which is the rule that keeps a
  clicked manoeuvre reproducible in a test.
- **Flight input now ignores keystrokes aimed at a text field.** The address box
  is the first input in the game; without the guard, typing `SOL` fires the
  retro thruster. Buttons blur themselves on click for the same reason — a
  focused button eats Space, which is pause.
- `apps/game/src/hud/hud.test.ts` renders the dock to static markup in Node.
  It proves nothing about layout and cannot; what it catches is a HUD that
  throws on first render, which nothing else in the suite would notice.

## Bugs the tests found (worth not reintroducing)

Each of these was invisible in a running browser and caught by a test or by
driving the harness. They are listed because the same mistake is easy to make
again in a neighbouring system.

- Terrain sampled in **inertial** rather than body-fixed axes: mountains stood
  still while the planet rotated under them.
- **No ground contact at all**: a ship dropped from orbit flew through the
  planet. Contact must be tested after integrating, against the new position —
  at 20 km/s a tick covers 300 m.
- Moons generated **outside their planet's sphere of influence**, i.e. not
  actually bound to the planet they claimed to orbit.
- **`AnimatePresence mode="wait"` never completed a dialog's exit**, leaving the
  scrim in the DOM at `opacity: 0` with `pointer-events: auto` — an invisible
  full-viewport layer over a running mode that swallowed every click. Nothing to
  see and nothing works is the worst shape a bug can take; it survived an
  accessibility audit because the audit opened dialogs and never closed one.
- **A glow as a selected state on a bright background.** The selected sky label
  was `sky-200` plus a sky-coloured glow and measured 1.16:1 against a star:
  light added to light. Selection has to change hue or carry its own ground.
- Surface frame ids were **not idempotent**: `(-1e-9).toFixed(6)` is
  `"-0.000000"`, which re-parses to `-0`, which formats as `"0.000000"`.
- The frame's geometry used unrounded angles while its id was rounded, so a
  restored landing site sat half a metre from the original.
- **Control input was not persisted**, so a save taken mid-burn resumed
  coasting.
- Terrain patches carried **radial normals**, shading a mountain range exactly
  like a smooth sphere — real relief rendered and was invisible.
- The harness host **captured `world` by reference**, so loading a save left the
  debug overlay reporting on the discarded world.
- A property test was **flaky, correctly**: depth compression is non-decreasing
  everywhere but only strictly increasing while the separation survives double
  precision.
- **Terrain sampled in inertial axes, again.** The fix recorded above was
  applied to one of the two samples in `stepFlight`. The other — the
  pre-integration one, seventy lines above the comment explaining why you must
  not — is the altitude the _atmosphere_ is evaluated against, and its terrain
  gate (`radius * 0.25`, ~1,600 km) is far wider than any atmosphere ceiling
  (60–180 km), so every atmospheric pass in the game used it. Nothing rendered
  wrong and no test failed, because that number only ever reaches a drag
  coefficient. `BodyFixedDirection` now makes it unrepresentable.
- **`seaLevel` was honoured by physics and ignored by the mesh.** It was carried
  from the generator through the worker to `terrainMesh` and dropped, so on a
  world with an ocean the landing pad sat on the water datum and the mesh drew
  the seabed underneath it.
- **`ir.land()` never landed.** It teleported the ship 3 m up and declared it
  landed; `stepFlight` short-circuits to `stepLanded` for an already-landed
  entity, so the contact test never ran and the ship hovered there permanently
  while `altitudeOf` reported 0. Dropping the flag was not sufficient — 3 m is
  inside `LANDING_CLEARANCE`, so it then "landed" at 3 m. A surface frame's
  origin _is_ the pad, so the answer was `Vec.ZERO`.
- **The starfield ignored the render origin's orientation.** It open-coded the
  projection over raw sector fields with `2 ** 40` inline, in the one directory
  vitest did not cover, while `placePoint` — written for the job — had no
  callers. Bodies were rotated into render axes and stars were not.
- **The terrain streamer resurrected pruned patches.** `update()` pruned to the
  ~9 visible patches and the caller then invoked `rebuild()`, which walked the
  whole 64-entry heightfield cache — one frame of off-screen geometry uploads on
  every origin rebase. `#ensure`'s generation check already covered it.
- **The normals test could not fail.** It asserted only that a normal was unit
  length, and a radial normal is also unit length — so it passed both before and
  after the fix for the bug it exists to guard.
- **The scene was lit by whichever star loaded first.** `stars[0]` is the key
  light, and `buildScene` emitted them in snapshot order — which is load order.
  Invisible while one system was ever loaded, and wrong the moment travel made
  two normal: arriving at Proxima left the scene lit by Sol, 4.2 light years
  behind, and the star overhead contributing nothing. They are sorted by
  apparent brightness now. Found by flying there and looking, not by a test —
  the test came after.
- **The ground slid out from under a landed ship, ten times a second.** Terrain
  patches were emitted in render space against the body's pose at build time and
  only rebuilt when the render origin rebased, so between rebases the ground was
  frozen at a pose the planet had already left — 865 m of slide per frame on a
  world orbiting at 52 km/s, snapping back on every rebase. Geometry is
  body-fixed and anchor-relative now, built once and placed per frame, which is
  what the datum sphere beside it had always done. A second cause of the same
  shape was hiding behind it: the streamer read `world.clock.time` while a
  snapshot presents the world one tick earlier, putting the ground 812 m ahead
  of everything standing on it. The regression test measures the invariant
  rather than either mechanism — a landed ship and the ground beneath it are
  both fixed in body-fixed axes, so their separation in render space is a
  constant — and it fails at 2,101 m and 90 m respectively.
- **The chase camera had no floor.** The offset is 14 m behind the ship in
  _ship_ axes, so pitching the nose up swings it down: 10° puts it at ground
  level and 40° puts it 7 m under. Underground, the near terrain vanishes to
  backface culling, stars show through the crust and the far terrain reads as a
  second band of land above the hole — it looks like broken geometry and it is a
  camera with no floor. `chaseCameraPosition` in `rendering` owns the rule now,
  because the three lines of vector arithmetic it replaces lived in a React
  component where nothing in Node could reach them.
- **Two clamps for one spiral.** The view clamped the frame delta to 0.25 s,
  which changed nothing (`SimulationClock.advance` already caps a step) and
  corrupted `droppedTicks`: a three-minute background stall was reported in the
  HUD as 8 dropped ticks instead of 11,520.
- **Every terrain triangle was wound clockwise seen from outside the planet**
  (20 Aug 2026), so the single-sided material culled the entire mesh from
  above, on every cube face, since the day it was written. The "ground" on
  screen was always the datum sphere 11 km below, dead flat; the only terrain
  ever drawn was the far slopes of ridges poking above eye level, leaking
  through as a thin terrain-coloured band floating over the horizon — visible
  landed, gone by ~100 m up, which is what finally localised it. No
  distance-based test could catch it: winding is invisible to arithmetic about
  vertex positions, and the strobe test's invariant (constant ship–patch
  separation) holds in either order. Found by rebuilding the exact scene in
  Node and raycasting it — `THREE.Raycaster` honours `material.side`, so
  "FrontSide: no hit, BackSide: hit at 2.39 m" was the whole diagnosis. The
  regression test asserts the geometric normal of every triangle points out of
  the planet, on all six faces, because each face maps (s, t) to different axes
  and a one-face test could pass with hard-coded handedness.
- **A stale starfield survey could land in a replaced world** (20 Aug 2026).
  `#invalidateDerived` cleared the starfield but nothing stopped a survey
  already in flight from repopulating it after the load — a save loaded in
  another system briefly wore the old system's stars. Masked for as long as
  terrain tasks queued ahead of the survey delayed it past every observer, and
  surfaced the moment the streamer stopped requesting patches from orbit: the
  existing invalidation test failed on scheduling alone. The survey now carries
  the world generation it was asked about and a result from a gone world is
  dropped.

## The five spikes, measured (19 Aug 2026)

Full write-ups with method and numbers in [`docs/spikes.md`](docs/spikes.md).
What matters here is the handful of facts that will otherwise be rediscovered
expensively.

- **`renderer.info.render.timestamp` lies on the canvas path.** It reported
  14.615 ms for a frame whose true GPU cost is 7.27 ms — it double-counts when
  three renders an output pass. Wall clock across `queue.onSubmittedWorkDone()`
  and a raw `timestamp-query` both agree with reality; that instrument does not.
  The first run of the TSL spike concluded "TSL is 2× slower" on the strength of
  it, which was false. This will bite the benchmark harness.
- **TSL costs nothing.** Generated WGSL ran at 1.000× hand-written, pixel-identical,
  in an interleaved same-harness comparison. The generator inlines every `Fn` and
  hoists every intermediate to a function-scope `var`; Metal removes the
  difference.
- **HDR output is one constructor parameter.** `WebGPURenderer({ outputType:
HalfFloatType })` sets both the `rgba16float` canvas format and
  `toneMapping: { mode: 'extended' }`. Setting `outputColorSpace` alone does
  nothing — `ColorManagement.getToneMappingMode()` has no caller in three r182.
- **`(dynamic-range: high)` is not a display test.** Chrome and Safari report true
  for an ordinary 2×-EDR laptop panel; Firefox reports false for the same display
  and cannot configure an `rgba16float` canvas at all. Detection has to be a
  capability probe.
- **Gaia is CC BY-NC 3.0 IGO.** Non-commercial, verified against ESA's licence
  page — not "open with attribution", which is what the design bible said. It
  stays out of any shipped bundle until ESA says otherwise in writing.
- **The catalogue is 12× cheaper than estimated.** 150 ly of HYG plus every
  confirmed planet inside it packs to ~159 KB brotli, against an estimate of
  ~2 MB. Size was never the constraint; HYG's completeness is — it holds ~52% of
  CNS5 within 25 pc.
- **HYG moved to Codeberg** and the GitHub copy is frozen at v4.1. The files are
  git-lfs pointers, so a `raw/` fetch silently returns 133 bytes of pointer text
  instead of data. Use the `media/` path and assert on the row count.
- **The Gamepad API caps at 16 axes / 32 buttons**, and on macOS Chromium indexes
  buttons by HID usage and _silently drops_ any usage above 32. WebHID has no such
  cap but exists only in Chromium.

## The horizon gap (resolved 20 Aug 2026 — it was the triangle winding)

**Standing on a world, there was a band of empty space at the horizon with
stars through it.** Three separate bugs were found and fixed while chasing this
(the sliding patch set, the render-time mismatch, the camera with no floor) and
the band survived all three, because the actual cause was the terrain winding
bug above: the mesh was culled from above everywhere, so the "ground" was the
datum sphere and the wedge between its limb (5.121° below the horizontal) and
eye level was open sky. With the winding fixed, the streamed terrain occludes
that wedge from the ground, exactly as real terrain should — a headless raycast
down the screen's centre column now crosses from sky to terrain at eye level
and never reaches the sphere.

What remains true, and still matters from altitude: the datum sphere is drawn a
full relief below the datum, so once the camera is high enough that the edge of
the streamed set dips below the sphere's limb (~150 m at this site), the sunken
sphere shows beyond the terrain's edge again. That seam is the real "terrain to
the horizon" work — [the terrain quadtree](docs/roadmap.md#terrain) the roadmap
already names as the next milestone. From orbit the winding fix exposed the
other end of the same seam — the 3×3 window read as a lone tile floating on
the sphere — so `terrainOpacity` in `lod.ts` now fades streamed terrain out
entirely above one octave of the full-detail altitude (solid below ~16 km on
this body, gone above ~32 km, a transparency ramp between); the streamer stops
requesting patches at zero, and the sphere alone represents the planet up
there until the quadtree can do better. The measurements below are kept because
they are correct and the next milestone needs them — all from `s:SOL/b:0`,
landed at 0.35, −1.1:

| Quantity                                                | Value                                    |
| ------------------------------------------------------- | ---------------------------------------- |
| Body radius                                             | 2,864,333 m                              |
| `surface.maxElevation` (= `relief`)                     | 11,133 m                                 |
| Datum sphere drawn radius (`radius − relief`)           | 2,853,200 m                              |
| Camera height above that sphere, standing on the ground | 11,436 m                                 |
| Sphere's limb, below the horizontal                     | **5.121°** (≈ 64 px at 65° FOV / 812 px) |
| Streamed terrain, edge to edge                          | 5.2 km (3×3 patches at level 12)         |
| Farthest terrain vertex from the camera                 | 4.3 km                                   |

So the ground you stand on is a 5 km mesa floating 11 km above a featureless
sphere. From the ground the mesa now hides the sphere entirely; from altitude
the wedge of sky between the mesa's edge and the sphere's limb reappears. The
sink is deliberate — `scene.ts` explains that a sphere at the datum hides every
valley on the planet — and it is the _right_ call from orbit and the wrong one
near the ground.

Approaches considered and not taken for that remaining seam, with the
arithmetic:

- **Blend the sink to zero near the surface.** Shrinks the band from 5.1° to
  ~1° (64 px to 13 px). Cheap, but a mitigation: any sphere below your feet has
  its limb below your horizon, so the band never closes.
- **Sphere at the local ground radius.** Closes the band exactly, and submerges
  every near patch that dips below it — an ocean without water.
- **Terrain to the horizon.** The only one that removes it rather than shrinking
  it, and it is [the terrain quadtree](docs/roadmap.md#terrain) already named as
  the next milestone. The true horizon from 2 m up on this body is 3.4 km, so
  the streamed set is already within a factor of two of covering it.

## The WebGPU and TSL migration (20 Aug 2026)

`docs/design/technical.md` § The WebGPU migration, carried out. The renderer is
now `WebGPURenderer` with TSL node materials; WebGL 2 is retained as
`WebGPURenderer`'s own fallback backend, so there is one set of node graphs and
no second material path. `packages/rendering` did not change and could not — it
emits plain data and has never imported Three.js, which is the whole reason the
swap was confined to `apps/game/src/render/` and `apps/game/src/scene/`.

Verified on the real GPU rather than only in CI: WebGPU backend, extended-range
output resolved on a display reporting `dynamic-range: high`, 60–70 fps in orbit,
on the surface and on approach, zero GPU validation errors.

What is genuinely new rather than ported: a capability probe and the three-state
HDR override `docs/design/art.md` calls mandatory; a tone curve that _is_ stock
ACES at headroom 1 and lifts only above the shoulder beyond it; an analytic
atmosphere with a real path integral; and a star field of instanced sprites.

### Four things that must not come back

- **WebGPU has no point size.** `PointsNodeMaterial.sizeNode` is ignored on a
  `Points` object under the WebGPU backend — every point renders at one pixel —
  and honoured on the WebGL fallback. The star field is a `Sprite` with an
  instanced position attribute and `Sprite.count` for exactly this reason. A bug
  visible only on the _primary_ backend is the worst shape a rendering bug has.
- **A `vec3` clamped against `float` bounds renders black, silently.**
  `clamp(graded, 0, headroomUniform)` generated a WGSL `clamp` whose arguments did
  not agree on a type: no warning, no exception, no console output, an entirely
  black frame. `graded.clamp()` gets away with plain numbers because a const is
  converted where a uniform node is not. Both bounds are `vec3(...)` now.
- **React Three Fiber cannot release a `WebGPURenderer`.** Its unmount path calls
  `renderLists.dispose()` and `forceContextLoss()`, both WebGL-only and both
  optional-chained, so both are silent no-ops. Two renderers then share one canvas
  and disagree about its size — `depthBuffer` at 300×150 against attachments at
  1800×1026 — and every frame submits an invalid command buffer until Chrome kills
  the tab. StrictMode's double mount reaches it in development and the HDR toggle
  reaches it by design. `releaseRenderer()` in the factory owns this now.
  **It does not reproduce at devicePixelRatio 1**, where the two renderers happen
  to agree, so headless verification reported it fixed while a Retina display was
  losing the tab on every load.
- **Never share the probe's `GPUDevice` with the renderer.** `requestDevice` is
  honoured once per adapter, so a renderer that later wants its own gets a device
  that is already lost, and a device shared with something that outlives its
  creator has no owner. The probe destroys its own; three requests its own from a
  fresh adapter.

### And one instrument that lies

R3F sets `outputColorSpace` and `toneMapping` itself, in `configure()`, which runs
_after_ the async `gl` factory resolves — so it lands on top of the custom tone
curve and reverts the renderer to stock ACES with its clamp to [0, 1]. Invisible
on the sRGB path; on the extended path it discards the entire range the migration
exists for. `commitToneCurve` in `onCreated` puts it back.

## Time warp, and the overlay that found it (20 Aug 2026)

`SimulationClock` capped every frame at `DEFAULT_MAX_STEPS = 8` ticks. At 60 fps
that is 480 ticks per second, which is **7.5× real time** — so of the seven
detents the dev dock offers, 1× through 100,000×, everything past 5× ran at
exactly the same speed and every tick above it was counted into `droppedTicks`
and never shown. The cap had been there since the clock was written.

The mistake was one budget doing two jobs. Eight ticks is the right guard against
a _stalled_ frame — a backgrounded tab returning after a minute must not try to
run 3,840 ticks — and the wrong one for a _deliberate_ frame, and the clock could
not tell the difference. The budget now scales with the requested time scale,
bounded by `MAX_WARP_STEPS = 2048`, so 1× behaves exactly as it always did and
warp gets what it asks for up to a ceiling. Measured after: 1×, 5×, 25×, 100× and
1000× all deliver in full; 100,000× delivers 1,927× and says so.

`ClockStatus.achievedTimeScale` is the "says so". It is a ratio of ticks wanted
to ticks run, not a sampled rate, so it reads exactly `timeScale` when the clock
is keeping up and does not wobble at 1×.

### The perf overlay

Dock tab three, `P`. `Series` in `packages/devtools` is the ring buffer and its
statistics — pure arithmetic, property-tested in Node against a plain array,
because a wrapped index and a nearest-rank percentile are three chances to be off
by one and none of them would look wrong on a plot. `apps/game` supplies what to
sample. `push` allocates nothing; `clock.achievedTimeScale` and `pool.queued`
exist as getters so the per-frame sample does not build two throwaway objects to
read two numbers.

Measured on an M5 at 1000×760, dpr 2, extended HDR — 60 fps in orbit, on approach
and on the surface; engine 0.19–0.23 ms; GPU 1.85–2.70 ms/frame; 10–17 draw
calls; 66–74 MB heap.

### Three more things that must not come back

- **`renderer.info` is reset by three's own rAF loop, not by the render.**
  `Info.autoReset` is honoured inside `Animation`, a `requestAnimationFrame`
  three starts for itself and keeps running whether or not anything uses it. With
  R3F driving the renderer instead, that reset lands at a moment unrelated to any
  frame R3F draws: `info.render.drawCalls` read from the frame loop was reliably
  **0** while the identical field read from the console was **11**. A counter
  that is right when you inspect it and wrong when you record it is worse than no
  counter. `autoReset` is off and `GameEngine.frame` resets it after sampling.
- **React Compiler froze the entire overlay on its first render.** Every input to
  the panel is a `GameEngine` that never changes identity, so
  `metrics.period.summarise()` looks like a pure call on a stable object and is
  computed once. It is not pure — it reads a ring buffer the frame loop is still
  writing to. The panel showed its first frame's numbers for the rest of the
  session, reporting `starting…` for a renderer that had been live for minutes.
  `'use no memo'` is the documented opt-out and those three components carry it.
  This will happen again to anything that renders live mutable state.
- **A frame _period_ is not a frame _budget_.** The budget is 16.6 ms of work;
  the plot samples the interval between animation frames, and on a vsynced
  display that interval is pinned near 16.67 ms no matter how little work
  happened. Colouring the plot on the budget alone marked a comfortable 60 fps as
  over budget permanently. The dashed rule is the budget; the warning fires at
  25 ms, which jitter cannot reach and a missed vsync always does.

## Hosting: the client is on a URL (20 Aug 2026)

`docs/hosting.md` H0 and H1, plus half of H2. Live at
<https://inertialrefd.jaquers.workers.dev>, served by `apps/server` — one
Cloudflare Worker holding the static bundle, `/api/health`, and `/ws` reserved
behind a deliberate 501. No Durable Object, no D1, no socket: everything stood
up, nothing load-bearing.

- **The whole change is above `packages/`, and that was the point.** Standing up
  an origin, an API and a versioned handshake required no change to the
  simulation core at all. The two things that did move below `apps/` were a
  decoder loop that belonged in the combinators and the H0 fix — the seams held.
- **H0 first: the debug overlay was computing partition keys itself.**
  `inspect.ts` scanned an entity's frame chain for an `s:` prefix and returned
  the frame id, which matched `partitionForAddress` only because the frame
  grammar and the partition grammar spell a system the same way. The frame
  grammar's owner now supplies the inverse (`systemOfFrameId`), and the overlay
  composes it with `partitionForAddress`. The test that guarded this asserted the
  literal `'s:SOL'` — which passes for both the right answer and the coincidence
  — so it now compares against the router's own output.
- **A 200 is not a server.** `/api/health` is decoded, not trusted:
  `decodeServerHealth` plus `incompatibility()` in `packages/protocol/src/net.ts`.
  A captive portal answers every request cheerfully with an HTML login page, and
  status-checking alone cannot tell that from a healthy server. Verified in the
  browser against the live deployment, along with a version mismatch, a dead
  server, and the browser's own offline event.
- **An algorithm one side has never heard of is a mismatch, not a default.** The
  tempting behaviour — ignore unknown keys in the generation manifest — makes the
  handshake pass in exactly the case it exists to catch, because a generator the
  server runs and the client does not is a universe the client cannot derive.
- **The service worker cached `/api` for the lifetime of the cache.** Fixed in
  three layers, because the failure is silent, survives reloads and looks exactly
  like an outage: the worker returns early for `/api` and `/ws`, the Worker sends
  `no-store`, the client's probe asks for `no-store`. Two adjacent bugs went with
  it — cache-first pinned the _unhashed_ files in `public/` forever (now
  stale-while-revalidate; only content-hashed `/assets/*` stays cache-first), and
  a hand-bumped cache name meant dead chunks accumulated across deploys (now
  named after the build id, which arrives on the registration URL because
  `sw.js` is copied verbatim and never compiled).
- **The service worker is now tested, in Node.** `serviceWorker.test.ts` loads
  the real file, installs its real handlers against stubbed globals and asks it
  what it would do. A mirror of the policy would have passed while the policy
  drifted — the same trap as the terrain-normals test. It asserts the bypass
  covers exactly the paths `net.ts` declares, which is the one duplication that
  could not be removed.
- **`Date.now()` in a Worker is not the time.** It returns the time of the last
  I/O and does not advance during execution — a Spectre mitigation. The health
  record deliberately carries no timestamp; a clock read there would be
  authoritative-looking and wrong.
- **pnpm 11 wants `allowBuilds`, not `onlyBuiltDependencies`.** `workerd` ships a
  native binary and its postinstall was being skipped, which fails at
  `wrangler dev` rather than at install.
- The bundle grew 2.2 KB gzip (503.9 KB by Vite's reporter). The figure recorded
  under **Known gaps** and in `docs/design/technical.md` predates this and was
  taken with an unrecorded instrument; refreshing it wants one deliberate
  measurement pass, not five edits.

## The authority port (20 Aug 2026)

`docs/hosting.md` H3. `packages/net` (layer 5) holds `AuthorityPort` and
`LocalAuthority`; `openSession` takes one and defaults to local. **Nothing about
the simulation changed** — capability check 12 still reports state hash
`804b2d58` at tick 513, and a session opened with an injected authority produces
a byte-identical hash to one opened without.

- **The seam is the default, not a branch.** `openSession` has no `if (online)`
  anywhere: it always joins an authority, and the one it constructs when nobody
  passes another is a `LocalAuthority` over its own world. That means the
  single-player path is what the browser client, the headless runner, the
  capability checks and every test exercise by default — which is the only
  mechanism that reliably keeps it from rotting into a stub, and the reason it
  is worth building before there is anything remote to talk to.
- **`LocalAuthority` is degenerate, not fake, and the tests say so.** The
  temptation with an implementation that mostly does nothing is to assert that
  it does nothing, which passes equally well once it has quietly stopped doing
  the things it should. So the tests assert true statements instead: which
  partition, refused on what grounds, and that it never emits an `entities`
  update however much intent it is handed. An authority echoing a client's own
  ship back at it would fight the local simulation every tick.
- **`status().partition` is recomputed, never remembered.** A remembered one is
  right until the first frame transition and quietly wrong afterwards. Flying
  Sol → Alpha Centauri moves the reported authority from `s:SOL` to
  `s:HIP71683` with nothing driving it, so ADR-0008's open handoff question is
  now something you watch on the overlay rather than discover inside a Durable
  Object.
- **Refusal is a `Result`, not a rejection.** A version mismatch is an answer;
  the save loader treats a newer schema the same way and for the same reason.
  `LocalAuthority` runs the same `incompatibility()` check a remote one will, so
  the two cannot drift into different rules for the same question, and it
  additionally refuses a hello carrying a different seed — the seed _is_ the
  universe, so a replicated position would refer to a planet only one side has.
- **`incompatibility()` compares two peers, not a server and a client.** It was
  typed `(ServerHealth, ClientVersions)`, which made the local authority — a
  server to its own client — read as if it were borrowing the client's type.
  Now `(server: Versions, client: Versions)`, and the message reads in argument
  order: `terrain 1≠2` is server 1, client 2.
- **The port takes `() => World`, not a `World`.** Loading a save replaces the
  world wholesale; a holder of the reference goes on reporting about the
  discarded one. `openSession` already learned that (its `world` is a getter for
  exactly this reason), so the port was built with the same shape rather than
  relearning it.
- **`partitionForFrames` moved into `universe`.** Two callers now need "which
  partition owns this ship" — the overlay and the authority — and two
  open-codings of it is the bug H0 had just finished fixing. One implementation,
  in the package that owns both grammars.
- Not built, deliberately: `remote.ts`, `channel.ts`, and any caller for
  `submit`. Intent has no recipient until there is a socket, and shipping a
  transport that transports nothing is how a seam becomes fiction. `submitted`
  is on the overlay reading `0`, which is the first number worth having at H4.

## Real astronomy (20 Aug 2026)

The catalogue stopped being 18 hand-transcribed stars and became an ingest.
`data/catalog/stars-150ly.irsc` is **7,123 real systems and 702 confirmed
planets** out to 150 light-years, built by `apps/ingest` from HYG v4.4 and the
NASA Exoplanet Archive, committed at 458 KB (179 KB brotli), and fetched at
runtime as its own asset. Operating it is
[`docs/guides/catalogue.md`](docs/guides/catalogue.md); the design it implements
is [`docs/design/galaxy.md`](docs/design/galaxy.md).

The old `catalog.ts` said its shape was chosen "so that swapping the source does
not change anything downstream". It was right — the swap changed three function
signatures and no architecture — but "downstream" turned out to include four
things that were not obvious.

### The catalogue is a second generation input, and it has to be an argument

`docs/design/galaxy.md` Rule 1 says the catalogue version is an explicit input to
generation. The cheap implementation is a module-level singleton the generator
reads, and it would have been wrong in the specific way this project cannot
afford: the catalogue changes when astronomy publishes, and a universe that
changes silently underneath a save invalidates every address in it.

So `resolveSystem`, `systemsWithin` and `new World({ … })` all take it. Five call
sites, one line each. `SaveGame` records `catalog` beside `generation` — it is a
string and `generation` is a map of numbers, which is the only reason it sits
beside rather than inside.

### Workers cannot have it, so tasks take what they need

Every worker task used to take a system id and resolve it, which now needs a
458 KB table in every worker in every pool to answer a question the caller
already knew the answer to. Two changes, both narrowing:

- `generateCell` takes a `CellContext` — how many catalogued stars are in this
  cell, and the radius inside which the catalogue is complete. Those two scalars
  are the whole of what procedural generation needs from the catalogue.
- `surveySystemTask` takes the resolved stub instead of an id. The caller had
  already resolved it; passing the id was asking for the work twice.

### Procedural fill has to subtract, and then stop

The density model says how many stars there **are**. The catalogue says how many
of them somebody has written down. Those are different numbers and the difference
is the whole quantity:

- Generating the full expected count _on top of_ the catalogue doubles the solar
  neighbourhood — 7,123 real systems within 150 ly plus the ~40,000 the density
  model expects in the same volume.
- Generating none leaves it five times too sparse, because HYG holds about 59% of
  the known stars within 25 pc and none of the brown dwarfs.

So the fill is `expected − catalogued`. That was still wrong near the Sun: the
first run put a procedural M dwarf **3.4 light-years away**, closer than Proxima
Centauri, which would have been the astronomical discovery of the century. The
density model is right about how many stars there are and says nothing about how
many are _unknown_, and within a few parsecs that is all of the difference. Fill
is now suppressed inside `completeRadiusLightYears` (25 ly) and
`ingest.test.ts` asserts it.

The cost, stated rather than hidden: RECONS counts 462 objects within 10 parsecs
where HYG has 324, so the inner volume is now slightly under-populated with what
would be brown dwarfs and close companions. Under-populating with L and T dwarfs
is a smaller lie than over-populating with front-page news.

### Addresses had to become issue ordinals

`b:2` used to mean "the third planet". With confirmed planets arriving from a
catalogue that gains entries, it has to mean "the third body ever issued in this
system" — or confirming a hot Jupiter interior to everything else renumbers the
system and every save pointing at those worlds is silently wrong (ADR-0009,
Rule 2). Confirmed planets are issued first in discovery order, which the
exoplanet letters already encode; projected ones fill after, and any projection
landing within a factor of 1.5 of a confirmed orbit is dropped rather than moved.
`orbitalOrder(system)` sorts for display. Earth is `b:2` and stays `b:2`.

## What the data itself taught (20 Aug 2026)

Four things that were measured rather than assumed, and one that reversed an
assumption.

**The spectral classification beats the colour index.** B−V is the obvious
temperature source — 89% of the catalogue carries one — and it is worse: 4.7%
mean absolute error against 17 published temperatures, versus 2.8% for the
classification, and 18% at the worst case against 5%. Ballesteros' fit bends
badly at the red end, which is where three quarters of the neighbourhood lives.
The measured exception is giants, where B−V wins because the classification ladder
is coarse exactly where a giant's temperature moves fast.

**Two defensible tables are not interchangeable inputs to one calculation.** The
first version paired Pecaut & Mamajek bolometric corrections with an older
temperature scale. Each is standard. Together they put Proxima Centauri at a
third of its real luminosity, because the correction was being read at a
temperature the correction's own authors would not have assigned. Everything is
on one calibration now: **T 1.3%, L 12%, R 6%** mean absolute error.

**The published bolometric correction polynomial is wrong where most stars are.**
Flower (1996) with Torres' (2010) corrected coefficients is the usual reference
and is fine above ~4,000 K. Below that it extrapolates past its calibrators: it
returned −3.11 for Barnard's Star where the published luminosity implies −2.36,
putting the star at **twice** its real luminosity. M dwarfs are three quarters of
the solar neighbourhood, so the polynomial was wrong about most of the sky.

**`spect[0]` is wrong about 13% of the catalogue and never says so.** `dM4` is an
M dwarf, `sdM4` is a subdwarf, `DA2` is a white dwarf, `A0m...` is an A0 with a
peculiarity, and 571 entries within 150 ly are the single lowercase letter `m`.
The parser now has a golden vector for every one of those shapes and leaves 2 of
7,123 unread.

**An id is not a name, and a name is not stable.** Three jobs, and conflating
them is how a star gets displayed as `HIP71683`. The id ladder is ordered by how
_stable_ each designation is, because nobody reads an id and everything depends
on it not moving; the name ladder is ordered by how _familiar_ it is. Two clauses
in the naming rule were arrived at only by looking at the output:

- **α Centauri's components are named Rigil Kentaurus and Toliman**, and neither
  names the system. When more than one component carries a proper name, the
  shared designation is the only name that refers to the whole thing. Sirius is
  the opposite case and must keep its proper name, which is why the rule counts
  named components rather than preferring designations for every multiple.
- **HYG's proper names contain both `Sirius` and `Ran`**, and nobody has ever
  called ε Eridani "Ran". The IAU's 2015–2018 assignments largely went to fainter
  stars whose designations were already the name in use, so a proper name loses
  below naked-eye prominence (magnitude 3). Alcor at 4.0 is the known miss.

Expanding Bayer and Flamsteed designations through the constellation genitive is
what turns `Tau Cet` into `Tau Ceti`. Only 214 systems within 150 ly have an IAU
proper name; 649 have a Bayer or Flamsteed designation, so one 88-row table
roughly quadruples the number of stars with a name a human recognises.

**Completeness, not size, is the constraint.** 178 confirmed planets around 117
hosts are dropped because HYG does not contain the host at all — TRAPPIST-1 among
them, at V = 18.8. That is not a matching failure; it is the horizon of knowledge,
and the star map is supposed to draw it.

**A version has to digest what ships, not what was downloaded.** The catalogue
version is a generation input, so it must change exactly when the data changes.
Hashing the source files fails that in both directions — the NASA archive's TAP
service returned two different digests an hour apart for a query whose 702
matched planets were identical. It digests the packed output instead, with the
metadata excluded because the metadata contains the version.

**Flux is not brightness.** The starfield now carries a per-star blackbody colour
and an apparent brightness instead of one hard-coded blue-white, and the first
attempt normalised linear flux against the brightest star in view. Measured in
Chrome at Alpha Centauri: a 40 ly sweep spans **20.7 magnitudes** — a factor of
10^8 — with the median at 13.2, so the median star came out at 10^-5 of the
maximum and the sky rendered black. Converting to apparent magnitude and mapping
that onto a ramp is what a magnitude scale is _for_, and it is roughly how the
eye responds. Both size and intensity keep a floor, because a sprite that is only
smaller stops reading as fainter once it is down to a pixel. Only reproducible in
a browser: this is a shader path, and there is no CPU backend to evaluate a TSL
graph in.

## The Solar System, rendered (20 Aug 2026)

Sol stopped being eight generated planets around a real star and became the
Solar System: **eight planets and twenty moons**, with measured radii,
oblateness, axial tilts, rotation periods, albedos, ring geometry and
atmospheres, from the NASA/JPL fact sheets. And they are drawn from photographs —
19 surface, elevation, cloud and ring maps, 10.7 MB, built by `apps/ingest` from
NASA, USGS and Solar System Scope imagery.

Operating it is [`docs/guides/catalogue.md`](docs/guides/catalogue.md#planetary-surface-maps);
the shading is [`docs/concepts/rendering.md`](docs/concepts/rendering.md#planetary-surfaces).

### Sol is the one special case in the generator, and it earns it

`generateSystem` branches on `stub.id === SOL` and delegates to
`solar/system.ts`. Every other system in the game is a real star with projected
bodies around it; this is the only one where the whole system is known and the
player has seen the photographs, so a generated substitute is not merely
unverifiable, it is visibly wrong. The Solar System's data moved _out_ of the
packed catalogue in the same change: eight rows in a planet table cannot carry
twenty moons, oblateness, axial tilt and ring geometry, and none of it is
catalogue data. They are facts, and they live in source.

The Sun itself is built from the IAU's defining constants rather than from its
own catalogue row. The photometric pipeline reads Sol back as 0.973 L☉ and 0.987
R☉, which is a fair measure of how well the method works and is the best
available answer for every _other_ star. For this one there is a defined answer,
and using the estimate would make the one object every player can check the only
one that is knowably wrong.

### Planetary surfaces are not Lambertian

The largest single change to how a body looks, and it is a physics correction
rather than a style choice. The full Moon is _flat_ — no limb darkening at all —
because regolith backscatters. A Lambertian moon has a bright centre and a dark
rim, which is what a standard material produces and what nobody has ever
photographed. The diffuse term is now the lunar-Lambert blend of Lambert and
Lommel-Seeliger, weighted per body by whether it has an atmosphere.

Everything else follows from taking that seriously: the tangent frame is built
from the body's spin axis rather than a UV channel, shadowing decisions use the
geometric normal rather than the mapped one (or normal-mapped slopes catch the
sun across the terminator and float as lit specks in the dark), and rings
scatter through the standard slab result rather than a Lambert stand-in.

### Bugs worth not reintroducing

**`toColourspace('b-w')` downcasts 16-bit elevation, silently.** libvips calls
8-bit greyscale `b-w`, so it truncated LOLA's 16-bit product; a following
`raw({depth:'ushort'})` widened the container back to two bytes without restoring
the range. Every gradient came out 256× too small and the Moon's normal map was
_perfectly flat_ — a valid file, a plausible pipeline, and no error anywhere.
`grey16` is the one that preserves it, and the metres-per-value scale now
calibrates itself against the field's own range so a unit bug of this class
cannot recur.

**GEBCO_08 has no bathymetry.** 77.5% of it is exactly zero. The ocean mask is a
threshold rather than a sign test, which was found by looking at the histogram
rather than at the filename. It comes out at 69% ocean coverage against a true
71%.

**Meshes added imperatively must be removed imperatively.** Bodies are mutated
rather than reconciled — deliberately, and the header of `SceneView.tsx` says
why — but that means React knows nothing about them. A hot reload left the
previous mount's objects parented to the scene with nothing updating them, and a
stale Saturn ring forty thousand kilometres wide hung across the Moon as a set of
dark horizontal bands that read convincingly as a texture bug. The textures were
fine. There is an unmount effect now.

**Two tests were spawning ships underground.** Both landing tests placed the ship
relative to the _datum_, which is a sea-level convention with terrain either side
of it. They passed only because the generated planet they happened to land on had
low ground at that longitude; against the real Venus, whose terrain reaches
6.9 km, "hovering 30 m up" is nearly seven kilometres below the surface. They
spawn against `surfaceRadius` now. The hard-landing test also moved to an airless
body: Venus's surface air is 65 kg/m³ and 400 m/s becomes a few metres per second
long before the ground arrives, which is the drag model working and not what that
test is about.

**Phobos cannot be orbited.** Its sphere of influence is 7.2 km and its radius is
11.3 km, so there is no altitude above it that is still bound to it. Parking
there and being handed back to Mars is the correct outcome, `canHoldOrbit` is how
the harness and the test agree on which case they are in, and the test asserts
that at least one such body exists so the check cannot quietly stop testing it.

**The two-body parameter is `G(M + m)`.** The frame graph propagates a body
relative to its primary's centre, and the relative orbit obeys `G(M+m)`, not
`G·M`. Fine to a part per million for a planet around a star; for the Moon, which
is 1.2% of Earth, it is the difference between the published 27.3217-day sidereal
period and 27.45.

## The camera as an instrument (21 Aug 2026)

The pass that made the render answerable to photographs. Reference frames live
in `design/inspiration/`; every change below was iterated against them in the
browser, shot by shot.

**Camera bookmarks** (`packages/devtools/src/shots.ts`, `ir.shot(name,
address?)`, dock → shots). Seven named compositions — full-face, gibbous, half,
crescent, glint, sunset, oblique — each placed by phase angle, distance in body
radii, and an aim (centre, sunward horizon, or the specular point). The debug
orbit parks one radius up, where a planet fills a 65° view with a magnified 60°
cap of itself; that is why the continents looked too big. Blue Marble is a
~4.5-radii shot, and the bookmarks put the ship where the photographs were
taken. Placement is pure geometry in the body frame, property-tested; the first
implementation rotated about the pole and got the phase wrong whenever the sun
left the equatorial plane, which the exact-phase assertion caught. `engine.
showShip` hides the debug hardware, because a grey cone parked dead centre
defeats the point of composing.

**Aerial perspective on the surface** (`render/planet.ts`). The atmosphere
shell only survives the depth test _outside_ the planet's silhouette, so
everything the air does in front of the ground has to happen in the surface
material: a blue lift at nadir thickening to a white-blue wash at the limb,
sunlight reddening near the terminator (keyed to geometric incidence — the
sun's altitude, not any hill's slope), and night lights dimmed under slant air.
This is the term that turned the disc from a map on a sphere into something
photographed through weather.

**Water is a material, not a colour.** The ocean mask (normal-map alpha)
flattens the albedo 65% towards deep-ocean blue — the map's ocean is
bathymetry, which no photograph shows — and carries the sun-glint: two Blinn
lobes (core in a wide skirt, the wave field being in no map) under a Schlick
Fresnel, so the glint is a modest white spot under a high sun and a blown
white-gold sheet towards the limb, into the HDR headroom.

**The shell got density and a twilight ring** (`render/materials.ts`). Optical
depth is now weighted by an exponential of the altitude at the ray's closest
approach — clamped to the segment, so it degrades to the camera's own altitude
for a sky viewed from the ground — which replaced the hard-edged halo band with
a limb that thins by e-folds to space. Colour comes from that depth: thin air
stays the zenith colour, thick air whitens (multiple scattering), and dense air
near the terminator warms to the limb colour, concentrated towards the sun's
azimuth — the ISS dusk stack, orange under white under blue, falling off to
steel blue along the limb. A two-lobe forward-scatter term stretches the ring
around a crescent's dark limb.

**`HazeLayer.thickness`** (0..1, Earth = 1) is what keeps one shader honest
across nine atmospheres: Mars at 0.15 stays a translucent butterscotch that can
never scatter its way to white, the giants at 0.3–0.45 wear a whisper of limb
haze rather than Earth's glowing ring, and procedural worlds derive it from
their generated surface density. Authored per body in `solar/bodies.ts`;
rendering with one constant painted Mars with Earth's white halo.

**The lens flare** (`render/flare.ts`, `flareMath.ts`). Seven additive quads in
camera space — PSF glow, streak, three coated-iris ghosts, a sunward ghost, and
the red aperture ring from the ISS sunset frame — strung on the sun→centre
axis. Occlusion is analytic against the scene description rather than a depth
readback, which is what lets the flare fade smoothly and redden as the star
slides behind a limb; the math is pure and tested in Node. Ghosts fade when
they overlap the star's own image (a centred sun otherwise wears them as a
targeting reticle). One trap worth remembering: disposing a `useMemo`'d GPU
resource in an effect cleanup empties it for good under StrictMode's
mount–cleanup–remount — `Starfield` was already the precedent for not doing so.

**The alpha rectangles** (21 Aug 2026), because the diagnosis will be wanted
again. The flare's quads rendered as hard, dim rectangles on an EDR display,
with the stars inside them dimmed — and every plausible suspect was innocent.
The radial profiles reach zero before the quad edges; `debug.getShaderAsync`
proved the compiled WGSL was exactly the authored graph; and the blend factors
for `AdditiveBlending` are the textbook `(SrcAlpha, One)`. The killer was the
channel nobody was looking at: the preset _also_ blends alpha `(One, One)`,
the renderer clears to **alpha 0**, and the `rgba16float` canvas is composited
premultiplied — so each quad stamped its footprint into the alpha channel, and
Chrome's compositor turned that stamp into visible brightness structure
(un-premultiplying by an alpha of 2 is what dimmed the stars). The fix is two
halves, and both are needed: the clear is opaque black (`createRenderer.ts` —
space is black, not transparent), and every additive material — flare and
starfield — uses `CustomBlending` with the preset's colour factors but alpha
factors `(Zero, One)`, so nothing additive touches dst alpha again. Silencing
alpha _without_ the opaque clear inverts the failure: additive colour over
alpha-0 sky is discarded whole by the compositor, which is its own hour of
confusion.

**The startup race** (21 Aug 2026): about half of all page loads came up
permanently black — HUD alive, world ticking, renderer built, tone curve
selected, framebuffer full-size, and not one line in any console. StrictMode
invokes the async `gl` factory once per doubled mount, and the two builds ran
_concurrently_: two `WebGPURenderer`s, each with **its own `GPUDevice`**, both
configuring the one canvas context. A context belongs to the device that
configured it last, so whenever that was the corpse's, the surviving
renderer's every present targeted a foreign device's swapchain texture —
invalid command buffers, dropped silently by Dawn, forever. The fix is one
invariant: **one build per (canvas, preference)**. The factory memoises, so
the StrictMode re-invocation adopts the same renderer; a real rebuild (the
HDR preference remounting the canvas) queues behind whatever is in flight, so
release-then-configure is atomic and the last build always belongs to the
mount that survives. The App-level cleanup effect that also called
`releaseRenderer()` is gone — under StrictMode its cleanup fires between the
doubled mounts and could dispose the renderer the memo was about to hand out;
the factory is the sole owner of disposal now. Two false trails worth
remembering: serialising the builds _without_ the memo made the kill
deterministic instead of fixing it (the second build disposed the renderer
the live root had already adopted), and a page loaded in a hidden tab shows
the same black symptom benignly — R3F defers canvas creation until the
ResizeObserver fires, which a hidden document does not do until it becomes
visible. That one recovers on focus and is the browser, not a bug.

**Graphics and camera panels** in the dock (21 Aug 2026). `graphics` holds
render-feature switches — lens flare only, so far — and `camera` holds a field
of view slider (20–110°, default 65°): the knob that separates the flying
frame from the photographic one. Both write plain presentation fields on
`GameEngine` (`lensFlare`, `fov`), persisted like the HDR override;
`CameraRig` applies the FOV because the R3F camera is rebuilt whenever the
canvas remounts, and `SunFlare` reads the toggle per frame. Turning a feature
off to isolate an artifact is how the alpha bug above was pinned to the flare
rather than the tone curve.

**Shots and orbits take their sun from the system, not the frame parent**
(21 Aug 2026, `devtools/harness.ts` `#toStar`). The sun direction fed to
`placeShot` and `orbit` was the direction of the frame's _parent_ — the star
for a planet, the **planet** for a moon — so every bookmark on a moon was
composed against its primary: `full-face` on Luna framed the earthlit side at
whatever phase Earth was in. The regression test measures the actual
sun–moon–camera angle of a `half` shot on Luna and demands 90°; it failed at
82° before the fix. A system frame's origin is its star, which is the one fact
the helper needs.

**Travelling to a star means the star** (21 Aug 2026). `goTo` with a system
designation used to arrive at `planets[0]`; it now parks in the _system_ frame
in a circular orbit of the star itself — eight stellar radii, where the disc
subtends ~14° — with the nose on it, and `orbit` accepts a system address the
same way. The star has no `Body` and no frame of its own; it _is_ the system
frame's origin, which is why none of the body machinery applied and the case
needed its own `#orbitStar`.

**Framed compositions hold** (21 Aug 2026, `#trackOrbit`). A teleport leaves
angular velocity at zero — a nose fixed in inertial space — so the body a shot
had framed slid out of the picture as the orbit proceeded. Every arrival that
promises "looking at it" now spins the ship at its own orbital rate,
`ω = r × v / |r|²`, written in **body axes** because that is what the
integrator composes; twenty minutes of Luna's gibbous orbit drifted 10° off
target before, and holds to a fraction of a degree now. Flight assist is
switched off with it, deliberately: assist reads the tracking spin as tumble
and damps it away within seconds.

**The hidden-load black screen** (21 Aug 2026, `App.tsx`). R3F sizes its
canvas from a ResizeObserver, and Chrome does not deliver the initial
observation to a hidden document — which this page _is_ during every Vite
full-reload triggered from an editor in front of the browser. Becoming visible
again does not replay the lost observation: the canvas sat at the default
300×150 with no renderer built, a black screen with a healthy HUD that only a
manual window resize revived. The measurement hook also listens to window
`resize`, so App replays a synthetic one on `visibilitychange`; verified live
— the stuck canvas went from 300×150 to full size and built the WebGPU
renderer the moment the window surfaced.

**Normal maps are lossless, and the ocean mask moved to blue** (21 Aug 2026,
`ingest/textures.ts`, `render/planet.ts`). Two compounding artefacts, one
autopsy. Lossy WebP block-quantised the smooth slope fields: whole 8-pixel
rows of the Moon's green channel offset ±39 around neutral — bands of surface
tilted ~15°, invisible face-on, black latitude-parallel scratches under the
grazing light at every full-phase limb. Re-encoding losslessly then erased the
maps _entirely_: libwebp's lossless encoder "cleans" RGB under transparent
pixels, and the ocean mask lived in alpha — the Moon has no ocean, so its
alpha was 0 everywhere and its RGB went with it. The mask now rides the blue
channel (the shader reconstructs Z as √(1 − x² − y²), exact for a unit
normal), the maps ship as 3-channel lossless VP8L, and nothing in the pipeline
has opinions about a colour channel. Measured: the Moon's worst adjacent-row
jump fell from 58.6 to 9.7, and what remains is terrain.

**Giants stopped wearing gaskets** (21 Aug 2026, `render/materials.ts`,
`SceneView`). The atmosphere shell was a sphere around an oblate planet: at
Saturn's 9.8% flattening the shell floated a tenth of a radius off each pole,
and the analytic "ground" — a sphere of the _equatorial_ radius — drew air
over ground the planet never fills, a detached grey ring around the whole
limb. Both ray endpoints are now mapped into a space stretched 1/flattening
along the spin axis, where the ellipsoid is the sphere the intersection maths
assumes, and the mesh is scaled oblate to match. The density also gains a
`(1 − altitude)` factor so the shell ends by vanishing: the exponential alone
left ~1% at the ceiling, which the HDR canvas rendered as a hard hairline
ring.

**Giants got limb darkening, chroma and moving weather** (`render/planet.ts`,
tuning in `SceneView`). A deep atmosphere reflects from optical depth ~1, so
a grazing view sees higher, thinner, darker gas — `pow(μ, 0.55)` blended at
0.72 for giants, and the flat decal became a ball. The published maps are
near-true-colour, paler than any released photograph; giants get the same
chroma stretch every press image has had (1.3 gas, 1.15 ice). And the bands
shear: a zonal-jet UV warp at the _real_ magnitudes (~110 m/s gas, ~400 m/s
ice) — invisible at 1×, visible differential rotation at high warp, exactly
like the real thing.

**Mapless rings are generated, not slabs** (`render/proceduralRings.ts`).
The opaque-white fallback drew Uranus's ring system as a cyan charcoal
compact disc four radii across. A mapless ring now gets a strip generated
from the owning body's kind, seeded from its address: ice giants get sparse
near-black threads with an ε-ring analogue near the outer edge, gas giants a
banded sheet with gaps. The same strip feeds the ring slab and the
ring-shadow projection on the planet, so the shadow bands match the rings
that cast them; procedural strips keep their own greys (the body tint is what
dyed Uranus's threads cyan).

**The star has a surface** (`render/materials.ts`). Worley-noise granulation
— bright convection cells draining into dark intergranular lanes — over a
fractal mottling octave, churned by presentation time so a held star simmers
under warp; a chromosphere-orange warm-up at the limb. Visible because the
disc now _stops down_: at the authored radiance 8 every lane clips to the
tone ceiling and the surface work is one white circle, so `exposure` ramps
from 1 to 0.1 as the disc grows from 0.015 to 0.1 rad — a camera exposed for
the sun once the sun is the picture — and the lens flare fades on the same
ramp rather than repainting the stopped-down photosphere back to white. From
afar nothing changes: the star stays the reference white the HDR path is
built on.

**The atmosphere is precomputed scattering now** (21 Aug 2026,
`packages/rendering/src/atmosphere.ts`, `render/atmosphereLuts.ts`,
`createAtmosphereMaterial`). The analytic shell's named successor, delivered:
per-atmosphere transmittance T(r, μ) and Hillaire multiple-scattering
Ψ(r, μs) tables, baked on the CPU in **planet radii** — the one unit that
survives distance compression — from coefficients derived off the authored
`HazeLayer` (the zenith colour _is_ the scattering spectrum; the limb colour
tints the aerosol; `thickness` scales the column, calibrated so Earth's split
lands within a few percent of the real (0.046, 0.108, 0.265) optical depths).
The shader is a 12-sample march — two table reads per sample against spike
2's measured 256-sample/7.27 ms budget — compositing as L + T·background via
premultiplied custom blending, so night air genuinely dims the stars behind
it. Nothing asserts a colour any more: the sunset ring is the table reddening
low-sun light, twilight is Ψ, Mars keeps butterscotch _and_ its blue dusk
from its own authored haze, and the first daytime blue sky ever drawn from a
planet's surface fell out for free. The bake is pure arrays in
`@inertialref/rendering`, property-tested in Node — monotonicity, horizon
extinction, sunset reddening, Ψ past the terminator — because the TSL graph
that consumes it cannot be.

Two traps for whoever touches it next. **TSL statements need a function
body**: `Loop` and `toVar` accumulators built at material scope compile
cleanly, log nothing, and render a vacuum — the march must live inside the
`Fn(() => …)()` that owns its stack, and the first unmistakable symptom was
a black noon sky over a sunlit ground while every limb still looked vaguely
atmospheric (the _surface_ material's veil was doing all the work). And
**ground rays need a forward test**: `step(impact², 1)` alone counts the
backwards extension of an up-ray as meeting the ground, which zeroes the
zenith sky from the surface; the `step(0, closest)` beside it is
load-bearing.

## A real hull, and the canvas that would not present (21 Aug 2026)

The debug cone is now the fallback rather than the ship. `data/models/` holds
glTF hulls with a manifest naming each one's file, true length and nose axis —
built as a registry because one ship was never going to stay one ship — and
`apps/game/src/render/shipModels.ts` loads, recentres, yaws nose-to−Z and
scales each to true metres (the Enterprise-D is 642.5 m; render space is
1 unit = 1 m and stays that way). The asset is “Star Trek Online | USS
Enterprise D” by LoganRolphh, CC BY 4.0, ~50k triangles with PBR maps and
emissive windows; provenance rides in the glTF's own `asset.extras` and in
`data/models/LICENSE.md`. Two rules fell out of it:

- **GLTFLoader is the one sanctioned crossing of the never-import-`three`
  rule**, and only because nothing it builds reaches the renderer: every
  classic material is rebuilt as a `MeshStandardNodeMaterial`, carrying maps,
  factors and `KHR_materials_emissive_strength` across. The shared classes —
  `Mesh`, `BufferGeometry`, `Texture` — are `three.core.js` either way, so
  identity holds.
- **The chase camera is a ratio, not a distance.** `chaseOffsetFor(length)`
  keeps any hull subtending the same angle; the hand-tuned 14 m offset remains
  as the debug-cone fallback. The metre/foot/inch props slide out past the
  active hull's beam, because ±4 m from the origin is now inside the saucer.

The same session killed the black-open bug for real. The earlier fix replayed
the canvas measurement on `visibilitychange`, which cured the hidden-reload
path and missed the other one: **the mount-time kick races
`createRenderer`'s async device probe and `init()`, and a measurement kicked
before R3F has a backend is lost with nothing scheduled to replay it** — a
focused fresh load could come up 300×150 and black until a manual window
resize. Two changes, both in `App.tsx`: the mount kick is unconditional
(dispatching `resize` sizes the canvas even in a hidden document — verified
live), and the renderer-ready callback kicks again one macrotask later, the
first moment a re-measure provably cannot be too early. `setTimeout`, not
`requestAnimationFrame`, because rAF never fires in a hidden tab and a
background load must still size its canvas for the frame that draws when
focused.

## The cinematic director, and a title sequence as a test target (21 Aug 2026)

The engine can now play scripted scenes over the live world — ADR-0010 — and
the proving scene is a shot-for-shot study of the 1987 television title
sequence, chosen because a frame-analysed reference exists for it: 2742 frames
at 24000/1001 fps with measured shot boundaries, title fade windows, an
alternating 65/67-frame credit grid, and camera-hold constraints, all of which
are now asserted by tests. `ir.play('tng-intro')`, the dock's cutscene section,
Esc to skip; a transport bar carries play/pause/restart and a frame scrubber,
and `ir.seekCutscene(frame)` with the clock paused gives frame-exact stills for
the numeric verification loop. The boot path is untouched — the whole system is
one null check when idle.

Shape: pure cinematic arithmetic in `packages/rendering/cinematic.ts` (easings,
fade envelopes, the 4/7/4 warp-flash shape, Catmull-Rom routes over
`UniverseVector` beats, one- and two-target composition solvers), the director
and script in `packages/devtools` (`prepare(world)` resolves the stage against
live ephemerides once; `sample(frame)` is pure), the application in the host
(`buildScene` grew an eye override so LOD, star brightness and flare occlusion
follow the cinematic camera; `CameraRig`/`ShipModel`/warp effects/DOM overlay
prefer `engine.cinematic` when non-null). Stopping restores the player's
captured state through the same verbs a save-load uses.

What the recreation taught, at cost:

- **Relative choreography must stay relative.** The hero ship was first
  authored as absolute world beats anchored to the camera's position at each
  beat's own frame; the cruise camera covers ~1000 km per frame, the two
  splines ran through beats tens of thousands of kilometres apart, and they
  diverged mid-segment by tens of kilometres — the flyby rendered as a dot on
  the wrong side of the sky. Scene A's ship is now offset beats, interpolated
  in offset space and added to the camera at sample time.
- **Never track a hull crossing metres from the lens.** Per-frame look-at
  through the overhead pass whipped the camera through the vertical and
  rubber-banded after the receding ship. The pass is authored aim beats that
  pitch over the top once and freeze in a held stern view — and the ship then
  recedes along the held view's own axis, so the hold frames it by
  construction.
- **Light is staging.** The cruise runs down-sun so the approaching hull is
  lit full-face and the warp-out is backlit glare; the credits stage looks
  ~130° off the sun line so the fly-bys catch front light while the sun stays
  outside both the frame and the flare's edge fade. The first cruise direction
  was arbitrary and rendered the entire flyby as black-on-black.
- **The whiteout is a scene change, honestly.** Both the f240 match cut and
  the first warp flash swap stage under full cover — the same trick the
  reference plays.
- **The transit obeys the ephemeris.** The eclipse planet's moons are
  auditioned by how close their orbit lies to the camera's standoff sphere
  (Deimos at 6.9 Mars radii beats Phobos at 2.8, whose detour ballooned the
  eclipsed disc), each candidate's detour is checked for clearance against the
  planet, and when nothing fits the edit degrades to a plain eclipse.

The blank-boot bug also finally fell. Measured: a wedged boot submits the full
scene — 16 draw calls, 800k triangles, every frame — while the canvas never
presents, so `renderer.info` cannot detect it; the watchdog
(`render/presentationWatchdog.ts`) samples the canvas bitmap itself
(native-resolution strips, so a lone star still counts as lit) and climbs a
ladder: replay the measurement, then a _real_ one-pixel layout nudge (a
synthetic `resize` event never fires a ResizeObserver — which is why the old
fix lost to a human dragging the window edge) plus a swap-chain reset, and
finally — the only cure for the deep state, verified live against it — a
canvas remount via an epoch in `canvasKey`, at most once per load. Checks run
only while the document is visible; an occluded window legitimately never
presents.

The TNG fonts: `TNG_Credits.ttf` is a 1994 Macintosh TrueType with only a
(1,0) MacRoman cmap and no OS/2 table, which Chrome's sanitizer maps to
nothing; the build's WOFF2 gets a synthesized (3,1) Unicode cmap and OS/2
(fonttools; script in the session scratchpad, output committed). The reference
audio is a local MP3 the overlay discovers at `/tng-intro.mp3` and syncs to
the playhead within 80 ms; the path is gitignored because the track is
copyrighted music and must never enter the repository — publishing a render of
the full sequence would raise the same questions, which is why the demo stays
a demo.

## The title sequence, re-cut against its own frames (21 Aug 2026)

The first pass at `tng-intro` was written against the reference analysis's
_prose_. This one was written against its 2742 frames, and almost everything
the prose said about motion turned out to be a paraphrase of something else.
Every number below was measured — hull bounding boxes tracked frame by frame,
title masks row-banded, the two logotype words tracked through their throw —
and the ones that matter are now assertions in `cutscene.test.ts`.

**It is an edit, not a camera move.** The analysis calls f240–f1084 "one
unbroken 35 s camera move"; its own frames disagree. Jupiter is absent at f370
and fills the right half at f382. Saturn is gone by f530 and the screen is
empty until f691. Those are cuts, hidden by an empty starfield, and authoring
them as one spline is what produced a camera crossing five astronomical units
between beats and aiming at whatever it was between. `tngIntro.ts` is now a
shot list — eight shots, each with its own camera placed against its own
subject — and `CUTS` is the single table both the script and its tests read, so
a boundary cannot drift out of agreement with the assertion guarding it. Three
of the eight cameras do not move at all, which is not a simplification: a
starfield sits on the star shell, so camera _translation_ moves nothing in
frame, and once the hull is authored camera-relative there is nothing left for
the camera to do.

**Choreography is authored in the frame.** Ship beats are
`(frame, screen x, screen y, range)` through `screenOffset`, because that is
what a tracked bounding box gives you — a centre and a width, and a width _is_
a range once the hull's length and the lens are known. Beats in this language
can be read straight off the analysis and diffed against it; the previous ones
were metres and resembled nothing in it. Range interpolates in **log** space:
an approach list spans four decades, and a Catmull-Rom over those knots in
metres overshoots through the camera and out the other side, which is why the
hull vanished for twenty frames before each warp-out.

What the frames actually show, against what the analysis had said:

- The hull does **not** approach as a dot dead ahead. It enters at the
  bottom-left _corner_ at f688, climbs across the frame, is barely closing
  between f760 and f792 (both measure 0.40 of the frame wide), then rushes in,
  fills the frame at f976 and banks away up-right without ever passing behind
  the lens.
- The main title is **not** a fade with a settle. Two words are thrown in from
  opposite sides at 2.25× size and decelerate onto their marks over 27 frames.
  The curve is a fit, not a taste: remaining offsets of 0.271 / 0.181 / 0.107
  at f1140 / f1144 / f1148 give p = 1.93, and that exponent then predicts f1137
  to a thousandth on all six channels — two positions and a scale, per word.
  What the analysis recorded as a "small settle over f1154–1162" is the tail of
  that throw.
- A **lens spike** bridges into both cards: a vertical anamorphic spindle,
  24 frames, rising over 11 and dying over 13, anchored where the ship went
  rather than on the frame's centre. It is new vocabulary
  (`CinematicEffects.spark`) and it is what the title emerges from.
- Every credit is centred at x ≈ 0.50. The per-credit centroids in the old
  analysis drifted left only because they were pixel-weighted and the label
  line pulled them. A label sits 0.1056 of the frame height above its name and
  is flush _left_ with it, so it now rides the name's own element — the name's
  width is a property of the typeface, not a number a script can supply.
- Wipes one and three are the **same animation** 247 frames apart, to three
  decimal places; the middle one is its mirror in x. One function, an offset
  and a flag.
- Neither warp flash is a whiteout. f1090, the brightest frame in the piece,
  means 95 of 255 — a mid-blue field with a hot core. Driven at the old 3.5 the
  wash cleared the tone curve's shoulder on every channel and fifteen frames
  rendered as a white rectangle.

Two renderer capabilities came out of it, both useful outside a cutscene. The
flare now draws a **corona** when a body occults the star: visibility is zero
at totality, which is exactly when the ring is the entire shot, so gating the
whole group on it left a total eclipse as an unlit disc on an empty starfield.
And the cinematic camera is a **cleaner lens** — `artifacts` scales the ghost
chain to 0.05 while a script is playing, because the reference's optics put a
warm ball beside a planet and nothing else, and three grey iris ghosts marching
across an empty half-frame read as breakage.

Lessons with teeth:

- **Ask the font.** The overlay divided measured cap heights by guessed
  cap-height-to-em ratios (0.72, 0.7). `measureText().actualBoundingBoxAscent`
  says 0.80 and 0.595, which had every credit 19% too large and the logotype
  15% too small — and once the sizes were right, the tracking that had been
  compensating for them fell out at zero.
- **A light's screen position is a product.** With `lookAlong` levelling
  against the pole, the star lands at `−dot(toStar, forward)·dot(pole, forward)`
  for anything near the ecliptic, so _both_ terms must carry the right sign.
  The first cruise had the second one negative, put the key 32° below the axis,
  and lit the hull's belly through a four-hundred-frame approach in which the
  reference shows nothing but a brightly lit dorsal.
- **A shot lookup needs a fallback that is near, not last.** Frames are
  fractional, so one lands in the sliver between a shot's `to` and the next
  `from`; falling back to the last shot in the list teleported the camera five
  AU for a single frame.
- **The reference is not physically consistent, and that is allowed.** Its
  opening has broadly lit terrain _and_ the sun in frame beside the planet;
  those contradict — the star's measured screen position puts it 72° from the
  disc's centre, which for a camera 1.2 radii up means the whole visible cap
  is past the terminator. Its key light and its sun sprite were placed
  independently. Staged against a real ephemeris you get one or the other, so
  the phase ramps instead: 78° at f125 where the cap is lit and the star is
  behind the lens, opening to 164° by f239 where the disc is the thin crescent
  the match cut needs and the star has swung into frame beside it.

## The verification loop, closed (22 Aug 2026)

The reference analysis was built to be diffed against, and now it is. Three
scripts in `~/Developer/tng-inertial/scripts/` close the loop:
`capture_render.mjs` drives this engine over the Chrome DevTools Protocol and
dumps 2742 frames at 1920×1080 in about five minutes, `compare_render.py`
measures the same three channels in both dumps and ranks the disagreements, and
`compare_sheets.py` stacks reference over render for the ones that need eyes.

Two things about the capture are worth knowing before anyone rebuilds it.
**A WebGPU canvas reads back blank**: `drawImage`/`toDataURL` from page script
returns mean luminance 0.0 on a frame that visibly shows Saturn, because the
swap-chain texture is invalidated at the end of the task that drew it.
`Page.captureScreenshot` takes the composited image instead — which also picks
up the DOM title overlay, so a canvas dump could never have been run through
`detect_titles.py` anyway. And **a capture must boot the page itself**: a tab
that has survived a session of hot reloads has a dead renderer, draws its HUD
happily, and waits forever for an `engine.gl` that is not coming back.

What it found, in one pass, that eyes had not:

- **Every credit was exactly four frames late** — nine of them, plus five on
  the Roddenberry card. The cause is that the reference's `firstVisibleFrame`
  is a _threshold crossing_, not a fade start: text at RGB (64,138,230) only
  clears the analysis's B≥195 floor at 85% opacity. `fadeEnvelope` now leads
  the measured frame by `THRESHOLD_FRACTION`, and the lag is +1 across the
  board. On the **rise only** — the same capture showed the trailing edges
  already on time, and applying it symmetrically left the logotype at 70%
  opacity nine frames after the reference had lost it.
- **The flashes were twice as bright as measured**, again: mean 176–186 across
  the peak against the reference's 81–100, after an earlier correction had
  already taken them off white. The mean is the number that settles this, and
  it is cheap to compute and impossible to eyeball.
- **The close pass was running at 6–14 mean luminance against 40–59**, and the
  reason was not the framing. The reference lights the hull's dorsal through
  the approach and its _ventral_ through the close pass; one directional light
  cannot do both. The cruise is now two shots with the key swung under the ship
  at f938 — the first frame where the hull is wider than the lens, so the cut
  is behind a wall of spaceship. Cruise exposure error fell from 11.0 to 4.9
  and its width error halved.
- **The nacelle glows were the brightest objects in the frame**, big enough to
  carry a mean of 86 while the hull under them sat at 11. Capping them at a
  fifth of that size revealed how dark the hull actually was, which is how the
  lighting problem got found at all.
- **The Venus cutaway had to go.** It stood in for the reference's f254–259
  foreground pass, which cannot be staged on Mars's anti-sun line; the capture
  measured it at mean 97 against the reference's 7–19 — the reference's body is
  a dark limb, not a lit cloud deck — and a cutaway loses the eclipse pair that
  the reference keeps on screen throughout. Seven frames of missing subject
  reads as a glitch, not a beat.

The titles and credits, meanwhile, came back at Δcx 0.008–0.021 and Δcy
0.002–0.021 of the frame, first try. Measuring the layout against the font's
own metrics had already done that work; the loop confirmed it rather than
correcting it, which is what a regression check is supposed to feel like.

## The overlay, hardened (22 Aug 2026)

The dock was built to be read, not to be survived, and a pass over it for the
inputs and failures a real session produces found one route to a black screen
that no watchdog can see, two silent-failure paths, and two arithmetic bugs.
`pnpm check` is green: 442 tests, 35 files.

### A HUD throw takes the canvas with it

React unmounts the whole tree when a render throws, and in this app the tree
contains the `<Canvas>`. So a body with no name, a `HarnessStatus` shaped like
last week's, or a series divided by its own zero length does not produce a
broken row — it produces a black screen with a healthy console, which is
exactly the symptom `render/presentationWatchdog.ts` exists to recover from,
arriving by a route that watchdog cannot observe. Verified by injecting a throw
into `harness.shots()`: before, the scene went; after, the navigate panel is
replaced and the tick keeps advancing behind it.

`hud/ErrorBoundary.tsx` is five small boundaries rather than one — per dock tab
(keyed on the tab, so leaving and returning **is** the reset), and one each
around the dock, the flight strip and the cutscene layer. One boundary around
the whole layer would take the dock down with whichever piece failed, and the
dock is how the simulation is driven. The fallback takes a `className` applied
to itself only, because the chrome it wraps positions _itself_ and a bare
fallback lands at the origin of a `pointer-events-none` layer with an
unclickable retry.

**Error boundaries do not work under `renderToStaticMarkup`.** React's string
renderer never calls `getDerivedStateFromError`, so `hud.test.ts` can assert the
boundary's error _normalisation_ and nothing else; recovery is a browser check.
The same test file also cannot render the perf tab, because `fakeEngine` is a
harness in a trench coat and `PerfPanel` reads `engine.metrics`.

### Before the first commit there was nothing on screen

`main.tsx` awaits the packed catalogue — a generation input, so the world cannot
be built without it — and until that resolved `#root` was empty. On a slow link,
or behind a service worker holding a bundle that no longer parses, that is an
indefinitely black page indistinguishable from a broken one, shown to the
audience that forms its impression in about a minute.

`index.html` now carries a boot line at the flight strip's own anchor, which
**React clears on its first commit** — the disappearance is the handoff, and the
10 s stall notice keys off exactly that (`document.getElementById('boot')`
returning null means the app is up). Its recovery unregisters service workers
before reloading, because a plain reload served by the same worker returns the
same broken bundle. `main.tsx` adds React 19's `onUncaughtError` plus a
DOM-built fatal panel appended to `document.body`, never to `#root`: after an
uncaught error React has unmounted the tree and still owns that container.

### Four things that must not come back

- **The navigation panel's error lived inside a collapsible section.** Every
  verb in `NavPanel` reported through one `error` state that was rendered inside
  `Section id="nav.go"` — whose open state is _persisted_. With that section
  collapsed, a failed `land`, `burn`, `generate` or scenario reported into a
  closed box and the button read as having done nothing. The banner is now above
  every section and names which verb failed.
- **"surveying…" was also the empty state.** Fly past the 8 ly survey radius and
  the destination list said it was still working, forever. Only one of those two
  answers has a next step, and it was the one being hidden.
- **The time-warp buttons were an index step over `WARP_STEPS`.** That only
  behaves when the clock's time scale is already one of them, and the clock is
  not only driven from the dock — `ir.warp(3)` from the console, or a save from
  when the ladder had different rungs, puts it between detents or past the top.
  From a console-set 200,000×, "slower" answered 1× and "faster" answered 5×.
  `hud/warp.ts` searches instead of indexing, and `warp.test.ts` checks that the
  result is always a rung and always moves the way it was asked to.
- **`usePersistentState` guarded `JSON.parse` and nothing else**, which is the
  failure that was never going to happen. `localStorage` outlives the code that
  wrote it: a `dock.tab` of `"nav"` from before the five tab names existed parses
  cleanly, matches no tab, and renders an empty dock with no active tab and no
  way back that is not devtools. A `camera.fov` of `NaN` or `5000` reaches the
  projection matrix. Every caller now passes an `Accept<T>` predicate and an
  unrecognised value is treated exactly like an absent one.

### The focus contract, which is subtler than it looks

Every control called `event.currentTarget.blur()` for a real reason: flight
input is a window-level keydown handler, so a clicked button that keeps focus
swallows Space — the pause key — and turns it into a second click on itself.
Blurring unconditionally solved that by making the dock untraversable; a
keyboard user who activated anything was returned to the top of the document.

`hud/focus.ts` blurs only when `event.detail > 0`. A click synthesised from
Enter or Space on a focused button reports `detail === 0` in every engine, so a
pointer keeps the old behaviour exactly and a keyboard keeps its place — and a
focused button swallowing Space is correct there, because Space is what
activated it. `useShipControls` gained the matching half: `Tab` declines when
`event.target.closest('.hud-layer')` is non-null, so Tab still collapses the
dock from the canvas and moves between controls once you are inside it. Same
shape as `isTyping`, and for the same reason.

All four paths were checked in Chrome: mouse click → focus returns to `BODY`;
Space after one still pauses; Enter keeps focus on the control; Tab from the
canvas still collapses the dock. **Do not "simplify" this back to an
unconditional blur.**

### Smaller, but real

Unbounded joins (`loadedSystems`, `terrainCandidates`) are capped with a stated
`+N more` rather than silently cut — a list quietly truncated at eight reads as
a list of eight. Every truncating row, target row and header summary carries its
value as a `title`, because a value you can neither read nor hover is a value the
panel is not actually showing. Scenario buttons and `save`/`load` take busy
guards; ten impatient clicks were ten concurrent scenarios teleporting the same
ship. `flash()` held one timer instead of orphaning one per call, which is why
notices raised in bursts used to vanish early. Selection, caret and scrollbars
are themed from the palette — the dock scrolls internally and on any platform
without overlay scrollbars that gutter was the one bright rectangle in a
dark-adapted interface.

### What the colorize pass found before it started

Not built — recorded so the archaeology is not repeated. `SystemStub`
(`packages/universe/src/galaxy.ts`) already carries `temperature`, a computed
blackbody `colour`, `catalogued` (which is provenance) and the confirmed
`planets`. **`TravelTarget` in `packages/devtools/src/travel.ts` carries none of
it** — the destination list gets a pre-formatted `detail` string and a boolean.

That matters because PRODUCT.md commits that "every body states whether it is
`observed` or `projected`" and the built list does not, and because the row you
scan for is the star, whose real colour the canvas is already painting from the
same measurement. The tension is DESIGN.md's **One Accent Rule**: the proposal
was a second Named Rule beside it — chrome stays graphite plus one blue plus
four status hues, and _data_ may carry its own measured colour, scoped to the
star glyph only so the Scarcity Rule holds at roughly six rows. It needs a
DESIGN.md amendment and a `TravelTarget` extension, and PRODUCT.md's "no
information by colour alone" means provenance needs a glyph as well as a grade.

Separately, DESIGN.md already names the perf chart's budget rule at `#f87171`
(red-400) as drift that should converge on rose rather than spread, and the
plots encode "over budget" by stroke colour alone.

### One thing the tooling cannot do here

`impeccable`'s mechanical detector runs **degraded** on this machine —
`htmlparser2`, `css-select`, `css-tree` and `domutils` are unavailable, so it
falls back to regex, does not evaluate custom properties or computed contrast,
and its empty result is an undercount rather than a clean bill.

## The UI foundations (22 Aug 2026)

Four libraries landed in `apps/game` at once, because they are one decision:
the dock is scaffolding, `docs/design/ux.md` specifies a cockpit and a set of
overlay pages, and every one of those needs the same four things. Nothing below
`apps/*` gained a dependency — `pnpm graph` still reports zero third-party
dependencies across the twelve packages, and that is the invariant that matters.

| Added                                    | For                                                             |
| ---------------------------------------- | --------------------------------------------------------------- |
| `lucide-react`                           | icons, tree-shaken per import                                   |
| `radix-ui` + `cva` + `clsx` + `tw-merge` | shadcn/ui's ten base components, vendored into `components/ui/` |
| `motion`                                 | enter/exit animation for anything conditionally rendered        |
| `zustand`                                | the engine-to-React subscription seam                           |
| `react-router`                           | overlay pages on real URLs                                      |

### The store is a snapshot publisher, not a second source of truth

`state/engineStore.ts` holds the most recent `HarnessStatus` and nothing else.
The rule it is written against is unchanged — canonical state never lives in
React — and a store that held the world would be that violation wearing a
library. What it changes is who does the reading: `App` used to hold the whole
status in `useState` and pass it down, so every panel re-rendered eight times a
second whether or not anything it displayed had moved. `useStore` is
`useSyncExternalStore` with a selector, so a panel can subscribe to the tick and
wake for the tick.

Two things worth writing down:

- **`harness.status()` allocates a fresh object graph every sample.** So
  `Object.is` on the root is always false and a consumer that selects the whole
  thing gains nothing; the win is entirely in narrow selectors, and `useShallow`
  is the answer for a selector that returns two fields. `engineStore.test.ts`
  pins this property, because if a future sampler starts caching, the advice in
  `useEngine`'s own docstring silently becomes wrong.
- **It makes React Compiler safe for these reads.** The compiler assumes what a
  component derives is a pure function of its inputs, which is false for a
  component reading mutable engine fields — that is why `PerfPanel` carries
  `'use no memo'`. A snapshot read through a selector satisfies the assumption.
  This is an argument for pointing panels at the store, not licence to point
  them at live engine fields.

The sampler takes a **port** (`EngineSource`), not the engine, which is why its
test builds no world, no DOM and no renderer.

### `@/` is the one non-relative import, and it is not a style choice

shadcn/ui's registry writes `@/lib/utils` and `@/components/ui/*` into every
component `pnpm dlx shadcn add` generates. Without the alias, each added
component is a file to hand-edit before it compiles, and re-adding one to pick
up an upstream fix reverts the edit. It is configured in **three** files that
cannot check each other — `apps/game/vite.config.ts`, `apps/game/tsconfig.json`
and the root `vitest.config.ts` — which is why `pages/pages.test.ts` renders a
page through it in Node: a disagreement between the three is otherwise a black
overlay in the browser and nothing else notices. `tsconfig` carries `paths` and
no `baseUrl`; TypeScript 6 deprecates `baseUrl` outright and errors on it.

### The design tokens are the instrument's, not the generator's

`shadcn init` would have written a light and a dark palette in its own neutral
hues. Those are not this interface. `index.css` keeps the registry's vocabulary
— `bg-background`, `border-border`, `ring-ring` — and points every token at the
slate/sky values already in `hud/`, each line naming the Tailwind step it is.
One palette; `class="dark"` on `<html>` with a `@custom-variant` keyed to it, so
the `dark:` utilities inside registry components still resolve without the OS
preference deciding anything. `--radius` is 0.375rem so that shadcn's
`rounded-md` lands on the 0.25rem `rounded` every existing control wears.

`tw-animate-css` is imported for a reason worth knowing: the `animate-in` /
`fade-in-0` / `zoom-in-95` utilities every shadcn overlay references are not
Tailwind v4 core. Without it those components mount with no transition and
nothing errors.

### Pages render inside the HUD layer, never above the canvas

`<BrowserRouter>` wraps the tree, but the route table is mounted inside
`.hud-layer`, which is a **sibling** of `<Canvas>`. A router that owned the view
would remount the canvas on every navigation and rebuild the `WebGPURenderer`
with it. Pages therefore also inherit `dynamic-range-limit: standard` for free.

`useTransitions={false}` on the router is deliberate and documented upstream:
React Router v8 wraps state updates in `startTransition` by default and says to
opt out for applications built on `useSyncExternalStore`, which this one now is.

The offline path already worked without a change — `public/sw.js` falls a failed
navigation back to the cached `/index.html`, and the Worker's assets config is
already `not_found_handling: "single-page-application"`, so `/settings` typed
cold resolves both online and off.

### `/settings` is a real page, not a demo

It renders the dock's own `GraphicsPanel` and `CameraPanel` — the same
components, the same props, the same engine fields. `docs/design/ux.md` puts
settings in an overlay over a running simulation rather than behind a pause, and
says there is no pause menu at all; the eventual move is out of the dock and
into this page. Both render today and neither is a copy.

The scrim was measured in front of Earth, not picked. `bg-slate-950/70` with a
`backdrop-blur-sm` obliterated the planet, which makes the page's own subtitle a
claim the frame contradicts. Dropping to 55% with no blur went too far the other
way, and the reason is the interesting half: **on the extended-range path the
canvas carries a sunlit planet well above diffuse white, so 45% of that is still
about diffuse white and the scrim barely registers.** A scrim over this scene is
read against what is behind it, not against a swatch. 70% with no blur is the
answer.

### Measured cost

`pnpm build`, before and after, same machine:

|     | before                     | after                      | delta             |
| --- | -------------------------- | -------------------------- | ----------------- |
| JS  | 1,937.7 KB / 555.6 KB gzip | 2,139.8 KB / 622.8 KB gzip | **+67.2 KB gzip** |
| CSS | 25.8 KB / 5.9 KB gzip      | 51.4 KB / 9.5 KB gzip      | **+3.6 KB gzip**  |

Roughly 71 KB gzip for all five libraries, against a bundle that is already over
budget and uncode-split. That is the number to hold the eventual splitting work
against, not a reason not to have done this.

### Known, and left for the refactor

- **shadcn's overlays portal to `document.body`**, which is outside
  `.hud-layer` — so a `Tooltip`, `Popover`, `Select` or `Dialog` escapes the
  standard-range clamp and would wash out against a star. Radix's `Portal`
  takes a `container`; wiring it is a change to the generated components, which
  is the refactor turn's job. Nothing uses one yet.
- **`TooltipContent` ships inverted** (`bg-foreground` / `text-background`),
  which in this palette is a light chip in a dark-adapted interface — the exact
  thing the scrollbar rules in `index.css` were written to stop.
- `.oxlintrc.json` turns `react/only-export-components` off for
  `components/ui/*.tsx`. Those files export `buttonVariants` beside `Button`,
  and the rule's remedy is an edit the next `shadcn add` reverts.

## Five modes, a shell, and a mode with no ship (22 Aug 2026)

The client stopped being one screen. It is now a **persistent shell** — the
`<Canvas>` and `.hud-layer`, owned by `App` forever — with two route tables over
it: _modes_, which decide who owns the camera, and _dialogs_, which open over a
mode and leave it running. Five modes exist: the menu, three flight routes, the
**planetarium** and the **cinema player**.
[ADR-0011](docs/adr/0011-application-shell-and-modes.md) and
[ADR-0012](docs/adr/0012-dockable-panels.md) hold the arguments;
`docs/design/planetarium.md` and `docs/design/cinema.md` are the design pages.

### A whole mode cost a nullable field, because ADR-0010 had already paid

The planetarium's camera is the _second_ producer of a presentation eye. The
first was the cutscene director, and the seam it needed — `buildScene` taking an
optional eye override so LOD, apparent star brightness, `up` and flare occlusion
all follow the camera that is actually on screen — is exactly the seam this
needed. `GameEngine.#step` gained six lines of precedence:

```
cutscene ?? observatory ?? the ship
```

and `CameraRig` gained a `??`. Nothing else in the renderer knows the
planetarium exists. That is worth recording because it is the payoff of a
decision made for a different reason a day earlier: **a seam built for one
consumer is worth building properly, because the second consumer arrives
sooner than you think.**

### The observatory writes nothing, and the test says so

`packages/devtools/src/observatory.ts` resolves an address, asks the world where
that is _this tick_, and returns a pose. No teleport, no clock, no entity write.
The test compares `world.stateHash()` before and after a session of dragging and
zooming, and that assertion is the design promise rather than a nicety: the
moment the planetarium can move the ship, the survey game has a free mode that
plays it for you.

It differs from `CutsceneDirector` in one deliberate way: **its `sample` touches
the world.** A script resolves its stage once and is pure afterwards because a
scene must be reproducible frame for frame; the observatory is _following_
something that moves, and one that resolved Jupiter's position once would orbit
where Jupiter used to be within a minute of time warp.

### Distance is logarithmic in nineteen decades, or it is a cut

From a kilometre above a moon to a hundred light years. Interpolated linearly, a
fly-to spends 99.9% of its time in the last decade and reads as a teleport — the
same trap `screenRoutePosition` documents for a four-decade cinematic approach,
met again two orders larger. Every zoom is a multiply; every ease is over
`log(distance)` with `1 - exp(-dt/tau)`, so 30 Hz and 144 Hz agree.

**The zoom-out ceiling is absolute, not a multiple of the target's radius.** The
radius-relative version put Luna's at 0.003 ly and a star's at 0.3 ly, so "zoom
out until the neighbouring stars appear" — the single most planetarium-shaped
gesture there is — worked at a star and refused at a moon, for a reason no user
could ever infer.

### Orbit traces: two ways to draw a curve that is not there

Affordable at all because ADR-0006 made orbits analytic: a period is 96
closed-form evaluations rather than 96 integration steps.

1. **A trace is relative to its primary, re-anchored to now.** Sampling a moon's
   _absolute_ position over one of its months also sweeps the planet through a
   twelfth of its year, so the trace is an open corkscrew that ends where the
   moon has never been.
2. **Each point is placed with the body's own radius.** Render compression keys
   off an object's radius (`placement.ts`), so a path placed as a radius-zero
   point is drawn _six times nearer_ than Jupiter is at Jupiter's range — the
   planet floats visibly off its own orbit. Measured, not guessed.

They are also **contextual**: what is drawn is the subject's siblings and the
things going round it. Everything at once, in a system seen from inside, is a
dozen ellipses edge-on — a fan of near-straight lines that says nothing.

### Four things that must not come back

- **A mode without `pointer-events-auto`.** `.hud-layer` is
  `pointer-events: none` so the scene stays reachable, and `ErrorBoundary`'s
  `className` styles its _fallback_, not a wrapper — so nothing between a mode
  and the layer turns them back on. The symptom is silent and total: the hit
  target at every pixel is the canvas, and the planetarium ignores every drag
  with nothing in the console. This cost an afternoon.
- **A ref-guarded "run once" effect.** `opened.current !== id` plus a cleanup
  that clears the target: React re-runs effects while refs survive, so the
  cleanup wins and the effect never fires again. The planetarium came up with
  the camera on nothing. **Reconcile against the state's actual owner** —
  `observatory.target?.address === wanted` — which is idempotent by
  construction.
- **A non-functional setter for derived state.** One pointer gesture can deliver
  more than one drop, and two `movePanel` calls composed against the same
  captured snapshot silently discard the first. `usePersistentState` now takes
  an updater and writes _inside_ it, so the string on disk is derived from the
  state React committed rather than from whatever the caller had in scope. The
  rendered layout and the stored one drifted apart before that, which is a bug
  that only shows after a reload.
- **A second transport on screen.** The cutscene overlay's scrubber and the
  cinema player's are two playheads a person can disagree with; the overlay's
  now rides the debug flag.

### The debug UI is off by default

The dev dock — navigate, telemetry, perf, graphics, camera — is the author's
instrument, and `docs/design/ux.md` specifies a cockpit that is nothing like it.
It is now hidden unless `` ` `` (or the shell bar's toggle) asks for it. Its
keybindings are unchanged when it is on.

### The gesture arithmetic is in Node, because every version of it is wrong once

`planetarium/gestures.ts` and `pick.ts` are pure and tested:

- **Wheel normalisation.** Chrome reports ~100 px per detent and Firefox reports
  3 lines; a handler that trusts `deltaY` zooms about thirty times faster on one
  than the other.
- **Pinch spread is the mean distance from the centroid**, not the gap between
  touches 0 and 1. The pair version leaps discontinuously the instant a third
  finger lands or the first lifts.
- **A drag with no previous sample contributes nothing.** Treating a missing one
  as the origin swings the camera by the pointer's absolute screen position — a
  full turn, from one frame.
- **Picking prefers what the pointer is inside, largest first**, and falls back
  to proximity. Distance alone lets a three-pixel point source beat the planet
  filling a third of the frame; size alone lets the largest body swallow every
  click.

### React DnD is an input device, and that is the whole design

`dock/layout.ts` owns every move and preserves one invariant — _every known
panel is in exactly one zone, exactly once_ — property-tested over random
sequences, because the ways to break it are combinations a test author does not
think to write. `hidden` is a zone rather than an absence, which is what makes
the invariant expressible.

The backend is chosen **once** at mount from `(pointer: coarse)`: `DndProvider`
builds its manager from the backend and cannot be handed another, so swapping it
is a remount of every panel. A user who has just plugged in a mouse can reload; a
user whose workspace resets because they brushed a trackpad cannot understand
what happened.

Because the algebra has no dependency on the library, replacing React DnD is
replacing two hooks in one file.

### Custom icons, drawn to Lucide's own rules

Lucide covers this interface almost completely — `Orbit`, `Telescope`, `Radar`,
`Clapperboard`, `PanelLeft` — and where it does, using it is the point: a set
drawn by one hand reads as one instrument. What it lacks is this game's own
physics, so `apps/game/src/icons/` adds seven through `createLucideIcon`, which
gives them the same props and the same stroke behaviour: three moon phases, a
sphere of influence, an interstellar span, a flip-and-burn profile, delta-v and
an observatory dome. 24 × 24, 2 px stroke, round caps and joins, and **2 px of
clear space between distinct elements** — the last is the rule that decides
whether an icon survives being drawn at 16 px.

### Mobile is real for looking, and honest about piloting

The planetarium and the cinema player work on a phone: one finger orbits, two
pinch, a tap focuses, and the panels become a bottom sheet with a tab strip over
a full-screen sky. Verified at 500 px wide. Docking is deliberately not offered
there — "left" and "right" have no meaning on a 390 px screen, so a drag with an
invisible effect is worse than no drag — and the stored panel _set_ is untouched,
so rotating a tablet back restores the columns.

Piloting on a touchscreen is not designed and the menu says so rather than
letting someone find out.

### The URL is the product's surface

`/planetarium?at=g:milky-way/s:SOL/b:5` opens on Jupiter.
`/cinema/tng-intro?t=1150` opens on that still. Both rewrite the address bar as
they go — the planetarium on every focus, the player only while paused, because
a router update twenty-four times a second is not a feature. Frames rather than
seconds in the cinema link: `t=48.2s` rounds to a different still on a 24 fps
scene than on a 30 fps one, and the whole point of a shareable frame is that two
people see the same picture.

`/auth/callback` is reserved now because a redirect URI is registered with an
identity provider ahead of time and changing it later is a coordinated deploy.
**No account page renders a credential field that goes nowhere** — people reuse
passwords, and a form that looks real is one they will type a real one into.

## The invariants got a loader (22 Aug 2026)

`AGENTS.md` holds thirty invariants, each one there because violating it is a
rewrite rather than a refactor — and **nothing loaded it**. `CLAUDE.md` says
"read AGENTS.md first", which is a request, not a mechanism; a session that
never read it operated with none of them. That is the whole reason `.claude/`
now exists in the repository rather than in a developer's home directory.

### The split, and why not one file

Nine path-scoped rules mirror the invariants into `.claude/rules/`, each with
`paths:` frontmatter so it enters context only when a matching file does —
editing `dock/layout.ts` brings the one-panel-one-zone invariant with it, and
editing the catalogue does not.

The tempting simplification is to move the invariants there and delete the
duplication. It was rejected twice over. `AGENTS.md` is vendor-neutral and is
what a human reads, so it stays canonical; and a rule is read on **every** touch
of its directory, where the thing it competes with for attention is the code.
So the rules carry only the _imperative_ — the one line that has to be in
context to prevent the mistake — and point at the section or ADR that says why.
The imperatives are the stable half, which is what keeps the duplication from
rotting. The contract for keeping the two in step is in
[`.claude/rules/README.md`](.claude/rules/README.md), and `AGENTS.md` now names
it in both directions, because a mirror that has drifted is worse than no
mirror: it fires with authority at the moment of the edit and states the
previous rule.

### The definition of done is executed rather than described

A `Stop` hook runs `graph → lint → typecheck → test` — measured 0.19s, 0.19s,
3.27s and 2.16s on an M5, so about six seconds — and a failure returns as work
still to do rather than a task reported complete.

`pnpm build` is out of it, and the number that argument was first written around
was wrong: the note claimed it added 5.3s, when `pnpm build` is
`typecheck && vite build` and the typecheck is already in the gate. The real
marginal cost is 1.66s. It stays out on the honest reason instead — bundling
proves nothing about the source that `typecheck` has not, and the failures it
does catch alone are resolution and asset ones, which are worth catching at the
commit. That is what `/ship` runs.

Three properties of the hook mattered more than the checks:

- **It only fires when a source file actually moved this turn**, off a marker
  the format hook leaves. A `Stop` hook has no other way to know what the turn
  did, and a turn that answered a question should pay nothing.
- **It blocks at most three times per prompt.** Exit 2 on `Stop` means "do not
  stop, here is why" — the feedback loop wanted, and exactly the shape of an
  infinite loop when the failure is one the agent cannot fix, such as a test
  that was already red. After the cap it reports and lets go.
- **It runs in the session's own cwd, not `$CLAUDE_PROJECT_DIR`.** Inside a
  worktree those differ, and gating the main checkout while an agent edits a
  worktree tests the wrong tree and passes for the wrong reason.

### What a worktree may carry

`.worktreeinclude` copies gitignored files into new worktrees, and the test for
belonging is: gitignored, **and not reconstructible from a command**. Almost
nothing passes it, which is the point — a worktree silently carrying state the
main checkout has is a worktree that passes tests the branch would fail.

`node_modules/` is the instructive exclusion. pnpm's is a symlink farm into
`.pnpm`, so copying it dereferences the links into roughly 640 MB per worktree;
`pnpm install --frozen-lockfile --prefer-offline` rebuilds it from the
machine-global store in about three seconds. The one real inclusion is the
cutscene's reference audio, which is copyrighted, must never enter the
repository, and which no command can fetch — so a worktree doing cutscene work
would have no way to get it back.

### Cloud sessions need Node 26, and a hook cannot supply it

Cloud images ship Node 20, 21 and 22. This repository runs the TypeScript
sources directly through type stripping with no build step, so an older runtime
does not degrade — `pnpm sim`, vitest and the headless runner fail at the first
import. **A `SessionStart` hook cannot fix it, because a hook cannot change
`PATH` for the commands that run after it.** So
[`scripts/cloud-setup.sh`](scripts/cloud-setup.sh) is committed to be pasted
into the environment's Setup script field, where it runs once as root and is
snapshotted. It resolves the current v26 patch from `SHASUMS256.txt` rather than
pinning one that goes stale, and it exits zero on every failure path — a
non-zero exit there means the session does not start at all, and an image with
the wrong Node is more useful than no session.

## Twenty-two findings the gate could not see (22 Aug 2026)

A multi-agent review of the `tng` branch — 145 files, 22,273 lines, too large
for one pass — against a tree where `pnpm check` was green and all 542 tests
passed. Every finding was a runtime or behavioural defect, which is the useful
fact about the whole exercise: **the gate proves the code compiles, lints,
type-checks and satisfies the assertions somebody thought to write. It says
nothing about the ones nobody did.** Four of these left the session
unrecoverable without a reload.

The findings themselves are in the commit and in the tests. What is worth
keeping is the _shape_ of them, because most repeated.

### The same bug, twice, in two files

Two wrappers around one cutscene director — the cinema player and the debug
overlay — were each a 100 ms poll driving a range input, written out
independently. Both latched `scrubbing` on `pointerdown` and cleared it only on
`pointerup` **on the input**, so a drag released anywhere else froze the
readout for the life of the player; touch never cleared it at all, because a
cancelled gesture fires `pointercancel` and nothing else. And they disagreed
about the other half: the player guarded its seek against a scene that had
already ended, the overlay did not, so the same click was safe in one and threw
in the other — out of an event handler, where a React error boundary cannot
see it, which is why the `ErrorBoundary` around the overlay caught nothing and
the interaction was lost with only a console line. `hud/useScrubber.ts` is both
rules in one place now: release at the window (`pointerup`, `pointercancel`,
`blur` — three different ways a gesture ends), and a seek that declines rather
than throws.

The general form: **two components that poll the same object will grow the same
bug, and then disagree about it.**

### A readout that could not name a frame

`timecode` derived seconds from the true rate and the frames field from
`Math.round(fps)`. At 24000/1001 those disagree once a second: frames
1006→1007→1008 read `0:41:22` → `0:42:23` → `0:42:00`, so the counter ran
_backwards_ inside a second, twenty-one times over the title sequence. A
timecode is a _name_ for a frame and a name that occurs twice names nothing —
which defeats ADR-0010's "two people see the same picture". Both fields come
from one rate now.

The instructive part is the test. `cinema.test.ts` exercised `fps = 24` and
`fps = 0` and never the 23.976 the product ships, and the first property test
written for the fix **passed against the broken implementation**: 21 bad
transitions in 1500 frames, and a property that samples single frames at random
almost never lands on one. It only went red once each case swept a _window_ of
400 consecutive frames. A property test over a sparse defect needs to sample
runs, not points.

### The background location was a contract two files kept

Opening a dialog over a mode records the mode's location in
`location.state.background`; `ShellBar` wrote it and `routes.tsx` read it, and
nothing else in the PR knew it existed. So the shell derived its mode from the
raw pathname and disagreed with the tree it was drawn over; the settings
section tabs dropped the state and tore the mode down mid-dialog; and all three
ways of closing a dialog navigated to `/`, which unmounted the planetarium, ran
`observatory.clear()` and threw away the `?at=` address — a close button that
returned the player to the main menu.

Over a running cutscene the first of those compounded into a loop: the gate
keeping the cinema player mounted is `mode === 'cinema'`, so navigating to a
dialog unmounted the player, whose cleanup stopped the scene, which republished
`cinema: false` 125 ms later (`PANEL_HZ = 8`), which mounted it again — a
mount/unmount flap several times a second that re-teleported the player, with
the requested dialog never rendering at all.

`resolvedLocation` (pure, in `paths.ts`) and `useOverlay` (the React half) are
the contract as code rather than as a convention. The invariant in `AGENTS.md`
now says the raw pathname is the wrong thing to read.

### Layers stacked by accident

Nothing in `apps/game/src` set a `z-index` except a Radix tooltip, so every band
of `.hud-layer` painted — and hit-tested — in DOM order. That was fine until a
mode covered the viewport: `PlanetariumMode`'s input surface is
`absolute inset-0 pointer-events-auto` and is emitted after the dock, so in the
planetarium every button, tab and drag handle in the dock was unclickable and
the surface silently took the click. The five bands are now numbered 0/10/20/30/40
on inert `pointer-events-none` wrappers — inert because `ErrorBoundary`'s
`className` styles its _fallback_ rather than a wrapper, so there was otherwise
nothing to hang the index on. Confirmed by A/B in the live DOM:
`elementFromPoint` on the dock's header returns the planetarium surface with the
bands stripped and the dock's own span with them.

### Two handlers, one key, no error

`useShipControls` is mounted in every mode and its `axes` option gated only the
axis branch, so `Space` still reached `onPause` in the cinema player — which
binds `Space` to its own transport. Both are on `window`, and `preventDefault`
in one does not stop the other (only `stopImmediatePropagation` would), so one
press flipped `clock.paused` twice and the documented play/pause control did
nothing at all. `axes` had the same argument and had been applied; `Space` was
missed because it is not an axis.

`Tab` was worse, because its guard could never open. It toggled the dock unless
focus was already inside `.hud-layer` — but on load `document.activeElement` is
`<body>`, whose `closest` returns null, so the guard was false, the dock
toggled, and `preventDefault` cancelled the browser's focus move. With no
`tabIndex` on the canvas there was nothing outside the layer to bootstrap from:
**focus could never enter the overlay at all**, and every focus ring,
`role="tab"` and `aria-expanded` in the PR was unreachable by keyboard. There is
no version that keeps both — Tab is how a browser moves focus and a window-level
`preventDefault` always wins — so Tab went back to the browser and the collapse
is `H`. `Space` is now declined when the keystroke is aimed at a control inside
the layer, which is what makes `hud/focus.ts`'s "a focused button swallowing
Space is correct: Space is what activated it" true; before the guard the button
never saw the key.

`F5` and `F9` were reported alongside and deliberately left as they are. No
control in the overlay responds to either, so declining them would activate
nothing — it would hand the key back to the browser, and F5 is Reload. Losing
the session because focus happened to be on a dock button is worse than the
thing it would fix.

### One frame without a player latched the whole session

`#step` returned early on `player === null`, and the cutscene sample sat below
that return. A load or an authority hand-off leaving `session.player()` null for
a single frame meant the director was never sampled again: it kept `#active`,
`engine.cinematic` kept its last non-null value, `engineStore` published
`cinema: true` forever, and every piece of chrome unmounted — including the
control that stops a cutscene. The camera precedence is
`cutscene ?? observatory ?? ship` and **only the last arm needs a player**; the
sample moved above the returns and the scene build stayed below them. The
regression test runs a scene to its end while there is no player, which is
exactly the frame the old order could not reach.

### Two more of the same family

- **`focus()` never re-clamped distance into the new target's band.** It carried
  `#state.distance` across a change of target and `approachState` log-lerps it,
  clamping elevation on the way and never distance — so Luna (settled ~3.2e6 m)
  to the Sun (band minimum 7.1e8 m) put the eye 695,700 km inside the
  photosphere for the second the ease took. Nothing surfaced it because
  `status().altitude` is `Math.max(0, distance - radius)`, so a negative
  clearance reads as zero. The property — every intermediate state of any ease
  is legal for the current target — reproduces it at 2.19e6 m against a 7.096e8 m
  minimum.
- **`#arrived()` compared raw azimuths while `approachState` converges via
  `shortestAngle`.** Azimuth accumulates unbounded as you drag, so after two
  turns the ease settles at a difference near 2π — the same heading, a whole
  turn apart numerically — which never falls below `ARRIVED_LOG_EPSILON`.
  `travelling` then stayed true for the rest of the session, which is the exact
  failure that constant's docstring says it exists to prevent. The same fact
  about azimuth produced the panel's `-327° az` for a heading of 33°, because
  JavaScript `%` is a remainder and keeps the sign.

### An impure updater, and why "derived from what React committed" was wrong

`usePersistentState` wrote to `localStorage` _inside_ the state updater, on the
argument that the string on disk should then be derived from the value React
actually committed. An updater is called during render, must be pure, and is not
the commit: StrictMode double-invokes it, and React may discard a rendered value
whose `setItem` has already landed — persisting a preference nobody chose. It
also made an FOV slider a synchronous `setItem` per input event. The write is an
effect on the committed value now, seeded so that an untouched default is never
written back — turning "never chose" into "chose the current default" would mean
a later change of default reached nobody.

### The two tests that pinned bugs

Both were caught by reading the tests rather than the code, which is the pass
worth doing on a branch this size. `planetarium.test.ts` had a case titled
"picks a moon in front of the planet it is against" that asserted the _planet_ —
the behaviour is deliberate and documented in the case body, but the title and
`pick.ts`'s docstring both described the opposite of what the code does, and a
docstring that claims largest-first "makes clicking a moon against its planet
work" is an invitation to "fix" the comparison. Both now say what the rule costs
and point the design question at `docs/design/planetarium.md`. The other is the
23.976 gap above.

One reported finding was checked and rejected: `.claude/hooks/gate.mjs` reading
`input.prompt_id` is correct — it is a documented common hook payload field
(Claude Code ≥ 2.1.196) with a `?? 'noprompt'` fallback for older versions.

## Readable with a star in the frame (22 Aug 2026)

The system's own standing test — "would this still be readable with a star
filling the frame behind it?" — had never been run. It has now, against pixels
sampled off the running renderer with the Sun framed to fill the viewport, and
it answered in two halves.

The panel material is **vindicated**. The solar disc composites to
`srgb(209,208,206)`, and behind `bg-slate-950/85` with its backdrop blur that
becomes `srgb(33,36,50)` — so `slate-300`, the primary readout value, holds
**10.34:1** with a star behind it. Translucency chosen for legibility rather
than for looks was the right call and the numbers now say so.

The **label ramp was never legible, anywhere**, and no amount of alpha was going
to fix it. `slate-500` — the left column of every readout row — measures 3.23:1
on the dock over a star and 2.43:1 on the flight strip. The decisive number is
that on a **fully opaque** `slate-950` panel it still reaches only **4.24:1**,
and on pure black 4.41:1; `slate-600` tops out at 2.66:1. There is no ground
this system would ever use from which either clears 4.5:1, so raising panel
opacity cannot help and only a lighter ink can.

That closes a design question rather than opening one: **the legible ramp is
200 / 300 / 400 and nothing below it.** Labels and secondary values now share
`slate-400` and are separated by position and case instead of brightness, which
is what the Case Rule was already doing. `slate-500` survives in exactly one
place, `hud/connection.ts`, where the pip is a non-text indicator held to 3:1
and where `checking` and `offline` are two greys that must stay distinguishable.

The flight strip is the one surface where the **alpha** moved rather than the
ink: at `/75` its bottom line was 2.43:1 and the line above it cleared 4.5:1 by
0.01, so it went to `/85` and its four-line ladder was respaced onto
sky-300 / 200 / 300 / 400. `docs/design` had already sanctioned exactly this —
alpha is functional here and loses every argument against contrast.

**The worst offender was not in a panel at all.** Sky labels are drawn directly
onto the one thing in the frame guaranteed to be bright, and measured **2.07:1**
(SOL) and 1.59:1 (EARTH) against the disc. Discounting their text-shadow, the
fill colour alone was **1.03:1**. A _selected_ label was worse — `sky-200` with
a sky-coloured glow measured **1.16:1**, because a glow can only add brightness
and the failing case is already bright. They now carry the panel material as a
plate and select with hue and a hairline: **10.41:1** and **11.62:1** measured
the same way. A dark shadow under light text only ever worked while the scene
was dark.

The transient notice had the same shape of bug and was found the same way:
`bg-sky-500/20` is 80% scene, so over a sunlit planet it composited to
**1.33:1** — on the element that echoes back whatever was just typed into the
address field. The accent is the edge now and the panel ground carries it.

## The dialog nobody could tab to, and the scrim that stayed (22 Aug 2026)

Two keyboard findings, one of which turned out to be much worse than the
accessibility audit that went looking for it.

**Targets.** 73 of 79 interactive targets measured under 24 px. Most passed
WCAG 2.2's spacing exception on luck of layout, but the destination rows did
not: 19.9 px tall and directly stacked, so consecutive targets sat 19.9 px
apart, inside the 24 px circles the exception measures. That is the one way an
undersized target cannot be excused. Everything is now ≥24 px with zero spacing
violations, measured across all five dock tabs. `measure gpu` in `PerfPanel`
turned out to be a hand-rolled copy of `Action` with byte-identical classes,
which is why it silently did not inherit the fix — invisible drift, and the
reason it is now the shared component.

**Focus.** Opening a dialog left `document.activeElement` on `<body>` and the
dialog is the last band in `.hud-layer`, so its first control was measured at
**79 tab stops** behind the rest of the chrome. The panel now takes focus on
open rather than its first control — a dialog that opens announcing "Close" is
announcing the one thing the reader did not ask for — and restores to the opener
on close. Two things about the restore are not obvious: React runs a deletion's
destroy around the same commit that detaches the node, so `activeElement` is
**not** reliably `<body>` at cleanup and checking only for that skips the
restore about half the time; and a mode can unmount behind an open dialog, so
the opener is checked with `isConnected` before being focused.

**And the bug none of that was looking for.** Verifying the focus fix turned up
that closing _any_ routed dialog left the scrim in the DOM at `opacity: 0` with
`pointer-events: auto` — a full-viewport invisible layer that swallowed every
click on the mode behind it. The scene kept rendering perfectly behind a sheet
of glass nobody could see. It reproduced on `HEAD`, so it predates the focus
work; the audit never found it because the audit never closed a dialog.

The cause was `<AnimatePresence mode="wait">` keyed on the full pathname in
`OverlayRoutes`. `mode="wait"` stopped the exit from completing, so the node was
animated out and then orphaned. Dropping it releases the node — but the outgoing
and incoming children then render together, and keyed on the pathname every
settings tab became a fresh entrance: **two 70% scrims stack to 91%**, so the
scene flashed dark on every tab click. The key is therefore the dialog's
_surface_ rather than its path — `/settings/display` and `/settings/camera` are
one panel showing different content. `overlaySurface()` is the pure half, in
`paths.ts`, with four tests; the leak itself needs a DOM and this vitest is
node-only, so what is tested is the arithmetic that regressed rather than a
claim that cannot be executed.

Live regions existed nowhere in the client and now exist in three places: the
transient notice (`status`, polite — it is the only confirmation most commands
give and it is gone in 2.5 s), the nav panel's failure report and the error
boundary's fallback (both `alert`).

## One component per file, and the registry underneath (22 Aug 2026)

The overlay was hand-rolled on top of a component library that had been
installed and used once. This is the rewrite `docs/roadmap.md` planned, plus the
lint rule that stops it happening again.

**The rule first, because it is what makes this stick.** oxlint implements
`react/no-multi-comp`, and turning it on found **57 violations** across
`apps/game`. It is now an error. The remedy is mechanical — a file named after
the component — and the reason it is worth enforcing is not tidiness: Vite's
Fast Refresh gives up on a `.tsx` that exports anything besides components, and
a full reload in this app rebuilds the `WebGPURenderer` and loses the camera.
That is the most expensive thing an edit loop can do here, and it was being paid
silently. `SceneView.tsx` was 1,390 lines and eleven components; the drop
indicator and the starfield shared a module on no stronger grounds than both
being drawn.

The exemption is `components/ui/*.tsx`. A Radix wrapper set communicates through
a context declared in its own module and is useless split, and `pnpm dlx shadcn
add` rewrites those files anyway — the same argument the `only-export-components`
override already made there.

Where a component needed a constant or a type as well, that went to a sibling
`.ts`: `hud/controls.ts`, `hud/perfFormat.ts`, `hud/cutsceneText.ts`,
`planetarium/presets.ts`, `pages/modes.ts`, `scene/debugMaterials.ts`. Two of
those closed real duplication — the field-of-view range was written out in three
places (`App`, `CameraPanel`, the planetarium's view panel) and is now
`FOV_MIN`/`FOV_MAX` in one, and `isColumn` moved into `dock/layout.ts`, which is
the tested module, because four components were each deriving the dock's axis.

**Then the controls.** `docs/roadmap.md` has the full table of what became what.
Three of its rows were wrong and are now corrected there:

- The anti-aliasing `Cycle` was listed as having no registry form. That is true
  of a cycle-through control and false of the problem: `off · 2× · 4×` is a
  closed set of three, which is a radio group. `ToggleGroup` renders it as
  `role="radiogroup"`, puts all three on screen, and reaches a specific level in
  one press instead of up to three.
- `ScrollArea` was listed for the dock body and the destination list. It must
  not be used there: Radix's viewport wraps content in a `display: table` box
  that grows past 100% to fit the widest line, and every readout in the dock is
  `truncate` inside a 27 rem column — the ellipsis would simply stop happening.
  `index.css` already paints the native gutter in this system's colours.
- Tooltips were listed as **blocked** because shadcn overlays portal outside
  `.hud-layer` and so outside `dynamic-range-limit: standard`. They are not
  blocked. The clamp exists because the dock and the flight strip are
  `backdrop-filter` surfaces and a backdrop filter samples what is behind it —
  which on the extended path includes a star's disc above diffuse white.
  `TooltipContent` is an opaque `bg-foreground` box with no backdrop filter, so
  it has nothing to sample. They are used only where a control is icon-only and
  the hint is therefore the label; everywhere text is visible the `title` stays,
  because there it is recovering a value that truncated, which is a different
  job.

**Two deliberate abstentions.** `Button`'s `default` variant is a solid
`bg-primary` plate and is wrong for the primary tone — `index.css` is explicit
that the accent is a material and never a fill behind text, which is why
`--accent` is `sky-500/15`. So `hud/Action.tsx` is `outline` plus that wash, in
one place rather than at sixty call sites. And `OverlayPage` keeps its
hand-rolled dialog: Radix's `Dialog` with `modal={false}` is genuinely the shape
it wants, and the sixty lines it would replace are the ones carrying the
focus-restore rules, the scrim's drag-release exception and the
`AnimatePresence` keying — every one of them written against a bug that shipped,
and three of them recorded in the entry above this one. That swap deserves those
cases as its acceptance criteria rather than a refactor's coat-tails.

**A test that could not fail.** `expect(graphics).toContain('off')` was asserting
that the lens-flare toggle read "off". The toggle stopped printing the word when
it became a `Switch` — and the assertion kept passing, because `off` is also one
of the three anti-aliasing levels a few nodes away. It now names the control:
`role="switch" aria-checked="false"`, and the anti-aliasing group by
`role="radio"`. Verified by reintroducing the state it guards against and
watching it go red, per the testing rule. The dock's tablist assertion moved the
same way — it named `id="hud-tab-camera"`, which Radix now owns and generates
per mount, so it asserts the contract instead: one selected tab, it is the one
asked for, and exactly one of five panels is not `hidden`.

**Verified in the browser**, not only in Node: all four modes, all five dock
tabs, the five planetarium panels, the settings dialog's three sections, and the
cinema player seeked to frame 1150. The two things most likely to have broken
silently both hold — a switch toggled in the view panel still writes through to
the scene (labels and orbit traces appeared), and a dialog opened over the
planetarium still closes back to `/planetarium?at=…` with the mode mounted, the
camera where it was, and no scrim left behind.

## A condensed voice, and the front door's lens (22 Aug 2026)

A design pass over the three surfaces a visitor actually meets. Everything below
was driven from a review of the running build rather than from the source, and
the two largest items are typographic.

**The display face is a condensed grotesque, and there is no serif in the
system.** Two serifs were tried in that slot in one sitting and both were the
same mistake in different clothes: Instrument Serif reads as a title page from
1780 over a live render of the Milky Way, and Spectral — lower contrast, more
technical — still puts a _book_ voice on an instrument. What this interface has
always been is signage. It is **Archivo Variable** now, run at 70% width and 700
weight for the name, 80%/600 for a title.

**It took the label steps with it, and that is the larger half.** The uppercase
micro-labels were Instrument Sans, a humanist face with generous sidebearings,
so at 10px with 0.15em of tracking they were loose and soft — which is how "the
labels look ugly" happens to an interface made almost entirely of labels.
Condensed at 78%, both steps grew a pixel (`type-heading` 11 → 12, `type-label`
10 → 11) while fitting _more_ characters per column, and the tracking came down
to 0.08em/0.1em because it had been compensating for sidebearings a condensed
face does not have. `type-ui` and `type-body` stay Instrument Sans: structure is
the grotesque, prose is the sans, data is the mono.

**Case is typography.** Every label in the source is title case and the step's
`text-transform` decides what is shouted, because a label is read in four places
CSS never reaches — a `title`, an `aria-label`, a screen reader, a copied
string — and `'PLAYABLE'` in a constant is a shout none of them can turn off.
About sixty strings moved.

**The corona was firing off-script.** The ring around an eclipsed limb was drawn
from occlusion geometry alone, so it appeared wherever a camera sat on a body's
anti-sun line: one press of `crescent` in the planetarium, and a third of every
slow orbit on the front door, as a gold halo filling the frame in a mode that
had never asked for an eclipse. At those ranges the physical corona is a
fraction of a degree past the limb and the drawn one is nearly a disc radius
thick. It is `CinematicEffects.corona` now — a script drive like `blackout` and
`flash` — and `tng-intro`'s eclipse shot (f240–356) is the only thing that sets
it.

**The front door orbits in phase, not in azimuth, and that is why the star
crosses the frame.** The old drift dragged the azimuth at 0.4°/s, which orbits
the world's pole; where the star ends up in that circle depends on how Sol's
ecliptic lies against the galactic plane, and it never reliably entered the
frame at all. `anglesForPhase` solves against the _star line_ and is continuous
through 360°, so the menu ramps phase at 1.8°/s from −112°. Measured on the
running page: on the positive arc the star's image sits at NDC x = −0.58, dead
centre of the poster's black gradient with its ghost chain out over empty sky;
negated it is at +0.58 and the composition is a bright rim on the left, the star
clear of it two thirds across, and the anamorphic streak running the full width
under the type. `engine.flareArtifacts` is the new dial that lets the menu run a
near-clean lens — at 1.0 the red aperture ghost is a 260px hoop on the
paragraph.

**The catalogue is measured from the camera.** `travelTargets` took the
_player's_ position, so in the planetarium — whose only verb is `look` — the
list opened at Alpha Centauri still ordered by distance from Earth: Sol's moons
at the top, and the star filling the frame reported as 4.4 ly away twenty rows
down. `targets({ origin: 'observer' })` centres the survey and the sort on
`Observatory.eye`. Systems sort by distance; bodies stay in orbital order under
their star.

**The clock has a date.** Every orbit is solved from J2000 elements at
`epoch: 0`, so simulation time has always been seconds after a real instant and
the readout has never said so — it was `formatDuration(clock.time)`, "15.23 s",
a stopwatch reading in a mode whose subject is _when_ you are looking.
`SIMULATION_EPOCH_UTC_MS` in `@inertialref/shared` is noon UTC on 2000-01-01 and
does not pretend to model TT−UTC; the panel formats it in the reader's own zone.
The transport is Stellarium's: slower, play/pause, faster, and the rate readout
doubles as the way back to 1×. **There is no reverse**, and it is not an
omission — `SimulationClock` counts fixed ticks forward, `setTimeScale` refuses
anything not positive, and ship state is integrated rather than derived, so
running it backwards is a re-simulation from a snapshot rather than a sign flip.

**On a phone the workspace had no way out of itself.** `Workspace` rendered the
IR menu only in the desktop arrangement, so the mark, the place and the settings
did not exist below 900px: the browser's back button was the entire navigation
model. The compact strip is a nav bar now — the same three questions at thumb
scale — and the panels moved into the sheet they open, where they wrap onto as
many rows as they need instead of scrolling the fourth name off the edge of one.
`openPanels` in `dock/layout.ts` is the census, pure and tested, because the
picker lives inside a sheet that opens closed and a static render could never
reach it.

**Cinema: three defects, one cause each.**

- The end of a scene cut to whatever the chase camera saw — the debug hull in
  front of Earth, arriving as a hard cut on the last beat of a title sequence —
  with "scene ended" in the display face over a sunlit planet at about 1.6:1.
  The player reopens two frames short of the end and pauses, so the last shot
  holds, and the card is a real surface with three ways out including one home.
  Two frames rather than one: the director reports `done` _on_ the final frame,
  so seeking to it loops.
- The transport sat under the IR menu at the bottom centre. It is at
  `bottom-14` now, above it, which is the same stacking the notice already used.
- The menu stayed on screen through the entire title sequence while the
  transport faded. `useTransportIdle` is one timer in `CinemaMode` and both bars
  fade together; the wrapper uses `visibility` alongside opacity so an invisible
  bar does not keep taking clicks.

**`TooltipContent` was the registry component `DESIGN.md` said not to ship.** It
was inverted — a white chip over a starfield — and portalled to `document.body`,
outside `.hud-layer` and therefore outside the standard-range clamp. Both are
fixed in the file rather than at ninety call sites, along with a 350ms delay:
at the registry's 0 it is not a hint, it is a popover following the pointer, and
crossing the seven glyphs of the menu fired seven of them.

**Smaller, all from looking at it:** panel headers carry a pin whose rotation is
the state and which tips under the pointer to the state pressing it would
produce, and their three controls lost their hover cards; the graphics panel's
icon is a monitor rather than an aperture, which belongs to the camera panel
next door; the extended-range override and the anti-aliasing level are one
generic `OptionGroup` instead of a cycling button and a bespoke toggle group,
with `auto → extended` stated underneath only when `auto` is what is selected;
the planetarium's presets lost their "tour" — five buttons that were a second,
worse catalogue — and gained six named compositions; sky labels dropped the
boxed plate for a text halo and a fading leader, keeping a ground only on the
selected one; and `SwitchRow` puts its detail on a second line, because beside
the label it truncated to "Show the Ship the hull the …", which reads as a
rendering fault rather than as a hint.

**Two new invariants, both with a regression test behind them.** _An effect is
staging, so a script turns it on_ — `cutscene.test.ts` walks all 2,742 frames
and asserts `effects.corona` is 1 inside f240–356 and 0 everywhere else; and
_labels are title case in the source, the type step decides the case_.
`observatory.test.ts` guards the catalogue's origin: after `ir.look('HIP71683')`
the player-centred listing still leads with Sol — the hull has not moved, which
is the mode's whole guarantee — and the observer-centred one leads with Alpha
Centauri. Both tests were checked against a reintroduced bug and go red.

**One frame-index trap, found by that test.** `frame` reaches the effects
function as `(renderTime - epoch) * fps`, and at 24000/1001 the round trip
through a float lands the last frame of a shot at 356.00000000000006 as often as
at 356 — so an inclusive comparison against the shot table read it as the _next_
shot and dropped the corona a frame early. `coronaAt` floors first. A frame is
an integer index; the fraction is sub-frame interpolation and no shot boundary
is a function of it.

**One detector finding is a knowing false positive.** `hud/OptionGroup.tsx`
trips `gray-on-color` because `data-[state=off]:text-slate-400` and
`data-[state=on]:bg-sky-500/15` are in one class string; they are mutually
exclusive states and never composite.

## The front door as a public surface (23 Aug 2026)

Everything a person or a machine meets before the canvas does. The site is now
**<https://inertialref.jonjaques.com>** — a Cloudflare custom domain declared in
`wrangler.jsonc`; `inertialrefd.jaquers.workers.dev` still answers and is
deliberately not canonical, because it is the address a deploy gets checked on
before DNS is trusted. `docs/hosting.md` H-7 and H-8 are the record.

**One dev command.** `scripts/dev.mjs` runs Vite and `wrangler dev` as two
children with one lifetime — prefixed output, and one exiting stops the other.
The two-process split was never the problem; the second terminal was, because
forgetting it makes every `/api` call fail in a way indistinguishable from a
broken client. `pnpm preview` is the new production emulation: build, then
`wrangler dev` alone, so the assets come through the real static asset store,
the real `run_worker_first` and the real SPA fallback, with the service worker
actually registering. Reach for it when a bug is about how something is
_served_. `@cloudflare/vite-plugin` is still declined and still for the same
reason — it takes over a tuned client build — and that is now written down in
one place instead of two.

**The brand is generated from one drawing.** `design/brand/brandmark.svg` is the
mark; `pnpm brand` renders `favicon.svg`, `favicon.ico` (hand-written ICO
container around three PNGs), `apple-touch-icon.png`, `icon-192`, `icon-512`,
`icon-maskable-512`, the 1200×630 `og.png`, `manifest.webmanifest`,
`robots.txt`, `sitemap.xml` and `src/icons/brandmark.ts`. `pnpm brand --check`
is in `pnpm check`. Before this there were three hand-kept copies of the same
three paths with comments on each asking the next person to keep them in step.

Two things in that pipeline cost real time and must not be rediscovered:

- **sharp's `text` input silently ignores `fontfile` for a WOFF2.** Measured:
  byte-identical 447×75 output for Archivo, Martian Mono and no font at all. A
  share card that renders in whatever the build machine happens to have looks
  fine locally and wrong everywhere else.
- **fontkit's `getVariation()` throws on a WOFF2.** It rebuilds a `TTFFont` from
  the _compressed_ stream, so the table directory is garbage and the first
  `cmap` lookup dies on `Cannot read properties of undefined (reading 'tables')`.
  `wawoff2.decompress()` first, then `fontkit.create()`, and the width axis
  works. That matters here because `type-display` is Archivo at `wdth 70%` — the
  condensed voice _is_ the wordmark, and the default 100% instance is a
  different brand.

The mark's content box is **measured** by rasterizing and asking sharp to trim,
not declared — and `trimOffsetLeft`/`trimOffsetTop` are the negative of the crop
origin, which taken at face value mirrors the mark about its viewBox. The only
symptom was a favicon two units off centre, which reads as a rendering artefact
rather than a sign error.

**The static head is the card, and it is hand-kept on purpose.** No social
scraper runs JavaScript, and `not_found_handling` is `single-page-application`,
so one document is the card for every path. `index.html` carries the full Open
Graph and Twitter set plus a JSON-LD `@graph`; `pages/DocumentMeta.tsx` updates
`<title>`, the description and the canonical link per route for the readers that
_do_ execute scripts. `src/site.ts` is what both are written from, and Node runs
it directly so the generators import it rather than keeping a third copy.
Per-route Open Graph needs `HTMLRewriter` on every navigation, which turns a
free asset request into a billed invocation; that is recorded as a seam, not an
oversight.

`DocumentMeta` is the one place in the client that reads `location.pathname`
raw. Everywhere else that is the bug AGENTS.md names — but this is about the
_URL_, not about what is on screen, and the address bar is exactly what a tab,
a bookmark and a canonical link are describing.

**Analytics is a gate, not a snippet.** GA4 loads only in a production build,
only on the canonical host, and only without Global Privacy Control — so
localhost, `pnpm preview`, a Wrangler preview URL and the `workers.dev` address
all measure nothing. `send_page_view: false` plus an explicit `page_view` per
navigation, because GA4's automatic collection depends on an enhanced-measurement
setting in a web console this repository cannot see. The measurement id is
`VITE_GA_MEASUREMENT_ID` in `apps/game/.env.production` — a build-time _public_
variable, committed because it ships in the bundle anyway. `site.test.ts` states
the rule; the failure is silent in both directions.

**Installable, and honest to agents.** The manifest was the only missing half of
a PWA — the service worker and a universe that is a pure function of a seed were
already there. `/llms.txt` is prose for a reader that is not a person, and the
`<noscript>` block is the same courtesy for one who is; both existed as a black
page and a boot message about a catalogue before this.

**The reference audio left the working tree, and R2 is bound.** It lives in
`r2://inertialrefd-storage/dropbox/tng-intro.mp3` and reaches the browser two
ways from one table (`apps/server/src/media.ts`): `pnpm media:pull` copies it
into the gitignored `apps/game/public/media/` so it ships as a static asset —
free, never wakes the script, `Range` handled by the asset server — and the
Worker's `MEDIA` binding serves it when a credential-less build did not. Two
transports, one object, so there is nothing to drift.

`run_worker_first` now covers `/media/*`, which costs an invocation on a path
that was free. It buys two things: the response is `immutable`, so it is roughly
one invocation per client rather than one per play, and an **unlisted** name now
404s where the SPA fallback used to answer a request for an `.mp3` with
`index.html` and a 200 — an `<audio>` element handed a page of markup fails as
though it could not decode the file. The miss is detected by content type
because there is no status code to test, and `/media/*` is an **allow-list**
rather than a key prefix: that bucket is the site's general storage, and a
prefix rule would have made all of it world-readable and turned `/media/../`
into a bucket read.

Two workerd traps, both found by running it and neither by reading:

- **`R2Range` is published as a union of three exclusive shapes**, so the
  obvious implementation narrows with `'suffix' in range`. The object workerd
  hands over has all three keys present with two of them `undefined`, so that
  test is true for a range with no suffix and the arithmetic runs
  `size - undefined`. Everything came out `NaN`, the runtime quietly replaced
  `Content-Length` from the real body size, and the only visible symptom was
  `Content-Range: bytes NaN-NaN/2747091` on a response whose bytes were
  correct. **Narrow on the value.** `routes.test.ts` has the regression, and it
  was checked by reintroducing the bug.
- **`stored.range` is populated whether or not the request carried a `Range`
  header** — an unranged get reports the whole object as its range — so keying
  the status off it answers every plain GET with `206 Partial Content`.

Verified against a local workerd with the bundled copy removed: 200 for a plain
GET, 206 with a correct `Content-Range` for explicit / suffix / open-ended
ranges, 304 on `If-None-Match`, 404 for an unlisted name and for `/media/../`,
405 for a POST — and the first 1024 and last 500 bytes byte-identical to the
source.

A third thing turned up on the deployed review app rather than locally:
**`env.ASSETS` does not serve ranges.** `Range: bytes=0-1023` came back 200 with
all 2.7 MB. A browser copes by buffering the whole track and seeking locally,
but the overlay drives `currentTime` against a reference clock, so on a slow
connection every seek waits for a download a 206 would have avoided. The handler
now treats "a range was asked for and the asset store answered 200" as a miss
and lets R2 answer — the one case where the second transport is better rather
than a fallback. The service worker treats `/media/` as immutable for a second reason:
stale-while-revalidate would re-fetch 2.7 MB in the background on every load.

**The GA measurement id is not in the repository.** It is not a credential — it
ships in the bundle and is visible in every request the tag makes — but this
repository is public, and an id committed in it is an id every fork measures
into. `.env*` is gitignored, `apps/game/.env.example` is the committed
documentation, and the real value is a Workers Builds **build variable**; a
deploy run from a developer's machine reads the same name from a local
`.env.production`. Vite gives a real environment variable precedence over a file
of the same name, verified by building with each in turn.

Also removed: `public/icons.svg`, a starter-template sprite sheet of Bluesky,
Discord and GitHub glyphs in `#aa3bff` that nothing referenced and the service
worker had been precaching.

## Known gaps

Fuller treatment, with the seam for each, in [`docs/roadmap.md`](docs/roadmap.md).

- **The planetarium has no bookmarks, filters or measure tool.** The address is
  already the whole record for a bookmark, so what is missing is a store; the
  filter fields are the ones `docs/design/galaxy.md` lists for the galaxy map.
- **The catalogue panel surveys 16 ly and filters in the client.** That is right
  for a list of a few hundred rows and wrong the moment a search is meant to
  reach the whole 150 ly sphere — `travelTargets` is a star sweep and cannot be
  run per keystroke. A name index over the catalogue is the seam.
- **Mode routes are not covered by a Node test.** Each drives a live engine, and
  a test that stubbed a renderer, a worker pool and a camera would assert
  against the stub. `modeForPath`, the link builders, the dock algebra, the
  gesture arithmetic and the compact dock all are; the boundary is deliberate.
- **Piloting on a touchscreen is not designed.** The flight modes are
  desktop-only and the menu says so. The planetarium and the cinema player are
  the mobile surface.
- **The interface never says `observed` or `projected`.** PRODUCT.md makes
  stating it a brand commitment and `SystemStub.catalogued` has carried the
  answer all along; `TravelTarget` does not forward it, so the destination list
  shows a real star and a generated one identically. See the colorize note in
  [the hardening pass](#what-the-colorize-pass-found-before-it-started).
- Binary and multiple-star systems are modelled as single stars (`components`
  in the catalogue records the truth for all 375 of them within 150 ly).
- Moons outside the Solar System are all projections, which is right — no
  exoplanet moon has been confirmed. Sol's twenty are real and observed.
- **Seven Solar System bodies have no vendored surface map** — Titan, Enceladus,
  Iapetus, Triton, Phobos, Deimos and the Uranian moons — and render from their
  measured albedo and tint. USGS has mosaics for several; they are large, and the
  return per gigabyte is much lower than for the four Galileans.
- **Three of the four Galilean maps are monochrome.** That is how Voyager and
  Galileo returned them. They are tinted with published colours, which is a
  different and smaller lie than rendering them grey.
- The atmosphere is still an analytic uniform-density shell with authored
  scattering colours, not the Bruneton LUTs spike 2 made a requirement. The
  colours are per body now, which was the loudest half of the problem.
- **Nothing diffs two catalogue versions.** Every save records the version it was
  written against and every build records its own, which is both halves of the
  input to a revision notice — and no code compares them. Until it does, a
  rebuild that moves a body is invisible to a loaded save.
- The 50 systems whose only identifier is HYG's own row key (0.7%) have ids a
  rebuild can move. They are counted on every ingest and asserted under 1%.
- **The procedural fill's IMF is not conditioned on what the catalogue is missing.**
  It draws B stars at their true 0.13% frequency, so a 40 ly sweep can put an
  invented 5,000 L☉ B star in the sky brighter than anything real in it — and real
  B stars that close do not exist, which is precisely why the catalogue has none.
  The fix is a per-spectral-class completeness curve, which
  `docs/design/galaxy.md` already argues the horizon of knowledge needs anyway.
- Proper motion and radial velocity are not stored, so the sky is a snapshot at
  J2000 rather than a sky. Two columns and a `positionAt(epoch)`; the sentinel
  that would have to be handled (`9999.99 mas/yr`) is already detected and
  counted by the ingest.
- A handful of HYG rows carry a spectral string that parses cleanly to the wrong
  answer rather than failing: Capella's is `M1: comp`, so a G-type giant binary is
  rendered as a red dwarf. Two rows in 7,123 fail outright; this class is not
  counted because nothing distinguishes it from a correct parse.
- No n-body perturbation; patched conics only.
- Terrain has no persistence of modifications yet (the schema anticipates it).
- Collision is ground contact only — no hull, no other entities.
- The atmosphere is an analytic shell — exponential density and a twilight
  ring as of 21 Aug, but still geometry rather than scattering. The Bruneton
  LUTs spike 2 made a requirement remain the specified replacement.
- No compute passes, storage buffers or indirect draw yet: the WebGPU migration
  delivered the renderer and the HDR path, not GPU-driven terrain or culling.
- Cold load to interactive is still unmeasured, and it is the budget most likely
  to be missed: the bundle is **663.3 KB gzip — 511.0 KB brotli — in a single
  chunk** with no code splitting and no `React.lazy` anywhere in `src`, of which
  67 KB arrived with the UI foundations on 22 Aug. `main.tsx` then awaits a
  469 KB catalogue before the first render, correctly (it is a generation input)
  but on top of that. Three of the four modes are not the first viewport and are
  the obvious thing to split out.
- Every performance number recorded here is from an Apple M5 in a 1000×760
  window. The target is a 2023-class laptop at 1920×1080 — roughly three times
  the pixels on a much weaker GPU — so these establish that the instrument works,
  not that the budget is met.
- The tone curve has no test. It is a TSL node graph, there is no CPU backend to
  evaluate one in Node, and a scalar mirror of the same arithmetic would pass
  while the graph drifted — which is the failure the terrain-normals test is
  remembered for. It is verified on a GPU or not at all, and the benchmark
  harness `docs/design/technical.md` already calls an M2 prerequisite is what
  would do it.
- `World.updateInterest` is the core's own system-streaming policy and has no
  production caller: both apps load one system and never stream another, and the
  client runs a separate starfield survey with its own radius and hysteresis.
  It is tested and left in place deliberately — wiring it into the frame loop
  changes what unloads mid-flight, which is a gameplay decision, not a cleanup.
