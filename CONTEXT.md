# CONTEXT.md — InertialRef build log

A dated record of what landed, what was decided, what was measured, and which
bugs must not return. This is a diary, not a working guide.

- **How to work:** [`AGENTS.md`](AGENTS.md), then [`docs/agents/`](docs/agents/README.md)
- **How the system works:** [`docs/`](docs/README.md)
- **How to append an entry:** the `context-log` skill

Update this file when a package lands, a decision changes, or a defect is
worth not reintroducing. Do not treat it as a substitute for an ADR or a
concept page.

Scope and principles are in [`docs/vision.md`](docs/vision.md); remaining work
is in [`docs/roadmap.md`](docs/roadmap.md); foundational decisions are in
[`docs/adr/`](docs/adr/).

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
| `universe`      | 3     | done — addressing, star catalog, generation, terrain, frames                    |
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
   plus a double offset inside a 2^40 m sector. Sub-millimeter everywhere in a
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
   center put a planet's datum sphere 30 km from the terrain it represents.
9. **A save is a reference, not a copy** — under 800 bytes for a flown session.

## Conventions worth knowing before editing

- **Axes: right-handed, +Y up.** System reference plane is XZ, forward is −Z.
  Textbook orbital mechanics is +Z up, so `physics/frameConvention.ts` converts
  once at that boundary and nowhere else.
- **SI internally.** Presentation units are branded and only exist for display.
- **Terrain is sampled in body-fixed axes.** Sampling it in inertial axes leaves
  the mountains behind as the planet rotates; this was a real bug.
- `packages/*` must run unchanged in the browser, a worker and Node. The root
  `tsconfig.json` gives them no DOM lib, which is how that is enforced.
- No TS project references: a referenced project may not disable emit. Five
  independent tsconfig projects — the portable core, the client, the Node
  runner, the Worker and the offline ingest — plus `pnpm graph` for the
  dependency layering.

## Commands

```bash
pnpm dev         # ONE command: vite on 5173 and wrangler on 8787, /api proxied
pnpm dev:client  # just vite      pnpm dev:server  # just wrangler
pnpm preview     # build, then the real Worker over the real dist — production
pnpm test        # vitest, node environment only
pnpm typecheck   # five tsconfig projects
pnpm lint        # oxlint
pnpm graph       # dependency layering + cycle check
pnpm brand       # re-render every brand artifact from design/brand/brandmark.svg
pnpm build       # optional media pull, typecheck, vite build
pnpm check       # all of the above
pnpm vitest run <substring>   # single test file
pnpm run deploy:worker        # pnpm build, then wrangler deploy

pnpm catalog:report           # build the star catalog and print the counts
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
  `structuredClone`s messages and honors its transfer list; it did neither, so
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
  dwarf is a sub-pixel point and traveling looks like a no-op. `distanceAu`
  asks for the hold-off explicitly.
- **The overlay became a dock.** Two tabs — navigate and telemetry — sharing one
  panel, every section collapsible and remembered in `localStorage`, and a
  toolbar so pause, time warp, assist and save/load are not keyboard-only. The
  panel calls the harness and nothing else, which is the rule that keeps a
  clicked maneuver reproducible in a test.
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
again in a neighboring system.

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
  was `sky-200` plus a sky-colored glow and measured 1.16:1 against a star:
  light added to light. Selection has to change hue or carry its own ground.
- Surface frame ids were **not idempotent**: `(-1e-9).toFixed(6)` is
  `"-0.000000"`, which re-parses to `-0`, which formats as `"0.000000"`.
- The frame's geometry used unrounded angles while its id was rounded, so a
  restored landing site sat half a meter from the original.
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
- **`seaLevel` was honored by physics and ignored by the mesh.** It was carried
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
  through as a thin terrain-colored band floating over the horizon — visible
  landed, gone by ~100 m up, which is what finally localised it. No
  distance-based test could catch it: winding is invisible to arithmetic about
  vertex positions, and the strobe test's invariant (constant ship–patch
  separation) holds in either order. Found by rebuilding the exact scene in
  Node and raycasting it — `THREE.Raycaster` honors `material.side`, so
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
- **StrictMode registered every boot producer twice** (23 Aug 2026), and the
  second `track('building bodies')` returned a ticket the component never held
  and could therefore never finish. Boot sat at `building bodies 62/62` with the
  cover up, forever. Not findable in Node — the tests drove `createWarmup`
  directly, where nothing is double-invoked — and found on the first boot in
  Chrome. The census is idempotent by label now: two producers with the same
  label are the same work.
- **A warm-up deadline counted down against an occluded window** (23 Aug 2026).
  Chrome suspends `requestAnimationFrame` entirely for one, so a frame-driven
  producer there has not stalled — it has not been given a single frame — and
  the eight-second timeout abandoned the build-ahead for exactly the load with
  the most time to spare, then logged a stall that had not happened. It counts
  only while the document is visible, which is the rule the presentation
  watchdog next to it already followed.
- **`α Cen` resolved to nothing** (23 Aug 2026), though `designations.ts` says
  in as many words that it should — it is the form that gets pasted out of
  Wikipedia. Only `α¹ Cen` was indexed, because dropping the superscript keys
  `ζ¹ Reticuli` and `ζ² Reticuli`, two unrelated systems, to one string. The
  fix is not to relax that rule: it is a constraint on an _exact_ lookup, and a
  search box handed an ambiguous name should offer both stars. Splitting `find`
  from `search` is what made the two answerable separately.
- **The time-warp ceiling was a count of ticks per frame** (23 Aug 2026), so a
  saturated clock delivered the same 32 simulated seconds however long the frame
  took. Simulated time then advanced per frame rather than per second and every
  determinism test still passed, because determinism is a claim about the tick
  and this is a claim about the wall clock between ticks. See the entry below.
- **The observatory placed its camera at `clock.time` while the scene drew every
  body at `renderTime`** (23 Aug 2026), and so did the orbit traces' per-frame
  shift — found by review, in a file the invariant's own glob covers, the same
  day the invariant was written. Up to one tick apart, and sawtoothing —
  so the camera aimed at where the target used to be, by a different amount every
  frame. `observatory.test.ts` already asserted the standoff, and passed, because
  its own helper asked at `clock.time` too: the test and the code were wrong
  together. Two assertions agreeing is not two pieces of evidence when they share
  a mistake.

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
- **Gaia is CC BY-NC 3.0 IGO.** Non-commercial, verified against ESA's license
  page — not "open with attribution", which is what the design bible said. It
  stays out of any shipped bundle until ESA says otherwise in writing.
- **The catalog is 12× cheaper than estimated.** 150 ly of HYG plus every
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
down the screen's center column now crosses from sky to terrain at eye level
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
  and honored on the WebGL fallback. The star field is a `Sprite` with an
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
  honored once per adapter, so a renderer that later wants its own gets a device
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
  `Info.autoReset` is honored inside `Animation`, a `requestAnimationFrame`
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
  happened. Coloring the plot on the budget alone marked a comfortable 60 fps as
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
  tempting behavior — ignore unknown keys in the generation manifest — makes the
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

The catalog stopped being 18 hand-transcribed stars and became an ingest.
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

### The catalog is a second generation input, and it has to be an argument

`docs/design/galaxy.md` Rule 1 says the catalog version is an explicit input to
generation. The cheap implementation is a module-level singleton the generator
reads, and it would have been wrong in the specific way this project cannot
afford: the catalog changes when astronomy publishes, and a universe that
changes silently underneath a save invalidates every address in it.

So `resolveSystem`, `systemsWithin` and `new World({ … })` all take it. Five call
sites, one line each. `SaveGame` records `catalog` beside `generation` — it is a
string and `generation` is a map of numbers, which is the only reason it sits
beside rather than inside.

### Workers cannot have it, so tasks take what they need

Every worker task used to take a system id and resolve it, which now needs a
458 KB table in every worker in every pool to answer a question the caller
already knew the answer to. Two changes, both narrowing:

- `generateCell` takes a `CellContext` — how many cataloged stars are in this
  cell, and the radius inside which the catalog is complete. Those two scalars
  are the whole of what procedural generation needs from the catalog.
- `surveySystemTask` takes the resolved stub instead of an id. The caller had
  already resolved it; passing the id was asking for the work twice.

### Procedural fill has to subtract, and then stop

The density model says how many stars there **are**. The catalog says how many
of them somebody has written down. Those are different numbers and the difference
is the whole quantity:

- Generating the full expected count _on top of_ the catalog doubles the solar
  neighborhood — 7,123 real systems within 150 ly plus the ~40,000 the density
  model expects in the same volume.
- Generating none leaves it five times too sparse, because HYG holds about 59% of
  the known stars within 25 pc and none of the brown dwarfs.

So the fill is `expected − cataloged`. That was still wrong near the Sun: the
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
catalog that gains entries, it has to mean "the third body ever issued in this
system" — or confirming a hot Jupiter interior to everything else renumbers the
system and every save pointing at those worlds is silently wrong (ADR-0009,
Rule 2). Confirmed planets are issued first in discovery order, which the
exoplanet letters already encode; projected ones fill after, and any projection
landing within a factor of 1.5 of a confirmed orbit is dropped rather than moved.
`orbitalOrder(system)` sorts for display. Earth is `b:2` and stays `b:2`.

## What the data itself taught (20 Aug 2026)

Four things that were measured rather than assumed, and one that reversed an
assumption.

**The spectral classification beats the color index.** B−V is the obvious
temperature source — 89% of the catalog carries one — and it is worse: 4.7%
mean absolute error against 17 published temperatures, versus 2.8% for the
classification, and 18% at the worst case against 5%. Ballesteros' fit bends
badly at the red end, which is where three quarters of the neighborhood lives.
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
the solar neighborhood, so the polynomial was wrong about most of the sky.

**`spect[0]` is wrong about 13% of the catalog and never says so.** `dM4` is an
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
roughly quadruples the number of stars with a name a human recognizes.

**Completeness, not size, is the constraint.** 178 confirmed planets around 117
hosts are dropped because HYG does not contain the host at all — TRAPPIST-1 among
them, at V = 18.8. That is not a matching failure; it is the horizon of knowledge,
and the star map is supposed to draw it.

**A version has to digest what ships, not what was downloaded.** The catalog
version is a generation input, so it must change exactly when the data changes.
Hashing the source files fails that in both directions — the NASA archive's TAP
service returned two different digests an hour apart for a query whose 702
matched planets were identical. It digests the packed output instead, with the
metadata excluded because the metadata contains the version.

**Flux is not brightness.** The starfield now carries a per-star blackbody color
and an apparent brightness instead of one hard-coded blue-white, and the first
attempt normalized linear flux against the brightest star in view. Measured in
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
packed catalog in the same change: eight rows in a planet table cannot carry
twenty moons, oblateness, axial tilt and ring geometry, and none of it is
catalog data. They are facts, and they live in source.

The Sun itself is built from the IAU's defining constants rather than from its
own catalog row. The photometric pipeline reads Sol back as 0.973 L☉ and 0.987
R☉, which is a fair measure of how well the method works and is the best
available answer for every _other_ star. For this one there is a defined answer,
and using the estimate would make the one object every player can check the only
one that is knowably wrong.

### Planetary surfaces are not Lambertian

The largest single change to how a body looks, and it is a physics correction
rather than a style choice. The full Moon is _flat_ — no limb darkening at all —
because regolith backscatters. A Lambertian moon has a bright center and a dark
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
8-bit grayscale `b-w`, so it truncated LOLA's 16-bit product; a following
`raw({depth:'ushort'})` widened the container back to two bytes without restoring
the range. Every gradient came out 256× too small and the Moon's normal map was
_perfectly flat_ — a valid file, a plausible pipeline, and no error anywhere.
`grey16` is the one that preserves it, and the meters-per-value scale now
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
stale Saturn ring forty thousand kilometers wide hung across the Moon as a set of
dark horizontal bands that read convincingly as a texture bug. The textures were
fine. There is an unmount effect now.

**Two tests were spawning ships underground.** Both landing tests placed the ship
relative to the _datum_, which is a sea-level convention with terrain either side
of it. They passed only because the generated planet they happened to land on had
low ground at that longitude; against the real Venus, whose terrain reaches
6.9 km, "hovering 30 m up" is nearly seven kilometers below the surface. They
spawn against `surfaceRadius` now. The hard-landing test also moved to an airless
body: Venus's surface air is 65 kg/m³ and 400 m/s becomes a few meters per second
long before the ground arrives, which is the drag model working and not what that
test is about.

**Phobos cannot be orbited.** Its sphere of influence is 7.2 km and its radius is
11.3 km, so there is no altitude above it that is still bound to it. Parking
there and being handed back to Mars is the correct outcome, `canHoldOrbit` is how
the harness and the test agree on which case they are in, and the test asserts
that at least one such body exists so the check cannot quietly stop testing it.

**The two-body parameter is `G(M + m)`.** The frame graph propagates a body
relative to its primary's center, and the relative orbit obeys `G(M+m)`, not
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
radii, and an aim (center, sunward horizon, or the specular point). The debug
orbit parks one radius up, where a planet fills a 65° view with a magnified 60°
cap of itself; that is why the continents looked too big. Blue Marble is a
~4.5-radii shot, and the bookmarks put the ship where the photographs were
taken. Placement is pure geometry in the body frame, property-tested; the first
implementation rotated about the pole and got the phase wrong whenever the sun
left the equatorial plane, which the exact-phase assertion caught. `engine.
showShip` hides the debug hardware, because a gray cone parked dead center
defeats the point of composing.

**Aerial perspective on the surface** (`render/planet.ts`). The atmosphere
shell only survives the depth test _outside_ the planet's silhouette, so
everything the air does in front of the ground has to happen in the surface
material: a blue lift at nadir thickening to a white-blue wash at the limb,
sunlight reddening near the terminator (keyed to geometric incidence — the
sun's altitude, not any hill's slope), and night lights dimmed under slant air.
This is the term that turned the disk from a map on a sphere into something
photographed through weather.

**Water is a material, not a color.** The ocean mask (normal-map alpha)
flattens the albedo 65% toward deep-ocean blue — the map's ocean is
bathymetry, which no photograph shows — and carries the sun-glint: two Blinn
lobes (core in a wide skirt, the wave field being in no map) under a Schlick
Fresnel, so the glint is a modest white spot under a high sun and a blown
white-gold sheet toward the limb, into the HDR headroom.

**The shell got density and a twilight ring** (`render/materials.ts`). Optical
depth is now weighted by an exponential of the altitude at the ray's closest
approach — clamped to the segment, so it degrades to the camera's own altitude
for a sky viewed from the ground — which replaced the hard-edged halo band with
a limb that thins by e-folds to space. Color comes from that depth: thin air
stays the zenith color, thick air whitens (multiple scattering), and dense air
near the terminator warms to the limb color, concentrated toward the sun's
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
the red aperture ring from the ISS sunset frame — strung on the sun→center
axis. Occlusion is analytic against the scene description rather than a depth
readback, which is what lets the flare fade smoothly and redden as the star
slides behind a limb; the math is pure and tested in Node. Ghosts fade when
they overlap the star's own image (a centered sun otherwise wears them as a
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
starfield — uses `CustomBlending` with the preset's color factors but alpha
factors `(Zero, One)`, so nothing additive touches dst alpha again. Silencing
alpha _without_ the opaque clear inverts the failure: additive color over
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
remembering: serializing the builds _without_ the memo made the kill
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

**Traveling to a star means the star** (21 Aug 2026). `goTo` with a system
designation used to arrive at `planets[0]`; it now parks in the _system_ frame
in a circular orbit of the star itself — eight stellar radii, where the disk
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
`ingest/textures.ts`, `render/planet.ts`). Two compounding artifacts, one
autopsy. Lossy WebP block-quantised the smooth slope fields: whole 8-pixel
rows of the Moon's green channel offset ±39 around neutral — bands of surface
tilted ~15°, invisible face-on, black latitude-parallel scratches under the
grazing light at every full-phase limb. Re-encoding losslessly then erased the
maps _entirely_: libwebp's lossless encoder "cleans" RGB under transparent
pixels, and the ocean mask lived in alpha — the Moon has no ocean, so its
alpha was 0 everywhere and its RGB went with it. The mask now rides the blue
channel (the shader reconstructs Z as √(1 − x² − y²), exact for a unit
normal), the maps ship as 3-channel lossless VP8L, and nothing in the pipeline
has opinions about a color channel. Measured: the Moon's worst adjacent-row
jump fell from 58.6 to 9.7, and what remains is terrain.

**Giants stopped wearing gaskets** (21 Aug 2026, `render/materials.ts`,
`SceneView`). The atmosphere shell was a sphere around an oblate planet: at
Saturn's 9.8% flattening the shell floated a tenth of a radius off each pole,
and the analytic "ground" — a sphere of the _equatorial_ radius — drew air
over ground the planet never fills, a detached gray ring around the whole
limb. Both ray endpoints are now mapped into a space stretched 1/flattening
along the spin axis, where the ellipsoid is the sphere the intersection math
assumes, and the mesh is scaled oblate to match. The density also gains a
`(1 − altitude)` factor so the shell ends by vanishing: the exponential alone
left ~1% at the ceiling, which the HDR canvas rendered as a hard hairline
ring.

**Giants got limb darkening, chroma and moving weather** (`render/planet.ts`,
tuning in `SceneView`). A deep atmosphere reflects from optical depth ~1, so
a grazing view sees higher, thinner, darker gas — `pow(μ, 0.55)` blended at
0.72 for giants, and the flat decal became a ball. The published maps are
near-true-color, paler than any released photograph; giants get the same
chroma stretch every press image has had (1.3 gas, 1.15 ice). And the bands
shear: a zonal-jet UV warp at the _real_ magnitudes (~110 m/s gas, ~400 m/s
ice) — invisible at 1×, visible differential rotation at high warp, exactly
like the real thing.

**Mapless rings are generated, not slabs** (`render/proceduralRings.ts`).
The opaque-white fallback drew Uranus's ring system as a cyan charcoal
compact disc four radii across. A mapless ring now gets a strip generated
from the owning body's kind, seeded from its address: ice giants get sparse
near-black threads with an ε-ring analog near the outer edge, gas giants a
banded sheet with gaps. The same strip feeds the ring slab and the
ring-shadow projection on the planet, so the shadow bands match the rings
that cast them; procedural strips keep their own grays (the body tint is what
dyed Uranus's threads cyan).

**The star has a surface** (`render/materials.ts`). Worley-noise granulation
— bright convection cells draining into dark intergranular lanes — over a
fractal mottling octave, churned by presentation time so a held star simmers
under warp; a chromosphere-orange warm-up at the limb. Visible because the
disk now _stops down_: at the authored radiance 8 every lane clips to the
tone ceiling and the surface work is one white circle, so `exposure` ramps
from 1 to 0.1 as the disk grows from 0.015 to 0.1 rad — a camera exposed for
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
`HazeLayer` (the zenith color _is_ the scattering spectrum; the limb color
tints the aerosol; `thickness` scales the column, calibrated so Earth's split
lands within a few percent of the real (0.046, 0.108, 0.265) optical depths).
The shader is a 12-sample march — two table reads per sample against spike
2's measured 256-sample/7.27 ms budget — compositing as L + T·background via
premultiplied custom blending, so night air genuinely dims the stars behind
it. Nothing asserts a color any more: the sunset ring is the table reddening
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
`apps/game/src/render/shipModels.ts` loads, recenters, yaws nose-to−Z and
scales each to true meters (the Enterprise-D is 642.5 m; render space is
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
  as the debug-cone fallback. The meter/foot/inch props slide out past the
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
sequence, chosen because a frame-analyzed reference exists for it: 2742 frames
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
  splines ran through beats tens of thousands of kilometers apart, and they
  diverged mid-segment by tens of kilometers — the flyby rendered as a dot on
  the wrong side of the sky. Scene A's ship is now offset beats, interpolated
  in offset space and added to the camera at sample time.
- **Never track a hull crossing meters from the lens.** Per-frame look-at
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
  eclipsed disk), each candidate's detour is checked for clearance against the
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
what a tracked bounding box gives you — a center and a width, and a width _is_
a range once the hull's length and the lens are known. Beats in this language
can be read straight off the analysis and diffed against it; the previous ones
were meters and resembled nothing in it. Range interpolates in **log** space:
an approach list spans four decades, and a Catmull-Rom over those knots in
meters overshoots through the camera and out the other side, which is why the
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
  rather than on the frame's center. It is new vocabulary
  (`CinematicEffects.spark`) and it is what the title emerges from.
- Every credit is centered at x ≈ 0.50. The per-credit centroids in the old
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
whole group on it left a total eclipse as an unlit disk on an empty starfield.
And the cinematic camera is a **cleaner lens** — `artifacts` scales the ghost
chain to 0.05 while a script is playing, because the reference's optics put a
warm ball beside a planet and nothing else, and three gray iris ghosts marching
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
  disk's center, which for a camera 1.2 radii up means the whole visible cap
  is past the terminator. Its key light and its sun sprite were placed
  independently. Staged against a real ephemeris you get one or the other, so
  the phase ramps instead: 78° at f125 where the cap is lit and the star is
  behind the lens, opening to 164° by f239 where the disk is the thin crescent
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
boundary's error _normalization_ and nothing else; recovery is a browser check.
The same test file also cannot render the perf tab, because `fakeEngine` is a
harness in a trench coat and `PerfPanel` reads `engine.metrics`.

### Before the first commit there was nothing on screen

`main.tsx` awaits the packed catalog — a generation input, so the world cannot
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
pointer keeps the old behavior exactly and a keyboard keeps its place — and a
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
scan for is the star, whose real color the canvas is already painting from the
same measurement. The tension is DESIGN.md's **One Accent Rule**: the proposal
was a second Named Rule beside it — chrome stays graphite plus one blue plus
four status hues, and _data_ may carry its own measured color, scoped to the
star glyph only so the Scarcity Rule holds at roughly six rows. It needs a
DESIGN.md amendment and a `TravelTarget` extension, and PRODUCT.md's "no
information by color alone" means provenance needs a glyph as well as a grade.

Separately, DESIGN.md already names the perf chart's budget rule at `#f87171`
(red-400) as drift that should converge on rose rather than spread, and the
plots encode "over budget" by stroke color alone.

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
  This is an argument for pointing panels at the store, not license to point
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

From a kilometer above a moon to a hundred light years. Interpolated linearly, a
fly-to spends 99.9% of its time in the last decade and reads as a teleport — the
same trap `screenRoutePosition` documents for a four-decade cinematic approach,
met again two orders larger. Every zoom is a multiply; every ease is over
`log(distance)` with `1 - exp(-dt/tau)`, so 30 Hz and 144 Hz agree.

**The zoom-out ceiling is absolute, not a multiple of the target's radius.** The
radius-relative version put Luna's at 0.003 ly and a star's at 0.3 ly, so "zoom
out until the neighboring stars appear" — the single most planetarium-shaped
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

- **Wheel normalization.** Chrome reports ~100 px per detent and Firefox reports
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
gives them the same props and the same stroke behavior: three moon phases, a
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
editing the catalog does not.

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
passed. Every finding was a runtime or behavioral defect, which is the useful
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
canceled gesture fires `pointercancel` and nothing else. And they disagreed
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
toggled, and `preventDefault` canceled the browser's focus move. With no
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
  `traveling` then stayed true for the rest of the session, which is the exact
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
the behavior is deliberate and documented in the case body, but the title and
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
and where `checking` and `offline` are two grays that must stay distinguishable.

The flight strip is the one surface where the **alpha** moved rather than the
ink: at `/75` its bottom line was 2.43:1 and the line above it cleared 4.5:1 by
0.01, so it went to `/85` and its four-line ladder was respaced onto
sky-300 / 200 / 300 / 400. `docs/design` had already sanctioned exactly this —
alpha is functional here and loses every argument against contrast.

**The worst offender was not in a panel at all.** Sky labels are drawn directly
onto the one thing in the frame guaranteed to be bright, and measured **2.07:1**
(SOL) and 1.59:1 (EARTH) against the disc. Discounting their text-shadow, the
fill color alone was **1.03:1**. A _selected_ label was worse — `sky-200` with
a sky-colored glow measured **1.16:1**, because a glow can only add brightness
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
  `index.css` already paints the native gutter in this system's colors.
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
center of the poster's black gradient with its ghost chain out over empty sky;
negated it is at +0.58 and the composition is a bright rim on the left, the star
clear of it two thirds across, and the anamorphic streak running the full width
under the type. `engine.flareArtifacts` is the new dial that lets the menu run a
near-clean lens — at 1.0 the red aperture ghost is a 260px hoop on the
paragraph.

**The catalog is measured from the camera.** `travelTargets` took the
_player's_ position, so in the planetarium — whose only verb is `look` — the
list opened at Alpha Centauri still ordered by distance from Earth: Sol's moons
at the top, and the star filling the frame reported as 4.4 ly away twenty rows
down. `targets({ origin: 'observer' })` centers the survey and the sort on
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
- The transport sat under the IR menu at the bottom center. It is at
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
worse catalog — and gained six named compositions; sky labels dropped the
boxed plate for a text halo and a fading leader, keeping a ground only on the
selected one; and `SwitchRow` puts its detail on a second line, because beside
the label it truncated to "Show the Ship the hull the …", which reads as a
rendering fault rather than as a hint.

**Two new invariants, both with a regression test behind them.** _An effect is
staging, so a script turns it on_ — `cutscene.test.ts` walks all 2,742 frames
and asserts `effects.corona` is 1 inside f240–356 and 0 everywhere else; and
_labels are title case in the source, the type step decides the case_.
`observatory.test.ts` guards the catalog's origin: after `ir.look('HIP71683')`
the player-centered listing still leads with Sol — the hull has not moved, which
is the mode's whole guarantee — and the observer-centered one leads with Alpha
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
`robots.txt`, `sitemap.xml` and `src/icons/brandmark.ts`. `pnpm brand:check`
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
symptom was a favicon two units off center, which reads as a rendering artifact
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
page and a boot message about a catalog before this.

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

**The service worker was never registering on a first visit, and that is older
than this change.** `main.tsx` awaits the packed catalog at module scope, and
that await resolves _after_ the load event — measured on a cold visit to a
review app: load at 761 ms, the 458 KB catalog at 969 ms. The registration was
inside `window.addEventListener('load', …)`, so it was a listener for an event
that had already been and gone.

It looked fine because a registration persists across visits: the _second_ visit
to an origin serves the catalog out of the HTTP cache, the await resolves
before load, and a worker is registered for good. What was broken was the first
visit to any origin — precisely the visit where "install it and it works on a
plane" has to be true. It surfaced now only because a review app is the one
origin nobody had ever opened twice. `document.readyState === 'complete'` is
checked first now.

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

## Documentation, one voice (23 Aug 2026)

The docs were rewritten so a human and an agent are not reading the same file
for different jobs.

- **Technical writing** lives under `docs/` — vision, architecture, concepts,
  ADRs, guides, the design bible. House voice is [`docs/STYLE.md`](docs/STYLE.md):
  American English, present tense, the fact first, session diary kept out.
- **Agents** have a handbook at [`docs/agents/`](docs/agents/README.md).
  [`AGENTS.md`](AGENTS.md) is the auto-loaded working card (invariants and
  definition of done). [`CLAUDE.md`](CLAUDE.md) is Claude Code machinery only.
- Toolchain facts moved from `CLAUDE.md` into
  [`docs/guides/development.md`](docs/guides/development.md). Client shell and
  cutscene authoring moved out of `AGENTS.md` into
  [`docs/guides/client.md`](docs/guides/client.md) and
  [`docs/guides/cinematics.md`](docs/guides/cinematics.md).
- British spelling in the docs was converted where it was safe. Identifiers,
  filenames (`catalogue.md`), and `cancelled()` are left for a later pass.

## The first look was the expensive one, so everything loads at boot (23 Aug 2026)

Measured (M-series, WebGPU, dev build, frames driven through R3F's `advance` so
an occluded window could not suspend the measurement): steady state was never
the problem — menu, planetarium and cinema all idled at p50 ≤ 0.8 ms of main
thread per frame, 3.04 ms of GPU at the heaviest view (Saturn, rings, moons,
22 draw calls / 530 k triangles), a locked 60 fps. Every stutter was a first
encounter. The first look at a cold body was one 98–119 ms frame — ~50 ms
atmosphere LUT bake, the rest material-graph construction, first-use pipeline
work and texture upload — followed by 6–16 ms frames as each surface map's
decode landed. Saturn arriving with seven moons clustered ~18 new material
instances into a single ~495 ms frame. A cross-system jump cost 77 ms (26 ms
of that is `loadSystem`'s synchronous generation, which remains). On the WebGL
fallback all of the pipeline half is synchronous program linking, which is why
Safari and Firefox stuttered hardest — confirmed by a hard hitch at `tng-intro`
f1085, the frame the warp quads first drew.

The shipped set is small enough to stop streaming: 19 maps / 14 bodies / 19 MB
compressed, a few hundred MB decoded. So boot now pays for everything, behind a
loading overlay, in `render/preload.ts`: every manifest texture fetched **and**
`initTexture`d (the upload is the other half of the stutter), every atmosphere
in the loaded systems baked (`render/preloadPlan.ts` recomputes `buildScene`'s
sunk-sphere ratio; `preloadPlan.test.ts` holds the two formulas together by
key equality — a one-rounding-step drift is a silent full cache miss), one
compile per body-material archetype, and the hull's converted materials via
the same promise `ShipModel` awaits.

Three things the obvious version of that gets wrong, all hit here:

- **An archetype twin does not warm an instance.** The backend builds shader
  source per material _instance_ before it can discover the pipeline is
  cached; with every texture, LUT and pipeline warm, Saturn's arrival still
  cost 88 ms of instance builds (~5 ms each). The fix is building the real
  instances ahead of need: `Bodies.tsx` now materializes every body of the
  loaded systems one per frame — compiled at creation, hidden after — which
  drains behind the boot overlay at startup and during the flight after a
  jump. `WarpFx` and `TerrainPatches` compile their own mounted instances the
  same way (terrain compiles both `transparent` variants, because the fade-in
  flips the flag and each is its own pipeline).
- **Three's pipeline cache is refcounted.** `Pipelines.delete` releases a
  pipeline at zero use, so disposing a warm-up material evicts exactly what
  was just compiled. The warm meshes are held for the session.
- **`compileAsync` walks visible objects only, and its traversal is
  synchronous.** Warm objects toggle visible around the call and never reach
  a drawn frame.

The overlay (`hud/BootOverlay.tsx`) continues `index.html`'s `#boot` corner
verbatim and fades only when two facts hold: the warm-up resolved, and pixels
provably presented. On WebGPU the second fact is the watchdog's probe
(`onPresented`, new). On WebGL that probe is a lie — `drawImage` of a WebGL
canvas without `preserveDrawingBuffer` may legally read back black between
frames, and gating on it left Firefox at "first light…" forever; two visible
rAFs are that backend's signal instead, and a watchdog that exhausts its
ladder now releases the fade rather than hide a possibly-fine scene forever.

After: first look at any shipped body is spike-free (worst main-thread frame
2.3 ms across a warm Saturn approach, zero frames over 8 ms), and the warp
reveal plays clean. One measurement trap worth keeping: driving frames
back-to-back through `advance` with no vsync produces 400–800 ms "main
thread" stalls that are really GPU queue backpressure — the instrumented
device showed zero shader modules, zero pipelines, zero uploads in those
frames. Pace with `queue.onSubmittedWorkDone()` before believing any number.

## American English in copy, comments, and docs (23 Aug 2026)

British spelling in user-facing copy, labels, comments, and documentation is
now American: _color_, _center_, _meter_, _catalog_, _behavior_, _license_,
_gray_, _artifact_, _toward_. Identifiers, panel ids (`catalogue`), JSON keys
(`licence`), enum values (`centre`), and filenames (`catalogue.md`) were left
alone for a later programmatic rename. [`docs/STYLE.md`](docs/STYLE.md)
already stated the policy; this pass applies it to the rest of the tree.

## Twelve shallow modules, deepened (23 Aug 2026)

[`REVIEW.md`](REVIEW.md) is the plan; this is what implementing it found. The
thread through all twelve is the same: a module was shallow because its
interface was `Env`, or a component, or a convention nobody owned — so the
behavior behind it could only be reached by running the whole application, and
every bug in it shipped.

**The Worker's media path had four fix commits and no test file.** Not for want
of trying: `media()` took `env: Env`, a whole workerd binding object, so nothing
could call it from Node. `serveMedia.ts` takes a `MediaStores` structural type
instead — three methods, restated rather than imported from the generated
workerd types, which is what lets a fake satisfy it. Seven tests, each a shipped
bug: the SPA fallback answering HTML with a 200, `env.ASSETS` ignoring `Range`,
the 304 with no body, the plain GET that must not be a 206, the 416 that needs a
second `head()` to name a length, that same `head()` failing too, and the HEAD
rule — which is now written once instead of on both the 200 and the 206 branch.

**The datum sphere was typed twice and agreed by luck.** `buildScene` computed
`max(radius * 0.9, radius - relief)` and the boot preloader computed
`max(radius * 0.9, radius - surface.maxElevation)`, and the two matched only
because `snapshot.ts` assigns one from the other — a three-hop identity nothing
asserted, whose failure mode is a silent full cache miss at boot. It is
`packages/rendering/src/datum.ts` now, called by both, and the guard is a
`fast-check` property rather than a test that built a `GameEngine` to compare
two six-line formulas. The property reaches the case the engine test could not:
relief above a tenth of the radius, where the clamp bites — no body in Sol comes
near it, so the clamp was typed twice and exercised never.

**One verdict on "is this the same universe?"** Two manifests — the generation
versions and the catalog version string — met in three places under three
disciplines: a comparator that had never heard of the catalog, a string
interpolation on a save's _failure_ path, and a caller that received both and
discarded them. `versionDrift` in `packages/protocol` is the one function all
three read. The handshake sends the catalog now; the save loader returns the
drift on **success**, which is the case that had nowhere to be reported — a save
whose catalog moved usually loads, and the only symptom is that a star is a few
light years from where it was. The Worker states its catalog version from
`data/catalog/manifest.json`, and `apps/headless/src/catalog.test.ts` holds that
manifest to the packed file beside it, because they are now read by different
things. `docs/roadmap.md`'s open square closes.

**`TravelTarget` dropped `catalogued`,** so a real star and an invented one
rendered identically — against a PRODUCT.md commitment — while `loaded`, a
streaming fact about this session, sat in the slot the epistemic fact belonged
in. One field forward, mapped to the domain word (`observed` / `projected`) at
the projection rather than carrying the storage boolean.

**`pnpm brand --check` never opened `index.html`,** which is the one artifact a
scraper parses and the only one nothing derives. `scripts/brand/checkHead.mjs`
is a check rather than a generator — generating the head was argued and
declined, and `build.mjs` records why it fights `pnpm format`. It holds the
title, the canonical, `theme-color`, `og:image` and the descriptions to
`src/site.ts`, holds every absolute URL to an allow-list of hosts, and holds
`sw.js`'s `PRECACHE` to files something actually ships. **Strip the comments
before extracting anything**: the head's own commentary quotes the tags it
explains, so the first `<title>` in the file is inside a comment, and the first
version of the checker read four hundred words of prose as the page title. The
tag _count_ is asserted too, because a regex extractor that stops seeing a tag
reports it as correct.

### The boot pair, and two bugs only the browser had

`warmup.ts` owns the compile-ahead recipe — make visible, `compileAsync`, put
the visibility back, swallow the rejection — which was written out three times
in the scene components, each making its own `as unknown as WebGPURenderer`
cast, each re-explaining in prose the measured fact that the backend builds
shader source per material _instance_. `rg 'as unknown as WebGPURenderer'
apps/game/src` now finds nothing. The second layer is the census: producers
register, and the progress total is the sum of what registered rather than the
running step's own count. Live, the status line reads `baking atmospheres
28/62` and then `building bodies 46/62` — 62 being every producer, and
`building bodies` being the per-instance drain that used to be invisible while
the line said "compiling the sky…".

Two things the Node tests could not have found, both found on the first boot:

- **StrictMode registers everything twice**, so `useState(() => trackAtMount(…))`
  returned a _second_ ticket the component never held and could never finish.
  Boot sat at `building bodies 62/62` with the cover up, forever. `register` and
  `track` are idempotent by label now — two producers with the same label are
  the same work, so the label is the identity.
- **The deadline burned against an occluded window.** Chrome suspends
  `requestAnimationFrame` entirely for one, so a frame-driven producer there is
  not stalled — it has not been given a single frame — and timing it out
  abandons the build-ahead for exactly the load with the most time to spare. The
  deadline only counts while `document.visibilityState === 'visible'`, which is
  the rule the presentation watchdog already followed.

`firstLight.ts` took the boot gate out of `App.tsx` — four `useState`s, five
effects, and a backend split that `presentationWatchdog.ts` documented and then
handed to its caller to enforce. "Provably presented" means a pixel probe on
WebGPU and two visible animation frames on WebGL, because `drawImage` of a WebGL
canvas without `preserveDrawingBuffer` may legally read back black; a module
that states an invariant it does not own is one edit from being untrue
elsewhere, which is how Firefox came to sit at "first light…" indefinitely. It
is a `PresentedSignal` with two adapters chosen by backend, inside the module.
`hasLitPixels` is exported and tested directly for the first time — including
the case its own comment warns about, a single lit pixel in a strip of empty
sky, which a downscaled thumbnail would average to black and "fix" by rebuilding
the renderer under a perfectly healthy starfield.

### The shell's reading side

The engine store's header always said panels should subscribe rather than be
handed props. Nothing did, because the snapshot carried two fields and every
panel needed a third — so the engine was read by four other mechanisms at four
rates: an 8 Hz sampler, `usePolled` at 6/4/3 Hz, bare `setInterval`s at 100 ms
and 250 ms, and raw animation-frame loops. `usePolled` is deleted. What is left
is two polls that are not field reads at all: the travel survey (a star sweep)
and the sky labels' projection (geometry over the camera and the viewport).

**The cutscene player was guessing.** `cutsceneStatus()` goes null for three
different reasons and the player reconstructed which from a half-second window
around the final frame — so `stopCutscene` from the console read as an ending,
because a stop near the end produces identical evidence, and the reopen undid
the stop within 100 ms. The director records how a scene left now
(`lastOutcome`: `ended` / `stopped` / `abandoned`), which is additive and leaves
`sample(frame)` exactly as pure as ADR-0010 requires. `cinema/session.ts` is the
one reader; three components polled it at three rates and each reached around it
into `world.clock.paused` for itself. `toggle` was implemented twice,
identically. The scrubber's drag latch stays in `useScrubber` — it is the
pointer — but what the latch _means_, that the published frame stands still,
moved to the session, because both transports needed the rule and neither owned
it.

**"Restored by whoever lowered it" was a convention with no owner.**
`GameEngine` named it; three modes implemented it three ways. The menu captured
and restored; the planetarium restored to hard-coded literals, so leaving it
after arriving from the menu put `showShip` back to `true` — a value it had
never held in that session; flight set and never restored, its own comment
calling it "belt and braces".

Designed twice, as the plan asked. A **mode-to-stance table** is tidier on paper
— the mode is already derived from the URL, so a table read by the frame loop
eliminates restore entirely, which fits ADR-0011 more tightly than anything
does. The deciding constraint is `NavPanel`'s in-planetarium ship toggle: a user
override on top of the mode's stance. The table needs a second channel for it
and then a rule for what happens to that channel on a mode change, which is a
restore rule wearing a hat. A **stack** gets it free — the toggle is another
push, and `release()` means "whatever was under me". Released by identity rather
than by position, because React interleaves one route's cleanup with the next
one's mount and popping the top would take somebody else's layer. The whole
round trip is a Node test with no React, no renderer and no world.

### Two the review caught

An `ultrareview` on the PR found two things the tests did not, both worth the
shape of the finding rather than just the fix.

**The end card was suppressed by an ordinary pause.** `dismissed` in
`cinema/session.ts` conflated two meanings — "hide the card that is showing"
and "suppress any future card" — because transport verbs set it and only `open`
cleared it. Pausing part way through a scene and carrying on therefore cost that
scene's ending its card, and with it the Replay button that lives there. The
same conflation had a second head: the reopen was guarded on the scene's _id_,
so a card that was dismissed and then played to the end again neither restored
the final frame nor came back. It is two states now — `carded` is whether a card
is up, raised by an ending and lowered by the person reading it; `handled` is
whether this session has reacted to the ending it can see, reset when a scene
starts, which is what lets one scene end twice and what bounds a reopen that
throws.

**A `useState` initializer is a factory, not a constructor.** `createFirstLight`
registered a `visibilitychange` listener on its way out, and it is called from
`useState(() => …)` — which StrictMode double-invokes. Two instances, two
listeners, and only the one React kept could remove its own, so every mount
cycle leaked a handler that dispatched a resize on each visibility change. The
same root cause as the boot census two sections up, arriving through a different
door: there the answer was idempotence, here it is that the factory does nothing
and `start()` returns its own teardown. Dev-only — StrictMode does not
double-invoke initializers in production — and worth fixing anyway, because the
rule had just been written down.

### Width, edges, and the measurement

`openSession` was accreting width: `presentation` and `onWorldReplaced` folded
into one `host` parameter — they are both the host's render side and always
travelled together — and, more to the point, the render answers are _named_
rather than spread. The spread landed last in the session object, so a stray
`world` key would have shadowed the getter the module exists to protect. That
bug class is unrepresentable now rather than commented against. `shipName` had
zero callers and is gone.

The service-worker registration was 36 untested lines beside a well-tested
worker, and it is where the shipped bug was: it listened for a `load` event that
had already fired, because `main.tsx` awaits the catalog at module scope and
that resolves _after_ load — measured on a cold review app at 761 ms and 969 ms.
The seam between "the page is ready" and "install the worker" was implicit in
module evaluation order, which is the thing that broke.

**The catalog index gate, measured.** The plan said to measure decode with and
without index construction before building. The answer is that the exact-name
index already existed — the decode loop calls `searchKeysFor` for every star —
so a _searchable_ one costs **0.18 ms** marginal, because the only extra work is
keeping the pairs instead of discarding all but the first. Decode is 22 ms for
7,123 stars; a query over all 16,537 keys is **0.14–0.30 ms**, which is
per-keystroke, and a 150 ly star sweep is not and never could be. Built eagerly,
parallel arrays rather than an array of pairs.

Splitting `find` from `search` bought something unplanned. `α Cen` is what gets
pasted out of Wikipedia and nothing could resolve it: dropping the superscript
keys `ζ¹ Reticuli` and `ζ² Reticuli` — two unrelated systems — to one string, so
the exact map cannot hold it without answering an ambiguous name arbitrarily.
That is a constraint on `find`, not on a search box, which should simply offer
both. The un-superscripted Bayer forms go into the search index and stay out of
the exact map. Gacrux, at 88.6 ly, is findable by name; under the old
survey-and-filter arrangement it was not merely hard to find but unexpressible.

## Five phone-shaped bugs, and the one that was not (23 Aug 2026)

Reported from an iPhone, mostly. Four of the five are about a viewport that is
not a desktop's; the first is about arithmetic, and it was reported as a fact
about two moons.

**Phobos and Deimos vibrated in their orbits, and nothing else did.** The
compression in `placeAt` is radial, so the point it is measured _from_ is the
one place in the image that stays honest — and that point was the render origin,
which is not the eye. The origin is ADR-0003's snapped grid point: it lags the
camera by up to `REBASE_THRESHOLD` and then jumps a whole 1024 m step to catch
up. Measuring compression from there gives every compressed body a parallax
error of `eyeOffset · (1/compressed − 1/true)`, and because the offset sawtooths
as the camera drives the rebase, so does the error.

The error is a fixed _angle_ whatever is being drawn, so what decided whether
anyone saw it was how big the object was on screen. Measured live, with the eye
2,045 m off the origin: Earth filling the frame was displaced by 0.0002× its own
angular radius; Mars, a point at 0.8 AU, by 0.57×; Mercury by 5.0×. From a
camera 25,000 km off Mars the two moons came out at 0.86× and 1.60× their own
radii, which is a body oscillating through more than its own width — and Mars
itself, in the same frame, by a millionth of its. Nothing about the bug was
about small bodies; everything about _noticing_ it was.

`placeAt` takes the eye in render space now, `buildScene` computes it once from
the same presentation eye the origin was maintained from, and the near-field
branch still returns the origin-relative offset unchanged so the datum sphere
and `terrainMesh.patchPlacement` cannot part company. The property is stated as
an angle rather than a coordinate, because the coordinate is deliberately a lie:
the drawn direction from the eye is the true direction from the eye, at any
separation. A second test says a rebase is a rigid translation and nothing else,
which is the deeper repair — the two mechanisms in ADR-0003 were not independent
while compression was measured from the origin, and could not be reasoned about
separately.

The eye had to become a _required_ argument rather than a defaulted one. A
default of `Vec.ZERO` is exactly the bug, silently, at whatever call site
forgets — and one call site outside `buildScene` does place geometry in the
compressed shell: the orbit traces, which have to be given the same eye or the
curve parts from the planet on it.

**The canvas stopped short of the screen on an installed PWA.** `viewport-fit`
was never set, so iOS insets the document by the safe areas and paints the
letterbox in the body's own color: black bands above and below a black sky, on
the one device where the app is full-screen. `viewport-fit=cover` fixes that and
creates the second half of the problem, which is that the insets then have to be
respected by hand.

They are spent in exactly one place. `index.css` names the four as `--safe-*`
and puts them on `.hud-layer` as its four **offsets**, which makes the layer the
containing block of every absolutely positioned piece of chrome in the interface
— so every readout, panel, dialog and menu is clear of the notch and the home
indicator without being told, including one written next year.

The first version of this used **padding** and was a no-op, which is worth
writing down because the reading behind it is the one every reference invites:
an absolutely positioned element does resolve `inset-0` against its ancestor's
_padding box_ — and the padding box's edge is the **outside** of the padding, not
the inside. Padding there shrinks a content box nothing in this layer uses and
moves nothing. The same trap is one level down in `hud-bleed`, whose padding
reaches an **in-flow** child only: the boot overlay's corner readout is
`flex items-end` plus a margin now rather than `absolute bottom-3 left-3`, which
would have resolved against the bled-out edge and sat on the home indicator
through the whole of boot. It was caught by review rather than by a test,
because the failure is a rectangle in a browser and every check in this
repository runs in Node — what did catch it, in the end, was overriding the four
custom properties in a live page and measuring the rectangles, which is a thing
worth doing again the next time one of these is written. Surfaces that are _picture_ rather than chrome opt back out with
`hud-bleed`, which offsets out and pads back in so its own children stay inside:
the cutscene blackout, the dialog scrim, the boot cover, and the transparent
surface a mode listens for drags on — that last one because a drag starting in
the 44 px a landscape phone keeps at each side is still a drag. The phone's nav
bar is the fifth case and takes `hud-bleed-bottom`, which bleeds the ground
without the padding, because the padding has to land on the row that draws it.

**Nothing is sized in `vh` or `vw` any more.** On iOS Safari `100vh` is the
height the page would have with the toolbars _hidden_, so a shell sized in it
runs a toolbar's worth of itself underneath the browser chrome — which is where
the bottom nav was ending up. The document is `100dvh` and `overflow: hidden` on
`html` and `body` both; inside `.hud-layer` a percentage now means "of the safe
area", which is what the `calc(100% − …)` caps became. `maximum-scale=1` because
this is a simulator with its own pinch gesture and the browser's own was racing
it, and `interactive-widget=resizes-content` so a soft keyboard cannot push a
fixed, unscrollable layout off screen.

**The pinch also spun the camera.** `useObserverInput` drove the orbit from the
centroid whatever the finger count was, which is right for a symmetric pinch —
both fingers moving apart equally leaves the centroid still — and wrong for the
pinch a thumb and forefinger actually make, which anchors one finger and moves
the other. That moves the centroid by half the travel, so a 200 px pinch also
swung the camera through half a radian at `DRAG_RADIANS_PER_PIXEL`. One finger
orbits; two or more zoom, and only zoom. Nothing is lost: this camera orbits a
target it cannot pan away from, so a two-finger drag never meant anything a
one-finger drag did not.

The decision moved into `gestures.ts` as `gestureStep`, beside the rest of the
gesture arithmetic, because that is the half that can be tested in Node — the
hook keeps only the bookkeeping a browser has. It also stopped calling
`getBoundingClientRect` on every `pointermove`: that forces a layout flush, once
per finger per frame, which on a phone at 120 Hz was 240 synchronous layouts a
second on top of the scene that was already the reason the gesture felt bad. The
surface cannot move under a gesture in a viewport that cannot scroll.

**The planetarium could fly inside a planet's atmosphere.**
`MIN_DISTANCE_RADII` was 1.02 — two percent of a radius of clearance, and
Titan's haze shell is drawn at **1.155 radii**: 400 km of tholin smog on a
2,575 km moon, which is what makes it a featureless orange ball in every
photograph before Cassini's radar. The camera could sit well inside that, and
level with Venus's shell and Earth's at ~1.016. That is the worst place this camera can be: the shell covers the
whole viewport, the march's near end clamps to zero so every pixel integrates
the full chord, and the picture is the inside of a ball of fog. A phone runs out
of fragment budget there first, which is how it was reported. It is 1.5 radii
now — a clearance from the air, from the altitude the terrain streamer starts
asking for patches at (about 1.011 radii), and from the framing below which the
planetarium is showing _less_ the closer it gets. The test states it over every
atmosphere in the model rather than over Titan alone, so vendoring a thicker one
fails there rather than in the renderer.

**The phone's bottom bar named the wrong thing.** The toggle that opens the
sheet took the open panel's title, so pressing a button marked _Panels_ left a
button marked _Catalog_ where it had been: a toggle whose label is the state it
produced rather than the thing it toggles, and no label anywhere for the way
back. It says "Panels" in both states now, with the chevron, the accent ground
and `aria-expanded` carrying open-versus-shut — which panel is open is answered
where the panel is. The sheet also grew the grabber every other sheet on the
platform has, and reopening returns to the panel that was last being read rather
than to `available[0]`, remembered for the mount and not persisted.

**What is guessed rather than measured.** The drawing buffer's pixel-ratio
ceiling is 1.5 on a coarse pointer against 2 elsewhere, and the argument for it
is sound — close to a planet the picture is three stacked, alpha-blended,
full-screen shells, blending defeats a tile-based GPU's hidden-surface removal,
and the atmosphere marches twelve samples with two table reads each — but the
number is a judgement, not a profile. `render/measure.ts` on the device is what
would turn it into one.

## The cloud image shipped Node 26 and forgot the rest (23 Aug 2026)

This morning's Cursor Cloud Dockerfile pinned Node 26.7 and pnpm 11, which is
the whole reason it exists — type stripping fails on the Node 20–22 images
Cursor otherwise ships. It did not install what Cursor actually runs _inside_
the container. A local `docker build` of that image is green and `node -v` is
right, so the next failures look like product bugs.

Three things were missing, each with a different symptom:

- **`tmux`.** `environment.json` starts `pnpm dev` as a named terminal. Those
  terminals run in a tmux session Cursor shares with the agent. The binary was
  not on the image.
- **`git-lfs`.** `*.glb` is LFS. Git itself is on `node:bookworm`, so clone
  succeeds; without the smudge filter the hull is a 133-byte pointer and the
  renderer silently falls back to the debug cone. `git lfs install --system`
  is what makes the checkout real.
- **`locales`.** `LANG` was empty and the locale was POSIX. Cursor's session
  init expects `en_US.UTF-8`; a custom image missing the `locales` package is
  a documented way to build successfully and then fail to open.

`xz-utils` was already on the fat bookworm image. It is declared anyway, next
to `git`, so a later `-slim` tag cannot drop them quietly. The image still
does not `COPY` the repository.

## Phobos and Deimos, still vibrating — and the clock was the second cause (23 Aug 2026)

The rebase-parallax fix on 22 Aug was real and is not the whole story. Both moons
still jittered, and the remaining cause was not in `packages/rendering` at all.

`SimulationClock.advance` capped time warp at `MAX_WARP_STEPS = 2048` ticks per
frame. Above about 1,920× that cap is always reached, so the clock ran 2048 ticks
— exactly 32 simulated seconds — on every frame regardless of whether the frame
took 14 ms or 19 ms, and dropped the rest. Simulated time therefore advanced per
_frame_ instead of per _second_, and frame-time noise became time-base noise:
±2 ms at 60 fps is ±12% of the delivered rate, every frame. The warp ladder is
`1, 5, 25, 100, 1000, 10000, 100000`, so both of the top two detents sat in that
regime permanently.

Why only two bodies. The visible amplitude is the time-base error times a body's
speed **in units of its own radius**, and that quantity is not close to uniform:

| Body      | v/R (own radii per second) |
| --------- | -------------------------- |
| Deimos    | 0.218                      |
| Phobos    | 0.190                      |
| Mimas     | 0.072                      |
| Enceladus | 0.050                      |
| Miranda   | 0.028                      |
| Io        | 0.0095                     |
| Luna      | 0.00059                    |

Measured in Node against the real clock and the real `buildScene`, camera 30,000
km from Mars, 60 fps with ±2 ms of jitter and one doubled frame in fifteen,
angular error against a local quadratic fit so genuine orbital curvature is not
counted, in units of each body's own angular radius:

| Body   | 1×     | 10,000× before | 10,000× after |
| ------ | ------ | -------------- | ------------- |
| Phobos | 3.3e-7 | 0.42           | 8.4e-4        |
| Deimos | 1.5e-6 | 0.42           | 8.9e-4        |
| Luna   | 3.6e-4 | 0.015          | 2.6e-5        |
| Mars   | 3.4e-8 | 2.4e-8         | 2.4e-8        |

At 1× nothing moves — the delivered rate is exact to 1.3e-14, and it always was.
The two smallest bodies in the model were being thrown most of a body width back
and forth at frame rate while everything around them held still, which is exactly
the report.

The fix is to make the warp ceiling a **rate** rather than a count:
`MAX_WARP_RATE = 1920` simulated seconds per wall second, spent as
`rate × this frame's duration`. A count fixes the delivery per frame; a rate
makes it proportional to the wall clock, which is the property the renderer
actually depends on. The 1× path is untouched and still a count — there the cap
is a stall guard, the frame has already gone wrong, and dropping the minute a
backgrounded tab was away is the honest answer rather than a throughput
question. Above 1× a frame longer than `MAX_WARP_FRAME = 100 ms` is likewise
treated as a stall, which keeps the rate honest down to 10 fps and bounds a
stalled frame's catch-up at 12,288 ticks (~10 ms of work at the 1.25M ticks/s
measured in-browser).

Confirmed in Chrome at 10,000× with the frame callback instrumented. Frame
durations ranged from 9.7 ms to 93.5 ms — a 9.6× spread — and the delivered rate
held between 1918.5× and 1920.0×, a spread of 0.078%. The same frames under the
old code would have run from 342× to 3,299×.

Two things are worth keeping from how long this took to find. The first is that
every determinism test passed throughout, and correctly: determinism is a claim
about state at a given tick, and this was a defect in how wall-clock time maps
onto ticks — a dimension the suite had no assertion in. The second is that
`droppedTicks` was reporting the fault loudly the whole time (39.8M of them in
the browser session above) and nothing connected a drop count to a visual
symptom.

## The moons of Mars were vibrating because the camera was a tick behind (23 Aug 2026)

Third attempt at this one, and the first two were both real bugs that were not
_the_ bug. Worth recording in that order, because the wrong turns are the useful
part.

The rebase-parallax fix (#12) was correct: compression must be measured from the
eye. The time-warp ceiling fix earlier today was correct: a saturated clock
delivered simulated time per frame rather than per second. Neither was what was
being reported, and the tell was there from the beginning — **it happened at 1×**,
where Phobos takes 7.65 hours to go round and is therefore, for rendering
purposes, standing still. A stationary object cannot be jittered by a defect in
how fast time runs. That should have ended the warp theory before it started.

The actual fault is one line. `Observatory.#targetPosition` asked

```ts
world.frames.pose(target.frame, world.clock.time).position
```

while `snapshot` places every body at `renderTime` — `time − (1 − alpha)·TICK`.
The camera was therefore anchored to the target's position _at the tick_, and the
target was drawn at a fractional instant up to one tick later. Worse than a fixed
offset: alpha sweeps 0→1 between ticks and resets, so the gap sawtooths, and at
60 fps against a 64 Hz tick it beats. The camera aimed at where the moon used to
be, by a different amount every frame.

Magnitude, and why only two bodies. The error is the target's **universe**
velocity times up to 15.6 ms — for anything riding Mars around the Sun, a flat
~377 m. What decides visibility is that distance in units of the body's own
radius, because the planetarium frames every subject to the same fraction of the
viewport:

| Body   | radius   | error / radius | vibration at 55% fill |
| ------ | -------- | -------------- | --------------------- |
| Deimos | 6.2 km   | 6.6%           | 19 px                 |
| Phobos | 11.3 km  | 3.5%           | 11 px                 |
| Mimas  | 198 km   | 0.2%           | 0.5 px                |
| Luna   | 1,737 km | 0.03%          | 0.11 px               |
| Mars   | 3,396 km | 0.01%          | 0.04 px               |

Measured by replaying `GameEngine.#step` headlessly and projecting through a
65° FOV at 1970 device px, framing each body in turn. After the fix every row is
**bit-exactly zero** — once both sides name the same instant the framing vector
is the constant standoff, so the projected position is identical frame to frame.

Confirmed in the real client through the path that was reported: Planetarium →
catalog → Phobos, 1×, drawn at 448 px of radius, real rAF frames from 1.2 ms to
47.3 ms. Worst standoff error 0.1 mm, which is 4e-6 px. The same geometry before
the fix: 377 m, 15 px.

`renderTime` now lives on `SimulationClock` rather than inside `snapshot`, which
is the actual repair — the arithmetic had exactly one writer and no _reader_, so
anything else wanting "now" for presentation found `clock.time` instead and took
it. `terrainStreamer` had already been bitten by this and carries a comment about
it ("terrain that disagrees with the ship about what time it is drifts from under
it by 800 m at orbital speed"); the cutscene director gets it right because it is
handed `shot.renderTime` explicitly. The observatory was the third consumer and
the one nobody wired up. It is now an invariant in `AGENTS.md`.

The test lesson is sharper than the code lesson. `observatory.test.ts` had
**two** assertions that the camera sits at its stated standoff, and both passed
throughout, because the helper they measured against — `originOf` — also asked at
`clock.time`. The test was wrong in exactly the way the code was wrong, so they
agreed, and the agreement read as confirmation. Both now say `renderTime`, and
both fail if the bug returns. The new test adds what neither could see: it runs
sixty frames so alpha wraps four times, because a single sample cannot detect a
sawtooth no matter which instant it asks about.

## The Cloud Agent that was supposed to rebuild from #15 did not (23 Aug 2026)

The test plan on #15 was: after merge, start a new Cloud Agent so it rebuilds
from the Dockerfile rather than from the previous snapshot, then confirm `pnpm
dev` is in tmux and `data/models/enterprise-d.glb` is a real GLB.

This agent is that follow-up. It booted from snapshot
`bld-20260823-8f2a6585-8181-4c0a-9ead-01cf98aad959` (`gitSetup: reuse`,
`warmFork: warm_fork`). That snapshot predates the merge. The first recurring
build after merge, `bld-20260823-6c5f7e0b-edef-414f-8924-32d1ecfaf161`, is
`SKIPPED`. So the new Dockerfile is on `main` and this pod is still the old
image.

Measured on this pod:

| Probe                          | Result                             |
| ------------------------------ | ---------------------------------- |
| `git-lfs`                      | not installed                      |
| `tmux`                         | not installed                      |
| `LANG` / locale                | empty / POSIX                      |
| `data/models/enterprise-d.glb` | 133-byte LFS pointer, `ASCII text` |
| Game and Worker terminal       | not running                        |

Node 26.7 and pnpm 11.22 are present — those were already on the image #15
amended. The three things #15 added are the three things still missing. A new
agent is not a rebuild when Cursor reuses a snapshot; the next green Build of
this environment is what would actually pick up the Dockerfile.

## The share card was a cyan marble (23 Aug 2026)

`scripts/brand/og.mjs` drew a sky-gradient disk with no surface. At 300 px —
the size a chat client actually shows — that disk is a glow, not a world, and
it does not look like the front door, which is Earth.

The card is still a drawing. A screenshot of `b:2` would be the honest picture
and the wrong artifact: it would move with the camera and it would need a GPU
in the build. Continents, clouds and a terminator that share one mask are how
a drawing reads as a world without becoming a second renderer.

Two things that look obvious and are wrong:

- **Darker land on the same hue is maria.** Sky-900 continents on a sky-700
  ocean read as craters. Land is slate-400, and it is painted _after_ the
  day-side wash, because the wash on top of land turns continents back into
  more cyan.
- **The anamorphic streak was behind the type panel.** The front door is
  composed around that blade of light; under an opaque panel it is a decoration
  on the planet. It is drawn after the type now, in the gap between the mark
  and the title.

`pnpm brand --check` still does not pixel-diff the PNG — sharp is not
byte-stable across versions. `og.test.mjs` holds the SVG: 1200×630, the same
markup twice, a seeded starfield of unequal dots, and the ids that would vanish
if a rewrite dropped the planet, the terminator mask or the streak.

## The title sequence measured again, and the ship flies straight lines (23 Aug 2026)

Planning the next fidelity pass over `tng-intro` produced three findings worth
more than the plan itself ([`TNG-PLAN.md`](TNG-PLAN.md)).

**The committed diff is the current diff.** The shot names in
`analysis/render-diff.csv` predate the last re-cut (`veil`, `eclipse-in/out`),
which made it look stale — so a fresh 2742-frame capture was taken
(`~/Developer/tng-inertial/.data/render2`) and re-diffed. Every per-shot number
came back identical. The names are just `compare_render.py`'s own reporting
buckets, which were never updated; the render had not changed since the last
loop. Verifying that cost six minutes and turned an assumption into a baseline.

**The reference ship flies straight lines and throttles.** Fitting 3D lines to
the measured screen tracks (positions recovered through the script's own lens
math): the cruise approach f676–896 is straight to 109 m over a 4.0 km path
(2.7%, a sixth of a hull length), the credit descent f1775–2100 to 134 m over
6.9 km (2.0%), and the wipe approach f1288–1316 to 19 m over 35.9 km — 0.05%,
a line to measurement precision. A _constant-velocity_ fit was tried first and
rejected by the reference's own numbers: f760 and f792 both measure w ≈ 0.40
(the hull holds range) before it rushes in, so speed varies while direction
does not. Only the skim f2180–2380 is genuinely curved (5.5% residual,
non-monotone advance). The staging consequence is in the plan: straight
`linePath` plus an advance profile, orientation derived from the line, authored
bank only where the reference maneuvers.

**The subject channel conflates lighting with geometry.** The single largest
defect in the current render is not choreography: the hull fails to register as
a bright mass for ~215 frames of the credit descent (f1770–1984) and at the
wipe entries, while the reference keeps a lit, readable ship at w 0.06. Until
that is fixed, subject-width errors in those bands measure the _lit region_,
not the hull — the close-pass band's dw −0.19 and the late descent's dw −0.43
are part geometry, part key. Fix the light first, then trust the channel. The
same capture pinned the warp-outs as a staging difference, not an intensity
one: at f2397 the reference still shows the hull at w 0.68 mid-streak; the
render has hurled it to a dot and drawn a lens line where a stretching ship
should be.

## The plan met the frames, and half of it was wrong (23 Aug 2026)

[`TNG-PLAN.md`](TNG-PLAN.md) was written from measurements and then implemented
against the same frames. Its timings and its structure held. A good deal of its
_causation_ did not, and the corrections are worth more than the work they
interrupted — they are collected in the plan's own §10 and summarized here.

**The instrument was reading the wrong thing, in three separate places.**
`compare_render.py`'s subject box is truncated wherever it touches a frame edge,
saturated wherever the subject fills the frame — 84 frames of the close pass sit
at w ≥ 0.995 against all four edges — and inflated wherever a second lit
component crosses its 400-pixel floor, which is the whole of the f752 → f754 →
f756 width step that looked like closing and was a filter threshold. In those
bands its width is not a range. What survives all three is a rigid landmark on
the subject: the pair of Bussard collectors, 265.5 m apart, whose separation is
immune to clipping and whose centroids are immune to glow. Every refit beat in
this pass is measured on that channel and spliced to the box only where the box
is interior.

The same class of error produced the plan's Earth "contradiction". Its claim
that the reference is physically self-contradictory — sun in frame beside a
broadly lit planet — rested on a 7.2° sun-to-limb clearance measured to the lit
mask's bounding-box _corner_, which sits at mid height rather than on the limb.
Fitting the visible limb as a cone gives 16.7°, recovers the standoff on every
frame instead of the one unclipped one, and predicts the reference's own frame
luminance to ±2.6 across f140–200. There was nothing to stage around. The shot
is now derived — fix the star's mark and the disk's and the phase follows — and
its orientation error fell from 50.3° to 12.7°, its limb from 0.056 to 0.013,
with the star inside 0.010 of its measured mark where it used to be off-frame.

**And §4's line fits were fits to the script's own beats.** Refitting them
against the reference gives a cruise path of ~730 m rather than 4.0 km at a 9.5%
residual, a descent of ~800 m rather than 6.9 km at 5.0% and strictly monotone,
a wipe of ~9.5 km at **0.13%** — and a skim that is not measurable at all, 217
of its 282 frames saturated and 273 touching an edge. So the plan's instruction
to prove `linePath` on the cruise "because it is already near-perfect" is
backwards; the wipe is the clean case by two orders of magnitude.

**Orientation was the largest single defect and nobody had measured it.** The
credit descent's hull was authored at `vec3(-0.02, 0.30, 0.95)` and fits
`vec3(-0.039, -0.605, 0.796)` — 57° out, with the wrong sign in y. The hull
descended 0.6 of the frame over 340 frames with its nose tipped up: flying
backwards down its own track, which is exactly the "sliding" the plan describes
and which no channel in the diff could see. The cruise was 24° out and the wipes
were authored nose-down where all three fit level to within 0.22° of each other.
Fitted directions replace them, and `withAttitude` carries the two places the
attitude genuinely differs from the flight path — a nose-down cruise, and the
banks the reference really does roll.

**Fixing the attitude moved the lighting bug into view.** With the hull pointing
the right way, the credit descent's camera sits on the face the star lights, and
the "camera underneath the key" defect a fill rig was being built for turned out
to be an artifact of the wrong attitude. What was left was smaller and worse:
`CameraRig`'s fill light had been a hardcoded world-space constant
`[0.4, 1, 0.8]` while `SceneView`'s comment called it camera-mounted, for its
whole life. Whether the near field was readable came down to which way a shot
happened to face. Aimed — back down the lens minus 0.85 of the key, so its `N·L`
is negative wherever the key already reaches and positive only where it does not
— it is provably a no-op on anything already lit, and 205 missing hull frames
became 4.

**Two smaller findings of the same shape.** The mirrored fly-through wipe's
offset is **126, not 128**: reference against reference, mirrored in x, the
second wipe's boxes agree with the first's to a thousandth on every frame at 126
and are two frames early at 128 — a perfect mirror on the wrong beat, which
reads as a bad mirror. And the titles shot had **no warp-out beats at all**:
from the f1092 cut the hull held at the first wipe's entry knot, a 0.012-wide
dot, and did not move for twenty-six frames, because `SHIP_CRUISE`'s exit beats
belong to a shot that has already ended.

**The camera was inside the ship, and no channel could see it.** Through the
skim the beats put the camera 125–170 m from the hull's origin — inside a
saucer 467 m across. Decoding the glTF's vertex positions in Node and reducing
them to a per-column height field in hull axes puts it _within the surface
envelope_ for forty-eight frames, f2234–2281, by up to 3.5 m, and within a
meter either side of that; at f2188 the shot is the inside of the saucer with
the engineering hull's battle bridge showing through the plating. The reference
diff is structurally blind to this — its subject channel scores the largest lit
mass, and an interior wall is a large lit mass — so it was found by eye and is
now held by `apps/headless/src/hullClearance.test.ts`, which walks every frame
the hull is on stage and asserts 15 m of daylight. Deliberately a test rather
than a runtime clamp: a director that quietly pushed the camera out would make
an authoring mistake invisible. The skim's ranges open from 125–170 m to
190–220 m, which is the least that clears it, and a knot at f2355 stops a
log-range spline undershoot that had put the camera back within 11 m of the rim
in the middle of a stretch whose authored knots were all clear.

**Read the signed table, not the mean-absolute one.** Two large errors of
opposite sign average to a small one. The Saturn pass scored a respectable +3.1
of exposure error across f413–470 while running −26.5 through its entry and
+18.7 through its exit: the whole pass was arriving eight frames late and then
not leaving. Re-fit as a flyby — closest approach 2.4 radii at f425, a straight
line at a varying throttle, 0.17 radii per frame closing and 0.09 opening — it
now runs −14.4 and −1.1. The residual entry error is physics: Saturn is at 9.5
AU against Jupiter's 5.2 and receives 30% of the light, while the reference lit
its Saturn like its Jupiter.

**Clipped is not bright, it is shapeless.** The eclipse corona was driven so
hard its ring saturated at 250 of 255 and read as a uniform cream annulus out to
the quad's edge; metered down and given a sunward bias that vanishes at
alignment, its window went from +29.8 of exposure error to +4.6. Both warp
flashes were the same story and had the same fix, plus one the titles already
knew: f1085 and f2382 are _threshold crossings_, not the frames the light
begins, so the envelope now opens before its start frame and its top is round
rather than flat — a constant carries nothing for a host to shape.

## The ship warped out twice, and a review found it (23 Aug 2026)

The fidelity pass shipped with three defects its own tests could not see, and a
`/code-review` pass over the branch is what surfaced them. Two share a cause
worth writing down, and it is now an invariant.

**A shot's exit beats are not dead.** `SHIP_CRUISE` carried three beats past
f1091 — the shot's last frame — hurling the hull to `atWidth(0.0008)` by f1120,
on the reasoning that a shot that has ended cannot render them. It does not
render them; it renders the segment they _shape_. A Catmull-Rom reads the knot
past a segment's far end to set its tangent, so those beats flew an entire
warp-out across f1080–1091 while `cruise-close` was still on screen: 431.9 m and
w 1.010 at f1080, 17.4 km and w 0.025 by f1091 — with `effects.flash` at 0.009,
so it happened in the clear — and then the titles stage's own f1092 knot put the
hull back at 568.0 m, thirty times larger, in one frame. Two warp-outs twelve
frames apart. It is one handover knot now, repeating `WARP_OUT_1`'s own f1092
entry, and f1076–1092 is the continuous recede the reference measures. The two
shots share the knot: change one and change the other.

**And the same cut had no attitude carried across it.** `routeOrientation`
holds its first beat before that beat's frame, so a `FACING_TITLES` beginning at
f1280 pinned the now-visible warp-out hull to the _wipes'_ fitted heading, which
points back down the lens. The attitude snapped 164.40° in the single frame
f1091→f1092 — 0.32°/frame either side of it — and the nose then sat 146.1° off
its own velocity at f1092 on a hull 0.768 of the frame wide. The ship flew
tail-first out of its own warp point, which is the defect the pass before it
existed to remove, one shot along. Its first two beats are `FACING_CRUISE`'s
last two verbatim; slerp is segment-local, so the two lists agree exactly over
f1035–1120 and the worst swing across the handover is now 0.350°/frame.

Neither was visible to anything. The chord test never samples the warp-out, and
the 2°/frame swing test excludes [1085, 1125] as an authored maneuver — the
exclusion that was covering it. `cutscene.test.ts` now asserts the handover
directly, in both channels, and the assertion names the frame: reverting the
script fails it with "cruise exit opens 47.54%/frame at f1085".

**The hull height field aliased outside ±32.8 km.** `hullField`'s packed column
key, `(floor(x/cell)+4096)*8192 + floor(z/cell)+4096`, is injective only for
|x|,|z| under 32.8 km, and the clearance sweep queries it with camera positions
up to 968 km out in hull axes. Against the shipped `enterprise-d.glb`,
`depthInside({z: 65536})` returned +32.77 — "the camera is 32.8 m inside the
hull" — for a point 65.5 km astern. 39 frames of the current sweep already fall
outside the key's domain; the test passed only because no aliased key happened
to land on an occupied column. `columnKey()` returns null outside its domain
now, and the test asserts far-field points read clear. The clearance test also
passed vacuously when the sweep found no frame at all — `-Infinity` satisfies
`toBeLessThan(-15)` — and now asserts it staged some.

Smaller, same review: `normalize` of the zero vector wrote a NaN into the
framebuffer at the exact center of the eclipse corona (`mix(1, NaN, 0)` is NaN,
so perfect alignment did not save it, and additive blend put it on screen);
`cutscenePeek` answered from a world the host had already replaced, because it
was copied from `sample`'s preamble minus the world-identity check; and the
warp stretch rasterized 13–24% of the frame with additive blend for ~2,600
frames it should have been invisible for.

And CI went red on the one finding the review had deferred as a policy call.
`hullClearance.test.ts` is the first test here to read git-lfs content, and
`.github/workflows/check.yml` checked out with `actions/checkout@v5` and no
`lfs: true` — so `enterprise-d.glb` arrived as a 130-byte pointer, `readHullField`
threw "is not a binary glTF" while vitest was still collecting, and the run
reported one failed _suite_ with no test names. The policy call is fail, not
skip: the asset is in the repo and the invariant is the whole point of the file,
so a skip would leave "a scripted camera clears the prop it stages" unchecked in
the only place it is checked automatically. Three things changed. The workflow
fetches LFS. `readHullField` recognizes a pointer and says `run \`git lfs pull\``rather than blaming the model, the courtesy`ingest/sources.ts`already extends
to a pointer served over HTTP. And the decode moved out of the`describe` body
behind a memo, so a missing asset fails three named tests instead of erasing the
suite.

The quieter half is the build. `shipModels.ts` pulls the hull in through
`import.meta.glob`, so `pnpm build` bundles whatever is on disk and Vite does not
care whether it is a glTF — a pointer checkout produces a _green_ build that
ships a 130-byte file where the hero ship should be. This is the second time LFS
has cost something: 6dea1c7 fixed the same gap in the Cloud Agent image, where
the symptom was the renderer silently falling back to the debug cone. Every
environment that checks this repository out needs the smudge filter, and the
failure looks different in each one — GitHub Actions threw during test
collection, and Workers Builds, which `vite.config.ts` already reads
`WORKERS_CI_COMMIT_SHA` from, would not have complained at all. So rather than
fix them one CI at a time, the build itself now declines: a `buildStart` hook
reads the first four bytes of every `data/models/*.glb` and fails unless they
are the ASCII magic `glTF`. Verified by building against a pointer — the build
stops and names `git lfs pull`. Production was checked and is unaffected: the
deployed `enterprise-d-ByumsAL0.glb` begins `glTF` and its length field reads
13,928,924, matching the local asset byte for byte.

Two things were left as they are, deliberately. `warpFlashEnvelope` still has a
flat top — `min` of two saturating smoothsteps is exactly 1.0 for t in
[5.5, 9] — which three comments and a test title claim it does not; reshaping it
moves output this pass tuned against the reference, so the comments were
corrected to the truth instead. And `hullWidth` divides by the live
`camera.aspect` while every threshold around it was metered at 16:9, so the
stretch's on and off frames move with the window's shape. That one is a real
reproducibility hole in a pipeline built on reference diffs, and it is a design
change rather than a repair.

## The share card stopped being a drawing (24 Aug 2026)

Yesterday's entry above ends "the card is still a drawing," with the reasoning
that a screenshot would need a GPU in the build and would produce a different
picture every regeneration. Both halves of that are true and neither is an
argument about the _picture_ — they are arguments about the _build_. A frame
captured once and committed answers both: `design/brand/og-plate.png` sits
beside `brandmark.svg` as the second thing the brand is drawn from, `sharp`
composites the type over it, and re-shooting it is a deliberate commit rather
than a build step. The drawing it replaced was six bezier continents and a
hand-built anamorphic blade, and at 300 px it read as grey amoebas on a blue
ball.

**The plate is a real orbital sunrise, not a beauty pass.** Earth at 1.16 body
radii (~1020 km), phase 95° so the ground under the camera is at dusk, rolled
6° so the limb climbs to the right and leaves the type column open sky. The
star is aimed to (0.865, 0.205) of the frame, which puts its streak above the
wordmark where the old drawn blade was. Captured at 3200×1680 and reduced to
1200×630 — the reduction is the only antialiasing the limb gets, and at 1× the
terminator stairsteps.

**Shot at `flareArtifacts = 0.35`, which is the menu's stance and not the
flight camera's.** `GameEngine.flareArtifacts` already documents why: the
ghosts march along the line from the star through frame centre, so a star on
the right of a poster puts the red aperture ring squarely on the paragraph on
the left. The first plate was shot at 1 and had a 150 px hoop behind the rule.
The value that was already correct for the front door was already correct for
the front door's photograph.

Three things about compositing type over a photograph rather than over a
drawing:

- **A partial rectangle has an edge.** The bottom-left scrim started as a
  vertical gradient inside a 672-wide box, and the box's right side was a
  straight vertical seam running down through the terminator. It is a radial
  that reaches zero before it reaches anything, painted across the whole
  canvas.
- **The scrim can be nearly nothing, because the framing did the work.** The
  drawn card needed a slab across 78% of the width to have anywhere to set
  type; this one ends at 68% and never reaches opaque, because the plate was
  framed with the column empty. A slab wide enough to cover the old planet
  would erase the sunrise.
- **The streak is the render's now.** Drawing a second one on top would be two
  blades of light from one star.

`pnpm brand --check` still does not pixel-diff the PNG. `og.test.mjs` holds the
overlay — 1200×630, the same markup twice, the scrim and floor ids, and the
assertion that the scrim's last stop is transparent and no stop is opaque,
which is the slab creeping back. It also reads the plate's IHDR and asserts it
is exactly the size the card is composited at, which is the one thing about a
captured frame a test in Node can know.

## 25 Aug — the Solar System stops being eight planets, and the renderer stops drawing spheres

Sol had eight planets and twenty moons. It has **129 bodies**: nine dwarf
planets, fifty asteroids and comets, and forty-two more moons — twenty-one of the
planets' that are rocks, and twenty-one going round something that is not a
planet — on top of what was there. Ninety-two of them are not spheroids,
twenty-five of those carry a **measured shape model**, and the renderer had to
learn what a shape is.
[ADR-0013](docs/adr/0013-measured-figures.md) is the decision; this is what it
cost and what it found.

### The reference is fetched and committed, and it is what caught the typos

`packages/universe/src/solar/` is a hand-transcribed table of about fourteen
hundred numbers. A table that size has typos in it — that is not a worry, it is
the base rate — and a transposed digit in a semi-major axis produces a Solar
System that runs, renders, and is wrong until somebody looks up Deimos.

So `pnpm solar:fetch` writes `data/reference/solar-system.json` straight out of
JPL: the planetary and satellite tables from Solar System Dynamics, and one
Small-Body Database query per asteroid and comet. It is _committed_ rather than
fetched at test time, because a test that reaches the network fails on a plane
and a reference that changes between two runs of one commit is not a reference.
`apps/headless/src/solarSystem.test.ts` builds Sol through the engine and checks
it row by row — **297 assertions**.

Half of what it compares is _derived rather than stored_, which is what makes it
worth more than a diff of two tables. The engine does not store an orbital
period; it computes one from `G(M+m)` and the semi-major axis. Matching JPL's
published period to four figures says the axis is right, the Sun's mass is right,
the body's mass is right and `orbitalPeriod` is right, in one assertion, because
there is no way for two of those to be wrong and still produce it.

What it found, in the order it found it:

- **Mercury's radius was the mean, not the equatorial.** 2,439.7 against JPL's
  2,440.53. 830 m, on the field whose contract is the equatorial radius and
  whose neighbors in the same file are all equatorial.
- **Deimos's mass was 2.4% high** — an older value than the GM the MAR097
  ephemeris fit gives.
- **Nix's and Hydra's masses were double.** JPL's GM for both is small and badly
  constrained; the literature values that were transcribed are not the same
  numbers.
- **The ingest's own cell parser read `n/a PLU060` as sixty.** Styx and Kerberos
  have no measured GM and the cell says so and then names the ephemeris; a regex
  hunting for digits finds the `060` and reports a five-kilometer moon's
  gravitational parameter as half Charon's. Nereid's GM cell is a literal
  `0.00000`, which is JPL writing "unmeasured" in a numeric column. Both are
  fixed by taking the _first token_ rather than the first thing that looks like a
  number.

And four disagreements that are not errors, each named in the test with its
citation rather than tolerated by a loose bound:

- **Eros is `34.4 × 11.2 × 11.2` km as an ellipsoid and 35.1 × 17.2 × 12.1 as a
  bounding box.** Both are right; the body is bent like a banana. The shape
  model is what the game draws, so it is what the data file carries, and the
  check that keeps it honest is the volume — which agrees to 1%.
- **Haumea is 715 km to Spitzer and 798 to the 2017 occultation.** Two
  measurements, and the newer one is used.
- **Hartley 2 is 1.6 km in SBDB and 1.16 to EPOXI**, which flew past it.
- **Pluto's four small moons come out 6 to 10% slow.** They orbit the
  Pluto–Charon barycentre and the engine is a patched-conic hierarchy that
  propagates them about Pluto alone, so `sqrt(1 + M_Charon/M_Pluto)` = 5.9% of it
  is the engine's and the rest is a resonant six-body system that a two-body
  relation describes to a few percent whoever computes it. The test asserts the
  _sign_ and a bound, and says which part is whose.

### The comets broke the Kepler solver, silently

Nothing in the game had an orbit more eccentric than 0.95 until C/2020 F3
(NEOWISE) arrived at **0.99913**. Newton–Raphson from a Danby guess diverges
above about 0.999 — the derivative `1 − e·cos E` goes to a thousandth near
periapsis, the first step overshoots by three orders of magnitude, and the loop
returns whatever it has after thirty passes.

Measured: residual 8.9e-16 up to e = 0.995 and **1.5 radians** at 0.9991. Not a
slightly wrong answer; a body on the wrong side of the Sun, with nothing to say
it had failed. `solveKepler` now falls back to a bracketed solve — `f` is
strictly increasing on `[0, 2π]` so the root is always bracketed by the interval
itself, and a Newton step that leaves the bracket is replaced by a bisection.
Reached only where the fast path already gave up, so every orbit that solved
before solves identically. The property test's bound went from 0.95 to 0.9999.

### Twenty-five shape models, and the star-shaped question

`pnpm shapes:build` pulls from the PDS Small Bodies Node — Thomas's satellite
grids, Stooke's small-body atlas, Gaskell's stereophotoclinometry, the radar
inversions, and the OSIRIS-REx SPC model of Bennu at 6.32 m — and resamples each
to a latitude/longitude grid of radii. 937 KB for the set.

The representation cannot hold an overhang, so the ingest **measures** whether it
had to: it computes the reconstructed volume and compares it against the source
mesh's own, and refuses anything outside ±6%. Every one of the twenty-five came
back between 99.8% and 100.6%, **including Kleopatra**, whose waist is a saddle
rather than a roof. A dog bone is star-shaped about its own centroid, which was
the open question and is now a number.

Two bugs the volume check found on the way:

- **Longitude 0 extrapolated backwards across the whole table.** The interval
  search used `<=` at the low end, so the output's first column — which is
  longitude 0, which is the axis's first sample — took the wrap branch and
  interpolated with `t = −119`. Every body came out with one meridian several
  times its own radius long. The check saw it; the eye would have read it as a
  shape model of something else.
- **The reported half-extents were the equatorial maximum, twice.** `shapeExtent`
  computed the largest radius in the equatorial plane and the largest along the
  pole, then reported three axes as `[eq, eq, polar]` — so no body ever had a
  distinct intermediate axis and Eros came out 17.6 × 17.6 × 6.1.

Measured against JPL afterwards, the reconstructions land: Phobos's
volume-equivalent radius is 11.115 km against a published 11.08, Epimetheus's is
58.32 against 58.2, Amalthea's 81.8 against 83.5.

### The generated case is the same case

A body with a `figure` and no model gets a radius grid out of its own address
seed, on its measured half-extents, through the same mesh builder. That is what
makes the change reach the rest of the galaxy rather than just Sol: generated
moons below 200 km — which is most of them, the mass draw runs from 10¹⁸ kg —
are now rocks, and generated systems have belts.

Both distributions are measured rather than chosen, off the twenty-five models:

```
                                     min    median      max
  b / a                             0.43      0.74     0.99
  c / b                             0.71      0.87     1.00
  rms(r) about the fitted           0.023     0.090    0.61
    ellipsoid, over the mean
```

The one clear trend is the threshold. The two bodies above 200 km — Vesta and
Proteus — have `a/c` of 1.21 and 1.09; everything below is scattered from 1.05
(Mathilde, a ball) to 2.89 (Eros) with no strong size dependence inside the
range. So the model is a threshold plus a spread rather than a formula. A tidy
monotonic function of radius would fit the data worse and look more scientific.

**The noise had to be calibrated to mean what it said.** Asked for 0.18 it
delivered 0.03, because an fBm's standard deviation is a sixth of its range and
nothing divided it out — every generated small body in the galaxy was a very
slightly dented ball. The displacement is now log-normal about a measured
`NOISE_SIGMA` of 0.167, clamped to an exponent range that caps the max/min
radius ratio at 4.5 (Ida, the worst measured, is 9.4 — the rest of that comes
from the half-extents, which is where a body that shape gets it from anyway).

### A belt in every system

Generated systems had planets and moons and nothing else — a tidy diagram of a
system rather than a system. They now get six to eighteen small bodies, and three
things about them are measured:

- **The size ladder is Dohnanyi's**, sampled from the top. `dN/dD ∝ D^-3.5`
  means the k-th largest goes as `k^-0.4`, so a belt is parameterized by its
  largest member rather than its smallest. Drawing fourteen bodies at random from
  a Dohnanyi population gives fourteen kilometer-sized rocks, which is correct
  and useless.
- **The spin barrier is real and is the floor.** `T = sqrt(3π/Gρ)` — 2.13 h at
  an asteroid's density, 4.26 h at a comet's. Across 300 generated systems,
  **the only body in the game below its own barrier is 1998 KY26**, which is real
  and is the textbook exception: eleven meters across, below the size where
  cohesion stops mattering, turning once every 5.4 minutes.
- **The composition gradient is the frost line.** Inner-belt bodies are S-type
  at a fifth reflectance, outer ones C- and D-type at a twentieth, and the
  transition is where volatiles survive.

`SYSTEM_ALGORITHM` went to 3. Nothing a save could already point at moved —
that is what issue ordinals are for — but a system contains things it did not.

### What the renderer had to be told

Three changes, and only one of them is in the draw loop.

- **`Bodies.tsx` branches once.** A body with no `figure` is drawn exactly as it
  was: a unit sphere, squashed by `flattening`. A body with one takes a mesh from
  `shapeModels.ts` and scales by a single number, because the mesh already
  carries all three half-extents. Applying `flattening` on top would squash it a
  second time by a ratio the geometry has already spent.
- **`MAX_BODIES` went from 64 to 160.** The cap counts every visual, and the
  star takes one: Sol was 29 and is 130. At 64 the arrivals past the cap
  silently stopped rendering.
- **Orbit traces learned what rubble is.** The planetarium drew a subject's
  siblings for context, which was eight ellipses and became a hundred and
  twenty-nine lines with Bennu somewhere behind them. `OrbitPath` gained a
  `kind`; a small body's orbit is drawn when it _is_ the subject or goes round
  it, and the planets stay because "where is this relative to the planets" is
  the question a planetarium exists to answer.

### The photometry, measured in the planetarium

The first pass made the dark bodies too bright, and the measurement is the
interesting part. The tint for a body with no map was `0.18 + 1.6·p`, which is a
guess, and it compresses a 6-to-1 range of real albedos into 2.3-to-1 of rendered
brightness. Shot at matched framing against the Moon, whose map is real and whose
rendering is the reference at sRGB 83:

| body     | geometric albedo | before | after |
| -------- | ---------------- | ------ | ----- |
| Deimos   | 0.068            | 155    | 71    |
| Phobos   | 0.071            | 147    | 97    |
| Amalthea | 0.090            | 85     | 63    |

Deimos was rendering _twice as bright as the Moon_ at half its albedo. It is now
the physical relation — a geometric albedo `p` comes from a Lambert reflectance
of `1.5 p`, on a hue normalized to its brightest channel so the color is not
multiplied in twice. Phobos additionally needed its tint halved because the Mars
Express SRC mosaic is a contrast-stretched product: its mean linear luminance is
0.30, about the same as the Moon's LRO map, on a body with half the Moon's
albedo.

**Nothing in `bodies.ts` above the small bodies was touched.** The eight planets
and the twenty original moons render exactly as they did.

The other half is an _exposure_, and it has a precedent in this file. The star
material already stops **down** as a star fills the frame — "a sun that fills the
frame is exposed for its surface, not for the scene it lights". A body reflecting
4.4% of the light that reaches it is the same decision at the other end: a camera
that spends a minute looking at Bennu from five hundred meters adapts to it, and
a renderer with one exposure for the whole scene cannot. `adaptationFor` in
`Bodies.tsx` opens `albedoScale` up toward a 0.12 target, scaled by how much of
the frame the body covers, and **returns exactly 1 above 0.12 geometric albedo**
— which is below Mercury at 0.142 and the Moon at 0.136, so no planet and no
major moon ever sees anything but 1. Bennu's boulder field is legible at close
range and it is still the darkest object in the frame.

The reference was OSIRIS-REx's published full-rotation animation of Bennu — the
one everybody has seen, and a _contrast-stretched_ OCAMS product: it is what the
instrument team put out to be read, not what an eye would see. It is not in
`design/inspiration/` with the rest, because it is fourteen megabytes of GIF and
git history is permanent. The render matches its silhouette, its equatorial ridge
and its boulders, and is honestly darker.

### One O(bodies) scan per tick, found by a test timing out

`considerFrameChange` walks every child of the entity's current frame looking
for a sphere of influence to descend into. For a ship in the system frame the
children are every body orbiting the star, which was eight and is now sixty-six
— and the loop body was a Kepler solve _plus_ a full canonical-position
resolution, per child, per tick. The approach test in `world.test.ts` went from
comfortably inside vitest's five seconds to 6.3 s and failed.

Two changes:

- **The entity's canonical position was recomputed inside the loop** and does
  not depend on the child. That was already wrong and merely cost eight times
  less.
- **A child is skipped unless the entity's distance from the parent overlaps
  the child's own orbital band.** `periapsis` and `apoapsis` come off elements
  the body already carries, and the test is exact rather than conservative: by
  the triangle inequality a body outside that band cannot be within `soi` of the
  entity.

**6,339 ms to 84 ms** on the same 13,836 ticks, entering the same frame at the
same tick — 2,180 ticks/s to 164,700, which is faster than the eight-body
version ever was. The cost is now proportional to the bodies plausibly nearby
rather than to the size of the system, which is what it should always have been;
sixty-six heliocentric bodies are what made it worth noticing.

### What the review caught

`/code-review max --fix` over the diff. Fifteen findings; the ones worth
recording because they were wrong in a way that would not have shown up:

- **A module cycle that only worked by luck.** `smallBodies.ts` imported
  `ROUNDING_RADIUS` as a _value_ from `system.ts`, and `system.ts` imports
  `solar/system.ts` which imports `smallBodies.ts` — with `SOLAR_SMALL_BODIES`
  built eagerly at module scope, so the constant is dereferenced before
  `system.ts`'s body has run. `import('packages/universe/src/system.ts')`
  directly threw a TDZ `ReferenceError`. It worked in the app only because
  `index.ts`'s `export *` list happens to name `solar/system.ts` first. Now a
  leaf `rounding.ts` with no imports of its own.

  The regression test is the interesting part. `pnpm graph` structurally cannot
  see this — it discards every intra-package edge before it starts. Neither can
  a vitest test: vitest evaluates modules through its own runner, which resolves
  the graph without the temporal dead zone Node's ESM linker enforces, and the
  first attempt **passed with the bug deliberately reintroduced**, which would
  have been worse than no test. `apps/headless/src/moduleGraph.test.ts` spawns
  one `node` per entry point instead, which is the only way to make each module
  the _first_ in its own graph. Verified failing, then passing.

  It also came back within the hour on the way there: `smallBodies.ts` is
  emitted from a script, and re-running that script to add a missing body
  restored the old import. The fix belongs in the generator, not the output.

- **The collision datum became the longest half-extent.** `surfaceRadius` was
  `body.radius + groundElevation(...)`, and `radius` is `a`. Ground contact is
  gated on having a spin frame, not on `isLandable`, so a ship can touch down on
  Haumea — 513 km above the pole, with the altitude readout at zero, and
  `frames.ts` anchors the saved site at the same wrong radius so it survives
  save and load. Phobos was the small version of the same thing and a genuine
  regression: its datum was the 11.27 km mean radius until it gained a figure.
  `surfaceRadius` now evaluates the measured ellipsoid. Spheroids are untouched
  — Earth's own 21 km of polar flattening has always been ignored there and
  changing it would move the ground under every save.
- **The generated field was up to 37% too big.** `NOISE_SIGMA` was measured on
  `broad + cut` and the code uses `broad + 1.6·cut`, and the analytic
  `exp(−k²σ²/2)` correction does not survive the clamp or the folded `cut` term
  — neither is the Gaussian that identity assumes. Measured: volume 1.004× the
  ellipsoid at the median roughness and **1.37×** at the top. Replaced with a
  uniform rescale to the ellipsoid's own volume, which is exact, costs one pass,
  and changes no shape at all. The property test that should have caught it
  asserted `exp(0.6)` while its comment claimed 30%, so it could not fail for
  any input in its own range.
- **The generated field was rebuilt at every LOD tier**, 23 ms of noise
  synchronously inside `useFrame`, because the cache key included the stride and
  the field does not depend on it. **The geometry cache was unbounded** and
  `disposeShapeGeometries` had no callers — one pass through Sol built 70–80 MB
  and every system jump added its own.
- **Comet traces were sampled uniformly in time.** By Kepler's second law a
  near-parabolic body spends nearly all its period near aphelion, so for
  NEOWISE consecutive samples were sixty-nine years apart and the two bracketing
  perihelion sat at 38 AU on opposite sides: the trace was a flat-ended lens
  through the middle of the Sun. Sampled in _eccentric anomaly_ now — the same
  96 points spread along the curve rather than along the clock, starting at the
  body's own anomaly so the pre-existing "the trace starts where the body is"
  invariant still holds. NEOWISE's innermost sample went from 38 AU to 0.41
  against a true perihelion of 0.295.
- **The pole was `across` copies of one point with `across` different normals**,
  so shading pinwheeled at both ends of any body whose pole faced the camera.
  `SphereGeometry` gets away with the same layout because its pole normal is the
  axis whichever face you ask; a lumpy body's is not.
- **`toutatis` shipped, was preloaded, and no body referenced it** — the entry
  was lost from the emitter's group list. And the Phobos map shipped in every
  bundle while the Phobos entry never set `texture: 'phobos'`, so the tint that
  had just been halved _to compensate for that map_ was landing on nothing.
- **`system.planets.length` beside the literal word "planets"** in four display
  sites, now that the array holds every body orbiting the star: the catalogue
  row read "Sol · 66 planets".
- **`Set<string>` in three files** for the same "which kinds are worlds"
  partition, so a ninth `BodyKind` would compile against all three and land in
  the wrong half of each while both tests kept passing. Typed
  `Record<BodyKind, boolean>` tables now; a ninth kind is a compile error.

Not fixed, and named in the gaps below: `radius` means the bounding box for a
measured body and the reference ellipsoid for a generated one, which cannot be
reconciled without giving up either the mass or the silhouette.

### The suite outgrew a five-second timeout

Worth writing down because the symptom pointed at the wrong tests. After the
Solar System quadrupled, `pnpm check` started failing intermittently — and the
tests it killed were mostly _not_ the new ones: an Rng uniformity property, an
atmosphere transmittance sweep, the catalog's own "inside a keystroke" search
bound. All pre-existing, all green standalone, all around a second of pure CPU.

Vitest's default is five seconds per test and it runs sixty-four files across
every core at once. Several things now legitimately take a second or more — a
129-body Solar System stepped for thousands of ticks, a fast-check property over
a quarter of a million noise samples — so under that contention the timeout had
stopped measuring the code and started measuring how busy the machine was.
`testTimeout` is 20 s now, which is still an order of magnitude below any of
them, and the two per-test overrides that were compensating for the low default
are gone.

The one place the new work was genuinely at fault: `moduleGraph.test.ts` began
as ten `it.each` cases, each spawning a Node process that type-strips the whole
universe package. Ten of those fanned out in parallel starved everything else.
It is one test with six serial spawns now, 1.3 s in total.

### Textures

Six new maps, all public-domain USGS Astrogeology mosaics: Pluto and Charon from
New Horizons at 300 m, Ceres and Vesta from Dawn, Phobos from Mars Express SRC,
and Bennu from OSIRIS-REx OCAMS at **25 cm per pixel** — a global map with
individual boulders in it, and the highest-resolution map of anything anywhere.
About 900 MB of download into `.data/` for 6 MB of shipped WebP; the whole
texture set is 25 maps and 25 MB.

Deimos, Eros, Itokawa and Ryugu have no global mosaic in a public archive and
fall back to their measured albedo and color. That matters less than it sounds:
a body a few kilometers across is a silhouette long before it is a texture, and
three of those four have their silhouette vendored.

### Where the rest of this ended up

This entry is the narrative. The durable parts are distributed, and each of
these carries a different half of it:

| Document                                                           | Carries                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [ADR-0013](docs/adr/0013-measured-figures.md)                      | Why a radius grid and not a mesh, and the four alternatives that were rejected                                                  |
| [`AGENTS.md`](AGENTS.md)                                           | The two invariants: never flatten a body that has a figure, never read `figure: null` as "unknown"                              |
| [Rendering concepts](docs/concepts/rendering.md)                   | Two shapes and which one is not a rendering choice; shape models as radius grids; exposure at both ends                         |
| [Determinism](docs/concepts/determinism.md)                        | Why `system` went to 3, and "draw, then override" as a numbered rule                                                            |
| [Identity](docs/concepts/identity.md)                              | Why Ceres is `b:8`: issue ordinals are what let fifty-nine small bodies land after the eight planets without moving an address  |
| [Art direction](docs/design/art.md)                                | A body's figure is on the "never negotiable" list; the shape _below_ the published axes is licensed                             |
| [Galaxy](docs/design/galaxy.md)                                    | Provenance is per **field**, not per body — the refinement the Solar System forced                                              |
| [Content](docs/design/content.md)                                  | Dohnanyi, the spin barrier and the measured elongation spread, as content targets                                               |
| [Planetarium](docs/design/planetarium.md)                          | The four orbit-trace rules, including sampling in eccentric anomaly                                                             |
| [Exploration](docs/design/exploration.md)                          | A figure is a Tier 2 scan yield, and on a small body it is the headline one                                                     |
| [Roadmap](docs/roadmap.md#small-bodies-and-their-figures)          | Photometric normalization, the archives the ingest cannot reach, what `radius` means, polyhedral gravity, belts as a population |
| [Catalog guide](docs/guides/catalogue.md#shape-models)             | `pnpm shapes:build`, `pnpm solar:fetch`, and the volume check that refuses a model the format cannot hold                       |
| [Testing guide](docs/guides/testing.md)                            | Three ways a regression test failed to fail; timeouts as hang guards; distributions; derived quantities                         |
| [Extending guide](docs/guides/extending.md)                        | Adding a body kind; calibrating a generator against a measurement; intra-package cycles                                         |
| [Architecture](docs/architecture.md#where-the-universe-comes-from) | The generation inputs, and that the observed/generated split runs per field                                                     |
| [Glossary](docs/glossary.md)                                       | figure · rounding radius · shape model · irregularity · star-shaped · spin barrier · Dohnanyi · datum radius · adaptation       |
| [`NOTICE`](NOTICE)                                                 | Provenance for twenty-five public-domain shape models and six new surface maps                                                  |

The **known gaps** below are the short form of the roadmap section. Where the two
differ, the roadmap has the seam and this has the measurement.

## The session setup learns what the transcripts already knew (25 Aug 2026)

Ten sessions of transcripts are the input to this one. Each change is a cost
those sessions paid more than once.

### A watch that could only report success

`gh pr checks` documents one extra exit code — `8: Checks pending` — and
returns `1` once a check has failed. The `/ship` watch guarded its poll with
`|| { sleep 30; continue; }`, so every iteration that had something to say
skipped the parse and slept. A red CI and a CI still working are the same
thing to that loop: thirty minutes of silence, then a timeout.

The loop keys on a non-empty body now, not on the exit code. `--json
name,bucket` returns the array whatever the exit status, which is what makes
the body a usable signal. This is the shape of the bug worth remembering: a
guard written for "the command failed" firing on "the command has news".

There are two checks on a PR here — `pnpm check` from
`.github/workflows/check.yml` and a Cloudflare `Workers Builds` deployment —
so ready means both, and `all(.[]; .bucket!="pending")` is what says so.

### The template was searched for once per session and never existed

`.github/pull_request_template.md` was absent. Measured across the project's
transcripts, counting tool invocations whose input names it:

| Sessions searching for it | Searches per session | Times it was found |
| ------------------------- | -------------------- | ------------------ |
| 10                        | 1                    | 0                  |

The GitHub tooling looks for a template before every PR regardless of what
any instruction says, so the fix is the file rather than another instruction.
It asks for what review here needs: the invariants a change touches,
screenshots, and verification with numbers. The issue forms ask for the seed,
the address and the tick — generation and simulation are deterministic, which
makes a reproduction that replays headlessly cheap to write and worth more
than a description.

### The hook was talking to the wrong reader

`SessionStart` emitted everything as `systemMessage` under a comment
asserting that channel reached the model. It reaches the human. "pnpm install
FAILED, no test result from this tree can be trusted" was going to the one
reader who was not about to run a test.

Facts go through `hookSpecificOutput.additionalContext`; the subset a human
must act on also goes through `systemMessage`, because only a human decides to
stop and fix the environment. Cursor's `sessionStart` has no
`additionalContext`, so its payload is detected by `conversation_id` — the
same discriminator `gate.mjs` already uses — and gets everything on the one
channel it has.

### The branch is cut at the first commit, not at session start

The hook fetches `origin` and fast-forwards local `main` through `git fetch .
origin/main:main` — no checkout, no second network round trip, and it refuses
a non-fast-forward. It reports the branch, the uncommitted count and the
distance from `origin/main`.

It deliberately does not create a branch. At session start the work has no
name, so a hook that made one produces `wip-3` on every session that turns out
to be a question. The first commit is where the work has been described, and
the branch is cut there off `origin/main` rather than off `HEAD`: a branch
based on a branch that merged last week produces a diff containing work that
already shipped, and that is discovered at review.

A dirty tree at session start is a question for the human, not a decision for
the agent.

### Draft first, and the slow verification goes where the time already is

`pnpm sim --self-test` leaves the pre-push gate for CI, where it already ran.
Holding the push for it bought nothing. The window while CI works goes to what
CI cannot do — a screenshot, a before/after pair, `invariant-auditor` and
`docs-curator`, both read-only, both slow, and both previously at zero
invocations across the transcripts.

A PR opens as a draft, because one opened ready-for-review announces a verdict
CI has not reached. `gh pr ready` is the last step rather than the first.

`git commit` moves from ask to allow. A commit is reversible and costs
nothing; a session that ends with forty files in one lump is neither
reviewable nor bisectable.

### Two rules load with no `paths:`

Path-scoped rules fire when a matching file enters context, which is too late
for two of them. `branching.md` governs the first commit, which happens before
any rule about a directory is relevant. `writing.md` governs prose written
into files no glob predicts — including the commit message, which is not a
file in the tree at all. Both are held to a tighter length limit than the
scoped rules for the same reason: they are in context for every session,
including the ones that only answer a question.

These two mirror `docs/agents/working.md` § "Starting work" and
[`docs/STYLE.md`](docs/STYLE.md) rather than `AGENTS.md`, because what they
carry is not a property of the code. `AGENTS.md` stays canonical for the code
invariants, and `docs/agents/invariants.md` maps those to their technical
pages; process rules are deliberately not in that table.

The ADR count was hardcoded in the `adr` skill and in `/ship`, and went stale
on every ADR. Both read the directory now.

### What the audit caught, and one bug worth a name

`invariant-auditor` and `docs-curator` ran against the branch while CI worked.
Between them they found five things a green `pnpm check` cannot see, because
none of them is a link, a type or a test.

The one worth remembering is **reparenting by insertion**. `### Avoid` was a
subsection of `## Voice` in `docs/STYLE.md`. Three new `##` sections landed
between them, and nesting alone moved that block under `## Commit messages` —
so a code invariant ("interface copy is title case in source; CSS decides what
is shouted") ended up filed under commit-message guidance. **Not one line of the
moved block appears in the diff.** Markdown nesting is positional, so a heading
can change meaning without changing text, and neither review nor Prettier nor a
link checker has any signal to fire on. Adding a `##` to a page means checking
what `###` now sits under it.

The other four are ordinary drift, each introduced by this branch:

| Claim                                               | Reality                                               |
| --------------------------------------------------- | ----------------------------------------------------- |
| Every rule is a path-scoped mirror of `AGENTS.md`   | Two carry no `paths:` and mirror other pages          |
| Unscoped rules are held to a tighter length limit   | `writing.md` was 33 lines against a ~30 cap           |
| Force-push and push to `main` are "denied outright" | Four matchers; `git push -u origin HEAD` matches none |
| `SessionStart` states the branch                    | Silent in a linked worktree, by design                |

The deny-list one is the pattern to watch: a rule that asserts a mechanical
guarantee stronger than the mechanism gives makes an agent _less_ careful,
because it stops checking what it believes is enforced. `git push:*` in `ask` is
what actually catches the push `/ship` runs.

`git commit` moving from ask to allow leaves "never commit to `main`" with no
mechanical enforcement at all. The main checkout sits on `main`, and the
`SessionStart` report does run there — so the guard is a branch line in context
and a rule that reads it. That is deliberate and it is behavioral.

## The planetarium panels stop describing the telescope (25 Aug 2026)

Four panels, and each was answering a question next to the one it was being
asked. The mode's subject is the sky; three of its five panels were about the
instrument, the list, or nothing in particular.

### Four rows about the telescope and one about Mars

The object panel led with the range from the camera to the subject, the
fraction of the frame the disk filled, the two orbit angles and the address
string. Two of its five readings were about the body — a name and a radius —
and the rest were about where you were standing.

Meanwhile `packages/universe` already held a mass, a density that follows from
it, elements at J2000, a rotation period, an axial tilt, an atmosphere as a
surface density and a scale height, a geometric albedo, three measured
half-extents for anything gravity never rounded off, and a discovery record for
every confirmed exoplanet. None of it was on screen.

`packages/devtools/src/dossier.ts` is the projection onto a page, and it lives
there rather than in the panel for the reason `travel.ts` does: it is a query
over the world, and every derivation in it deserves a Node test rather than a
component that has to be rendered to be checked. Earth comes out at 1.01 bar
from `p = ρgH`, a 24.00 h solar day against a 23.93 h sidereal one, 1,361 W/m²
of insolation, and a Sun 0.533° across — all four of which are the published
figures, from arithmetic over what the generator already stored.

Two derivations were wrong the first way they were written, and both are
properties now.

**The synodic day takes the period about the _star_, not about whatever the
body immediately orbits.** Luna is tidally locked, so its rotation period and
its month are equal and the difference of their reciprocals is zero — an
infinite day, for a body whose sunrises are 29.5 days apart. What moves the Sun
across a moon's sky is its planet's year, and against Earth's 365.25 days the
same subtraction gives the synodic month exactly.

**The sign of the rotation is kept.** Dropping it puts Venus's solar day at
2,802 days instead of 117 and looks entirely plausible in a panel.

### An unmeasured field is a row

Writing that page forced the question this project had not had to answer: what
does the interface do about the astronomy it does not have? The list is long
and none of it is obscure — composition, surface temperature as opposed to
equilibrium temperature, magnetic field, atmospheric chemistry, age, proper
motion, metallicity, orbital resonance.

Omitting the row destroys information. An absent "Atmosphere" cannot
distinguish _this body has no atmosphere_ from _nobody has measured this body's
atmosphere_, and those are opposite claims about the same world.

So `Fact.value` is nullable, a null draws as **no data** with the reason behind
it, and the header counts them: _12 unmeasured_ on Earth.
[ADR-0014](docs/adr/0014-the-record-with-holes-in-it.md) is the whole argument.
The part worth repeating here is the voice rule: **the reason is written in the
universe's terms and never in the engine's.** "No spectrometer has resolved
this body's interior" and "the generator does not produce a composition" are
the same fact and only the first may be shown. A projected world is _real_ —
`projected` is a claim about the record, not about the place — and a row
reading "not modeled yet" tells the reader the sky is a program, on the one
screen whose entire subject is that it is not. A test greps every reason on
four representative pages for `generator`, `procedural`, `not modeled`, `this
build`, `engine` and `TODO`.

### The catalog could not be folded, and its order was not an order

Sol is a hundred and twenty-nine bodies. The panel listed all of them, flat, in
the order the addresses were issued, with three glyphs across nine classes.

Three separate bugs came out of that shape.

**Issue order is not orbital order.** ADR-0009 says `b:2` is the third body
ever _issued_, and the two agree in Sol by historical accident. The tree is
sorted outward now, over the `parent` field the survey already answers.

**A promoted moon sorted by its own orbit.** Turning off "Asteroids" orphans
their moons, and the design keeps an orphan rather than dropping it — losing Io
because "Planets" is off would be a filter deciding what a moon is. But sorted
by its own semi-major axis, a moon of an asteroid orbits at a kilometer or two
and lands _above Mercury_: nine rocks nobody asked for at the head of the list,
measured in kilometers in a column of AU. The sort key for a promoted body is
its parent's axis now, taken from the run before the filter.

**`searchTargets` was interpolating a parsed record into a string.**
`CatalogStar.spectralType` is a `SpectralType`, not the string, so every search
result for a star that was not loaded read `[object Object] · 0.12 M☉`. The
loaded branch reads `system.star.spectralType`, which _is_ the string, and the
two looked identical in the source.

### A brightness floor is desaturation

The neighborhood rail and the catalog's star glyphs carry each star's own
colour, which `docs/design/art.md` puts on the list of things this game may not
invent — "a K dwarf is orange, it does not get to be a nicer orange". The first
version lifted every channel toward white by 0.45 so a saturated M-dwarf red
would be legible at 12 px over slate. It turned the whole neighborhood into
pale peach and Sirius into off-white: a rail of nine identical dots.

It did not need one. `blackbodyColour` normalizes the brightest channel to 1,
so every star already has a channel at full and no glyph can come out dim. What
the floor was buying was already there, and the hue was what was being spent
for it. The transfer function stays — linear to gamma-encoded sRGB, because an
M dwarf's blue channel is 0.16 linear, which is 111 encoded and 41 not.

### Year zero is not a year

`SolarBody.discoveryYear` uses `0` for the bodies known since antiquity, and
rendering it as a number produced `First observed 0` on Earth. It is not an
empty field either: "nobody wrote down when this was first seen" is a stronger
answer than a date. It reads **Antiquity** now, and Uranus still reads 1781.

The same class of bug, one clause along: `starSummary` divides by the Sun's
luminosity and quotes a distance from Sol, so without a branch for the Sun
itself it wrote "catalogued at 0.00 light years, putting out 1.000 times
fainter than the Sun" — wrong twice, about the one star every reader looks at
first.

### Two banks of word-buttons that were the same kind of thing

`Framing` had three buttons and `Compositions` had six. A framing is a
composition that happens not to move the light, so they were one list badly
split — and either way they were nine identical rectangles of type, when the
only two things separating any two shots are how much of the frame the body
fills and where the terminator falls. Both are pictures.

They are drawn now, to the geometry the solver uses: the disk's radius is
`fill × half the frame height`, which is what `frameTarget` solves a distance
for, and the terminator is a half-ellipse of projected width `r·cos φ`, which
is why it collapses to a straight line at exactly 90°. Checked against the
running app: pressing **Backlit** put Earth on screen as a dark disk inside a
thin warm ring of its own atmosphere, with the night-side city lights showing —
which is the thumbnail, at full size.

### What is now a stance field

`orbitScope` — the subject's context, or every orbit in the system — is the
fifth field on `Stance`, because the frame loop reads it and a presentation
switch has no carve-out for the ones that look like preferences. It arrived
after the stack existed, which is what the stack is for: a panel's override is
a one-field push and `release()` restores the mode's.

Label density and the minor-body filter did _not_ become stance fields, and the
line is worth stating: they are read by a DOM layer that already owns its own
projection pass, not by `GameEngine.#step`.

## The terrain rig, and the three defects it found on its first run (26 Aug 2026)

Phase 0 of [`TERRAIN-PLAN.md`](TERRAIN-PLAN.md) § 9: the instrument every later
phase is judged through, built before any of them so the phase that triples the
per-sample cost has something to be a regression against. No generator changes.

### What it is

**A second observer arm.** `packages/rendering/src/surfaceStance.ts` is five
numbers about a point _on_ the ground — where, how high, which way — against the
orbit arm's three about a point in space. Its ceiling is
`(MIN_DISTANCE_RADII − 1)` radii, which is exactly the orbit arm's floor, so the
two meet with no band that is both or neither. The height scrub is logarithmic
because the band is 2 m to 3,186 km on Earth: a linear slider puts its midpoint
at 1,593 km, above the altitude terrain is drawn at at all, so the control that
exists to reach two meters would be the one control that cannot. The default
pitch tracks `acos(r / (r + h))` rather than zero — from 400 km the horizon is
**19.79°** below level (the small-angle `√(2h/r)` gives 20.30°, 2.6% wrong and
growing), so a level camera at the top of a descent is a picture of empty sky.

**The selection rule left the browser.** `terrainWindow` is the streamer's
request set as a pure function of (radius, distance, direction). Same rule, both
of its limits intact and now named: `windowRadius`, and a `clipped` count for
the patches a cube-face edge drops — five of nine over a corner. Nothing about
the streamer's behavior changed; what changed is that "what would this camera
ask for?" no longer needs a GPU, which is why the 1.0 ms terrain line in the
frame budget has been a designed figure rather than a measured one.

**Sites are derived, not authored.** A beam search over the field finds four —
`summit`, `basin`, `shore` and `rough`, the last of them an escarpment search
scored on gradient — and two are chosen outright for the renderer
rather than the geology: `corner`, where three faces of the addressing cube meet,
and `pole`, where the east/north basis is singular. A survey of _interesting_
ground would never wander into either. 2,100 samples, ~20 ms, memoized per body.
A hand-written latitude is stale the moment the generator moves; "the highest
ground on this body" survives regeneration by construction.

**A descent is arithmetic.** `ir.descend()` flies orbit → 2 m over a site and
reports level churn, peak burst and cache behavior with no world, no pool and no
renderer, so a console, `pnpm sim --terrain-baseline` and a Node test all get the
same numbers.

### The three defects, which share one cause

`terrainLevelFor` and `terrainOpacity` are handed `distance − radius`. For a
camera standing on the ground that is `groundElevation + height`, not `height`.
**The streaming rules measure altitude from the datum**, and on a body with real
relief the datum is kilometers from the ground.

- **A mountain can be too tall to draw.** `terrainOpacity` fades out one octave
  above `radius · 2^(4.5 − maxLevel)`. On Miranda that is **2,605 m**; the summit
  the survey finds is **4,826 m**. Standing on it the streamer requests nothing,
  draws nothing and leaves the datum sphere on screen — at every altitude,
  including zero. Verified in Chrome: `ir.terrain()` reads
  `level 10, opacity 0, patches 0` with Miranda at `surface` tier filling 70° of
  the frame. Two of Miranda's six survey sites are ground that cannot be looked
  at. Any body whose relief exceeds `2^(5.5 − maxLevel)` of its radius has this
  hole somewhere, and Miranda's 4.2% is Verona Rupes rather than an exotic case.
- **A summit streams at half resolution.** Two meters above Iapetus's highest
  ground the streamer asks for level 11; two meters above its deepest basin it
  asks for 12. Same body, same height above the ground.
- **A level pass re-requests the world.** Flying level across Iapetus at fixed
  height coarsens and re-refines as the ground beneath rises and falls. Nine
  patches today; a few hundred once the quadtree covers the disk.

None is fixed here — Phase 0 measures the build that exists, and the fix is
already in the plan, because a screen-space error metric measures against the
patch rather than against the datum. The tests pin the numbers so the fix is a
diff rather than a rediscovery.

### The baseline, measured

`pnpm sim --terrain-baseline`, Node 26 on an M5, main thread. Zoo members are
found rather than written down — Gliese 1061 d and b for the rocky archetypes,
Iapetus and Miranda for the icy ones.

| Measurement                         | Figure                                                        |
| ----------------------------------- | ------------------------------------------------------------- |
| Patch generation, 65×65, 14 octaves | **12.7–13.5 ms/patch**, 0.31–0.33 M samples/s, steady over 48 |
| Descent orbit → 2 m, 128 steps      | 558–838 patch requests, 7–8 level changes                     |
| Peak burst                          | **9** — one window, however the camera arrives                |
| Cache hit rate, 64 heightfields     | **< 5%** on a tracked descent; the working set is hundreds    |
| Terrain drawn                       | on the last **two levels only**; the rest is the datum sphere |
| Patches on screen at level 12       | 9 patches, 38,025 vertices, 73,728 triangles                  |

The generation figure is the one that matters and it **exceeds the documented
budget by 60%**. `docs/design/technical.md` carried "≤ 8 ms per patch per
worker — Measured; within" with no machine and no date beside it; every
neighboring row names both. It is 12.8 ms here, before a single band of geology
is added, and the plan's own estimate is that the band stack is 3–5× today's
fourteen octaves. That moves Phase 5 (the GPU producer) from "adopt only if the
measurements say so" to a condition the measurements have already met once.

Not measured, and the summary says so rather than inventing them: frame cost,
draw calls and the worker queue's real depth are browser facts and this is a
Node process.

### Two findings from building the zoo

**No generated system within 25 ly of Sol contains an `icy-active` body.**
Generated moons come out on orbits too circular for the eccentricity tide to
register, so the zoo is a set of bodies rather than one system. Sol supplies both
icy archetypes from unmapped moons — Iapetus and Miranda — and neither has a
shipped map, so both are squarely inside the milestone's scope.

**Every unmapped rocky body in Sol is generated with `maxElevation` of zero.**
Eris, Makemake, Quaoar, Haumea and the rest are perfectly smooth spheres. That is
why the rocky archetypes have to come from outside Sol, and it is a gap in the
small-body generator rather than in the search.

### Corrected while measuring

Phobos reads **1.64 g/cm³** here, not the published 1.88, and the cause is data
rather than arithmetic: the vendored half-extents are 13.3 × 11.9 × 9.8 km
against a published 13.0 × 11.4 × 9.1, which is 13% more volume for the same
mass. `volumetricMeanRadius` is right — it fixes the 1.52× volume error a sphere
of `a` makes — and the test asserts that ratio rather than a figure this data
cannot reach.

### What the plates show

Standing at Iapetus's north pole at two meters, in the planetarium, with no ship
anywhere: Sol on the horizon with its lens ghosts, and a flat tilted plane of
ground. That is today's three-band field at level 12 and it is the honest "before"
plate — the last octave of noise is the smallest thing that exists. At 40 km the
same camera sees a perfectly smooth limb, because the streamer has faded out
entirely.

## Known gaps

Fuller treatment, with the seam for each, in [`docs/roadmap.md`](docs/roadmap.md).

- **The planetarium has no bookmarks, filters or measure tool.** The address is
  already the whole record for a bookmark, so what is missing is a store; the
  filter fields are the ones `docs/design/galaxy.md` lists for the galaxy map.
- **Mode routes are not covered by a Node test.** Each drives a live engine, and
  a test that stubbed a renderer, a worker pool and a camera would assert
  against the stub. `modeForPath`, the link builders, the dock algebra, the
  gesture arithmetic and the compact dock all are; the boundary is deliberate.
- **Piloting on a touchscreen is not designed.** The flight modes are
  desktop-only and the menu says so. The planetarium and the cinema player are
  the mobile surface.
- Binary and multiple-star systems are modeled as single stars (`components`
  in the catalog records the truth for all 375 of them within 150 ly).
- Moons outside the Solar System are all projections, which is right — no
  exoplanet moon has been confirmed. Sol's twenty are real and observed.
- **Most small bodies have no vendored surface map** — Titan, Enceladus,
  Iapetus, Triton, the Uranian moons, Deimos, Eros, Itokawa, Ryugu and every
  asteroid and comet below Bennu — and render from their measured albedo and
  tint. For the moons that is a size-versus-return judgment. For the small bodies
  no global mosaic exists in a public archive: NEAR, Hayabusa and Hayabusa2
  archived images and shape models rather than projected maps. Twenty-five of
  them do have their _figure_ vendored, which for a body a few kilometers across
  is the half that shows.
- **67P/Churyumov–Gerasimenko and Ryugu have no shape model here.** Both are
  archived — ESA's Planetary Science Archive and JAXA's DARTS respectively — and
  the shape ingest only speaks PDS. 67P is the most recognizable small-body
  silhouette in existence and it is currently a generated figure on its measured
  half-extents.
- **`radius` means the bounding box for a measured body and the reference
  ellipsoid for a generated one.** The two cannot agree: a lumpy body with an
  ellipsoid's volume has a larger bounding box than that ellipsoid, and
  `irregularFigure` picks volume because the mass depends on it. Measured
  consequence: a generated body's silhouette exceeds its stated `radius` by
  about 17% at the median roughness and up to 55% at the top of the range. The
  only thing downstream is the angular radius the LOD tiers are chosen from,
  which is a tier boundary rather than a fact.
- **The renderer has no per-body photometric normalization.** A surface map's
  mean linear luminance ranges from 0.048 (Callisto) to 0.32 (the Moon) across
  the shipped set, against published geometric albedos that do not track it —
  Vesta's map is four times darker than Mercury's on a body three times brighter.
  Each body's tint compensates by hand. The fix is for the texture ingest to
  record each map's mean and the renderer to scale toward `1.5 p`, which would
  change how every planet is lit and is therefore a deliberate pass rather than a
  patch.
- **Three of the four Galilean maps are monochrome.** That is how Voyager and
  Galileo returned them. They are tinted with published colors, which is a
  different and smaller lie than rendering them gray.
- The atmosphere is still an analytic uniform-density shell with authored
  scattering colors, not the Bruneton LUTs spike 2 made a requirement. The
  colors are per body now, which was the loudest half of the problem.
- **A catalog drift is reported, not resolved.** `versionDrift` compares the two
  manifests wherever they meet — the handshake, the save loader, the health
  panel — so a save written against a moved catalog says so on the way in. What
  is still missing is the _revision notice_: nothing tells a player which of
  their bodies moved, or offers to re-resolve the references. That is a
  roadmap seam, not a comparison problem.
- The 50 systems whose only identifier is HYG's own row key (0.7%) have ids a
  rebuild can move. They are counted on every ingest and asserted under 1%.
- **The procedural fill's IMF is not conditioned on what the catalog is missing.**
  It draws B stars at their true 0.13% frequency, so a 40 ly sweep can put an
  invented 5,000 L☉ B star in the sky brighter than anything real in it — and real
  B stars that close do not exist, which is precisely why the catalog has none.
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
  469 KB catalog before the first render, correctly (it is a generation input)
  but on top of that. Three of the four modes are not the first viewport and are
  the obvious thing to split out.
- **No performance number in this file was measured on a handheld.** The
  pixel-ratio ceiling for a coarse pointer is reasoned about rather than
  profiled; so is the claim that the near-planet frame is fragment-bound on a
  tile-based GPU. `render/measure.ts` on the device is what settles both.
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
