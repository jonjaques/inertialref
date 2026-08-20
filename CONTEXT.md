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
pnpm dev         # vite dev server (apps/game)
pnpm test        # vitest, node environment only
pnpm typecheck   # three tsconfig projects
pnpm lint        # oxlint
pnpm graph       # dependency layering + cycle check
pnpm build
pnpm check       # all of the above
pnpm vitest run <substring>   # single test file
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

## Known gaps

Fuller treatment, with the seam for each, in [`docs/roadmap.md`](docs/roadmap.md).

- Binary and multiple-star systems are modelled as single stars (`components`
  in the catalogue records the truth).
- No n-body perturbation; patched conics only.
- Terrain has no persistence of modifications yet (the schema anticipates it).
- Collision is ground contact only — no hull, no other entities.
- The atmosphere is an analytic uniform-density shell, not scattering — a
  placeholder for the Bruneton LUTs spike 2 made a requirement.
- No compute passes, storage buffers or indirect draw yet: the WebGPU migration
  delivered the renderer and the HDR path, not GPU-driven terrain or culling.
- Cold load to interactive is still unmeasured, and it is the budget most likely
  to be missed: the bundle is 501.7 KB gzip with no code splitting.
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
