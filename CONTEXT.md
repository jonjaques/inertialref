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
`window.ir`, terrain heightfields produced on the GPU with the worker pool as
canon and fallback, landing on a generated
surface, a sphere-of-influence frame transition mid-flight, and a save
round-tripping through IndexedDB to an identical state hash. With the preview
server **stopped**, the page still loads from the service worker and passes
12/12 — offline-first demonstrated rather than asserted. The browser runs
~1.25M simulation ticks/s for one integrated entity, and a coasting one is on
rails: a 100,000× frame over it is one jump, and 10⁷× is delivered in the
planetarium at 0.37 ms of engine (ADR-0025).

| Package         | Layer | State                                                                                                                                                                                                       |
| --------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared`        | 0     | done — units, brands, invariants, structured logging, the timing port (ADR-0022)                                                                                                                            |
| `spatial`       | 1     | done — UniverseVector, frame graph, floating origin                                                                                                                                                         |
| `procedural`    | 1     | done — PRNG, hierarchical seeds, noise, algorithm versions                                                                                                                                                  |
| `physics`       | 2     | done — Kepler, rigid body, atmosphere, thrusters, universal-variable propagation for any conic (ADR-0025)                                                                                                   |
| `universe`      | 3     | done — addressing, star catalog, generation, terrain, frames                                                                                                                                                |
| `simulation`    | 4     | done — clock, entities, flight, streaming, snapshots, rails for a coasting entity with a jumped frame (ADR-0025)                                                                                            |
| `protocol`      | 4     | done — validation combinators, wire and save schemas                                                                                                                                                        |
| `workers`       | 5     | done — typed tasks, ports, pool, five tasks, the `HeightfieldSource` port the pool implements (ADR-0023)                                                                                                    |
| `persistence`   | 5     | done — save/restore, migration chain, store port                                                                                                                                                            |
| `net`           | 5     | done — authority port, local authority; remote + channel are H4                                                                                                                                             |
| `rendering`     | 5     | done — LOD, depth compression, terrain meshing                                                                                                                                                              |
| `devtools`      | 6     | done — inspection, twelve capability checks, harness, `openSession`                                                                                                                                         |
| `apps/game`     | —     | done — React + R3F client on `WebGPURenderer`/TSL, every frame drawn through the sensor chain (ADR-0029), the GPU tile producer, worker pool, IndexedDB saves; `/docs` is the documentation site (ADR-0016) |
| `apps/headless` | —     | done — Node runner, ~100–105k ticks/s, `pnpm sim --self-test`                                                                                                                                               |

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
pnpm build       # optional media pull, docs:build, typecheck, vite build
pnpm check       # graph, brand:check, presets:check, format:check, lint, typecheck, test, build
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

- **A cache keyed without the body, cleared without the queue.** `regionKey` is
  packed arithmetic over the region alone, so after a retarget a job still out
  for the discarded world names the same key the new body's roots do — and
  `#request` filtered the nearest-first head of the new list out until it
  settled. The ground arrived a heightfield's latency late on every retarget,
  silently. `clear()` empties `#inFlight` and cancels it, and the stale job's
  own `finally` is epoch-guarded so it cannot delete an entry the new body
  just made.
- **A session that reacts to an ending nobody is watching.** The cutscene
  session reopened an ended scene and paused the world clock from a sampler
  that runs whether or not the cinema is mounted, so a console `ir.play` left
  the world frozen for the rest of the session. Two tests in
  `cinema/session.test.ts` pin it: a scene the session did not open, and an
  ending that arrives in the same sample as the leave.

Each of these was invisible in a running browser and caught by a test or by
driving the harness. They are listed because the same mistake is easy to make
again in a neighboring system.

- **A generated filename that preserved case**, on a case-insensitive
  filesystem. The API reference exports `Vec3` and `vec3`, `Session` and
  `session`, and twenty-two more pairs that differ only in case; on APFS those
  are one file, so 904 pages produced 878 and the twenty-six that vanished were
  whichever of each pair was written second. On Linux — CI, and the deploy build
  — all 904 survived, so the two environments produced different sites from the
  same commit and neither reported anything. Page filenames are lowercase with a
  digest of the route appended, and the manifest carries the name so nothing has
  to re-derive it. `scripts/docs/routes.test.mjs` fails if either half is undone.
- **A performance sink that crashed the frame it was measuring.**
  `console.timeStamp` is not a function in the Node context a `GameEngine` test
  runs in, and an unguarded call threw straight out of the frame loop — a crash
  in a debugging aid, which is strictly worse than the aid being absent. The
  trap underneath it is that two questions look like one: whether the method
  _exists_ is a `typeof`, and whether it accepts the four custom-track arguments
  is a Chromium extension with **no capability query at all**. Guarding the first
  and assuming it answers the second is how Safari, Firefox and Node end up
  paying a hot path for entries that land nowhere. The level is the gate for the
  second; the `typeof` only covers the first.
- **An inertness test that could not fail.** The obvious shape — attach a
  recording sink, leave the level `off`, assert no entries arrive — is vacuous
  by construction, because a sink _is_ what "on" means, so attaching one opens
  every guard and the entries arrive correctly. The observable that means
  something is the count of `performance.now` calls: exactly two a frame when
  nothing is listening, which is what the frame loop read before any
  instrumentation existed. Written as an equality rather than a bound, because
  the claim is that the instrumented and uninstrumented builds do identical
  work. `apps/game/src/engine/timingInert.test.ts`.
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
- **`parseSpectralType('D10')` returned a subclass of 10** (27 Aug 2026),
  against the field's 0–9.9 contract — the white-dwarf branch took whatever
  digits followed the class letters while the ladder branch below already
  degrades past 9.9 to null. The input is legitimate: a white dwarf's
  temperature index is 50400/Teff, which runs past 9 for the coolest ones.
  Found by the never-throws property on a fresh seed, months after the branch
  was written — which is the argument for properties over vectors, and for
  pinning the counterexample as a vector once one is found.
- **A stand-in texture at `DataTexture`'s nearest default.** The WGSL builder
  binds a nearest texture with no sampler, and the gradient sample names one
  anyway, so the ground's 1×1 white pixel was a shader module Tint refused —
  every mapless body's ground was a black frame, and the boot warm-up was
  compiling it and swallowing the rejection. Found by the first run of
  `materials.gpu.test.ts`, which now holds each stand-in and a real map to one
  program. Photographed bodies never showed it because a loaded map is linear.
- **One stand-in texture under two nodes.** A texture node's uniform hash is
  its texture's uuid, so two nodes over one stand-in compile to one binding
  owned by the first, and the second node's later swap binds nothing. The
  sphere's relief sampler read the reflectance that way, an icy moon's albedo
  was its sea mask, and every mapless moon in Sol was a dark disk under a
  sun-glint over a bake that read back correct. `materials.gpu.test.ts` counts
  the cube bindings in its signature and draws a bake through a program frozen
  over the stand-ins first. The ocean world it was verified on hid it, because
  a mask read out of a sea world's albedo is a plausible sea.
- **A throw inside `PostProcessing.render` leaves the renderer with no curve
  and a linear output, for good.** The quad draws with `toneMapping` and
  `outputColorSpace` swapped and two plain assignments put them back — no
  `finally` — and the scene renders inside the swap, through the pass. The
  sensor read the two as a mode signal and rebuilt its output for the poisoned
  state, and every later frame was one sRGB transfer too dark: 59/255 on a lit
  hull arriving at 15. `render/sensor.ts` restores both around the quad;
  `sensor.gpu.test.ts` throws from an `onBeforeRender` and holds the renderer
  and the next frame. The trigger was the next bug.
- **A frame drawn against a pipeline `compileAsync` is still building throws
  out of the whole render.** The warm-up's walk registers the pipeline and the
  promise fills in the GPU object later; `WebGPUBackend.draw` in r182 skips a
  pipeline that failed and not one that is pending, so `setPipeline` gets an
  undefined. The build-ahead materialises a body in view and warms it in the
  same task, so the next frame threw — twice at every boot, once per body in
  flight, one lost frame each without the chain and the picture with it.
  `patches/three@0.182.0.patch` skips the draw instead; `warmup.gpu.test.ts`
  draws the frame before the promise and holds it quiet and empty, and fails
  with the guard stripped.
- **A pass keyed on three's frame counter draws once per task.** `PassNode`
  is `NodeUpdateType.FRAME`, gated on `nodeFrame.frameId`, which only three's
  own animation loop advances. Forty `render()` calls in the GPU measurement
  were one scene and thirty-nine quads, and the harness — whose loop is a
  stub — drew a second frame through one chain over the first frame's pass and
  read it black. The sensor's pass is `NodeUpdateType.RENDER`;
  `sensor.gpu.test.ts` draws three frames in one task and counts six scene
  renders with the picture changing between them.

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
blackbody `color`, `catalogued` (which is provenance) and the confirmed
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
  ADRs, guides, the design bible. House voice is [`STYLE.md`](STYLE.md):
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
alone for a later programmatic rename. [`STYLE.md`](STYLE.md)
already stated the policy; this pass applies it to the rest of the tree.

## Twelve shallow modules, deepened (23 Aug 2026)

[The architecture review](design/plans/arch-review.md) is the plan; this is what
implementing it found. The thread through all twelve is the same: a module was
shallow because its interface was `Env`, or a component, or a convention nobody
owned — so the behavior behind it could only be reached by running the whole
application, and every bug in it shipped.

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
more than the plan itself ([the tng-intro plan](design/plans/tng-intro.md)).

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

[The tng-intro plan](design/plans/tng-intro.md) was written from measurements and
then implemented against the same frames. Its timings and its structure held. A
good deal of its _causation_ did not, and the corrections are worth more than
the work they interrupted — they are summarized here.

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

**And the plan's line fits were fits to the script's own beats.** Refitting them
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
[`STYLE.md`](STYLE.md) rather than `AGENTS.md`, because what they
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
subsection of `## Voice` in `STYLE.md`. Three new `##` sections landed
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
color, which `docs/design/art.md` puts on the list of things this game may not
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

Phase 0 of [the terrain plan](design/plans/terrain.md): the instrument every later
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

## Source maps in every mode, and four editor debug configurations (27 Aug 2026)

Vite's defaults are JS maps in `pnpm dev` only, nothing for CSS, and
`build.sourcemap: false`. A production deploy — and `pnpm preview` — therefore
shipped minified bundles the debugger could not map, while the editor's launch
configs looked as if they could. `hidden` would have written the `.map` files
and omitted the `sourceMappingURL` comment, so DevTools would never fetch them:
a deployed site that looked debuggable from the asset list and was not.

`build.sourcemap: true` and `css.devSourcemap: true` are the switches. A
writeBundle check fails the production build if any hashed JS asset —
including the universe worker — lacks the comment or its sibling `.map`.
Copied `public/` files are not compiled and are not in `assets/`. Production
CSS has no map: Vite 8 minifies it with lightningcss and does not expose
`sourceMap` on those options, so the gate does not claim otherwise. The
service worker lets `.map` requests through: they sit next to hashed chunks,
so `/assets/` would otherwise cache-first megabytes of original source in
every player's Cache Storage, and DevTools asks the network when a breakpoint
needs them.

Wrangler's inspector defaults to 9229, which is Node's `--inspect` default.
`pnpm sim` now binds that port; Attach Node is aimed at it. workerd listens on
9230 so the two can run together. `upload_source_maps` is the Worker script
half — client maps ride with the asset store.

Four configurations in `.vscode/launch.json`, shared by VS Code and Cursor.
Launch Browser is first, so the play button starts the game: a background task
runs `node scripts/dev.mjs --ensure`, which reuses 5173 if something is already
answering and does not kill a server it did not start. Launch Node runs the
headless runner. Attach Browser is Chrome on 9222.

## The quadtree covers the disk, and three things it had to learn first (27 Aug 2026)

Phase 1 of [the terrain plan](design/plans/terrain.md). A 3×3 window at one level
becomes a restricted, morphing quadtree walked from the six cube faces.
[ADR-0015](docs/adr/0015-terrain-level-of-detail.md) is the decision record.

### What it closed

The horizon is terrain rather than the datum sphere. Cube-face edges are not
holes — there is no neighborhood to fall off, because the traversal starts at
all six faces and a patch samples one row past its own edge into whichever face
owns it. Patch boundaries have no seam, because two rings of border make every
normal a central difference. And **all three of the datum defects the rig found
are gone**: every one of the zoo's twenty-four survey sites now bottoms out at
its own detail floor, where two of Miranda's could not be drawn at any altitude
including zero.

The tests that pinned those three now assert their opposites, which is what the
rig was built for.

### Three measurements that changed the design

**The deep levels were an upsample.** On Mercury a level-9 patch differs from
the bilinear interpolation of its parent by **12 cm**, and levels 10 through 12
by nothing a float can hold — the shipped three bands have no content below
about 11 km on an Earth-sized body. The old rule saturated at level 12, which is
sixteen times the patches of level 10 for identical output at 12.8 ms of worker
apiece. `surfaceDetailFloor` measures the residual from the field itself — 24
golden-angle probes, five samples each, memoized, ~5 ms — and lands between
level 7 and 10 across the zoo. It sits beside `elevationAt` so Phase 2's bands
move it without anybody raising a constant.

**Per-node distortion and neighbor consistency are incompatible.** Measuring
each region's true span describes a patch better than its level does, and
correcting for it is what Zucker & Higashi is about. It also breaks the no-crack
argument: a patch and its coarser neighbor are measured at different points on
the cube face, where the gnomonic scale differs by up to **22% at level 2**,
which leaves the finer patch 15% short of its neighbor's grid. The metric is
nominal per level; the distortion costs over-tessellation near the cube's eight
corners instead of a seam.

**A coarse patch costs more per sample than a fine one.** 20.69 ms at level 1
against 14.33 at level 12 for the same 4,761 samples — 0.23 against 0.33 M
samples/s — because a level-1 patch's consecutive samples land in different
noise lattice cells and a level-12 patch's share one. The window never saw this;
a whole-disk selection generates the coarse shell too. The border itself costs
exactly the 12.7% it should: 12.80 ms unbordered, 14.46 bordered, same rate.

### Three defects the browser found, and one only a per-frame sample could

**The morph closes one level and nothing wider.** A patch slides onto its
_parent's_ grid, so a level L patch meeting a level L+1 patch arrives exactly on
its vertices — and meeting a level L+2 patch arrives on a grid the coarser one
has no vertex on. Unrestricted, standing on Miranda, **30 of 468 patch edges had
a gap of two or more and the worst was six**, drawn as dashed black arcs along
every level ring. The plan said "neighbor levels unconstrained for geometry (the
morph handles it)"; that is the one line of it that was wrong. The tree is
restricted to 2:1 now, in packed integer keys with no allocation in the ancestor
walk, because the readable version cost 1.8 ms — sixteen times the traversal it
was correcting.

**Terrain was painting over the photographs.** Extended to the sphere tier, the
level 0–2 shell drew Earth at two and a half radii as five flat tinted patches
with the map underneath. Terrain is now gated on a body's relief covering more
than eight pixels: past that the mesh and the datum sphere are the same picture,
and the sphere already carries a normal map and, on four bodies in Sol, a
photograph. Earth draws its map to 2,000 km of altitude and its ground below;
Miranda keeps terrain to eight thousand kilometers, because there the relief is
the shape of the body. The plan's unconditional shell wants Phase 3's per-face
albedo bake under it, and this threshold is where that goes.

**`buildPatch` was 6.26 ms.** Six frames of terrain budget for one patch, on the
main thread, during a descent that wants four hundred — and all of it
allocation: a `Vec3` per direction, per scaled position, per difference, and two
three-element arrays per normal, about forty thousand short-lived objects per
patch. Written in scalars against flat arrays it is **0.250 ms**, 25× faster,
with the morph-endpoint and shared-edge properties unchanged.

**A cache smaller than the working set does not degrade, it oscillates.** The
terrain strobed at every altitude, and one `ir.terrain()` sample per frame says
why in a line: `cached` pinned at exactly 512 while the draw set swung between
19 patches at level 3 and 356 at level 9. 512 heightfields was sized against a
3×3 window; a quadtree holds two selections at once — the drawn one and the
request one, taken from where the eye is going — and together they are six
hundred to twelve hundred regions. Every frame evicted ground the next frame
wanted. **A still could not have shown this**; the sample could.

### What the invariant audit found afterwards

Three, and the first is the one worth remembering. **`surfaceDetailFloor`
memoized on `radius * 1e6 + resolution + tolerance`**, which folds three numbers
additively — so (65, 0.5) and (64, 1.5) collided and whichever call ran first
won for both. A pure function of the seed whose answer depended on the order it
was asked in, which is the one thing generation may never do. Nothing in
production passed a non-default, so it was a trap rather than a bug; the four
tests that referenced it used it as the expectation _and_, through
`simulateDescent`'s default, as the input, so they would have passed had it
returned a constant.

**Refinement gated on the heightfield cache while drawing needs geometry.** The
traversal drops a node the moment it refines, so a region whose field had
arrived but whose mesh had not was covered by nothing — not itself, not the
parent that had given way to it. 138 of 266 selected regions on arrival at a
landable body. It gates on the mesh now.

**A docstring argued an ordering the code did not produce**: `#request` claimed
nearest-first inside a grouping kept by a stable sort, and there was no sort —
the first eight regions a cold frame asked for on Earth at two meters were
470–750 km away rather than the ground underfoot.

### The numbers

`pnpm sim --terrain-baseline`, Node 26 on an M5, and the browser through a CDP
driver at 1600×900.

| Measurement                         | Figure                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| Patches selected, whole disk at 2 m | 236 Earth · 435 Miranda · 474 on an 11,536 km world; 623 at a descent's worst step |
| Selection cost                      | **0.11–0.31 ms** against the plan's 0.5 ms line                                    |
| Mesh build                          | **0.250 ms** a patch, four a frame                                                 |
| Patch generation, bordered 65×65    | **14.5 ms**, 0.33 M samples/s — 80% over the documented ≤ 8 ms                     |
| Frame, standing on Miranda's summit | **2.04 ms at 63.9 fps**, 438 patches, 1.85 M vertices, 3.59 M triangles            |
| Steadiness, 200 consecutive frames  | 440 patches and level 9 every frame, nothing starved, nothing pending              |
| Vertex buffers                      | 203 KB a patch, so **45–126 MB** for a disk                                        |

The memory is the number to watch and the levers are named rather than pulled:
packing the four attributes below float32 is worth about half, and frustum
culling the selection about half again.

### Two departures from the plan, deliberate

**Mapped bodies keep streaming.** `surfaceRadius` is one function and the
contact test lands a ship on procedural elevation whether or not the body has a
photograph — Mars's is ±14.7 km against a sphere drawn 29.4 km under the datum,
so a mapped body with no streamed ground is a ship parked fifteen kilometers
above a smooth planet. The carve-out is about what may be claimed of a mapped
surface, not about whether the ground under the landing gear is drawn. Phase 3
owes those patches a material that wears the published map.

**Terrain rides the body's render compression.** The opacity fade was hiding
that the surface tier reaches more than eight radii while `NEAR_LIMIT` is two
thousand kilometers, so patches at true meters against a compressed sphere are a
different object at a different distance. `RenderPlacement` grew a dimensionless
`compression` for it: `scale` is the drawn _radius_, and multiplying a patch's
anchor by that put it 10^12 m away.

### What the plates show

Standing at two meters on Miranda's summit — the site that could not be looked
at — a terrain horizon with a distant peak, ground unbroken from underfoot to
the limb, no seam at any of the seven level boundaries on screen. At 3 km, the
same ground graded from level 9 underfoot to level 2 at the horizon in one
surface. Earth from two and a half radii is its own photograph again.

## The review of the disk — keys that named too little, constants that had to agree (27 Aug 2026)

An xhigh review read PR #27's whole diff from twelve angles and came back with
fifteen verified findings, all fixed in one commit. Most of them are five
mechanisms, each worth recognizing on sight in a neighboring system.

**A cache key must name everything the value depends on, and three did not.**
The patch mesh cache keyed on `face.level.i.j` with no body, so a retarget
served Miranda's vertex buffers as Iapetus's ground for every colliding key.
Worker heightfields committed with no generation guard, so results in flight
across a `clear()` landed under keys the next world reuses — and sat in the
drawn set's keep list, unevictable. The survey-sites hook keyed on
`[engine, address]` when sites are a function of the seed, so a world
replacement at the same address kept serving the old world's summits. Fourth
face of the same die: `stand()` committed `focus()` before validating the
site id, so a typo'd site moved the planetarium and then refused.

**The detail floor believed the sea.** `surfaceDetailFloor` stopped at the
first quiet level, and the sea clamp makes submerged stencils exactly flat —
so an ocean world whose ~6 aliased level-0 face-center probes all land at sea
reported floor 1, and the streamer capped the whole body there, silently,
forever. `rootSeed('d')`'s Earth: seaLevel 0.55, 9.9 km of relief, 23–34%
land, reported floor 1 against a true 9; 7 of 112 sampled ocean worlds trap
the same way. The walk carries past sea-flattened levels now and that seed is
pinned.

**Extrapolate in the frame you sample in.** The prefetch pushed the eye
forward in universe coordinates and converted with the body's current pose,
so the body's orbital velocity — which a hovering camera shares — displaced
the request set by v × 2 s: ~94.7 km east on Mercury, a phantom pyramid
refined forever at 12.8 ms a patch while a real descent prefetched along the
orbit instead of the ground track. This is the velocity form of "never sample
terrain in inertial axes", which has now shipped three times in three
disguises. Its sibling in the same commit: the streamer gated on
`hasSolidSurface` alone, so figured bodies streamed patches on the spherical
datum while the contact test, `surfaceRadius` and the stance camera use the
measured ellipsoid — ground ~3.5 km above the eye on Phobos, and from orbit a
spherical terrain shell floating around the shape model.

**Two constants that must agree will drift; make one the other.**
`GEOMETRY_KEPT` said it matched the streamer's cache and was 512 against 896
— under the 623 patches a whole-disk drawn set reaches, so mesh retention was
permanently inert on large worlds. The descent baseline's `DEFAULT_CACHE`
copied the 512 the same PR retired for 2,304, so every regression figure
described the oscillating configuration the change removed. `PITCH_LIMIT`
restated `ELEVATION_LIMIT`'s argument with its own number. Each is now the
other constant, or derived from it.

**`Number.MAX_VALUE` rounds to Infinity in a float32 uniform**, and
`Inf − Inf` is a NaN in the morph denominator — WGSL leaves `max(NaN, 1)`
indeterminate, so "level-0 patches never morph" held by driver luck on the
hardware at hand. A sentinel that must survive f32 has to be finite there:
`NO_MORPH_DISTANCE = 1e30`.

The rest, briefly: eviction called `geometry.dispose()` on geometries holding
the session-wide shared index — three r182 destroys attribute GPU buffers
with no refcount, so every eviction past the retention cap killed the 98 KB
index under ~450 live meshes; the evictor kept less than the requester
re-asked for every frame, a 12.8 ms-per-patch regeneration treadmill at the
cache cap; `#forget()` reset three of seven selection mirrors, so
`ir.terrain()` reported stale counters in exactly the states it exists to
explain; and `harness.sites()` offered six clickable survey sites on Saturn,
each of which threw.

**The 2:1 test could not fail.** The crack property looked the coarser
neighbor up by the parent key, which skips exactly the two-level mismatch
`balance()` exists to prevent — deleting `balance()` left the whole suite
green. The replacement pins a deterministic Miranda-radius case and was
watched go red under that mutation. Third regression test here to fail the
"can it fail" check, for a third reason.

One found and deliberately left: `installSurfaceFrame`
(`packages/universe/src/frames.ts`) negates east; the PR's `localTriad` is
the correct increasing-longitude one. Flipping the old one rotates every
restored landed save a half turn, so it wants its own change with a
migration story, not a line in a fix pass.

## The browser gets a driver, and shipping stops at the pull request (27 Aug 2026)

Three changes to how work is done here, none to what the code does.

### The browser is `scripts/drive.mjs`, and nothing else

Agent browser sessions ran through the Claude-in-Chrome extension, which drives
the _human's_ Chrome. Its screenshot takes focus, and focus is the resource the
page needs: `requestAnimationFrame` is suspended while a window is occluded, so
the tab it just took focus from stops rendering and the one it gave focus to is
whichever of the two `localhost:5173` tabs it guessed at. Recovering that needed
AppleScript to raise a window, which then fought whoever was using the machine.

The driver launches its own Chrome on its own profile and debugging port and
needs no focus at all, because `Emulation.setFocusEmulationEnabled` plus
`Page.bringToFront` makes the page render while occluded. Three other things it
has to do, each of which cost a round trip when they were discovered:
`Page.captureScreenshot` rather than a canvas readback, because the renderer is
WebGPU and the swap-chain texture is invalidated at the end of the task that drew
it — `toDataURL` returns transparent black on a frame showing two-thirds of a
planet; readiness on `window.engine.gl` rather than `window.ir`, which appears
seconds earlier; and a real window rather than `--headless`, because headless
macOS Chrome falls back to a software WebGPU adapter.

**Boot is the cost, so Chrome is left running.** A cold start is the dev server
plus about ten seconds of shader warm; a second invocation attaches to the booted
page and returns in **86 ms**. That is what makes a step list worth having —
`--js`, `--wait`, `--shot`, `--sample`, `--reload` and `--logs` run in the order
written, in one process, so a whole verification is one command. `parseArgs`
returns a map and loses that order; `tokens: true` gives it back.

Two smaller decisions. A `--shot` is downscaled to 1568 px on its long edge,
because that is where the reader downsamples anyway and beyond it a larger file
is bytes spent on pixels nobody sees; `--max-px 0` keeps the native capture for a
plate. And a `--url` the attached page is not already showing forces a re-boot
rather than attaching: the mode is a function of the path _and the query_, so a
booted page on `/` is not a booted page on `/planetarium`, and one on
`?at=…/b:5` is not one on `?at=…/b:2`. Attaching regardless screenshots the
wrong subject under the right caption, which is the failure a capture rig must
not have. The comparison is over the keys the URL **asks for**, never the whole
search string: `CinemaPlayer` rewrites `t` on every frame and `PlanetariumMode`
rewrites `at` on every target, so an exact match would miss on a page already
showing exactly what was asked for and turn every warm attach into a re-boot.

**A CDP command timer holds the event loop open.** Every request armed a
two-minute timeout and none of them were cleared on the reply, so an invocation
that printed its answer in one second still took two minutes to exit — which
reads as a hung driver and is a forgotten timer. `clearTimeout` on the reply, and
`unref` besides.

### The pull request opens ready, and review is a separate command

`ship` opened a draft and marked it ready once CI was green, which put the
invariant audit, the documentation audit and the screenshots in the window
_after_ the PR existed, to overlap them with CI. They are now all before it: a PR
that opens ready is one whose evidence is already attached, and the overlap it
gave up was never real — `check.yml` runs `on: pull_request`, so no CI exists to
overlap with until the PR does. The gate and the two read-only audits still run
concurrently with each other, which is where the minutes actually are.

**The checks are scoped to the diff.** Running all of them on every change is
not thoroughness; it is a slower way to reach the same PR, and it teaches the
reader that the verification section means nothing. A prose-only diff is verified
by `pnpm format:check` and by having been read while it was written — the browser
cannot say anything about a paragraph and `pnpm build` cannot say anything about
a heading. Config and tooling get the full gate and no browser, because there the
thing that broke is the thing that runs the gate. Source gets everything, and
anything visible gets a picture. The two calls the table cannot make: prose that
states a fact about the code is verified by running that one thing, and a diff
that looks like documentation but carries a `.ts` file is a source change with
documentation in it.

Reviewing is deliberately not part of shipping. `/code-review --fix` is invoked
on the finished PR, by hand, which is also what makes the cloud `ultra` variant
reachable.

### Rebase, never merge

`main` carries a ruleset with `required_linear_history` and the repository allows
squash merges only, so a merge commit cannot land — a branch behind `origin/main`
is rebased or it is not mergeable. `ship` rebases **first**, before the gate:
`pnpm check`, an audit and a screenshot are evidence about one specific tree, and
taken against a stale base they describe a tree that will never exist.

The deny matcher on `Bash(git push --force:*)` also matched `--force-with-lease`
by prefix, which is the ordinary end of a rebase, so the flow it was protecting
would have stalled on its own guardrail. It is narrowed to `git push -f`;
everything else falls to the existing prompt, and `main` stays protected by the
`git push … main` matcher and by the ruleset's own `non_fast_forward` rule.

## A hundred and twenty thousand words go inside the application (27 Aug 2026)

`docs/` had been readable in exactly one place — GitHub, by somebody who already
knew the repository existed. `/docs` is now a mode: 904 pages, of which 71 are
the markdown in this repository and 820 are exports of `packages/*` rendered
from TypeDoc's reflection tree. [ADR-0016](docs/adr/0016-documentation-as-a-mode.md)
carries the decision and the four alternatives it beat; what follows is what the
building measured.

**The masthead is where all the surprises were.** The design is a band of live
simulation across the top of every page, and the observatory centres its subject
in the _whole canvas_ — so a framing that fills half the frame puts the body
entirely behind the reading plate and leaves the dark cap of a disk in the band.
Every intuition about `fill` is therefore backwards here: the working values are
**above 1**, so the body overfills the canvas and the band cuts a slice out of
it near the top, where there is a limb, an atmosphere and a terminator instead
of the top of a circle.

The tilts are negative for the same class of reason. Tilt rolls the camera out
of the star's plane, so a positive one puts the camera above it and the lit face
below — behind the plate. Measured at 1600x900 on Earth: `phase -135, tilt +14`
is the night side across the masthead, and `phase -135, tilt -30` is the
terminator with the sun in frame beside it and the anamorphic streak running the
width of the band. The five wings frame Earth, Saturn, Mars, Jupiter and
Neptune.

**`s:SOL` cannot be a masthead subject.** A star has no limb to cut a band out
of: at any framing that keeps it clear of the plate it is a point of light
behind the plate and the band is black, and at a framing large enough to reach
the band it is a wall of blown white behind the title. Neptune took the
reference wing instead.

**The presentation watchdog fires on a legitimately dark scene.** Cold-loading
`/docs` on a framing whose visible slice is a planet's night side sampled as
black, so `render/presentationWatchdog.ts` climbed its whole ladder, rebuilt the
renderer once and gave up — correctly, by its own design, and for nothing. The
framings above are bright enough that it no longer fires, but the interaction is
worth knowing: a _dark by intent_ first frame is indistinguishable from a
canvas that never presented.

**Numbers.** The build takes about eight seconds, almost all of it TypeDoc
converting twelve packages under the root `tsconfig.json`. The staged output is
6.2 MB: a 180 KB manifest fetched before the navigation can be drawn, a 572 KB
search index fetched on the first keystroke and not before, and 904 page bodies
of which the largest is 100 KB (`hosting`, which is mostly Mermaid and shell).
Mermaid code-splits into its own chunks and is imported only on a page with a
diagram.

**The reading plate is `slate-950/92` over a blur, and that alpha is measured.**
`.hud-layer` clamps the canvas to standard range, so the brightest thing that
can be behind a paragraph is diffuse white; 8% of it composites to about
`#202428`, where `slate-300` body text is 9.9:1. The contents drawer on a phone
is the one **opaque** surface in the interface: at 97% the article behind it was
still legible as text, because prose is high-frequency in a way a starfield is
not, and 3% of `slate-300` reads as a second column of words while measuring as
nothing.

**Two things tried and dropped.** The masthead carried the document's own lead
under its title, which reads well in a search result and badly on the page it
came from — `concepts/coordinates` stated its opening sentence in the masthead
and again eight lines below it, where the author put it. And the API index rows
carried a kind column, which under a heading that already says `Interfaces`
repeats the word fourteen times and carries nothing.

**A stop list has to travel with the index it was applied to.** The matcher
requires every term, and the build drops `the`, `and`, `for` and forty more from
every page's vocabulary — so a query keeping one of them requires a term nothing
can satisfy and returns nothing at all. "The harness" found it. `search.json`
now ships its own list and `tokenize` filters against it.

## The camera gets a lens, and every terrain number is re-measured through it (28 Aug 2026)

The engine stated its field of view in nine places and three values, and the
predicate that spends the number hardest read none of them. `selectTerrain`
refines while one grid cell subtends more than 16 px, and the pixels came from
`DEFAULT_VIEWPORT` — 60° over 1080 — which is neither the flight lens (65°), nor
the cinematic one (45°), nor anything the field-of-view slider's 20–110° passes
through except in transit. [ADR-0017](docs/adr/0017-the-lens.md) carries the
decision and the five alternatives it beat; this is what the building measured.

**The lens is 848 px/rad against the guess's 935, and it costs 2–10% fewer
patches.** Standing at two meters, 1920×1080, 16 px a cell, on the terrain zoo:

| Lens            | px/rad | Earth | Zoo, standing | Zoo, descent peak | Saturated steps |
| --------------- | ------ | ----- | ------------- | ----------------- | --------------- |
| 60°, the guess  | 935    | 300   | 336–444       | 415–460           | 0 of 128        |
| **65°, flight** | 848    | 294   | 330–438       | 385–449           | 0 of 128        |
| 110°, wide end  | 378    | 264   | 300–408       | 334–415           | 0 of 128        |
| 20°, telephoto  | 3062   | 665   | 529–642       | 687–742           | **77–108**      |

**The plan's own arithmetic overstated the telephoto end by an order of
magnitude, and why is the useful part.** It predicted 21× the patches at 20°,
from `scale²` — the honest reading of the predicate in isolation. Measured, the
uncapped demand is 808 to 1,418 patches, 1.9× to 3.2×. Refinement runs out of
_levels_ before it runs out of budget: `surfaceDetailFloor` puts the zoo's floor
at level 9 or 10, and a balanced whole-disk tree has a floor of its own. A
predicate bounded above by the field's own detail cannot spend the square.

**The 768-patch cap binds at the telephoto end and nowhere else**, on 60–84% of
a descent's steps, reported as `saturated`. It is left where it is: 1,418
patches is 6.0 M vertices and 288 MB of vertex buffers, on a lens the player has
deliberately narrowed and where one level coarser is a four-pixel error rather
than a two-pixel one. The number is written down so the next person to want it
raised knows what they are buying.

**The angle survives the conversion, and the bound is stated rather than
claimed.** `lensForFov` on a 24 mm gauge puts the flight lens at
18.836226925409882 mm and the cinematic one at 28.970562748477143 mm. The round
trip through `atan(tan(θ/2))` is bit-exact for 70% of the slider's range and
never worse than 2.9e-14° across it; the cinematic 45° round-trips exactly and
the flight 65° is one ulp out. Carried into `framingDistance`, which goes as
`1/tan(fov/2)`, that is 7.5 nanometers at Earth's radius. Rounding to a tidy
19 mm would have moved it 0.85%, which is every `SHOTS` bookmark and every
`tng-intro` beat, so `compositions.test.ts` holds the bound.

**A body's tier now follows the lens it is looked at through.**
`LOD_THRESHOLDS.billboard` was 2e-4 of angular radius under a comment reading
"~0.2 mrad is roughly a pixel at a 60 degree FOV on a 1080p display" — a pixel
there is `atan(1/935)`, 1.07 mrad, five times larger. It is now a third of a
pixel of _diameter_, 1.97e-4 at the flight lens over the baseline, and in the
browser Atlas at 104,146 km draws as a `point` at 110° and a `billboard` at 20°.
The 1.7% shift in the shipped constant moves where a distant star becomes a
billboard, which is a plate review rather than a unit test; it was done at both
ends of the slider.

**Three fallbacks fired exactly when they were most wrong.** `flare.ts`,
`warpEffects.ts` and `planetarium/project.ts` read `camera.fov ?? 65` or `?? 45`
— and the `??` branch is taken precisely when the camera is not a
`PerspectiveCamera`, which is when the picture is least like the one the number
assumes. Two of them disagreed with each other by 20°. All three now take
`engine.lens`, which resolves the camera's own precedence.

**The planetarium's lens copy described a coupling nobody had wired.** The panel
said narrowing the lens "pulls the camera back rather than magnifying" and that
"the subject stays the same size"; `setFov` recorded an angle and nothing
re-solved the standoff until the next `focus`. Zoom, dolly and framing are three
acts with three controls now, and the browser confirmed each does its own: a
zoom moved the field and left `desired.distance` bit-identical, `Out` took
Saturn from 196.3 Mm to 273.8 Mm — exactly 1.18², the wheel's own notch — and
Hold Framing re-solved to 196.7 Mm, easing back toward the 0.55 fill it solves
for.

**The dolly buttons were wired backwards and the browser is what found it.**
`applyZoom` takes a multiplier on distance and `ZOOM_PER_NOTCH` is 1.18, so a
positive notch _retreats_. `In` was `+2`. Nothing in Node could have caught it —
the arithmetic is correct in both directions and only the label is wrong.

**The terrain viewport is display pixels now.** `App.tsx` multiplies the device
ratio by `aaDprFactor`, so at 4× AA the drawing buffer is twice the display in
each axis; supersampling raises the sample count, not the detail a viewer can
resolve, and feeding the raw buffer height into the predicate asks for 6.5× the
patches to draw geometry the resolve filter averages away. The engine divides
its own factor back out, and a `gameEngine.test.ts` property pins it: the same
window at 1× and 4× resolves to the same viewport.

**Two derived numbers settle scope on sight.** The hyperfocal distance is 5.37 m
at the flight lens on a 1520 px buffer, so everything at planetary range is at
infinity and sharp — depth of field can never affect terrain, which is why the
defocus _pass_ can be deferred while the _parameters_ cannot. And the circle of
confusion is a display pixel rather than a film convention: 23.7 µm on a 24 mm
gauge over 1520 px, against the 29 µm full-frame print rule, close enough to be
a sanity check and moving with the display the way the blur it predicts does.

## The instrument the lens is operated from (28 Aug 2026)

[ADR-0017](docs/adr/0017-the-lens.md) gave the camera a lens and the terrain a
predicate that reads it. What nothing had was a hand on either: the planetarium
is the mode whose whole subject is looking, and its controls for looking were on
three surfaces, two behind the author's disclosure. The aperture, the focus and
the exposure were behind the console key.

Phase 1.6 of [the terrain plan](design/plans/terrain.md), in full.
[ADR-0018](docs/adr/0018-the-instrument.md) is the record.

**Two grep-able claims, and they are the point.** One
`addEventListener('keydown'` in `apps/game/src` outside tests, where there were
nine; one `localStorage` call site, where there were five. Neither is tidiness —
`input/keymapStore.ts` can arbitrate a chord only because it sees every one, and
the preference export exists only because one file knows the whole set.

**The `Space` bug, as an ordering.** `Space` was the global pause key and the
cinema player's transport. Both listeners were on the window, `preventDefault`
does not stop the other (only `stopImmediatePropagation` would), so one press
flipped `clock.paused` twice: the documented play/pause control did nothing at
all, with nothing in the console. `LIVE_SETS` enumerates every set of contexts
that can be live at one moment, and the check runs against those rather than
per-context — because `global` is live beside everything, and a rule phrased as
"conflicts within a context" misses exactly this pair. Four shadows total, all
deliberate, pinned in a test: `Space` (cinema over pause), `Escape` twice (a
dialog and a running scene over the cinema library), and `/` (the reading room's
search over the catalog's).

**Three shell flags disappeared into contexts.** `axes: mode === 'flight'`,
`pause: mode !== 'cinema'` and `mode !== 'docs'` were booleans threaded through
`App` that turned parts of a listener off. They are a context claim, a
specificity, and a mute declared where the reading room is.

**The rise geometry, and the 0.28° that decides it.** `riseStance` takes a
_displacement_ to the parent rather than a direction. Read as a direction the
answer is wrong by `asin((R + h)/d)` — 0.28° for Earth from Luna, against a
clearance being solved for of 3°, so 9% of the answer. The quadratic in `cos θ`
closes; both roots satisfy the squared equation and only the one whose
`d·cos θ − r` agrees in sign with `sin α` satisfies the original, and the other
stands the eye on the far side of the body with the parent under its feet. The
round trip against `riseClearance` holds to 1e-9 radians over Phobos-to-Ganymede
radii, three to two thousand parent-radii out, at any parent direction.

**The lens spans twenty-two to one across the pairs a rise has to work for.**
Earth is 1.90° across from Luna and Mars is 42.39° from Phobos, so the lens is
part of the picture rather than a setting beside it. `riseFov` clamps to the
slider's 20–110°, which is doing real work at the long end: Earthrise wants
11.4° and gets 20°, because that is where the terrain predicate saturates
(§ 2 of the plan). The captured plate is right otherwise — Earth over the
lunar limb from 110 km, horizon on the lower-third line.

**Three of sixteen compositions were ship-only, and the reason was one line.**
`observerPose` is `lookAlong(−offset, up)` — the target's center, always — so
`glint`, `sunset` and `oblique`, which aim at a limb or a specular point, could
only be taken by teleporting a hull. With the aim solved as a look offset there
is one list and two placers. `sunset` at 1.04 radii and `oblique` at 1.35 land
on the _surface_ arm, which is the honest reading of what they are: a stance
four hundredths of a radius up.

**A zero look offset returns the base quaternion itself**, not its product with
the identity. The product is exact for every field; stating it as a branch is
what keeps it true under a later change to `multiply`, and the compositions are
fitted against that pose.

**A drag now moves the picture by the pixels dragged.**
`DRAG_RADIANS_PER_PIXEL` is a constant, so at 8× zoom a 100 px drag swung the frame through three of its own
field-widths. The sensitivity is `pixelAngle(lens,
viewport)`.

**Two the audit found before it shipped**, and both are the same shape — a
number that was right in one unit and read in another.

`ir.preset` fitted its lens by writing `engine.flightLens`, and the shell owns
that field: `camera.lens` is a persisted preference and an effect re-asserts it
on every render-preference change. So a picture held its lens until the next
unrelated toggle — press The Rings, change the anti-aliasing, and Saturn goes
from 0.660 of the frame height to 0.812 with the A ring's outer edge off both
sides, which is exactly what that picture's 80° exists to prevent.
`requestLens` writes **both**: the field, because `framingLens()` is read on the
very next line and a `fill` standoff is solved against it, and the shell's
setter, because that is what survives. Routing through React alone was tried and
is wrong for the first reason — the state update is asynchronous, so `the-rings`
composed at 2.735 radii wearing an 80° label instead of 2.249.

And the drag sensitivity was radians per **display** pixel while a pointer delta
is in **CSS** pixels. `lensView().viewport` keeps the device ratio deliberately —
the terrain predicate and the circle of confusion are claims about physical
pixels — so on a 2× display the picture moved at half the rate of the hand, and
on a phone at two thirds, which is the case free look exists for.
`GameEngine.displayRatio` is the missing factor and `dragSensitivity` spends it;
the test is that the same CSS window drags at one rate at 1×, 1.5× and 2×.

### Bugs this pass found, worth not reintroducing

- **A plate captured from the menu is seven files, all the right size, all
  wrong.** `ir.preset` moves the observatory, and the observatory produces a
  camera only while a layer is holding it — a stance the planetarium pushes on
  mount. Every verb succeeded and every capture was a picture of the menu.
  `scripts/presets/plates.mjs` names the page for this reason.
- **`chordLabel` printed `Shift + /` on Chromium and `?` everywhere else.**
  `getLayoutMap()` answers what a key types _unshifted_, so a rule of "use the
  US shifted table only when there is no map" is inverted on the one browser
  family that has the information. The test compares the unshifted character
  instead, and names AZERTY's `Slash` as the case where the table is genuinely
  wrong.
- **A key-up compared as a whole chord misses its own key-down.** Shift can go
  down or up between press and release, and for a held axis "misses" means the
  thruster never stops. The release matches on the physical code alone.
- **An inline `--js` IIFE returns `null` through the driver.** The multi-step
  capture is a `--file`, which is what `scripts/drive.mjs --help` already says.

## The ground stops being noise and becomes a geology (28 Aug 2026)

Phase 2 of [the terrain plan](design/plans/terrain.md), in full.
[ADR-0019](docs/adr/0019-the-geology.md) is the record.

Three bands of noise is the smallest number that reads as a planet and the
largest that can read as anything _in particular_. Mercury and Titan came out of
it as the same rolling fBm at different amplitudes, because `SurfaceParameters`
carried a seed, a peak, a frequency and a sea level and nothing downstream could
know more. It now carries a `SurfaceGrammar` derived from the body's own facts,
a per-body sketch of plate nuclei, hotspots and a crater ladder sits under it,
and six bands evaluate against that.

**What comes out, checked against the published numbers.** Mercury: saturated
(crater density 0.97), one lid, largest basin 1,098 km against Caloris's 1,550,
floors flattening past 7.8 km. Luna: 0.86, largest 782 km against Imbrium's
1,145. Mars: 0.47 and 1,525 km against Hellas's 2,300. Earth: 0.19, 22 plates.
Venus: 0.00 craters and **one** plate — the same size and age as Earth, and the
only input that separates them is standing water, which is the leading
explanation for why one of them subducts. Callisto: 37% relaxed at 134 K; Pluto
0% at 40 K, which is why its water-ice mountains stand.

**`maxElevation` is a strength limit rather than a dial.** `σ/(ρg)` with σ =
3.2 × 10⁸ Pa calibrated on Olympus Mons, capped at nine percent of the body's own
mean radius and at 22 km. Each of the three binds on a different class of body:
strength on the planets (Earth 5.9 km, which understates Everest because a static
limit describes what a crust holds rather than what a collision is still doing),
size on a 50 km moon where strength alone would allow 5,000 km, and the ceiling
on Luna where it would allow 59. Twenty-two kilometers is the largest relief
measured on any body in the Solar System, and Vesta and Mars carry the same
number four orders of magnitude of gravity apart.

**The crater lattice is cubes in ℝ³, and the cube-sphere grid is the trap.** A
crater straddling a face edge has to hash the same from both faces, and at the
eight points where three faces meet a cell has _seven_ neighbors — `regionNeighbor`
says so in its own docstring — so a ring walk counts one twice and that crater
comes out at double depth, on every world, at eight places. A cubic lattice has
no seams and no corners: a cell is `floor(d · s)` whoever is asking. It costs a
3×3×3 neighborhood, and the exact box-sphere test rejects a third more of those
twenty-seven than a bounding-sphere test would.

**Two optimizations that were not.** Splitting each hash lane into halves answers
all eight of a cell's questions from one `pcg4d` instead of two and saves half a
millisecond in twenty-one; the lanes stay whole. Writing the crater's jittered
center out unnormalized and taking `2 − 2 cos θ` straight from the dot product
_did_ pay — one divide where there were three, on the band's inner loop — and so
did flattening the gradient table.

**The gradient table was an array of arrays, and `noise3` was four times slower
for it.** 209 ns a call became 47, with identical output; the golden vectors are
the assertion. That is a fifth of a heightfield patch, and it is why the band
stack is under three times the documented Phase 0 figure instead of five.

### The numbers

| Measured                            | Was     | Now                               |
| ----------------------------------- | ------- | --------------------------------- |
| A bordered 65×65 patch              | 12.8 ms | 9–37 ms across the zoo            |
| The same three bands, re-measured   | 12.8 ms | 3.6–3.8 ms                        |
| `noise3`                            | 209 ns  | 47 ns                             |
| `surfaceDetailFloor` across the zoo | 7–10    | 10–16                             |
| Whole-disk selection, flight lens   | 410–480 | 380–862                           |
| `DEFAULT_MAX_PATCHES`               | 768     | 1,024 (208 MB in the corner case) |
| `REQUESTS_PER_FRAME`                | 8       | 24                                |

An atmosphered world is half again as expensive as an airless one, and the reason
is one branch: its erosion damping is the only consumer of the analytic gradient,
and `gradientNoise3` is four times `noise3` — the value is one trilinear
interpolation and the gradient is three more. Every band that does not read a
slope calls the v1 primitives.

**The detail floor is what moved everything else.** Crater rims are sharp — a rim
is about a seventh of its crater wide — so resolving one to half a meter takes
samples seven times finer again, and `surfaceDetailFloor` reports it without a
constant to raise, exactly as ADR-0015 said it would. Every extra level underfoot
is another ring of about ninety patches, which is why the cap moved and why the
streamer's per-frame request budget tripled: the ladder is strictly serial, and a
landing that used to sharpen in eighty frames wanted two hundred and fifty.

**The crater ladder's depth is the dial that connects the two.** Capped at eleven
halvings, so a body's finest crater is a two-thousandth of its largest — a
kilometer on Mercury, a hundred meters on Callisto. Fourteen halvings gives 134 m
craters on Mercury and pushes its floor from 14 to 16, which doubles the patches
a landing generates: 1,250 against 600. Three decades of crater diameter is what
a body reads at from orbit to a landing, and below that is the micro-relief tail
Phase 4 synthesizes per pixel rather than meshes.

### Bugs that must not come back

- **A quiet level is not a floor when the field has discrete feature scales.**
  `surfaceDetailFloor` took the first level whose residual fell under tolerance.
  With a crater ladder a stencil that straddles nothing at one level lands on a
  rim at the next, and the level it returned had a residual of 1.01 m against a
  0.5 m tolerance. It takes three consecutive quiet levels now, which is the
  claim it was making all along.
- **A sea datum scaled by a constant floods or drains the whole world.** The
  clamp was `(2s − 1) · maxElevation · 0.55`, a number that matched the old
  continents band's amplitude. With the budget divided into shares, a world whose
  grammar spends most of its relief on craters has its ocean floor at a fifth of
  that, and the datum lands below every seabed on it — a dry basin with a sea
  level in it. It is scaled by the hypsometry band's own share.
- **A `WeakMap` on `SurfaceParameters` is not a cache for a worker.** The
  heightfield task rebuilds a fresh surface from its payload on every call, so
  object identity is never shared and every patch derives its own sketch — a
  millisecond apiece against a twenty-millisecond patch. Keyed by what the
  derivation reads.
- **The bimodality of an elevation histogram is not the share of samples in the
  middle third.** Two deep basins stretch Mercury's range and pile everything
  else into the top third, so that statistic reads the one-plate world as _more_
  bimodal than Earth. Sarle's coefficient — `(skew² + 1) / kurtosis`, above 5/9
  for two modes — puts Earth at 0.76 and the four stagnant lids at 0.36–0.40.
- **An imported one-liner costs thirty-five nanoseconds a call under vitest and
  one under Node.** Vite's SSR transform rewrites every reference to an imported
  binding into a property read on a module-namespace object. The crater loop
  reads four of them per cell over a million cells a patch, which put a patch at
  **98 ms** under the test runner against 20 under Node's own loader — and it is
  what made the four tests that stream a whole landing take two minutes each.
  Destructuring the namespace into module-local consts once, in `craters.ts`
  alone, brought it to 25 ms. It is a rename rather than a copy, and the same
  change to `bands.ts` — which calls the same primitives ten times per sample
  rather than a million times per patch — moved the number by 0.7 ms and was
  reverted. The lesson is about where to measure: the harness is not the build.
- **A ridge-fold derivative property tested nothing under `fc.double`.** Doubles
  bias toward whole numbers, Perlin noise is identically zero at every lattice
  point, and that is exactly where `1 − |n|` has its kink — so the skip that
  keeps the property honest fired on 196 of 200 samples. Integers over a prime
  divisor, and the surviving count is asserted.

## The rim was a cliff and the damping was a bias (29 Aug 2026)

Two defects in the geology's own field, both found by `invariant-auditor` against
the phase that introduced them, both bounded by a stated invariant the code did
not keep.

**The ejecta blanket entered at full value one crater radius out, so every
crater on every body had a vertical wall at its rim.** `r⁻³` is largest exactly
where the blanket begins: the apron's outer end was faded to zero and its inner
end was not, which is a step of 7–17% of the crater's depth at precisely the
radius the rim crest sits on. Measured by bisecting to adjacent doubles along a
great circle: **590 m across 1.7e-10 m of ground on Iapetus**, 432 m on a rocky
airless world, 313 m on a rocky atmosphered one. The tell is the ratio of the
largest adjacent-sample jump to the p99.9 jump — 14.4 on Iapetus where a C1
field gives ~1 — because a crater rim is _genuinely_ steep and a large jump on
its own proves nothing.

That is not a cosmetic seam. `elevationAt` is the one function the mesh and the
contact test share, and ADR-0019's "one field, at every level" is exact only
because a parent and its child evaluate the same function — which two patches
straddling a step at different levels do not. `craters.ts` fades the apron in
over `smoothstep(1, RIM_OUTER, t)`, where the rim ring has already returned to
zero.

**`fbmField` and `ridgedField` divided a damped sum by an undamped norm**, which
does not attenuate detail — it subtracts a bias. The amplitude the damping
removed never reached the numerator and never left the divisor, so the mean
walked toward zero and `ridgedField`'s `·2 − 1` remap walked it toward −1:
measured means of **−0.644 at `damping: 1` and −0.890 at 6**, against +0.255
undamped, on a function whose docstring promises "roughly [−1, 1] … so the two
are interchangeable as band inputs".

`bands.ts` then amplified it. The stagnant-lid branch returns
`(1 − ranges)³·2 − 0.1`, which reaches 1.9 as `ranges` goes to zero — so the
band meant to draw lobate scarps was a near-constant pedestal of **3,064 m on
Mars and 2,625 m on Venus**, exceeding its stated [−1, 1] on 97.5% and 99.6% of
samples. `norm += amplitude * damp` in both fields; the `clamp` every other exit
from `beltBand` already had, on the one that did not.

**The floor came down four levels and the cap got its headroom back.** With the
step gone, `surfaceDetailFloor` reports 10–16 across the zoo where it reported
13–17, Iapetus falling 16 → 12, and a whole-disk selection costs 380–862 patches
where it cost 420–1,008. `DEFAULT_MAX_PATCHES` stays 1,024 and that is now a
measurement rather than a hope: 862 is 84% of it, against 1,008 and 98% before —
768 would still bite, so the raise in the phase before this one was right for a
reason that survived the fix. `REQUESTS_PER_FRAME` and `MAX_CRATER_LEVELS` did
not move; the baseline reports "budget bit on 0 steps" on every body.

**The regression test measures continuity rather than steepness.** A large
adjacent jump is not a defect; what separates steep from discontinuous is
whether the gap closes as the two samples are brought together. `geology.test.ts`
finds the worst jump on a great circle, bisects sixty times to a sub-nanometre
separation, and asserts the gap went with it — 1 m bound against a 2.4 mm worst
survivor and a 590 m defect. Reintroducing the step fails it on Luna by three
orders of magnitude.

**And the same class of step, twice more, at plate boundaries.** `hypsometryBand`
blended a plate's base toward the average of it and its neighbor with a weight
that started at **0.5** rather than 0 — and `plate`/`neighbor` swap as you cross
the line, so half the difference between the two plates stood as a cliff:
**9,433.9 m on Proxima Centauri II, 46% of that world's whole relief budget**,
and 891.2 m on Earth. `beltBand` then read `plate.continental` and `plate.step`
where they flip while `edge` is _one_, which is a second 1,347.6 m step on Earth
— and the hypsometry blend was partly masking it, so correcting that alone made
Earth **worse**. Both go through one `acrossBoundary` helper now: the average is
the only combination of two plates that is symmetric under the swap, so weighting
from it at the line to the plate's own value in the interior is what makes a band
continuous. A boolean becomes a fraction on the way through, which is what a
passive margin actually is, and the volcanic arc fades over its own margin rather
than being gated on a bit that flips.

**What that does not fix, and the shape of what would.** `plateAt` returns the
second-nearest plate, and _which_ plate that is changes discontinuously along the
locus where the second and third nearest are equidistant — a network of curves
through every plate's interior, nowhere near an edge. `acrossBoundary` reads
`neighbor` by construction and inherits it: **1,532.3 m still stands on Proxima
Centauri II**, pinned in `geology.test.ts` rather than asserted away. It is the
same shape as the cube-corner problem `craters.ts` avoids, and the fix is the
same: a partition of unity over every plate, so no rank identity enters. Every
Sol body including Earth is continuous.

`TERRAIN_ALGORITHM` does not move. `origin/main` is on v1 and the branch already
carries the one bump to v2, so v2 has never described a shipped world: changing
what it means before it merges costs nothing, where a second bump would claim a
migration that never happened. One golden vector moves with it — the damped
`fbmField` — and the undamped fields, `gradientNoise3`, `latticeSeed` and both
`pcg` lanes are bit-identical, which is what says the change is in the divisor
rather than in the noise underneath it.

## The cost of a sample, and the two seams that were not boundaries (29 Aug 2026)

Five findings that all touch `elevationAt`'s inner loop, taken as one branch
because every one of them changes terrain or its cost and each change means
re-measuring the same numbers. The budget first, so that the correctness work
had something to spend.

**Three ways the loop paid for an answer it already had.** The sketch was
resolved through a string key of nine floats — built 4,761 times a patch to find
a value that could not have changed, 1.7 ms on an airless world and 2.5 on
Earth; a `WeakMap` in front of the string cache answers the repeats while the
string map goes on sharing an entry between two equal surfaces built separately,
which is the case the worker's per-task rebuild needs. Three bands each did
their own plate lookup and `convergence` was paid twice, for an answer that
depends on nothing but the direction. And the belt band generated seven octaves
of ridged fBm — in the analytic-derivative form on anything that erodes — and
then multiplied it by an `edge` of zero everywhere outside a tenth of a radian
of a boundary. Together: Luna 20.0 → 17.5 ms a patch, Miranda 12.3 → 9.0,
Proxima Centauri II 33.8 → 24.8.

A fourth was in the selection rather than the field. `terrainSelect`'s numeric
region key was gated at level 12 on the reasoning that `surfaceDetailFloor`
returned nothing deeper — and the band stack moved the floor to between twelve
and sixteen across the zoo, seventeen on the worst generated body, so every
whole-disk selection deeper than twelve took the string fallback the key exists
to avoid, 1.8 ms a pass. The span goes to 2²², which is
the deepest level whose `i` and `j` still fit inside a double's exact integers.

**A crater the walk cannot see arrives as a cliff rather than not at all.** The
3×3×3 neighborhood's docstring claimed it contained every crater whose support
reaches the sample. It did not, for two independent reasons. The ejecta reach is
1.3 cells, because `craterLadder` sizes a cell to the level's largest crater
diameter and that crater's radius is half a cell. And the lattice is cubes in ℝ³
while the field is a shell cutting through them, so a crater's center sits off
the sphere by up to the cell's own width along the radius, is indexed _there_,
and has its profile measured from its projection — a crater directly underfoot
can be indexed a cell away for no other reason. Walking the reach alone still
lost 34 m on Luna. The walk derives its own bounds per axis from both, which is
about five cells an axis against three, and `craterFieldWithin` exists so the
test can walk two cells wider and assert the two are _equal_.

**Which plate is second is a rank, and a rank has a seam where it changes.**
`plateAt` returned the nearest plate and the second-nearest, and the phase before
this one made the blend between them continuous across the line separating them.
It was. The field still had a kilometer of cliff in it, because the pair also
changes along the locus where the second and third nearest are equidistant — a
network of curves through every plate's interior, nowhere near an edge. Measured
either side of one on Proxima Centauri II: the same nearest plate, base 0.432,
with the second jumping from base 0.224 to −0.894 at a `boundary` of 5.72e-2.

A sample now carries every plate within a quarter-radian of the nearest and a
band reads a property as a normalised weighted average over all of them, so no
rank identity enters and continuity is by construction — the same argument the
crater lattice makes about the cube corner. `convergence` is weighted over
_pairs_, because a convergence taken from the nearest plate and whichever is
second inherits exactly the same seam, and near a triple junction it runs through
the ground the belt band is loudest on. Largest gap surviving sixty bisections,
over twenty-four great circles: **Earth 3,081 m → 1.3e-4, Proxima Centauri II
6,070 m → 4.8e-5.** It costs about a percent of a patch.

The weight is `(1 − s)/(1 + s)` and not the plain complement, which is the one
place this changes a world rather than a defect. It is what the two-plate blend
was already spending, so where only two plates are in range the field is
unchanged; with the complement, Earth's elevation histogram smears until Sarle's
coefficient falls to 0.553, under the 5/9 at which a distribution stops having
two modes. It reads 0.583 as shipped, against 0.76 before the partition — the
triple junctions are genuinely more blended now, and that is the honest picture
of ground where three plates meet.

**The bug that must not come back is the test that missed it.** `has no step in
it` walked one great circle per body and bisected onto its single largest jump.
On Earth that jump was a crater rim — genuinely steep, genuinely continuous —
while 3,081 m of plate seam sat elsewhere on the same arc, and the test passed.
A one-plate world cannot exercise the tectonic bands at all, which is how the
first round of these survived; a one-arc walk on a world that can is the second
half of the same blind spot. It now bisects the four largest jumps per arc and
sweeps sixteen arcs on the worlds with plates, and truncating the plate
neighborhood back to two fails it on Earth.

**What it costs, measured across the zoo.** A patch goes 26.6 → 32.3 ms on a
rocky airless world, 25.2 → 35.9 on Iapetus, 12.4 → **8.8** on Miranda, which has
no craters and therefore keeps the budget savings whole — and 49.9 → **37.3** on
a rocky atmosphered world, which is _cheaper_ than before the crater walk
widened. Two levers on the crater walk remain deliberately unspent: its radial
bound is the cube's full width where the worst case measured over six bodies is
1.36 of 1.73, and `EJECTA_REACH` is 2.6 where the published continuous ejecta
deposit is often mapped to 2.

**The gradient lattice was hashing with the wrong function, and it cost twice.**
`gradientAt` called `pcg3d`, which returns three lanes, and read one — eight
calls per `gradientNoise3` and seven to twelve octaves a sample, so V8 exhausts
its inlining budget across the eight sites and never scalar-replaces the object.
That was the cheap half. The expensive half is that `noise3` hashes with `hash3`,
so the two gradient lattices were _different fields_: `bands.ts` picks between
`ridged3` and `ridgedField` on whether a world erodes and says the two give the
same number, and they were separated by up to 1.25 on a band whose contract is
[-1, 1] — two worlds a pascal apart got unrelated mountain ranges rather than the
same ones slightly more worn. Sharing `hash3` makes the claim true (they agree to
twelve decimals now, and `field.test.ts` holds them there) and takes the whole
analytic-gradient path from 59.7 ms a patch to 37.3. `hash3` is _written out_
rather than called, because composing it with `mix32` is two levels deep at eight
sites and calling it costs 14 ms a patch — 51.8 against 37.3 — where the same
call in `noise.ts` costs nothing measurable.

**The erosion damping was a dead dial.** `fbmField` accumulated each octave's
gradient scaled by frequency but not by amplitude, so the sum grew as
`lacunarity^i` instead of `(lacunarity·gain)^i` and saturated after three
octaves whatever `erosion` was: measured octave weights of 0.813/0.156/0.027 at
`damping` 1 against 0.850/0.128/0.019 at 24, a 48× range moving the fundamental
by three points. Every atmosphered world was three octaves of fBm paying for
twelve. With the amplitude in, `norm` had to stop accumulating the _damped_
amplitude too — dividing by it renormalizes each sample back to full range, so
the damping got **rougher** as it rose (total variation 29.3 undamped, 30.6 at
1.2, 41.7 at 24) instead of smoother. Against the raw amplitude it falls the way
the name says: 29.3, 11.9, 2.5. `ridgedField` remaps `2r² − 1` per octave rather
than `·2 − 1` on the sum, which is identical undamped — `2·Σa·r²/Σa − 1 =
Σa·(2r² − 1)/Σa` — and attenuates toward the band's midpoint rather than toward
−1 when damped, which is the bias the damped divisor was there to fix. `erosion`
is `1.2·air^1.5` where it was `24·air^1.5`, because the old scale was calibrated
against a dial that had already stopped turning.

**And three latent defects the same review found, none of which had a live
trigger.** `surfaceDetailFloor`'s three-level quiet run counted sea-flattened
levels toward the run and gated only its last, so `floor = runStart` could answer
with a level whose quiet was the clamp — the exact failure the paragraph above it
says it prevents. `surveySites`' memo key never learned about the grammar, though
its derivation samples `elevationAt`, which reads twenty of its fields; the
grammar goes in whole now, which is complete by construction rather than a list
somebody maintains. And the geology card in `dossier.ts` re-derived which of the
three relief limits bound a body, when on any body with a `publishedRelief` none
of them ran — Earth's card read "limited by what the crust can hold up" over a
crust limit of 5,910 m against its 9.9 km. `reliefLimit` reports its own source
now, because ADR-0014 makes every row on that panel a claim about the place, and
a mechanism that did not run is the one kind of claim it may not make.

`TERRAIN_ALGORITHM` does not move, for the reason the entry above it gives:
`origin/main` is on v1, this branch already carries the one bump to v2, and v2
has never described a shipped world. That window closes when it merges.

## The disk strobed twice a second, and the cache had promised more than it held (29 Aug 2026)

Reported as terrain jitter on Luna under the Earthrise preset, two to three
times a second, arriving with the finest level. It reproduced on a 3840x2400
drawing buffer and not at all on 1600x900, which is what made it read as a
rendering defect: the same body, the same stance, the same seed, and a strobe
that followed the display.

It was `GEOMETRY_CACHE`, sized from the wrong set. The constant was
`DEFAULT_MAX_PATCHES + 128` and its docstring said "only drawn patches get
geometry, so the ceiling is the selection itself plus enough slack" — but the
streamer does not hold the drawn set. `#build` takes the drawn set _and_ the
rung below it, and `#evict` keeps whatever the frame requested: the drawn set,
the starved children, and the whole pyramid under the ideal selection. A
quadtree's ancestors are a third again as many as its leaves, so that keep set
floors at ~1.33x the selection cap before the starved rung is counted. Measured
at Earthrise: **one frame's request list named 1,323 distinct regions against a
cap of 1,152**, with 98 held meshes outside the keep set and therefore always
available as victims.

So the streamer ran a treadmill. Four patches built a frame, four dropped that
it had wanted a moment earlier, `starved` sitting at ~70 instead of falling to
zero, and `buildPatch` on every frame forever — 267 samples at a 16.9 ms median
gap over a 4.3 s profile, which is the tell: a converged streamer builds
nothing. Every twenty-sixth frame the rotation took a patch the traversal was
refining through, `ready` returned false, the walk stopped ten nodes in instead
of 1,138, and the disk drew **four patches at level 1 where the frame before had
760 at level 7**. A Chrome trace of the deployed preview carries it frame by
frame: the frame either side of the collapse differs by **zero pixels** — the
scene is perfectly static — and the collapse frame differs from both by 30,050,
of which 17,391 are ground, at **2.29 Hz**. On screen every crater flattens to a
blank shell for one frame, twice a second.

The fix is `DEFAULT_MAX_PATCHES * 2`, and the first thing written about it here
was wrong: that the keep set is bounded by the selection cap and not by the
viewport, "measured 1,232 to 1,327 at both 3840x2400 and 5120x2880". Both
measurements were taken at Earthrise, **which is a hover** — and at a hover
`#lookAhead` collapses to the present, so the drawn selection and the requested
one are the same set and the keep set really is just one pyramid. Let the camera
move and they are two independently capped selections whose union grows with
both the buffer and the ground-track speed: 957 regions at a hover over
1600x900, 1,824 at a 20 km lead over 5120x2880, on Ganymede and Triton at 500 m.
So twice the cap is a number that clears everything measured with about 11% to
spare, not a bound anything proves — and the old cap of 1,152 was under the keep
set at 1600x900 too, on any camera that was moving. It is a ceiling rather than
an allocation, so the sizes that already fit pay nothing; full it is 416 MB. At 3840x2400 the streamer
now converges to 1,597 resident and **901 patches drawn against the 760 it
managed while thrashing**: correcting the cache made the picture both stable and
deeper, because a treadmill spends its build budget re-making ground it already
had.

`FIELD_CACHE` above it has carried this argument since the 3x3 window — "a cache
smaller than the working set does not degrade, it oscillates" — and the geometry
cache never got it. What hid the second case is that nothing reported it:
refinement gates on geometry, not on the heightfield, so `cached` sat at its
steady 1,421 and said nothing was wrong while the cache under it strobed.
`ir.terrain()` reports `geometry` beside `cached` now, and it was the counter
that ended the search — pinned at exactly 1,152, which is the signature
`FIELD_CACHE`'s own comment describes.

## The ground stops being a color and becomes a face (29 Aug 2026)

Phase 3 of [the terrain plan](design/plans/terrain.md), recorded in
[ADR-0020](docs/adr/0020-the-face.md). Terrain had one flat color under the
scene's ambient light — survivable while the streamed set was nine patches, and
not survivable once the quadtree draws the whole disk, because the ground is
then the picture of the planet.

**The split is by who can answer.** Latitude is the direction against the spin
axis, altitude is the radius and slope is the normal against the radial: a
fragment has all three for free. What a shader cannot derive is the body's past,
and that is four bytes a vertex — impact-fresh material, flood basalt, where the
crust sits on the body's own compositional ramp, condensed volatiles. Eight bits
a channel because every one is a fraction read through a splat weight. It morphs
with the geometry, bit-exactly, for the same reason the normal does.

**Rays are a short list rather than a wider walk.** Tycho's reach thirty-five of
its own radii where its apron reaches 2.6, and a lattice walk that wide is
hundreds of cells a sample. `rayCraters` enumerates the coarse rungs once per
body and keeps the youngest sixteen, reading every field back from the same two
hashes the height walk reads — so a ray system is centred on a bowl the field
actually digs. The test silences every other rung to say so, because comparing
the whole field against itself cannot: a fresh 60 km crater on the inward slope
of a 700 km basin reads _higher_ than the ground beside it, and four of Luna's
sixteen do.

**A mapped body's ground wears its published map.** The archive's photograph is
the truth about large-scale albedo and it is also what the approach view is
already drawing, so on those bodies the palette holds pure ratios, the material
multiplies the two, and the cover's invented channels switch off — the maria and
the ray systems are in the photograph, and a second set on top of them is two
disagreeing planets in one frame.

Numbers that settled things.

- **`BodyAppearance.color` means two different things and they differ by a
  factor of six.** A tint where there is a map, a color where there is not — so
  on Luna it is (1, 1, 1). Read as a reflectance it made lunar regolith 0.88
  against a published 0.136 and the lit side blew out to a white disk. Anchored
  properly, Luna is 0.136 with its mare at 0.073 against a measured 0.07.
- **The reflectance ceiling belongs on the reference, not on each deposit.**
  Enceladus reflects 1.375 at full phase; clamped deposit by deposit, its
  bedrock, its mantle and its ice all landed on 0.88 together and the moon had
  no contrast anywhere.
- **Three terms had to be matched before the two halves of a descent agreed**,
  and each was found by measuring across the eight-pixel gate rather than by
  reading the code. **Skylight added beside the direct beam** rather than taken
  out of it: 15% brighter than the photograph of the same planet on Mars.
  **The aerial veil**, which `render/planet.ts` carries because the atmosphere
  shell is a back-side sphere and only survives the depth test _outside_ the
  silhouette — so everything the air does in front of the ground has to happen
  in the surface material, and the terrain is inside the silhouette too: 48% on
  Earth, and a blue planet whose coastlines were in the wrong places. And **the
  deposits' own brightness on a body that has a map**: halved it was still 9% on
  Mars, almost all of it evaporite lifting ground the photograph had already
  drawn pale. Where a photograph exists it supplies the albedo outright; the
  deposits keep the roughness, the grain and the bump, which no map at ten
  kilometers a texel has an opinion on. With all three, the gate is 3.1% on Mars
  and 1.5% on Earth and the frames are the same picture.
- **An ocean is an invented channel too.** The generated field and the archive's
  photograph disagree about where Earth's land is — that disagreement _is_ the
  mapped-body carve-out — so painting deep ocean wherever the _generated_ sea
  datum said water goes put open sea over the map's continents. The override is
  gated on `invented`, like the maria and the rays.
- **The soft-limited crater sum carries no information about basins.** `tanh` at
  a raw sum several ceilings deep is within 2% of its asymptote over half of
  Luna, and reading the mare off it flooded 49% of the Moon. Read raw and
  thresholded at two and five ceilings, and gated by a _dipole_ rather than a
  noise — a noise spreads its power over several degrees and gives a body basalt
  in patches, where the measurement is 31% of the near side against 2% of the
  far — Luna comes out at 10.8% mare with the flooded directions averaging 0.61
  of a unit vector, where a hemisphere would be 0.5.
- **The cover costs 0.55 to 1.0 ms a patch** against 8.2 to 36.9 before.

### Four float32 defects, all of them the same defect

Reported as a coastline warping several times a second at two kilometers over an
island chain, and it was arithmetic in four places.

**Altitude was a difference of two planetary radii.** Both terms are 6.4 × 10⁶
on Earth where one float32 step is half a meter, so the water test — a band four
meters wide — read a quantized value, and the CDLOD morph walks `local` across
those steps every frame. `(2(a·l) + l·l)/(|p| + |a|)` is the same number and
never lets the large numbers meet; `anchorAltitude` carries the last half-meter,
measured in float64 against the same rounded vector the uniform holds, because a
constant offset per patch is a grid of rectangles across a flat sea.

**The map's UV gradient came from that same quantized position**, so the mip
level changed at every patch boundary. It is analytic now, from the tangential
part of a precise step — which also deletes the wrap hack, because the longitude
jumps by a whole turn along one meridian and its rate of change does not.

**The detail fade was a screen-space derivative.** `local` is linear across a
triangle, so `dFdx(local)` is constant over the whole triangle; at two
kilometers up, where one far cell covers a hundred pixels, the fade stepped per
polygon and the plain drew as flat-toned quadrilaterals. Distance times the
lens's own pixel angle is continuous, and it is the same lens the selection
refined against.

**And the bump normalized its position derivatives**, which is right for a
dimensionless texture difference and wrong for a height in meters: `det` stayed
per-triangle constant while `dH` grew with the footprint, so the bump
strengthened with distance and stepped at every edge.

Two more came out of the same look. The evaporite's "low ground" ran to a fifth
of the relief budget — 2.5 km on Earth — so every flat hectare on the planet was
a salt flat; it is 40 to 500 m above the shoreline now, and an ocean is excluded
outright, because an ocean _is_ the flattest lowest ground on a body and without
the gate Earth's sea surface came out as playa at 2.4 times the reference with a
white sheet of water under it. And a deposit's own brightness is halved where a
photograph already carries it.

### Two more the audit found, and a constant that had drifted from its own fit

**The ray filaments entered at full strength at their own gate.** The same class
`craterProfile` records above it, and the same shape: a term whose value does
not reach zero at its boundary appears there rather than beginning there. The
filament threshold is cleared on about a third of azimuths at 1.2 crater radii,
so crossing that radius stepped the brightness by 0.30 on Luna's ray craters and
0.57 on Mars's, against a p99.9 adjacent-sample step of 3 × 10⁻⁷ just outside.
It drew as a scalloped bright ring — a thirty-kilometer circle around a
fifty-kilometer crater — on every mapless body, which is nearly all of them.
Faded in across 0.4 radii, the step is 1 × 10⁻⁷, which is the probe's own
epsilon. `cover.test.ts` holds it, and it goes red with the fade removed.

The probe has a trap worth writing down: offsetting by `angularRadius · t` in
the tangent plane and normalizing gives `atan(span)/angularRadius`, which on a
50 km lunar crater is t = 1.19998. A tight scan either side of 1.2 then lands
entirely on one side and reports a step of exactly zero. The great-circle
rotation is the one that sees it.

**`GREENHOUSE_GAIN` was falsified by its own docstring.** The fit claims Mars,
Earth and Venus at 210, 288 and 737 K; at 0.0076 it produced 213, 296 and 913 —
Venus 24% high. At 0.0054 it produces 213, 286 and 739. No consumer noticed,
because every one of them only asks whether the ground is above 170 K or below
450, but a docstring that says "fitted" is arithmetic and this one was not.

**And capability check 10 was comparing half of what it claimed.** The heightfield
task transfers a cover beside the elevations and the check looped over the
elevations alone, so a worker whose sketch had diverged would have passed it and
drawn a different planet through an identical heightfield. It compares all
16,900 cover bytes now.

### What did not land, stated rather than dropped

- **No orbital albedo bake.** A generated body's sphere is still a flat tint
  while its ground has maria, rays and caps, so the far half of a descent is the
  one half that does not agree. A mapped body has no such gap. It needs a worker
  task, a cube texture with a slot allocator, and a second consumer in
  `render/planet.ts`.
- **No hex-tiling and no triplanar**, which § 2 of the plan specifies. Both
  answer questions an authored material set asks — a period to break, a
  projection to choose — and there are no authored textures. The detail is
  gradient noise on the body-fixed position, which has neither. The seam is the
  detail field in `render/terrain.ts`.
- **Deposits chosen from the mesh step at a level boundary.** Two patches
  covering adjacent ground at different levels report different slopes for it,
  so a weight read off the normal steps by about 4% of the drawn value on
  Earth's coastal plain. Widening the flatness bands to reach the angle of
  repose takes near-flat ground out of the transition and does not account for
  all of it; the footprint, the map gradient and the altitude were each isolated
  after their fixes and come back smooth on a fresh browser, so it is none of
  those three. The fix is for the deposits to read the canonical field instead
  of the mesh, which means more channels on the cover.
- **Shading terrain with a real light exposes the mesh's own normals.** The
  selection refines to about a pixel of error by design, so a low sun on
  saturated ground aliases where a flat ambient fill could not show it. At
  device pixel ratio 2 the same frame is clean.

## The ground goes below the field the ship lands on (30 Aug 2026)

Phase 4 of [the terrain plan](design/plans/terrain.md), recorded in
[ADR-0021](docs/adr/0021-the-ground.md). The ground at a two-meter stance was a
plane, and the reason is arithmetic rather than taste.

**The floor could not have moved, and the loop is closed.**
`surfaceDetailFloor` refines while one grid cell's middle differs from the
bilinear of its corners by more than `TERRAIN_DETAIL_TOLERANCE`, and that
tolerance _is_ `CANONICAL_AMPLITUDE_FLOOR` — deliberately, so the level past
which refinement stops buying detail is the level past which the field stops
having any. So a term bounded by half a meter cannot deepen the floor by one
level however fine its wavelength, and "detail below the canonical floor" read as
"amplitude under the floor too" is a field the mesh will never go and get. An
sub-floor crater band cuts up to 0.8 m, and that is what buys the levels.

The split is now two functions and a published number. `groundElevation` is the
contact test, the saves and the survey sites; `drawnElevation` is the mesh, the
material and the camera that composes a picture of them; and
`drawnDivergence` is **1.25 m**, by construction rather than by measurement —
`softLimit` is asymptotic to `MICRO_CRATER_CEILING` and the grit is a normalized
fBm. Nothing is versioned, because nothing canonical moved.

- **The floor goes 15/16/12/10 → 19/17/14/12 across the zoo**, which is cells of
  **0.35, 0.87, 1.10 and 1.41 m** against 5.54, 1.75, 4.40 and 5.66. That is
  "levels to ~1 m spacing", measured.
- **A patch costs 6 to 15 ms more** — 43.4 / 43.2 / 49.8 / 21.6 ms against
  32.5 / 37.2 / 35.0 / 8.7 — because the tail is four more rungs of the crater
  walk, and the walk is most of a patch. Measured with nothing else on the
  machine; the same command with Chrome up reads 79 to 84 and says nothing,
  which is the trap the Phase 3 entry already records and which caught this one
  too.
- **A whole-disk selection peaks at 1,077 patches** against 862, so
  `DEFAULT_MAX_PATCHES` is 1,280 and the corner case is 303 MB of vertex buffers
  — a patch is 237 KB, because it carries **two** four-byte cover attributes, its
  own and its morph target's, and the constant's own arithmetic counted one.
- **The ground measures 12.3° of RMS slope at a one-meter baseline on Luna,
  8.4° on Mars and 15.6° on Mercury**, against a published 5–20° for lunar
  regolith and the MER landing sites — and against **0.2° on Luna canonically**,
  which is what a flat plane measures. The first attempt was 1.6 m of ceiling
  and drew as broken glass at 21°; halving it is the statement that a
  _saturated_ population is in equilibrium and its members destroy each other,
  so the net relief is not the depth of one fresh crater.

### What the browser says

A two-meter stance on Luna, at the flight lens over 1600×900: **level 17, 895
patches, 7.33 M triangles**, and every counter a fixed point over 240 consecutive
frames — `cached` and `geometry` both 1,274 against caps of 3,840 and 2,560,
`starved` zero, `saturated` false. At 1920×1200 over a device pixel ratio of 2 —
the window that found the Phase 3 strobe — it reaches **level 17, 1,106 patches
and 9.06 M triangles**, and 120 consecutive frames are again identical. The
geometry cache is not the binding constraint at either size, which is what
`DEFAULT_MAX_PATCHES` at 1,280 was raised to buy.

**What is binding is generation.** The retina stance had not converged after
sixty seconds — level 15, 128 in flight, 17 starved — and had after a hundred
and eighty. 1,562 patches at 43 ms is 67 s of single-core work and the pool does
not turn that into 17, which is the Phase 5 argument arriving as a wall-clock
number rather than as a projection.

### The rungs are numbered from a fixed base, and `young` does not enter them

Continuing the canonical ladder needs a largest crater to count down from, and
`grammar.largestCrater` is zero on every surface `young` deletes — Miranda,
Enceladus, Europa, three of the most interesting places to stand. Anchored at
`MICRO_RUNG_BASE` instead, the tail is a property of the body's size and air
alone, its hashes cannot collide with any canonical rung, and Miranda's floor
moves two levels rather than none.

`young` is left out on its own argument: a resurfacing event deletes a crater
population, and retention at a meter is geologically instantaneous, so the moon
paved last week is saturated at a meter by the afternoon. Air enters harder
instead, because an atmosphere screens the small impactor and then fills the
hole in — `(1 − air)⁴` orders Luna 1, Mars 0.14, Earth 0.012, Venus 0. A world
with Earth's air keeps its canonical floor and gets its meter scale from the
scatter and the grain band, which is the right answer rather than a gap.

### A millimeter that differed between two patches

`2 − 2 cos θ` out of one dot product is how `craters.ts` measures the distance
from a sample to a crater, and it cancels. At the canonical ladder's finest rung
θ is about 2 × 10⁻⁴ and the subtraction costs seven significant figures, which
leaves the height exact to a nanometer. Three decades further down it is not
fine: a one-meter crater on a 1,700 km body subtends 3 × 10⁻⁷, so the expression
is 4 × 10⁻¹⁴ against a float64 ulp of 2 × 10⁻¹⁶ — half a percent, which is a
millimeter on the crater's own depth and, worse, a millimeter that **differs
between two patches that computed the same direction by different routes**. The
sum of squared component differences is the same number with nothing cancelling
and costs two divides a crater. `ChordForm` is the parameter; the canonical
ladder keeps the cheap form deliberately, because changing it would move
`elevationAt` in its last bits on every body.

### Rocks are addresses, and they wear the ground's material

`regionScatter` answers "does `r:…/o:837` hold a rock" with a hash — 1,024
candidate slots over a 256 m region, one rock per 64 m² at saturation, gated by
the cover the vertex already carries. `slots` is a half-open range because
resolving one candidate is a field sample and a whole region is 2.6 to 5.8 ms
across the zoo; the streamer takes it 128 slots a frame — 0.31 to 0.72 ms — and a
region is drawn only once it is whole.

They are drawn by **the terrain material itself**, not a second one. Three's node
material inserts the instancing before `positionNode` runs — `instancedMesh(
object )` assigns into `positionLocal` and `normalLocal` — so the graph reads the
instanced position and every term it derives is right for the rock rather than
for the field's anchor. A rock therefore comes out bedrock on its steep faces and
regolith on its top, in the palette of the ground it lies on, by the same slope
term that decides the ground.

Two things this cost, both worth remembering.
**Every rock was inside out, and three quarters of them were underground.**
Both found by `/code-review max --fix` after this had already opened, and both
invisible to every test that existed. The instance basis `(east, up, north)` is
_left_-handed — `north` is `up × east`, so `east × up` is `−north` — and three
columns in that order are a reflection with determinant `−sx·sy·sz`. The
terrain material never sets `.side`, so front-face culling applies, and Three
flips `frontFace` only on the _object's_ `matrixWorld` determinant, never the
per-instance matrix: every rock drew its far shell through the hole where its
near one was culled. `scatterRender.test.ts` asserts exactly that invariant one
object up, about the shapes rather than the instances.

And `sink` is a fraction of the rock spent against `rock.radius`, which is half
its _longest_ dimension while it is drawn 0.62 to 0.82 of that tall — so the
median rock sat entirely below the surface. `rockRise` is the drawn half-extent
now and the seat, the sink and the instance scale all read it. The fixed
twelve-centimetre seat then buried the small end on its own, because it is
taller than a 25 cm rock's own 17 cm of stand: **0 buried across 14,727 rocks
against 3,588 before**, in every size class.

**Two attribute names may not share one `BufferAttribute` object.** The backend
keys its GPU buffer on the object the geometry hands back, so one object under
two names is one buffer at two shader locations and the whole pipeline fails to
build — reported as `[Invalid ShaderModule "fragment"] is invalid due to a
previous error`, with the real message on the channel the page console does not
carry and the canvas never presenting. Isolated by un-aliasing the two
vertex-rate attributes and leaving the instanced pair aliased, which builds.
**And `warmCompile` swallows its rejection**, so the warm-up dummy failing the
same way was invisible until the real draw hit the same wall.

### The band between a mesh cell and a pixel

A patch at the detail floor is 0.35 to 1.41 m a cell, and standing at two meters
one of those cells is two hundred display pixels across. `MICRO_METRES` is a
seven-meter octave and there was nothing under it, so the near ground drew as a
smooth swell. The grain band is 0.7 m down to 9 cm at about fifteen degrees of
slope, which is what lunar regolith measures at centimeter baselines.

Its domain is the interesting part. `positionLocal` is patch-local, so a noise on
it jumps phase at every patch edge — invisible at seven meters of wavelength and
a straight line across the ground at seventy centimeters. The body-fixed position
is continuous and useless: 1.7 × 10⁶ on Luna, where float32 resolves 0.1 m and
quantizes a nine-centimeter octave out of existence. So the anchor is reduced
modulo `GRAIN_PERIOD` wavelengths **in float64 on the CPU** and the noise is
periodic over it — exact, continuous across every boundary, and repeating every
45 m of ground, which is more than the band survives to. It is written out rather
than taken from `mx_*` because periodicity is the one property none of the
built-ins has.

### What did not land, stated rather than dropped

- **The canonical crater ladder is still capped at eleven halvings**, so a body
  whose largest basin is 2,170 km has canonical craters down to 2.1 km and then
  nothing until the tail starts at eight meters. Measured, raising it to fourteen
  moves the detail floor by 0 to 2 levels and costs 13% a patch — it works, and
  it moves the field the contact test integrates, which is terrain algorithm v3
  and every save's landed hull. The plan spends that bump once and this is not
  the phase.
- **A rock's foot is the field and the ground under it is a triangulation of the
  same field.** They differ by the mesh's own interpolation error over one cell:
  3 to 9 cm in the mean at the detail floor and up to 0.70 m at the worst cell on
  the body with the coarsest floor. `MESH_SEAT` buries every rock twelve
  centimeters to cover the mean; the tail is a small rock on an atmosphered world
  standing a little proud. The fix is for the rock to read the mesh instead of
  the field, which is the same change the deposits want.
- **Scatter has no collision.** A rock is presentational until on-foot arrives,
  and the contact test does not know it exists — the same split the tail makes.
- **A rock reads as a silhouette under a high sun and correctly under a low
  one**, and the cause is not the palette: on a mapped body every deposit's
  ratio is exactly 1.000, so a rock's color is the ground's color and the
  difference is entirely in the shading. The suspect is the bump. Its height
  field is the grain band on `local`, and across a rock `local` changes by the
  rock's own width over a handful of pixels — far above the band's Nyquist rate
  — while `grainFade` keys on the _footprint_, which is the same for a rock and
  for the ground behind it. So the fade cannot switch it off and the
  perturbation swamps the rock's true normal; at a low sun the ground is dark
  and any normal reads plausibly, at a high sun the ground saturates and the
  rock reads as noise. **That is a suspect rather than a measurement** — a TSL
  graph cannot be evaluated in Node, so it is settled on a GPU or not at all,
  and it is not settled. The rocks are placed, solid and correctly oriented,
  which is what this phase claims; their photometry is the next thing to look
  at, and the material has no channel left to tell a rock from the ground with.
- **Iapetus at a two-meter stance draws a smooth white sheet**, and it does so on
  `origin/main` too: a flat icy plain at the reflectance ceiling under a high sun
  has no contrast anywhere, so the terrain is there and unreadable. It is not
  this phase's regression and it is not this phase's fix; the plate set moved to
  Luna, where the archive's photograph supplies the contrast.
- **`[Invalid ShaderModule "fragment"]` is printed at boot on `main` as well.**
  Reproduced on `origin/main` at the same site before any of this landed. Nothing
  visible fails with it; it is a thread to pull separately.

## The six instruments get the axis they were missing (30 Aug 2026)

[ADR-0022](docs/adr/0022-the-timeline.md) and
[the plan](design/plans/the-timeline.md) carry the decisions. What belongs here is
the measurements, and the three things the instrument found on the days it was
built.

**`performance.now()` in this app steps in exactly 100 µs, and it reshaped the
design.** `crossOriginIsolated` is false — nothing sets COOP/COEP, and
`frameMetrics.usedHeapMb` reading `performance.memory` is the other
confirmation — so Chrome coarsens the clock. Two hundred thousand consecutive
reads produced **two** distinct deltas, both 100.00 µs; a busy-wait of 40 µs
reads back as 100 µs and so does one of 90 µs. Terrain selection is documented
at 40–90 µs, so a span over it would have quantized to a single tick and lied by
up to 2.5×.

The answer was not to drop the span. It was **one clock read per boundary rather
than a pair per span**, so the phases _tile_ the engine step and the
quantization error redistributes between neighbors instead of accumulating.
Measured: the eight Engine phases sum to 271.4 ms against an `engine` total of
272.1 ms — 99.7% — and the five Terrain phases to 3.920 ms against
`Engine/terrain` at 3.921 ms. The consequence to keep is that a short phase is
honest **in the mean and not in the instant**: over a 240-frame window the
rounding is unbiased and the mean is good to well under a microsecond, but one
bar is not a reading.

**Terrain selection is 40–90 µs from orbit and 2.7 ms on a summit.** Standing on
Earth's summit site with a nine-level selection visiting 446 nodes,
`terrain.select` was **2.733 ms of a 4.461 ms engine step** — 61% of everything the
engine did, and 30–68× the figure `terrainStreamer.ts` had carried since it was
written. Both numbers are real; the comment now says which is which. This is the
same lesson Earthrise taught about keep sets, arriving from a different
direction: a figure measured at one operating point is a figure about that
point.

`terrain.request` and `terrain.evict` were briefly folded into one entry on the
assumption they were sub-resolution bookkeeping. The summit measurement
falsified it within the hour at 0.916 ms, and they are two entries again.

**A heightfield waits 2.94 s in the queue and then runs for 83 ms.** On arrival
at that summit, over 112 jobs: `queue` at 2937.75 ms mean and `run` at 83.45 ms,
with `PoolStats` corroborating — 124 queued, four workers, none idle. The pool's
header has always named the distinction ("slow tasks want optimization, a deep
queue wants more workers or fewer requests"); both numbers existed and there was
nowhere to see that one of them was three seconds. Per thread the four workers
took 52 jobs each at 53.38, 53.58, 53.68 and 53.94 ms mean, which is a balanced
pool and was also unstatable before.

**The whole preload and warm-up census runs twice on a cold boot.** 1798 ms,
then 920 ms 4.5 s later. Not StrictMode, which was the obvious guess and the
wrong one: the log says `canvas never presented despite nudges; rebuilding the
renderer`, and rebuilding the renderer re-runs the warm-up. It is the
presentation watchdog's documented recovery path, and the timeline is the first
instrument that could show it as a _shape_ — the panel does not exist yet at
boot, and the log is two identical sentences four seconds apart with nothing
relating them.

**The entry costs, measured rather than taken from Chrome's documentation.**
Against a 7.0 ns/iteration empty loop over 200,000 iterations, in Chrome, landed
on Earth: `console.timeStamp(label, start, end, track, group, color)` at
**46.5 ns** and `performance.measure` with a devtools detail at **988.5 ns**.
Net of the loop, ~40 ns and ~981 ns. At the ~22 entries a frame this emits,
`trace` costs 0.87 µs a frame — 0.005% of the 16.6 ms budget — and `full` costs
21.6 µs, 0.13%. The 25:1 ratio is the whole argument for two levels. Measured
with no DevTools recording active, which is the case that decides whether
turning `trace` on costs anything; under a live recording it will be higher.

**Retention is real and it is not only ours.** Three seconds at `full` retained
8,394 of this project's entries — and **338,065 of React DevTools'** in the same
timeline. That is why nothing here ever calls `performance.clearMarks()` or
`clearMeasures()` bare, and why the drain clears by name and by kind: `clearMarks`
does not remove a measure, so a drain calling one of them leaves half of what it
emitted. The sink's own ceiling is 250,000, which at the measured ~2,800 entries
a second is about ninety seconds — longer than any profile window, shorter than a
session somebody walked away from.

**A share of frame time is undefined for concurrent spans**, and it printed
**58,767%** before that was noticed. Worker queue waits overlap each other and
the frames they cross, so the ratio is arithmetically true and describes nothing.
`summarizeProfile` now detects the overlap empirically, per span, and prints an
em dash — empirically rather than by a list of track names, so a track added
later classifies itself.

**Two defects the tests found, both worth not reintroducing.**

`console.timeStamp` is not a function in this Node context, and the sink threw
through a `GameEngine` — a crash in a debugging aid, which is worse than the aid
being absent. It is bound once behind a `typeof` now. The trap is that this
guard and the _extension_ guard look like one question and are two: whether the
method exists is a `typeof`, and whether it accepts the four track arguments has
no query at all, which is why the level is the gate.

`timingInert.test.ts` took two attempts to become non-vacuous, and the first
attempt is the instructive one. Attaching a recording sink and leaving the level
`off` proves nothing — a sink _is_ what `on` means, so attaching one opens every
guard and the entries arrive correctly. The observable that means something is
the count of `performance.now` calls: **exactly 240 over 120 frames**, which is
the two reads `GameEngine.frame` already made before any of this existed. An
equality rather than a bound, because the claim is that the instrumented build
and the uninstrumented one do identical work. Checked against a clock read moved
one line outside its guard: 1200 instead of 240.

**What the trace event actually looks like**, because it is not guessable and
the answer belongs somewhere findable. An extended `console.timeStamp` lands as
a single _instant_ event carrying its own interval —
`cat: 'devtools.timeline'`, `name: 'TimeStamp'`, `ph: 'I'`, with
`args.data: { name, message, start, end, track, trackGroup, color }` — and
`start`/`end` are **microseconds on the trace's monotonic clock**, not the page's
`performance.now()` milliseconds. `performance.measure` lands separately under
`blink.user_timing` as a `b`/`e` pair joined by `id2.local` with the payload in
`args.detail` as a JSON string, which is where React's own tracks live.

That trace also settled the one claim the page structurally cannot check. Two
attempts to attach to a worker thread over CDP both hung; the trace answered it
for free — the `Tasks` track appears on **four distinct `tid`s**, one per worker,
while Engine, Terrain and Render share the main thread's. The level crossed the
worker boundary, the worker's own sink attached, and each side timed and emitted
against its own `timeOrigin`.

Finally, a figure **not** to quote: the `navigation to first light` entry read
8588 ms on the run that verified it. That is what the driver's occluded Chrome
waits while the presentation watchdog gives up twice, on a Vite dev server
transforming modules. The entry is verified; the number is about that window and
not about a player.

## The frame stops rebuilding what has not moved (30 Aug 2026)

The verifying pass over [perf and perf-2](design/plans/perf.md), since
consolidated into one plan of what is left. What is worth keeping here is what
the fixes had in common and the two instruments that were lying.

**Four of the five frame fixes are one shape: a rebuild key that mixes two
invalidation sources, so the cheap half pays the expensive half's cadence.**
The starfield rewrote twenty thousand stars whenever `origin.generation` moved
— every 4,096 m, which is every ninth frame in Earth orbit — for a buffer of
_directions_, which translation does not change. It is gated on parallax now:
the survey's identity, the origin's orientation and anchor exactly, and its
position within 1e-5 of the nearest star's distance. That star is the system's
own sun at ~1 AU, so the budget in orbit is ~1,500 km. `Render/starfield` in
the planetarium at Earth: 0.48 ms mean and 1.7 max, to 0.00 and 0.10.

`#maybeTraceOrbits` re-solved ninety-seven Kepler steps for every body in every
loaded system whenever the _focus_ changed, because the sampling and the scope
filter shared one key — 18.4 ms on a Sol retarget, 22.2 on a Proxima one, 12.3
on every planetarium mount. Split, with the path's anchor making it legal: four
retargets in one profile window leave `Engine/orbits` at 0.20 ms max. What does
age is the phase, since the sweep starts at the body's own eccentric anomaly,
and a full ellipse looks the same wherever it is cut.

`balance` rebuilt a depth map over the whole node list in each of its passes. A
summit selection settles in seven and the first is the only large one — the
passes split 72, 29, 12, 10, 5, 2 and 0 nodes, so six of them walked nine
hundred ancestor chains to find at most twenty-nine splits. Depth is monotone,
so the map is carried: 0.777 to 0.612 ms a walk with the selection
byte-identical. Two further ideas were measured and declined, which is the more
useful half — skipping the ring probe for nodes within one level of the deepest
is exact and worth 8%, because a summit selection is flat across levels
(5:8 6:60 7:75 8:75 9:75 10:80 11:60 12:64 13:55 14:32 15:16) and only 48 of
600 qualify; driving each pass from a recheck set costs more key arithmetic
than the eight probes it saves at those pass sizes.

And `snapshot()` formatted every body's address four times a frame — once for
the field, once through `bodyFrameId`, and twice inside a ternary that spelled
`bf:${formatAddress(…)}` on both arms. Sol is 129 bodies: over 30,000 formats
and 23,000 template strings a second, on the one path every operating point
pays. Memoized on the address object, in a `WeakMap` because a region address
is built fresh per call and a `Map` would be a leak with a per-patch growth
rate.

**Forgetting an answer is not retiring the work.** `TerrainStreamer.#epoch`
discarded heightfields that outlived their view; the jobs behind them ran to
completion, so a departure left up to 128 of them queued ahead of everything
the next view wanted. `#inFlight` holds the `JobHandle` now and `clear()`
cancels it. Landed on Mars and then looking away: queued 124 to 0 within 60 ms,
at a 264 ms mean run — 33 seconds of worker time not spent. At the cap all but
`poolSize()` of the window are still in the pool's queue, where cancelling is a
splice and the work never happens.

**The pool ceiling was four on a ten-core machine and nothing had measured it.**
`IN_FLIGHT_CAP` over `poolSize()` times the run time _is_ the queue, so the only
question was whether extra workers dilate each job by more than the parallelism
buys. On an M5, landing on Mars and converging twenty seconds: four workers is
30.4 jobs/s at a 129 ms mean run and 4,037 ms of queue, reaching drawn level 10;
eight is 41.6 jobs/s at 187 ms and 2,876 ms, reaching level 13. Runs dilate 45%
and it is not close. The frame does not pay — 16.67 ms mean and 23.3 p95 at
four against 16.71 and 19.3 at eight. The ceiling is eight and `?workers=N`
re-runs the table anywhere.

**The rig was measuring itself, and it was doing it twice over.** The
presentation watchdog decides whether the canvas has ever presented by reading
the bitmap back, and defers while `document.visibilityState` is not `visible`,
because an occluded window legitimately never presents. CDP focus emulation —
which is what makes an occluded Chrome run animation frames at all — reports
`visible` for a window that is still behind everything else. Probed directly in
the rig: `visibilityState` visible, `hasFocus()` true, and all four readback
strips pure transparent black, alpha included, on a renderer that was drawing
fine. So the gate opened, the ladder exhausted, and the canvas was remounted on
every automated boot. That cost a second full preload and warm-up census 4.5 s
after the first — about 6.5 s of a 10.2 s `navigation to first light` — and it
also brought the drawing buffer back at 3200×1800 for a rig asking for 1600×900
at DPR 1, because `useDevicePixelRatio`'s media query does not re-fire under
emulation. **Terrain selection is measured in display pixels, so every terrain
figure taken after a rebuild in this rig was a retina figure wearing a
default-window label.** `?presentation=occluded` tells the page its probe is
unreadable rather than black; the watchdog stands down and releases the boot
cover, which is the exhausted rung minus the four samples, two nudges and the
remount. Boot: `renderer ready` 9.1 to 5.2 s, and a clean Boot track for the
first time — first light 4,302 ms, preload 1,843 of which `warming surface
maps` is 1,569, one census rather than two.

The remount also produced an uncaught `TypeError: Cannot read properties of
undefined (reading 'usedTimes')` on every boot, from Three's `Nodes.delete`,
which decrements `nodeBuilderState.usedTimes` without checking there is one —
and there is not, for a render object the renderer created but never built a
pipeline for, which is the ordinary state of a scene that has never presented.
It is Three's bug and nothing this side can prevent. What this side controls is
what the throw takes with it: uncaught it aborted the cleanup loop, so every
visual after the first was left with its materials undisposed on exactly the
path whose purpose is to rebuild them.

**And the clock had been paused by the harness verb that measures it.**
`CutsceneSession.sample()` runs on the engine store's sampler, which is
session-wide and does not stop when the cinema does, so an ending is visible to
it however the scene was started. It reacts by reopening the scene two frames
short and pausing the world clock to hold the last picture — right for a reader
holding an end card, wrong for a driver's `ir.play('tngIntro')`: the director
restores the clock when the scene ends and the session paused it again. Every
flight and warp figure taken after that described a frozen world with nothing
on screen to say so, which is why the second pass found the clock at tick 5782
and could not bisect it out of the timeline. It was never in the timeline. A
session reopens only a scene it opened itself now, and `CinemaPlayer` unmounts
through the session rather than past it, which also closes the one-sample
window where an ending arrives in the same beat as the leave.

Two smaller things worth not re-deriving. `surfaceDetailFloor` is 33–43 ms cold
and was paid inside the frame a body arrives — 85% of a 40 ms first-contact
spike on Earth, measured in Node as first `update` 39.8 ms against 0.5 warm,
and the same ratio on Mars (40.3/34.0) and Luna (48.6/42.8). Its own docstring
already said nothing about it needs the main thread, so it is a pool task and
the streamer holds the ground back for the frames it takes. And `placePathInto`
replaced `placeAt` per orbit vertex; its property test shrank to a shift of
eight micrometres and reported the _reference_ as wrong, because a universe
offset runs to 2^40 m where a double resolves 0.24 mm, so `UV.translate` rounds
a fine shift away and adding it after the difference does not.

## The shaders run in the Node suite, and the first thing they found was every mapless body's ground (30 Aug 2026)

[The plan](design/plans/headless-webgpu.md) is executed as written: `webgpu@0.6.0`
is Dawn as a Node addon, `render/gpuSetup.ts` installs the three globals
`three/webgpu` reads at import time, `render/gpuHarness.ts` hands a test a
`WebGPURenderer` on the physical `apple` / `metal-3` adapter with five verbs
over it, and `pnpm test:gpu` runs the `*.gpu.test.ts` suite — every production
material compiled to a Metal pipeline, structural assertions on the WGSL, a
pixel ramp on both target types, and two compute kernels checked against the
CPU functions they port. Twenty-four tests in **620 ms** of test time inside a
0.9 s command on an idle M5; the
root suite excludes the suffix and `pnpm check` does not run it, because a
physical adapter is a claim about the machine rather than the code. The
91 MB the addon costs in `node_modules` is the price, and it is `allowBuilds:
false` in the workspace because its postinstall only strips a quarantine
attribute a registry fetch never sets.

**The ground of every mapless body was a black frame, and nothing said so.**
The compile smoke test refused `terrain.ts` with `unresolved value
'nodeUniform17_sampler'`, and standing on Gliese 1061 d in Chrome reproduced
it: 706 patches and 5.8 million triangles streamed, a pure-black canvas, and
`[Invalid ShaderModule "fragment"] is invalid due to a previous error` on the
console with the real message on the channel the page console does not carry.
The cause is three layers deep. `DataTexture` defaults to `NearestFilter` both
ways; the WGSL builder classes nearest-both-ways as _unfilterable_ and binds
such a texture with no sampler, reading it with `textureLoad`; and r182's
`generateTextureGrad` — the path `sampled()` takes for the albedo map's
analytic mip gradients — has no unfilterable branch, so it names
`<texture>_sampler` unconditionally. The 1×1 `BLANK` stand-in was therefore
a module Tint refused, a published map (loaded linear) was not, and every body
with a photograph hid it. The boot warm-up compiles the ground against the
stand-in, so `compiling the ground` was warming a pipeline that could not
build — and `warmCompile` swallows exactly that rejection. The fix is two
filter assignments on the stand-in; the same two go on the atmosphere's and
the planet's stand-ins, where the consequence is quieter and not what it first
looked like. A nearest stand-in reads with `textureLoad` and a real map with
`textureSample` — two programs — and **the swap does not choose between them**:
a TSL `texture()` node's value assignment changes the binding, no cache key
observes it, and the WGSL is not rebuilt. Measured on the device: a node built
over a nearest 1×1 compiles `textureLoad` with no sampler, and after assigning
a linear map the fragment shader is byte-identical. `Bodies.tsx` warm-compiles
each body's visual against the live camera and scene at build-ahead time,
before `setTextures` runs, so every photographed body was reading its 8K
albedo at mip 0, point sampled, with the anisotropy `planetTextures.ts` sets
doing nothing. The filter assignments are a visible change to those bodies,
not only a warm-up saving. `materials.gpu.test.ts` now holds each stand-in and
a real map to one program — the ground, the atmosphere, the planet, the clouds
and the rings — and the rule is in `AGENTS.md`.

Four traps the harness owns, each measured rather than read:

- **`readRenderTargetPixelsAsync` returns the mapped staging buffer whole**,
  rows aligned to 256 bytes and never unmapped. An 8-wide RGBA8 target reads
  back with row 1 at element 256; the first probe reported the bottom-left
  pixel as zeros. Row 0 is the _top_. `QuadMesh`'s own geometry puts `v = 0` at
  the top as well, so `drawGraph` uses a plane in front of an orthographic
  camera and `uv()` reads the way the production geometries carry it.
- **A pipeline that will not build does not reject on either path.** A draw
  reports through three's console sink from the backend's own validation
  scope; `compileAsync` gets the failure as `createRenderPipelineAsync`'s
  rejection, which the backend catches and discards, so its scope pops clean.
  The harness brackets every verb in an outer validation scope, which is where
  `createShaderModule`'s error lands, and listens on the sink besides.
- **A compute node dispatches whole workgroups of 64 and WGSL clamps an
  out-of-range write onto the last element.** `pcg3d` over 1,547 cells
  disagreed with the CPU in exactly one cell, always the last: the fifty-three
  excess invocations all wrote it. The direction kernel never showed it because
  6 × 32² divides by 64. A kernel guards its own index.
- **`compileAsync` builds against a render context that assumes a depth
  attachment.** Warmed against a depthless target and drawn into the same one,
  the star material built two pipelines — `depth24plus` and none. Not a
  production case, because the canvas always has depth, but it is what the
  warm-up test measures against, so that test's target carries one.

Two smaller facts. `webgpu`'s `adapter.info` prints as
`{ subgroupMatrixConfigs: [] }` because the identity fields are accessors;
read `vendor` and `architecture` by name. And headless Chrome keeps the
physical GPU on macOS — SwiftShader has no build there — so the reason
`drive.mjs` launches a window is `--cast`, not the adapter; its header said the
other thing and now says this.

[Test speed](design/plans/test-speed.md) records where the root suite's time goes,
measured on the same idle machine: 102.9 s for `pnpm test`, 10.0 s without
`gameEngine.test.ts`, whose `beforeAll` streams one landing through the inline
worker for 101.5 s. Nothing is changed on that page; the four levers it names
are each a decision about what the gate promises.

## The GPU produces the heightfield the CPU defines (30 Aug 2026)

Phase 5 of [the terrain plan](design/plans/terrain.md) lands as
[ADR-0023](docs/adr/0023-the-gpu-producer.md). Heightfield tiles are a TSL
compute kernel — `apps/game/src/render/terrainKernel.ts`, one thread a sample,
sixteen tiles a dispatch — fed by `packages/universe/src/terrainKernel.ts`,
which packs a surface into 112 words and a tile into a float64-computed
per-rung integer frame. The streamer asks a `HeightfieldSource` port for its
tiles; the pool implements it and so does `createTileProducer`, installed at
renderer ready once its pipeline has compiled behind the boot cover. Every
band's shape table is exported from the band's own file and read by both
paths; the CPU function's `'exact'` chord test adopts the kernel's integer slab
test, presentational and unversioned.

Measured. In the harness, sixteen tiles in **10.0 ms** on the GPU against
805.6 ms for the same sixteen on the CPU; a batch is bit-identical to the same
tiles produced singly. In the browser, a two-meter stance on Luna at 1600×900
converges in **4.4 s** at eight builds a frame (8.2 s at four, 3.5 s at
sixteen) against 25.5–32.7 s from the pool at any of them, and at 1920×1200 on
a 2× ratio in 7.5 s against 61.4 s — where both producers stop at level 7 and
954 patches, identically, which is a question about selection at display
pixels and not about production. `BUILDS_PER_FRAME` is eight: the main-thread
build is the queue now. Tolerance holds on every zoo body and on Luna, Earth
and Mercury at levels 0 through the drawn floor to
`3e-5 · maxElevation + halfWidth · 2⁻²¹`, and per band with each band's own
bound, under `pnpm test:gpu`.

What the port found, each on the device rather than in a mirror:

- **A float32 sphere test flips at the lattice boundaries.** Coarse levels
  over-counted craters by 44 m on Luna and 190 m on Earth, and the tail was
  wrong by its own amplitude, because `Σ m² ≤ cells²` in float32 admits cells
  the CPU rejects. The test is done in 48-bit integers on the frame-relative
  chord against packed `floor(cells²)` and `ceil(cells²)`; the CPU's
  `'exact'` path does the same, which is what removed Miranda's level-0 spikes
  at rational directions — float64 rounding on integer-`cells` tail rungs, the
  same defect from the other side.
- **Metal's `tanh` underflows.** `tanh(v / 1e12)` is 0 on the device where
  the arithmetic says otherwise; the per-rung diagnostic returned zeros until
  it used real ceilings, and the kernel's `tanh` is a WGSL function.
- **Three parser facts of r182's `wgslFn`.** A leading `//` comment before
  `fn` is "not a WGSL code"; `from` is reserved; nested `Loop`s must be named
  or every level is `i`.
- **Isolating a band means zeroing its share, not dropping its rung.**
  Dropping crater levels from the list shifts every frame after them, and a
  tail diagnostic walked the wrong rungs until the levels stayed and
  `CRATER_LIMIT` went to zero instead.
- **A routing test does not need a field.** The streamer's source-routing
  test took 10.6 s with a real heightfield fixture and takes 104 ms with a
  flat one; [test-speed](design/plans/test-speed.md) has the rest.

Left open, named in the ADR: normal tiles and the mesh stay on the main
thread at 0.25 ms a patch; the kernel's level-0 offset term is the
`halfWidth · 2⁻²¹` in the bound; the retina level-7 stop is unexplained.

## The black boot was two defects, and the watchdog could see neither (30 Aug 2026)

A dev boot comes up black under a live HUD, the CPU lights up, the frame
strobes, and Earthrise arrives about ten seconds in. Reproduced in headless
Chrome, where nothing can occlude the window, so every reading below is a
composited screenshot or an in-frame readback and not a rig artefact. The
reading that named it: 789,603 triangles and 1,728 lines submitted a frame,
the canvas opaque black inside the frame, and `camera.aspect === 0` on the
camera being rendered with, while the R3F store held `size 1600×900` and a
viewport aspect of 1.78.

**The first defect is R3F's, and the rig now owns the aspect.** R3F 9.7 builds
its camera as `new PerspectiveCamera(75, 0, …)` and corrects the aspect only
from a store subscription that fires on a size or pixel-ratio _change_, using
whichever camera is in the store at that moment. Its async `configure()` reads
a state snapshot taken before it awaits the `gl` factory — here a renderer
build of one to six seconds in dev — and `<Canvas>` calls `configure()` again
on every re-render while it waits. Each queued call finds no camera in its
stale snapshot and builds one; the last one built lands after the size is in
the store, its `setSize` is a no-op, and the subscription never fires for it.
A zero aspect is a NaN projection: every draw is submitted and rasterizes to
nothing. Three headless dev boots of three came up that way. `CameraRig`
writes the aspect from `state.size` beside the field of view it already owns,
one compare a frame.

**The second is the watchdog's probe, and it was blind on every boot.** The
ladder in `render/presentationWatchdog.ts` sampled the canvas with `drawImage`
from a timer, and between frames a WebGPU canvas has no readable image: Chrome
hands the drawn texture to the compositor when the frame's task ends, and the
readback is transparent black whether the canvas presented or not — the fact
the plate-capture rig met from the other side ("a WebGPU canvas reads back
blank", above). So a healthy boot read as "never presented" and climbed the
whole ladder — replay at 2.9 s, nudges at 3.8 and 4.7, a renderer rebuild at
5.5 with its second preload census, replay, nudges, "giving up" at 9.5 — and
the cover came off at first light around 12 s. That is the ten seconds, the
strobe and the CPU. The rebuild cured the first defect about half the time,
which is how the ladder masked it and why the picture arrived at all. The
sample is now taken from a `requestAnimationFrame` callback registered by that
timer, which runs after R3F's loop (its next frame is always already queued)
and reads the texture the loop has just drawn: measured on one lit canvas,
8192 of 8192 pixels opaque and 4,202 lit inside the frame, 0 of 8192 a
`setTimeout(0)` later.

After: a headless dev boot with the watchdog live logs no rung — `renderer
ready` at 0.6 s, `first light` at 7.6 s on `warm-up complete`, cover off and
the picture lit at 9.2 s; the warm-up is the whole wait. The in-frame sample
reads under the driver's focus emulation too — 57 lit of 8192 opaque on an
Earthrise strip through `drive.mjs` — so `?presentation=occluded` is not what
prevents a false negative any more; it stays because a driven boot is a
measurement and a ladder run is what it must never contain. Neither a bisect
nor the rig could have found this: the rig's window sits at x=2400 and
composites only while nothing covers it, so a shot ten seconds after a reload
measures the desk as much as the page, and #41 read as lit only because its
ladder had rebuilt the renderer before the capture. The ladder itself stays —
the wedge it was built for is a different animal from a NaN projection, and
the in-frame sample can now tell the two apart.

## The interface learns to spell its own units (31 Aug 2026)

The prose and instrument faces are the IBM Plex pair now, the display face
stays Archivo, and the scale has a tenth step — `type-stat`, 17px/600 mono for
the poster figures on the front door and the docs masthead.
[ADR-0024](docs/adr/0024-the-type-system.md) has the decision and the
alternatives; what belongs here is the finding that drove it and the trap
worth not re-springing.

The finding: **a web font's coverage is not the family's coverage.**
Fontsource's builds are sliced by script, the mathematical operators belong to
no script, and so every operator the interface prints — `M☉`, `R⊕`, `″` of
parallax, `auto → webgpu`, the lens panel's `∞` — was falling through to a
per-OS platform font, silently, mid-figure. A census counted the damage across
app, packages and docs: `°` 432, `×` 551, `−` 318, `²` 164, `µ` 54, `≈` 50,
`☉` 21, `⊕` 14. The proof is a probe of the served woff2's cmap (fonttools
over the files in `node_modules/@fontsource*/files/`), never the foundry's
spec sheet — the desktop family had every operator and the web build had none
of them. The fix is 16 KB: two pyftsubset cuts of IBM's TTFs declared under
the same family names with a `unicode-range`, plus two Noto subsets for the
sigils no text family draws.

Tried and reverted the same day: Bricolage Grotesque in the display slot,
picked for its display cut and kerning after the brief asked for a more
revered face. It rendered well and read wrong — the site's character lives in
that condensed stencil more than anywhere else. The kerning complaint it was
meant to answer is answered at the one call site set at poster size instead:
the wordmark is hand-kerned around the `r`–`t` pair and the `l`→`Ref` seam,
because tracking is uniform by definition and a kern table is tuned for text.

## The plans leave the published tree, and the gate stops paying for a landing (1 Sep 2026)

`docs/` is published at `/docs`, and a reader who reaches a page there expects
the system to already behave the way it says. A plan promises the opposite. The
seven under `docs/plans/` were therefore seven pages of the documentation site
describing things that do not exist, and nothing said so — the division was
written down only in `wings.mjs`, so the next plan would have landed in `docs/`
and failed `docs:build` with a message suggesting a wing. Plans now live in
`design/`, outside the published tree, and the rule is an invariant rather than
a build error.

The cut that followed is the part worth remembering: **6,010 lines to 1,913,
verified against the tree rather than against each plan's own status line.** A
phase with an ADR closing it and code in the tree is not work that is left, and
a status line is written once and never revisited. What survives is what a plan
is for — open work, live risks, measured figures with the operating point they
were taken at, and every constraint saying why the obvious thing does not work.
Those constraints are not history; they are the most expensive thing in the
document to rediscover. The pare-down also inverted two claims, which are
corrected rather than repointed: `docs/guides/testing.md` sent the reader to the
headless WebGPU plan for measurements the plan now sends back, and ADR-0021
cited a perf section whose table lives in `browserWorker.ts`.

**One `beforeAll` was ninety percent of the per-turn gate.** `gameEngine.test.ts`
generates a landing's worth of ground through an inline worker: 103 s of a 109 s
`pnpm test`, and `pnpm test` is the whole of the Stop hook, so every turn that
touched a `.ts` file paid it. Skipped, the four stages sum to 12 s and the suite
runs in 7.2 s wall. The skip is a cost decision and the file says so, because
`describe.skip` under a long design comment reads as an abandoned red test to
whoever finds it next. What it costs is exact: `pnpm check` and CI lose the one
place "the ship lands on the ground it drew" is proved, so the comment names the
change that should drop the skip and run the file by hand. The gate keeps its
ten-minute budget for the `test` stage — that budget is sized for the descent,
whose runtime moves by a factor of two with how busy the machine is, and sizing
it to 12 s would make every parallel build a false red the moment the skip comes
off.

**Severity in a config file applies to the report, not just the gate.** This bit
twice, once for `fta.json` and once for `knip.jsonc`, and it is the reason
neither carries `score_cap` or `rules`: put the threshold in the config and the
reporting verb inherits it, so `pnpm knip` becomes something that exits 1 while
printing the answer, which is not a report. The split lives on the command line
instead — `pnpm fta` reads and `pnpm fta:check` gates at 91, one above the
measured worst; `pnpm knip` reports everything and exits 0 while `pnpm
knip:check` narrows to four unambiguous classes. An unused _export_ is
deliberately not one of them, and `knip:check` is red today.

knip's defaults are wrong here twice over, both reading as dozens of false
"unused file" reports: tests are entry points and its vitest plugin only finds
them in the workspace holding the vitest config, of which this repository has
exactly one covering all sixteen; and `packages/*` publishes nothing, so
`exports` points at `./src/index.ts` with no build step and no `dist`. One
false positive survives and is worth recognising rather than re-diagnosing:
`tngIntro.ts` declares a local helper named `require` that looks a body up by
name, so knip reads `require('Earth')` as a CommonJS import and reports Earth,
Mars, Jupiter and Saturn as unlisted dependencies.

**Neither instrument alone ranks anything.** The worst-scoring file in the
repository, `dossier.ts` at 90.30, is also one of the best covered at 95%, while
`apps/ingest` scores mid-table and executes 7.6% of its statements. Score times
uncovered fraction is what separates them, and what it finds first is
`apps/ingest/src/build.ts` — 441 lines at cyclo 55 with **0 of 122 branches**
ever taken, in code whose own header says the middle two pipeline steps are
where an ingest goes quietly wrong. It is already pure, so it needs a fixture
rather than a refactor. Two things that look like neglect are not: the data
tables score in the worst five on size alone (`smallBodies.ts` is 1,729 lines at
cyclo **7**, and fta cannot tell a catalog from a thicket), and 127 files in
`apps/game` sit at 0% because `vitest.config.ts` registers no browser on
purpose, which is the invariant that keeps the simulation core runnable in Node.
Counting `pnpm test:gpu`, which covers nine render modules the main suite reports
at 0%, the merged figure is 65.9%.

**A declared `unicode-range` over a glyph the subset file does not hold is
silent.** ADR-0024 closed the operator gap and its census — `°` 432, `×` 551,
`☉` 21, `⊕` 14 — was taken per _codepoint printed_ against the _families_.
That is one join short. What decides the face is the specific subset file the
range routes a codepoint to, and two of the census's own entries route to a
file without the glyph: Noto Sans Symbols begins its U+2600 block at **U+260A**,
one codepoint above `☉` U+2609, and carries no `⊕` U+2295; Noto Sans Math holds
both and is declared over a `latin` range containing neither. The vendored Plex
subsets declare `U+2200-22FF`, which _contains_ U+2295, and do not carry it —
the worst of the three shapes, because it looks covered. So `M☉` and `R⊕`, the
two units the object record states most often, still reach a platform font.
Checking a family, a spec sheet or a declared range all report success; only
`fontkit`'s `characterSet` on the served file answers it.
`design/plans/type-coverage.md` has the cut.

A defect the instruments could not see, because it was arithmetic rather than
shape: **`describeBody` divided by a thousand and rounded**, so every one of
Sol's sixty-six asteroids and comets under a kilometer across described itself
as `asteroid · 0 km · 0.922 AU` — in the one string a catalog row has to tell
itself apart by. `formatReading` picks the unit, so Apophis reads `225 m` and
Earth still reads `6,378 km`.

## The ship stops paying for ticks it does not need, and the heap was never leaking (1 Sep 2026)

Three questions from `design/plans/perf.md`, taken together because they had
one answer between them: what a tick costs, why the top three warp detents were
one speed, and whether the heap climbs at steady state.

**What a tick cost, headlessly, before.** Per tick on an M5, 20,000 ticks per
point, nothing else running: 0.40 µs at the spawn point, 1.06 µs at 36,000 km
over Earth, **12.5 µs at 400 km**, 13.3 µs at 100 km over Luna, **12.5 µs at
1 AU in the Sun's frame**, 0.30 µs landed. The low-orbit figure was two terrain
samples a tick — fourteen octaves, pre-step for the atmosphere and post-step
for contact — behind a gate of a quarter of the body's radius, 1,600 km on
Earth, for an altitude the datum sphere already gave to nine kilometers. The
star-frame figure was the sixty-six children's sphere-of-influence tests: the
band prune admits every body whose orbit crosses 1 AU, which in Sol is twenty
comets and near-Earth objects, and each admitted one is a Kepler solve and a
pose composition. The collector was 14% of that profile on its own, 5.5 KB of
garbage a tick.

**The clock's 1,920× is the rate one ship can be integrated inside a frame,
and nothing needed integrating.** A ship with no input, no spin under assist,
and a periapsis above the ground band is on a conic — exactly the planets'
situation, and they have been evaluated from elements since ADR-0006. So it is
now propagated from a recorded epoch by the universal-variable formulation,
which covers the hyperbola an escape leaves on as well as the ellipse, and a
frame jumps every tick on which every entity coasts. ADR-0025 carries the
decision and the alternatives; the things worth remembering from doing it:

- **The epoch is canonical or the round-trip hash lies.** The first shape
  re-anchored the epoch at every 64-tick boundary so nothing needed saving.
  A world restored mid-chunk anchors on the restored state instead, and the
  two part in the low bits by the next boundary — each propagating a
  different rounding of the same conic. Five numbers in the save closed it.
- **The eligibility test cannot look at the warp.** A ship integrated at 1×
  and propagated at 100× would be two ships, and the hash would say so.
- **`(−ω/dt)·dt` is exactly `−ω` because `dt` is a power of two.** Flight
  assist's damping drives the spin to _exactly_ zero in one tick, which is
  what lets "no spin under assist" be an equality rather than a tolerance.
  ADR-0006's reason for 64 Hz paid a second time.
- **The sphere tests are skipped by the triangle inequality, on both paths.**
  A child found `g` meters out of reach cannot be in reach until the entity's
  travel from where it was measured plus the child's periapsis speed times
  the elapsed time has consumed `g`. On a coast the entity's own periapsis
  speed makes that a _time_, and the time is how far a frame jumps: a ship in
  low Earth orbit is bounded by Luna at about ten hours, so a 100,000× frame
  is one jump. A thrusting ship has no speed bound and measures its actual
  travel instead; the same record serves both.
- **The post-step tests were asking at the wrong instant.** The integrated
  state is the tick's end and the contact and frame tests asked the frame
  graph about its start: 470 m of Earth's orbital motion at every sphere
  crossing, seven meters of ground rotation under every landing. Both now ask
  at `time + dt`, and the post-step ground sample at that instant is the next
  tick's pre-step altitude, reused — bit-identical to sampling again, which is
  what lets a restored world with nothing to remember continue on the same
  hash.
- **A radial fall is not a coast.** The first version of the crossing test
  put the ship on the Sun's ray to the planet, heading outward, and it never
  went on rails: its conic about the Sun has a periapsis inside the Sun.
  Across the ray it is a hyperbola and coasts.
- **A paused clock reported full warp.** `plan` sets the achieved scale to
  0× on a paused or zero-delta frame, and `settle` ran on that frame too,
  where "asked for nothing" is the sub-tick case that reads as delivered in
  full — so the perf row said 100,000× delivered over a world that was not
  moving. The asked count is now null between frames and for a frame that
  bought nothing, and `settle` leaves the 0× standing. Not pinned by a test.
- **Newton on the universal anomaly walks, on the hyperbolic side.** Staying
  inside the bracket is not enough: there `F` grows like e^{χ√−α}, so from a
  χ that is far too large every Newton step back is the same 1/√−α, and a
  first step that overshot by 5 × 10⁶ needs a hundred and twenty of them; the
  loop's cap returned the hundredth. A step is taken only while it at least
  halves the one before, otherwise the bracket is bisected. Exit is on the
  residual, never the step: a far propagation divides a large residual by a
  large radius into a small step. Each defect is pinned by a deterministic
  example, because the property's bound cannot be: a step-size exit reads
  4.2 × 10⁻⁹ on the hundred-day case against 4.8 × 10⁻¹² fixed, and one that
  never bisects reads 5 × 10¹³ on a near-parabolic escape the property draws
  once in thirty thousand runs. The property's worst is seed-dependent —
  2 × 10⁻¹⁰ to 1.2 × 10⁻⁹ over 180,000 states, and 6 × 10⁻⁸ on a near-radial
  state from conditioning alone, which the arbitrary now excludes — so its
  5e-9 is a smoke bound, and a bound written from one seed's sweep sat below
  the defect it was named for.

After, per tick: 0.01–0.03 µs at every coasting point, the integrated cases
within noise of before (0.55 µs against 0.44 at the spawn point, quiet
machine) — and the thrusting ones, which are what the game pays at 1×,
**12.3–12.6 µs on `origin/main` against 0.43–0.51 µs** at 400 km over Earth and
**11.8–13.3 against 0.56–0.60** at 1 AU in the Sun's frame — the first being the
crater ladder sampled twice a tick under the old gate and the second the
children's solves, and the ellipse-versus-elements property pinned the propagator's
agreement to 0.3 m per revolution at e = 0.98 — which is the _element_
solution's rounding, a period wrong by parts in 10¹³, and grows linearly.

**In the browser.** Flight start at 100,000×: 106,240 ticks a frame, achieved
100,000, the engine at 0.50 ms mean and 0.70 max, the period at 16.67 with
none late, `Engine/advance` 0.05 ms. Planetarium at Earth: 100,000×, 10⁶× and
10⁷× all achieved in full, 8.26 million ticks a frame at the top, the engine at
0.37 ms. What the engine's 0.4 ms is now: the snapshot at 0.28–0.39 ms, which
is 129 bodies' poses at the render instant, and nothing else over 0.05. Above
the engine, the starfield is 0.62–0.79 ms a frame under warp because the eye
moves past the shell's parallax budget every frame — the budget binds on the
system's own sun, which is in the survey and drawn on the shell.

**The measurement trap, twice.** The integrated tick read 1.5–2.0 µs while
`pnpm test` ran in the background, against 0.55 quiet. The plan already says
a figure taken beside a test run is a figure about the test run; it applies to
a 40 ms benchmark exactly as much as to a worker pool. The second one is
subtler and nearly shipped: benchmarking `origin/main` in a worktree
_immediately after installing into it_, both sides in sequence rather than
interleaved, read 39–49 µs against 1.5–2.6 µs — three times the true cost on
both sides, in a ratio plausible enough to write down. Alternate the two
builds; a comparison that runs one side to completion before starting the
other is measuring the machine's mood as much as the code.

**The heap does not leak at steady state.** Three operating points watched
over CDP with a full collection forced before every reading: the flight start
at 129.5 MB flat for 150 s, a converged Earth summit stance at 524 MB flat for
240 s with 1,134 fields and 403 geometries resident, the planetarium at
100,000× at 552–556 MB for the 32 s before an unrelated source edit reloaded
the page. The sampling profile of what is _retained_ across the window is
under 6 MB and names the travel survey's rows, the catalog rows and the
cutscene overlay's animation-frame closure. The unforced reading does
not ramp either: at the same stance `usedJSHeapSize` sits between 534 and 582
MB for 200 s, a scavenge-sized sawtooth and no trend, so the 906 MB the tour
ended on belongs to the transitions and not to any steady state — whether as
garbage a major collection had not yet taken or as something still held is
the snapshot-diff across one jump that has not been made. The collector at
the stance is 87 ms in 5 s on the main thread, 1.7% of wall and 6.8% of task
time, mostly incremental marking; the producers feeding it are the 8 Hz
status sample — which built two whole world snapshots a sample to inspect one
entity, and now builds none — the 1 Hz travel survey, and the frame's own
snapshot.

## The liquid arrives, and the noise is baked (2 Sep 2026)

The rest of [the terrain plan](design/plans/terrain.md), taken as far as a
generated world can go before the sphere behind it learns what it looks like.
[ADR-0026](docs/adr/0026-the-liquid.md) is the record; what is worth
remembering from doing it:

- **A sea was drawn wherever the generator drew one, and thirty of the
  fifty-four within twenty light years were on ground between 400 and
  1,200 K.** Fourteen remain. `makeSurface` still takes the draw and now reads it against the
  ground temperature through `liquidKind`; `SYSTEM_ALGORITHM` stays where it
  is because the `rng.bool` is still taken. Proxima Centauri II — the plate
  world every tectonic test named — sits at 491 K, lost its sea, and with the
  ocean lost the lithospheric weakening that gave it twenty plates. The test
  now finds the most-plated solid body in the fixture; the claim did not
  move, the example did.
- **Valleys are the zero-level strip of a warped noise, and it reads as
  drainage from every height the mesh reaches.** The strip where a noise
  crosses zero branches and never ends in a plain, and `drainageCarve`
  shallows it toward the datum so a valley meets the sea at sea level. From
  30 km the rivers run to the coast and pool in crater bowls below the datum;
  what they do not do is join, because nothing here knows which way is
  downhill. The drainage graph stays deferred, and the plan says so.
- **The shore needed the seabed.** Painting the sea on ground clamped to the
  datum was the seabed's shape in blue, and from two meters it was a slope,
  not a shore. The heightfield is `drawnGroundElevation` now — no clamp —
  and `buildPatch` emits a datum sheet for any patch the sea reaches, with
  the depth per vertex and a morph target for both. `drawnElevation` keeps
  the clamp for the stance and the floor search, and `universe.test.ts` holds
  the mesh to the unclamped canonical field under the sea.
- **The sea refracts the frame behind it, and the harness cannot draw that.**
  `viewportSharedTexture` copies the framebuffer once a frame by ending the
  render pass and beginning it again, and the harness has no swap chain to
  copy — `compile` hit the canvas stub, `draw` into a target hit
  `RenderPassEncoder was already ended`. The frame read is a build option;
  `materials.gpu.test.ts` compiles the sheet without it.
- **The aerial veil's `1/μ` is an orbital formula.** From a standing camera
  it put the ground forty meters away, seen at five degrees, behind eleven
  atmospheres, and the sea at a two-meter stance was white. The view leg is
  now the lesser of `1/μ` and the distance over Earth's 8.5 km scale height;
  above the eight-pixel gate the distance is hundreds of scale heights and
  the orbital term wins, so the seam with the disk is untouched.
- **The frame at a retina size was per-pixel noise.** Measured at 1920×1200
  over a device pixel ratio of 2, two meters over the sea with 1,227 patches
  at level 17, by switching the terms off through `engine.surfaceQuality`:
  9.5 fps before the phase; 12.2 with each octave inside a branch on its own
  fade — a noise multiplied by a zero fade was a noise evaluated — of which
  the ground's octaves were 25 ms of the 82 ms frame, the sea's waves and
  refraction 15, the rocks 12 and the patches past `balanced` 18; 19.4 with
  every octave a fetch of one baked 128³ single-channel texture; 11.9 once
  the texture carried its gradient in four channels; and **16.3 with five
  fetches a pixel rather than ten** — a four-channel texel fetch costs about
  four times a one-channel one at the texture unit, and shrinking the texture
  to 96³ or 64³ moved the figure by a frame. With every octave off the two
  surfaces cost 18.0, which is the deposit stack, the veil, the sky shell and
  MSAA at nine million pixels; the instrument for that is a timestamp query
  per pass. At two kilometers 17.9 → 15.3, at thirty 23.9. Run-to-run
  variance is about two frames a second, and a figure taken beside the GPU
  test suite is a figure about the suite.
- **A trilinear fetch differenced in screen space shows its texel grid.** The
  first baked sea had a moiré in it: the normal was `dFdx` of a piecewise-
  linear function, constant across each texel. The texture carries the
  lattice's analytic gradient in its other three lanes now, and a shading
  normal is the fetch's `yzw` projected onto the tangent plane — the ground's
  bump left Mikkelsen's screen-space construction with it, which also ends
  the per-triangle stepping that construction had at distance. The gradient
  costs three fetches' worth of bandwidth, paid for by dropping the octaves
  nobody could see: the macro band's third, the micro's second, the grain's
  third at nine centimeters.
- **A hue drawn uniformly makes every world the same unlikely pastel.**
  `appearance.ts` draws from families — the iron oxides, the basalts, the
  feldspars, olivine, sulfur, the tholins, five ices — weighted by ground
  temperature, seven haze compositions gated by it, six pigments, and a
  liquid's color, absorption and glow, all off a fork of the surface seed so
  the body's other draws stay put.
- **An opaque node material writes an alpha of one whatever its opacity
  node says, and a cube camera inside a shell sees the winding backwards.**
  The orbital bake found both. The first bake carried its sea mask in the
  alpha lane and every face read 1.0 — a sphere that was all sea, glinting
  everywhere — so the mask is a second pass into a second target. And the
  first bake of all was black: the camera at the body's center looks at the
  ground from inside, where its counter-clockwise-from-outside winding is
  clockwise and the single-sided material culls it all. The bake's index is
  the patch's turned over, which keeps the pipeline the boot warmed. Checked
  by reading a face back through `window.orbitalBaker`, and by plates either
  side of the relief gate showing the same lakes in the same places.
- **The dev server reloads on every source edit, and a reload wipes the page
  globals a driving script keeps.** Three DPR 2 measurements were lost to
  `window.__sub` vanishing mid-run. Nothing under `src` is edited while a
  drive invocation is in flight; test files and `.scratch/` are safe. A
  "before" figure is `git stash`, measure, `git stash pop`.
- **The seabed is right only under a sheet, and every producer emitted it
  everywhere.** A mapped body gets no water sheet because its photograph is
  its sea, and with the clamp off Earth's ocean floor streamed as a trench
  under the photograph while the stance stayed at the datum: 347 of 400
  directions below it, 4,955 m at worst. `HeightfieldRequest.seabed` carries
  the choice now, set exactly where the streamer hands `buildPatch` a sheet
  datum and defaulting to the clamp; `universe.test.ts` holds the default
  clamped over a submarine region and `terrainKernel.gpu.test.ts` runs
  Earth's seabed through both sides. Found by the review, beside the sphere's
  fixed navy sea and a bake that thrashed with five bodies in frame.

## Five modules, deepened — and the structure the tolerance test was holding alone (3 Sep 2026)

The second architecture review walked where the last fourteen commits landed
and found eighteen frictions; five are in the tree and the rest are
[the deepening plan](design/plans/arch-review.md). The vocabulary is the
design skill's — a module is deep when a small interface hides a lot of
behavior, and the test of a candidate is whether deleting it would
concentrate complexity or just move it. What each one cost before, measured:

| Change                             | Files touched                                            | Where it is now                         |
| ---------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| one band (the valleys sub-commit)  | 8 code files, port +263 lines against the band's +237    | `bandStack.ts`, one table               |
| one render knob (`render.surface`) | 8 files in the client, +181 lines                        | one definition, one binding row         |
| one host capability (the timeline) | 7 files, harness +82 and engine +234                     | one `Host`, one `render` object         |
| one heightfield producer's wear    | 11, 11 and 13 `userData` writes across three scene files | `groundWear.ts`, one record             |
| one entity state write in a test   | 13 sites past the world's verbs                          | none: the store's write half is private |

**The band stack's composition is one description, and the kernel is not a
table-walker.** Which stages exist, in what order, behind which gate was
spelled in `evaluate`, in the TSL kernel against packed scalars the packer
zeroes to mean the same thing, and a third time in the band isolation test.
`BAND_STACK` names each stage's gate once as the body spells it and once as
the packed slot, and both evaluations read it; `packedStageOn` decodes a gate
from a packed record so a Node test holds the packer's encoding to the body's
over the zoo and Luna, Earth and Mercury for both sides of the sea. It ran
green on the first pass, which is the point: the packer _was_ faithful, and
nothing could say so without an adapter. The obvious next step — the kernel
iterating the table and composing from `kind` — was rejected on ADR-0023's own
ground: it is the scalar mirror one level up. The bodies stay two, and the
tolerance test is left holding what only it can hold.

**A mesh that wears the ground reads one record, and an undressed mesh is a
default rather than a throw.** The material's `onObjectUpdate` uniforms run
inside the frame, where a throw takes the canvas; `groundWearOf` answers the
undressed record — at the origin, unmorphed, on the datum — and the test is
where an undressed wearer fails. The three anchor terms move together through
`anchorGround`, never one without the others, because the rocks were computing
their altitude from the scatter field's own copy of `hypot(fround) − datum`.

**The session is the host.** `openSession` used to return a second object
with five of the host's members copied onto it, the `world` getter written
twice. It returns the host itself with the session's extras assigned onto it —
`Object.assign` keeps the getter; a spread would have copied its value, which
is the bug the getter exists to prevent. `setPlayer` had no caller and is gone.

**The preference binding is one subscription per key, and that is the fix, not
the tidiness.** A single effect keyed on every render preference re-asserted
every field whenever any moved, and a lens a verb fitted held its picture only
until the next unrelated toggle (Saturn 0.660 → 0.812 of frame height). A
binding per key cannot do that, and `engineKnobs.test.ts` holds the Saturn
case in Node, which the effect's dependency list never could.
`requestLens` declines an unusable lens whole: the field's setter refused it
while the callback still forwarded it, so the preference could hold a NaN the
next reload rejects while the picture kept the last good one.

**A store that refuses a write reverts the value it was asked to keep.** The
same Saturn defect, from a second cause, found after the binding fix landed.
`write` announced `resolve()` unconditionally, and `resolve` reads the
preference back — so where `setItem` throws, which is a private window,
blocked site data or a full quota, the announce carried the _old_ value one
line after the caller set the new one. Harmless while the sink was React
state; load-bearing the moment `camera.lens` became the road from `ir.preset`
to `engine.flightLens`. `writeRaw` now says whether the store took the write,
and `resolve()` stands where it did and where the preference refuses the
value — which is what makes an import of a broken file land as the defaults
on screen rather than as nothing.

**The store's write half is private, and the guard can fail.**
`expectTypeOf(world.entities).not.toHaveProperty('update')` was proven by
inverting it and watching `tsc` fail on that line — the check that a
regression test can go red, applied to a type. Thirteen writes past the verbs
were nine velocities on a ship spawned the line before, three `setControl`s
waiting to be called, and the save loader, which now hands control and assist
to `spawn` so a restored coaster is whole at birth rather than written after
through a verb that drops the epoch on a non-neutral input.

**One process trap, recorded so it is not repeated.** Undoing a scratch `sed`
on an uncommitted test file with `git checkout --` restored the file to
`HEAD` and discarded every edit since; the negative type check it was meant to
run had also proven nothing, because `tsc` is not on the shell's path and its
absence was a zero on the grep. The way to perturb a working file for a
negative check is a copy in the scratchpad and `pnpm exec`, restored from the
copy.

## The heightfield request carries the surface (3 Sep 2026)

The sixth of the deepening plan's candidates, measured the way the five above
were — what one request field cost before, and what it costs now:

| Change                                | Files touched                                                                    | Where it is now                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| one request field (the `seabed` flag) | 9 code files — four seam files beside the five that pack it — and a task version | `terrain.ts` and the callers that set it; the wire takes it as it is |

`HeightfieldSource.submit` takes what `generateHeightfield` takes, the
surface and the request, rather than a nine-field flattening of both. Four
callers spelled the flattening and three producers re-inflated it; the GPU
producer kept a 64-entry map keyed on `seed|maxElevation|roughness|seaLevel|seabed`
to recover an identity `surfaceKernel` and `terrainSketch` already memoize on
by `WeakMap` — a second cache of a thing cached, because the seam threw the
object away. It now cuts a batch on the surface object and the seabed flag
and holds no surface of its own. The one real conversion is the seed, four
uint32 lanes that cross a structured clone as hex: `encodeSurface` in the pool
adapter, `decodeSurface` in the two task runs, and `WireSurface` is
`SurfaceParameters` with that one field retyped, so a field added to the
surface or the request travels without an edit to the wire. The heightfield
task is version 6 and the floor task version 2 for the shape; the worker host
names a mismatch by version before a version-5 worker could read
`surfaceSeed` off a payload that has none. Held by the streamer's fake source,
which asserts it receives the body's own surface object once over a
whole-disk walk, and by the GPU suite's batch ≡ singles case, which is the
check that the cut still separates bodies without the key. ADR-0023 § 3 named
the key's spelling and now names the identity.

## The ladder deepens to fourteen, and the ground moves under every save (3 Sep 2026)

Terrain algorithm v4. `MAX_CRATER_LEVELS` goes from eleven to fourteen, which
ADR-0021 measured and declined and the terrain plan carried as the one change
still waiting on a version. Every cratered body's canonical field moved — a
world whose largest basin is 2,170 km carries craters down to 265 m where the
ladder stopped at 2.1 km — and nothing else in the stack did: a body `young`
left without a population is untouched to the last bit, and `SYSTEM_ALGORITHM`
stays at 3 because no draw moved.

**Measured, and the floor did not move.** `pnpm sim --terrain-baseline` before
and after, on the same machine with nothing beside it:

| Body                         | Floor v3 → v4 | ms/patch v3 → v4 |
| ---------------------------- | ------------- | ---------------- |
| Gliese 1061 d, rocky-airless | 19 → 19       | 54.2 → 62.3      |
| Gliese 1061 IV, atmosphered  | 17 → 17       | 53.1 → 59.6      |
| Iapetus, icy-dead            | 14 → 14       | 59.1 → 69.6      |
| Miranda, icy-active          | 12 → 12       | 23.6 → 23.5      |

The plan's "0 to 2 levels" was measured before the presentational tail
existed; with the tail in place the floor is the tail's on every zoo member
and the three extra rungs sit above it, so they cost the walk — 12 to 18% a
patch — and change the mesh's depth not at all. Mercury's finest crater is
134 m at a floor of 15, Luna's 95 m at 17, Callisto's 13 m at 17. The kernel
holds the fourteen-rung ladder to its tolerance on every body in
`terrainKernel.gpu.test.ts` with no change to the kernel: `MAX_KERNEL_LEVELS`
is derived, `SLAB_AT` moves from 52 to 56, `KERNEL_WORDS` from 116 to 132,
and the records grow with it.

**The survey sites moved with the field.** A deeper ladder puts craters
where the `rough` search had found none: Gliese 1061 d's rough site went from
−875 m to 358 m and Iapetus's from 683 m to −2,403 m. A site is derived from
the field, so this is the version bump doing what a version bump does rather
than a defect — and it is why a site named in a save is a claim about a
version.

## The generated sphere gets its mountains back (3 Sep 2026)

The orbital bake's second pass wrote the sea mask as a grey and nothing
else, so a generated body's disk had the ground's reflectance — its lakes,
its maria, its biosphere — laid over a normal that was flat everywhere. The
mountains were in the near half of a descent and gone in the far half, which
is the one thing the eight-pixel gate is supposed to make invisible.

That pass now writes the sphere's whole normal-map record: the mesh normal's
components along geographic east and north, and the sea mask beside them.
Three things had to be true at once and each was a decision.

**The frame is built the way the sphere builds it, not the way the ground
does.** `render/planet.ts` takes north as the spin axis with its radial part
removed and east as north × up; the bake writes the slope against those same
two lines, so a photograph and a bake decode through one path and the disk
has no idea which it is wearing.

**A signed channel does not survive the output stage.** The first version
wrote the slope raw and measured a north of −0.19 reading back as exactly
zero from a float target — half the relief on the body, the downhill half.
The archive's `x / 2 + 1/2` is not only symmetry with the published maps; it
is what makes the record representable.

**A byte is not enough, and this is where a bake differs from a
photograph.** At forty kilometers a texel the real slope is a few
hundredths, which a byte resolves to five steps — and the sphere's relief
exaggeration, 6 on an atmosphered body, draws every one of those steps as a
facet. The relief target is half float, where the same range is forty steps.
It is 256 texels a face against the reflectance's 512, because the bake is
drawn from level-2 patches at 64 cells across a quarter face: a texel per
mesh normal is all there is to keep.

`materials.gpu.test.ts` holds it on the real adapter, both ways: a ground
wearer with a known tilted normal anchored a million meters up +Z, where
north is +Y and east is +X, reads back as the normal's own components in the
archive's encoding; the same wearer under the body's sea datum reads back
flat with the mask at one. The fixture is the nearest generated world with a
sea, swept for rather than named, because the zoo is chosen by archetype and
none of its four members draws one.

## Every mapless moon in Sol was a dark disk under a sun-glint — it was one stand-in bound twice (3 Sep 2026)

Enceladus, looked at from the planetarium: a black sphere, a bright soft
hot-spot left of centre, a grey marbling on the lit limb. Rhea, Mimas, every
Saturnian and Uranian moon without a vendored map the same. The three obvious
guesses were the bake, the relief encoding and the tone curve, and the bake was
the first thing measured: its two cube targets read back through
`readRenderTargetPixelsAsync` on the driven page were correct to three places —
relief (0.506, 0.504, 0) with the mask at zero over all of face 0, reflectance
(0.81, 0.83, 0.88). The streamer was idle. So the sphere was wearing a correct
record wrongly, and the picture said how: a hot-spot with a Fresnel skirt is the
sun-glint, and the glint is gated on the sea mask.

**The relief sampler was reading the reflectance.** `TextureNode.getUniformHash`
is the texture's uuid, and `UniformNode.generate` hands every later node with the
same hash the first node's uniform — so `bakeMap` and `bakeRelief`, both built
over the one `BLANK_CUBE.texture`, compiled to a single `texture_cube` owned by
the reflectance node. The warm-up freezes the program there, and `setBake`'s
later value swap on the relief node binds nothing. The sphere then decoded the
ice's 0.8 of albedo as a slope of 0.6 east and north and a sea mask of 0.8:
the normal tilted off the star, the albedo went two thirds of the way to the
ocean colour, and the glint landed on it. The same collapse was already in
`planet.ts` for the 2D maps, and `RING_WHITE` exists because of it; the cube
stand-in was written once and used twice anyway. Two stand-ins now,
`BLANK_REFLECTANCE` and `BLANK_RELIEF`, and the invariant is in `AGENTS.md`.

It was invisible on the body the relief pass was verified on. Gliese 908 IV is
an ocean world whose reflectance under the sea is dark and whose land is
mid-toned, so a mask read out of the albedo was a plausible sea in roughly the
right places. An icy moon is white everywhere, which is a sea everywhere, which
is what Enceladus drew.

**Two things the suite already had did not catch it, and each was a decision.**
`textureSignature` counted `texture_2d` bindings and not `texture_cube`, so the
stand-in and the bound bake compared equal at five bindings while the cube count
was one against two; it counts cubes now. And a drawn test of the sphere over a
bake passed against the shared stand-in twice: bound before the first compile,
two distinct cubes get two bindings whatever the stand-ins share, and after
that was fixed a `compile` followed by a `draw` into a fresh target still
passed, because a pipeline is keyed on its attachment and the second draw
built a second program over the bake. The test holds one float target across
a stand-in draw and the bake draw — the boot's own sequence — and only then
reads 0.36 at the centre against the shared stand-in where the fix reads 0.80.

With the sphere wearing relief for the first time on a Sol moon, Enceladus's
tiger stripes are visible from orbit as four hairlines running pole to pole.
`StripeAxis` is a great-circle trough by design, so the picture is the
geology's; whether four whole great circles read as Enceladus is a plate-review
question, noted in the terrain plan.

## A generated giant was a lens with rings through it — it was the uniform-fluid flattening, and a six-hour day (3 Sep 2026)

Gliese 876 c, seen wide from the planetarium: an ellipsoid with an axis ratio
near 0.7, its rings a straight line through it. The record said why —
"Polar radius 62,436 km, 30.00% flattened", a sidereal day of 8.67 h — and
the 30.00 was the ceiling of the model. `rotationalFlattening` was the
Maclaurin relation for a uniform fluid, `f = (5/4)·q`, and its own docstring
conceded a factor of two against real giants and kept it because there was
nothing better. There is: the Darwin–Radau relation,
`f = (5/2)·q / (1 + (25/4)·(1 − (3/2)·C)²)`, which takes the moment of inertia
factor and thereby knows a giant keeps its mass in the middle. With each
body's published `C` it reaches Jupiter at 6.6% against 6.5, Saturn 9.85
against 9.8, Earth 0.333 against 0.335 and Neptune 1.77 against 1.71; with
the class factor a generated body gets — 0.23 for a giant, 0.35 for a rocky
world, 0.4 for a rubble pile, which is the uniform limit where the expression
is Maclaurin's again — all four land within 10%.

The relation was half of it. The planet draw takes a day from 0.25 to 3 days
whatever the body, and six hours on a giant of 0.65 g/cm³ is a spin at half
its own equatorial gravity — a body shedding its equator, not holding a
figure. Saturn is the fastest known relative to breakup at `q = 0.155`. The
draw is floored at `q = 0.2` by the body's own mass and radius,
`hydrostaticSpinFloor`, which spends no draw and so moves nothing else in the
system; a giant at the floor comes out 13.6% flattened, which is Gliese 876 c
now, on a 10.93 h day. The small bodies keep their own rubble-pile barrier —
strength holds a rock the fluid relation says would fly apart, and their
figures are measured shapes rather than spheroids in any case.

No version is spent. The polar radius is presentation and the dossier's
number; the ground's datum, the contact test and the saves read the
equatorial radius and the spherical field, and the rng sequence is unchanged.
`universe.test.ts` holds the four published bodies to 5% with their own `C`
and to 10% with the class factor, the uniform limit to Maclaurin, and every
generated planet in the fixture above its floor with no giant past 0.14.

## A ring system is drawn from a character, and Sol's seven are looked up (3 Sep 2026)

`proceduralRingStrip` branched on the host's kind: every generated ice giant
in the galaxy wore the same six to eleven charcoal threads and every gas giant
the same three to five bands, and the ice-giant look measured 3.8e-4 over the
annulus, which is nothing. It now draws a character from the body's seed —
sheet, threads or mixed, with the host leaning the odds; a particle albedo
and a tint that follow the architecture, since the three have one cause —
and a profile from the character: plateaus with a diffuse inner edge and a
sharp outer one, a grain of density waves, Cassini divisions, shepherded
ringlets, a C ring of dust, paired hairlines, a dominant outer thread. The
strip is mipmapped for the grain, which is sampler state and changes no
program. Over twelve seeds at τ 0.7 the ice-giant median is 4.5e-3 against
3.8e-4, the gas giant's 8.2e-3 against 5.9e-3, and each class spans two to
three hundred times between its faintest and brightest;
[ADR-0027](docs/adr/0027-the-rings.md) has the table.

**The seed was tossing a coin on Uranus.** Uranus, Neptune, Jupiter, Haumea,
Quaoar, Chariklo and Chiron have no ring photograph, so all seven went
through the generator, where a kind-lean is a probability and Uranus had a
two-in-five chance of a Saturn sheet. A table keyed by address gives each its
published character, and `proceduralRings.test.ts` holds the table to the
catalog both ways — every key a mapless ringed body in Sol, every such body a
key — because the small bodies are keyed by issue-ordinal addresses nothing
else in the file can see.

**The ring's albedo was in the product twice.** The strip's colour multiplies
`ω₀` and the strip is where the darkening lives — Saturn's B ring is 0.51 in
its photograph, Uranus's rubble 0.06 — so at 0.6 a τ 1 sheet's lit face sat
at a sixth of its planet. `ω₀` is 0.9, clean water ice in the visible, on
both the backscatter and the transmission terms, so the lit-to-backlit
crossover the rings test holds near unit depth does not move.

**What is still faint is geometry, and one lever was spent.** A planet of
ordinary tilt spends most of its orbit with its star within a few degrees of
the ring plane, and a slab lit at grazing incidence is honestly dark — the
plates of Xi Boötis V and Kapteyn's Star c under the same framing as Saturn
are dim the way Saturn's own are there. The planet tilt draw stretches its
tail from the same single gaussian, one planet in eleven past 34° up to 86°,
so a share of ring systems are open to their star the way Uranus's is. No
extra draw is taken, so nothing downstream of the tilt shifts in the stream —
which is not the same as nothing moving, and the audit below is about the
difference. A multiple-scattering floor
for the equinox case is written down in the plan and not in TSL, because it
is a number nobody here has measured.

## The audit that found a version owed, and the figures that had gone stale (3 Sep 2026)

`invariant-auditor` and `docs-curator` over the terrain-and-rings branch, in
that order. The finding worth keeping:

**A draw that keeps its place in the stream can still be a version.** The tilt
tail and the hydrostatic spin floor were held to spend no `SYSTEM_ALGORITHM`
because `planetTilt` consumes exactly one gaussian, as the `Math.abs` before it
did, so no draw downstream shifts. That is the wrong test. Order protects a
body's _neighbors_ and says nothing about the body: measured over 400 catalog
stars and 6,496 generated bodies, 142 axial tilts moved, the worst by 41°, and
one rotation period lengthened at the floor. `spinEvaluator` builds the
body-fixed frame out of both, so a moved pole moves the ground terrain is
sampled on and the pose a landed entity is held against — and `world.stateHash()`
cannot see it, because a landed entity's numbers are body-frame-relative and
identical on either side. `polarRadius` moved on 1,515 bodies and is the one
field that genuinely is presentation: `datumRadius` reads the equatorial radius
whenever `figure` is null.

**The bump is spent: `SYSTEM_ALGORITHM` is 4.** It was first held back to be
paid by the next change that touched generated system state, on the argument
that one version could cover both — which is a real saving only if the interval
costs nothing, and it does not: two builds reporting `system@3` while placing
Proxima Centauri II's pole 41° apart is exactly the disagreement the manifest
exists to make visible, and a handshake that cannot see it is worse than a
regenerated save. One bump covers every field that moved with it, including
`polarRadius`, which rides along rather than earning its own number.
[ADR-0027](docs/adr/0027-the-rings.md) carries the argument; `system.ts` carries
it at the constant; the rule is an invariant.

**Four figures were retired and copied forward anyway.** The pattern is the
same each time — a comment rewritten around numbers measured before the change
it describes:

- `MAX_CRATER_LEVELS` said Mercury's detail floor goes "from 14 to 16" at the
  deeper ladder. Measured at both caps, it is 16 → **15**: the floor _falls_.
  The 600 → 1,250 patch figure beside it was derived from that reversed delta
  and is gone rather than re-derived, because no rig here reports it.
- "The detail floor does not move" is true of the four-body zoo and false over
  192 bodies: Earth 15 → 17, Proxima Centauri II 14 → 16, Mars 15 → 16, Sirius I
  17 → 18, Barnard's b and c 16 → 17. `surfaceDetailFloor` is a probe search for
  where refinement stops paying, not a function of the ladder's depth, so it
  moves either way. **A figure measured at one operating point is a figure about
  that point**, again.
- `SLAB_AT` "moves from 48 to 56". It moves from **52**; 48 is the constant's
  own retired docstring, which the same commit had already corrected in place.
- Darwin–Radau "within 5%" is the accuracy given each body's own moment of
  inertia factor. A generated body gets the factor for its class, where the
  bound is 10% — which is what the branch's own test asserts, in two separate
  cases the doc had merged into one.

**Rings landed with no ADR and a plan that outlived it.** ADR-0027 now carries
the decision and `design/plans/rings.md` is reduced to the record's missing
per-ring profile and the unmeasured multiple-scattering term. ADR-0023's patch
cost is amended rather than overwritten: it is the evidence the GPU producer was
decided on, and the current 23.8–69.4 ms is a different measurement, not a
correction of that one.

## Three things the plans named as cheap, closed (3 Sep 2026)

**The terrain descent is the slow suite.** `gameEngine.test.ts` carried a
`describe.skip` around the one test that streams a landing — 101.5 of the root
suite's 102.9 s in one `beforeAll`, and the root suite is the whole of the Stop
gate — so the skip bought the gate its ten seconds by dropping "the ship lands
on the ground it drew" from `pnpm check` and CI as well. It is
`gameEngine.descent.slow.test.ts` now, a second vitest project behind
`pnpm test:slow` that `pnpm check` and CI run and the gate does not; the root
suite is 7–15 s and the descent is green again at 110 s. The engine recipe both
suites build from is `engine/headlessEngine.ts`, because a test file cannot
import a helper from another without running its tests. A root run started
beside the slow one went red on a timeout and green alone, which is the
contention the testing guide already warns about.

**The crosshair reads over the Sun.** The shell review measured a `sky-300/40`
ring at 1.05:1 against a star filling the frame — the one element with no panel
behind it, by design. The mark is a light hairline between two dark ones now
(`hud/crosshair.ts`): 11.3:1 over the Sun and 8.8:1 over Earth's disk on the
dark strokes, 9.8:1 over the sky on the light one, read off native-resolution
shots through the rig. An inverting blend mode was the obvious alternative and
fails on a mid-gray limb, where an inverted mid-gray is mid-gray; two dark
strokes and a light one cannot all vanish against one ground. `· projected` in
the destination list is `slate-400` under a dashed rule — the provenance device
the accessibility page names — rather than the retired `slate-500` at 3.4:1.

**The catalog is a tree with one tab stop.** `/planetarium` had 281 real tab
stops with the way home at 272, and 138 of them were catalog rows. The rows are
`treeitem`s with `aria-level`, exactly one of them `tabIndex` 0 — the current
row where it is drawn, else the first system — and the panel's `onKeyDown`
moves between them, folds a system with `→` and `←`, and climbs from a body to
its system; the disclosure buttons leave the tab order. The camera's arrows
already yield to a focused row, because every one is `yieldsToFocus` and a row
is a control inside `.hud-layer`, so nothing had to be stopped from
propagating, and the rig's census confirms the azimuth does not move. 148 stops
now, the menu at 133; what remains is six panels of instruments before the way
home, which is a landmark problem rather than a list one, and the shell plan
says so. Virtualizing the rows — the review's suggestion — was not taken: a
windowed list still cannot be tabbed through, and the depth was a semantics
problem rather than a rendering one.

**The atmosphere bake is off the arrival frame.**
[ADR-0028](docs/adr/0028-client-tasks.md). A jump to a generated system paid
39.7 ms of scattering bake inside a 43.3 ms frame, and the pool task the shape
wanted could not live in `packages/workers`, because the bake is in
`packages/rendering` at the same layer. The game's worker entry serves
`createGameTaskRegistry()` — the shared set plus `render.bakeAtmosphere` — and
a shell whose tables are in flight draws a vacuum for those frames. Measured on
the same jump into HIP 71683: three main-thread bakes before, none after,
twelve made on the pool. Two alternatives were declined in the record: moving
the scattering model into `universe`, which would put a rendering integrator
under the determinism rules, and a new `optics` package for one module with one
consumer.

## A guard that throws where its callers catch, and a version paid rather than deferred (4 Sep 2026)

A review pass over the branch, and two of its three findings are worth keeping.

**An `invariant` at the top of a function is a synchronous throw, and callers of
an async function do not catch those.** `WorkerPool.submit` opens with
`invariant(!this.#terminated)`, and both callers of `warmScattering` hang a
`.catch()` on the promise it returns, each with a comment saying a pool that has
gone away is the one rejection they handle. They handle nothing of the sort: the
throw leaves before a promise exists and lands in the per-frame `Bodies` update
and the 1 Hz prefetch interval. It never fired, because `session.dispose()`
nulls `pool` in the same statement as `terminate()` — which is the thing to
notice, since the code that reads as the guard and the code that is actually
guarding are in different files. Wrapping `submit` so the failure comes back as
a rejection makes the comment true. **The general shape: when a function is
`async` or returns a promise, a validation that throws is reachable only by
`try`, and a caller written around `.catch` will not see it.**

**A version deferred is a handshake that lies.** `SYSTEM_ALGORITHM` was held at 3
on the argument that the next change to touch generated system state would pay
for both at once. That trade only saves anything if the interval is free, and the
interval is exactly where the cost lives: `GENERATION_VERSIONS` is what `save.ts`
stamps and what `ClientHello` carries, so the deferral buys a `main` client and
this one agreeing on `system@3` while placing Proxima Centauri II's pole 41°
apart. It is spent — 4 — and one bump covers every field that moved, including
`polarRadius` on 1,515 bodies, which is presentation and rides along. A version
answers one question, whether the world a save was written against is the world
this build generates; it is not asked per field.

**And the version is a declaration, not a seed input.** `version.ts` said it is
"folded into the seed path"; nothing in `GENERATION_VERSIONS` reaches a seed, and
folding it in would be wrong rather than merely unimplemented — every bump would
move every body in the galaxy, including the ones the change never touched, and
the loader could no longer distinguish "this save's ground moved" from
"everything moved". So a bump moves nothing by itself. It is the honest half of a
change that already happened, and it has to be spent by hand.
||||||| parent of 9aa5891 (docs(adr): the sensor spine gets a record, and the plan keeps only what is open)

## The sensor owns the frame, and the picture that was one transfer too dark (4 Sep 2026)

Phase 0 of [the sensor plan](design/plans/the-sensor.md) is on the default
path: `render/sensor.ts` draws every frame through one `PostProcessing` around
the scene pass and the house curve, `scene/Sensor.tsx` takes the frame from R3F
at priority 1, the renderer is built at zero samples with MSAA on the pass, and
`ir.gpu()` measures through the chain.
[ADR-0029](docs/adr/0029-the-sensor-spine.md) has the decision and the three
facts about r182 that cost the handoff — the swap `PostProcessing.render` does
not undo on a throw, the draw against a pipeline still building, and the pass
gated on a frame counter only three's own loop advances — each of them now in
"Bugs the tests found" above.

What the handoff had ruled out was right and what it had not tried was the
answer: reading the canvas from inside the page, on one frame, through the
chain and through the renderer's own path, gave identical pixels — and the
renderer found sitting at `NoToneMapping` and a linear output. The screenshot
was never lying; the state under it was.

Measured on the M-series at 1600×900, DPR 1, occluded rig, one Chrome on the
GPU at a time, the world pinned by one save at tick 272, the baseline being the
parent commit in its own worktree and dev server, drained-queue ms per frame,
median of five sixty-frame runs after the first:

| Operating point                      | Baseline | Chain |
| ------------------------------------ | -------- | ----- |
| Earth from 14,400 km                 | 1.84     | 1.78  |
| Earth summit, converged              | 6.17     | 5.87  |
| Proxima Centauri d from orbit        | 0.47     | 0.49  |
| Proxima Centauri d summit, converged | 4.37     | 4.43  |
| `tng-intro` at frame 800             | 0.84     | 0.90  |

Against a 0.15 ms budget the spine adds at most 0.06 ms anywhere, inside the
spread. The plate gate is **zero** differing pixels at the four planetarium
points; the cutscene differs from the baseline by 531 pixels at 15/255 and from
itself across two boots by the same 531 and 15.

Two protocol facts for anyone taking plates across boots. A world paused before
its star survey has settled draws a sparser sky, differently each boot — the
first Proxima plates were 83 KB against 259 KB settled, and a patch of sky held
seven stars on one build and one on the other with the pause first, none of it
the chain's. And two boots paused at different ticks differ by a sub-pixel
drift of the surface that reads as hundreds of pixels at a few levels. The
sequence that is exact is `ir.look`, twelve seconds, then `ir.load` of one
save, then `ir.pause`: the survey has settled and the tick is the save's.
`ir.gpu()` under the old pass would have reported the quad's cost, not the
frame's; the first figures taken through it were about a path that drew the
scene once per forty submissions.

The one piece of phase 0 still open is the chain's own warm-up producer: the
quad's pipeline is the one compile the first presented frame pays.

## A second hull, a ship the player picks, and solo behind a dev flag (4 Sep 2026)

`data/models/` now holds two hulls. The Rocinante — the _Corvette_-class light
frigate of _The Expanse_, in its MCRN _Tachi_ livery — joins the Enterprise-D,
CC BY 4.0 by Jakub.Vildomec, ~141k triangles against the Enterprise's ~50k, with
four 1K PBR material sets and the same `asset.extras` attribution block the
Enterprise carries, so the credit travels with the file. **Scaled to 46 m**, the
length the Expanse wiki and the official _Ships of the Expanse_ RPG both give;
the loader divides that by the model's own nose-axis extent exactly as it does
for the Enterprise's 642.5 m, so `engine.hull` reads length 46, beam 16 in
flight, and 642.5, 467 when the Enterprise is chosen back. The bow is +Z — the
drive cone sits at the model's −Z, the antennas at its +Z — which the loader's
half-turn faces to the game's −Z.

Two changes made the manifest a chooser rather than a constant:

- **The manifest is a data module now, `render/ships.ts`, holding no Three.js.**
  `state/preferences.ts` needs the set of ship ids to guard the stored choice,
  and it is imported by the Node preferences suite; `shipModels.ts` imports
  `three/webgpu`, the `GLTFLoader` and an `import.meta.glob` of the `.glb` files,
  none of which can load in Node. So the JSON lives in a leaf both import, and
  the loader is the only thing that pulls the renderer in.
- **`render.ship` is a preference like any other** — a string id into the
  manifest, guarded by `oneOf(SHIP_IDS)`, defaulting to the Enterprise so every
  screenshot and the reference cutscene keep their framing. `ShipModel` reads it
  live and reloads the hull without a page reload, which here rebuilds the
  renderer and loses the camera; the boot warm-up reads it too, so the compiled
  hull is the one that will be drawn. The chooser is an `OptionGroup` at the top
  of Display settings, the label a short chip and the value the id, so a saved
  ship survives a name reword. A stored id this build cannot load degrades to the
  default the same way a missing hull degrades to the debug cone.

Solo flight is offered from the menu **in development builds only**:
`isEnterable` now returns true for a `built` mode when `import.meta.env.DEV` is,
which Vite folds away in a production bundle. The routes stay mounted regardless,
so a pasted `/play/solo` still resolves in every build — the gate is about what a
visitor is invited into, not what the build can do.

## The valves fire, the drive burns, and the ship arm has an orbit (4 Sep 2026)

The Rocinante maneuvers with its thrusters drawn firing, and its Epstein drive
burns when it burns. Three layers, each testable without the one above it:

- **The snapshot states the thrust demand.** `thrustDemand(entity, dt)` in
  `packages/simulation/src/flight.ts` is the commanded acceleration as
  fractions of the thruster profile's authority, in body axes, with the
  assist's damping torque included — and it is computed by the same
  `commandedAcceleration` the two integrators call, so a spin being nulled
  draws the nozzles nulling it and a plume can never light while the hull does
  not turn. `EntitySnapshot.thrust` carries it, `RenderEntity.thrust` passes it
  through. A forward burn arrives as `linear.z = −1`, and a zero is a zero: the
  sign flip in `resolveThrust` produces `−0`, and `flight.test.ts` found it.
- **`packages/rendering/src/thrusters.ts` maps a demand onto valves.** A
  projection, not an allocation: a valve opens in proportion to its thrust
  against the linear demand plus its torque _direction_ against the angular
  one, clamped to 0..1, and the physics — which applied the demand exactly —
  makes the ship move as if the set were perfect. Torque is by direction and
  not by lever so a pitch is drawn as a couple rather than as the nose alone,
  with `TORQUE_LEVER` (2 m) scaling only valves near the centre of mass. A
  hull with a drive burns ahead on the drive alone; the valves never see the
  forward half of the demand, or a stern pod leaning aft would glow through
  every burn. `thrusters.test.ts` holds it to nine properties, the mirror
  symmetry among them: a mirrored hull under a mirrored demand fires the
  mirrored set, which is the cross product's handedness checked by
  `fast-check` rather than by eye.
- **The layout is measured, never drawn.** `scripts/nozzles.mjs` parses the
  GLB itself and walks each matching mesh into shells, reporting centroids,
  mean face normals and boundary loops in the game's hull axes — recentred,
  scaled, bow turned — so a number it prints is copied into
  `render/thrusterLayouts.ts` as it stands. The reading found that these
  nozzles are capped bumps whose open loop is the _attachment_: the exhaust
  axis is the shell's mean normal, and the loop's normal points into the hull.
  The Rocinante has fourteen bow jets in ten `thruster_N` shells, six belly
  pods with a round lip at the tip of a hexagonal housing, and one stern pod
  modeled at one corner with holes in `hull_rear` at all four, so the corners
  are that pod mirrored twice. The drive's exit plane sits at z 21.0 between
  the throat piece and the 3.70 m mouth, so the rim stands in front of it from
  every angle but dead astern. `thrusterLayouts.test.ts` holds the table to
  the hull's extent, unit exhausts, mirror symmetry, a valve for every
  half-axis, and the couples a pitch and a retro should light.

`render/plumes.ts` draws it in five draws for the whole hull: the jets and the
pods are each one shell instanced by four attributes — mouth, axis, size,
firing — of which only the last is written per frame; the drive is the same
shell at a torch's profile with filaments scrolling aft and a crown of spikes
at the rim, plus a disk at the exit plane carrying the turbulent core the
reference plates show filling the cone. Additive in colour and silent in
alpha on the flare's discipline, depth-tested against the hull, with the
facing term carried down from the vertex stage so a shell seen edge-on
softens and one seen down its axis shows the cap as a burning disk. No
light: a point light on the skirt would be a second program for every
material in the scene. `materials.gpu.test.ts` compiles all four.

The ship arm of the camera precedence has two views. **Chase** is what it
was, exactly — `flightCameraPose` with the head centred reproduces
`chaseCameraPosition` and the ship's orientation bit for bit, and
`camera.test.ts` says so — with a drag now turning the head. **Orbit** stands
off in the world's own axes, pole on the scene's local up, distance in hull
lengths and tethered at eight, looking at the ship while it turns: the only
way to watch a maneuvering system fire, since a camera bolted to the hull
shows every plume in the same place on screen whatever the ship does. Entering
it seeds the angles from where the chase was standing, so the switch is a
change of what the camera does next rather than a jump. The state lives in
`packages/devtools/src/flightCamera.ts` beside the observatory, is reachable
as `ir.view('orbit')` and `ir.flightCamera`, and rides `HarnessStatus` so a
plate beside the hull records the orbit it was taken from. `V` cycles the
views, `Home` levels the head, and the drag sensitivity is the one number
every draggable camera now reads, `dragSensitivityOf`.

## Known gaps

Fuller treatment, with the seam for each, in [`docs/roadmap.md`](docs/roadmap.md).

- **The timeline has no span inside `packages/simulation`, so `pnpm sim
--profile` reports only the worker pool.** That is deliberate rather than
  unfinished — the simulation depends on the integer tick and wall clock enters
  at one call — but it means a bare `--ticks` loop has nothing to decompose and
  the headless half of the profile story is thinner than
  [the plan](design/plans/the-timeline.md) hoped. The seam for changing that is
  ADR-0022's `void` return, which is what would keep a tick span from becoming a
  canonical read.
- **A worker's entries are invisible to `ir.timing.drain()`.** They live on the
  worker's own performance timeline because each side times against its own
  `timeOrigin`, so a `full`-level drain on the main thread covers Engine,
  Terrain, Render and Boot and stops there. The worker tracks are in a _trace_ —
  `pnpm drive --trace`, then `pnpm timing --threads` — and closing the gap means
  collecting from both sides over `postMessage`, which is a protocol change
  nobody has needed yet.
- **The entry-cost figures were taken with no DevTools recording active.**
  46.5 ns for `console.timeStamp` and 988.5 ns for `performance.measure` are the
  numbers that decide whether _turning the level on_ costs anything, which is the
  question that matters for shipping. What they do not answer is the cost under a
  live recording, where the category is enabled and the entry is actually written
  somewhere. `--trace` now exists to measure that and it has not been done.
- **Nothing checks the timeline against a real browser, including the one claim
  ADR-0022 calls out as failing silently.** The inertness check is
  `apps/game/src/engine/timingInert.test.ts` — a Node unit test with a stubbed
  clock counting `performance.now` calls — and `pnpm sim --self-test` exercises
  none of it. The figures the whole three-level design rests on (46.5 ns and
  988.5 ns an entry, 0.87 µs a frame at `trace`) came from one manual browser
  session, and no automated check reproduces them. The seam for closing it is
  the same one the twelve capability checks use; the reason it is not a
  thirteenth is in the ADR.
- **A 3-second trace is 41 MB and 204,000 events.** `pnpm timing` carries
  `--max-old-space-size=8192` for that reason. The categories are already the
  narrow set — the V8 CPU profiler is deliberately excluded — and most of the
  volume is `disabled-by-default-v8.gc`, which comes along with
  `devtools.timeline`. A longer recording wants streaming rather than one
  `JSON.parse`, and `traceFrames.mjs` has the same shape of limit.
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
- No indirect draw or GPU-driven culling yet: the heightfield producer is the one
  compute pass (ADR-0023); selection and the mesh are CPU-side.
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
- The tone curve has no test. It is a TSL node graph, and a scalar mirror of
  the same arithmetic would pass while the graph drifted — which is the
  failure the terrain-normals test is remembered for. Its home is a
  `*.gpu.test.ts` under `pnpm test:gpu`, where `drawGraph` on a float target
  returns the curve's own output for comparison against the published formula;
  none is written yet.
- `World.updateInterest` is the core's own system-streaming policy and has no
  production caller: both apps load one system and never stream another, and the
  client runs a separate starfield survey with its own radius and hysteresis.
  It is tested and left in place deliberately — wiring it into the frame loop
  changes what unloads mid-flight, which is a gameplay decision, not a cleanup.
