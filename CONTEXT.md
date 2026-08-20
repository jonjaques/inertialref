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

| Package | Layer | State |
|---|---|---|
| `shared` | 0 | done — units, brands, invariants, structured logging |
| `spatial` | 1 | done — UniverseVector, frame graph, floating origin |
| `procedural` | 1 | done — PRNG, hierarchical seeds, noise, algorithm versions |
| `physics` | 2 | done — Kepler, rigid body, atmosphere, thrusters |
| `universe` | 3 | done — addressing, star catalogue, generation, terrain, frames |
| `simulation` | 4 | done — clock, entities, flight, streaming, snapshots |
| `protocol` | 4 | done — validation combinators, wire and save schemas |
| `workers` | 5 | done — typed tasks, ports, pool, four tasks |
| `persistence` | 5 | done — save/restore, migration chain, store port |
| `rendering` | 5 | done — LOD, depth compression, terrain meshing |
| `devtools` | 6 | done — inspection, twelve capability checks, harness, `openSession` |
| `apps/game` | — | done — React + R3F client, worker pool, IndexedDB saves |
| `apps/headless` | — | done — Node runner, ~100–105k ticks/s, `pnpm sim --self-test` |

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
8. **Render compression keys off distance to the *surface*.** Keying off the
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
  limb visible, and half the SOI is *inside the surface* of a planet orbiting at
  0.005 AU, which collapsed the clamp onto its floor and parked the ship 10 km
  up.
- **Arriving somewhere points the nose at it.** `orbit` aims along the track,
  which is right for flying and wrong for arriving: you teleport into orbit and
  see empty space, which reads as a planet that failed to load. Naming a *system*
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
  not — is the altitude the *atmosphere* is evaluated against, and its terrain
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
  origin *is* the pad, so the answer was `Vec.ZERO`.
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
- **Two clamps for one spiral.** The view clamped the frame delta to 0.25 s,
  which changed nothing (`SimulationClock.advance` already caps a step) and
  corrupted `droppedTicks`: a three-minute background stall was reported in the
  HUD as 8 dropped ticks instead of 11,520.

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
  buttons by HID usage and *silently drops* any usage above 32. WebHID has no such
  cap but exists only in Chromium.

## Known gaps

Fuller treatment, with the seam for each, in [`docs/roadmap.md`](docs/roadmap.md).

- Binary and multiple-star systems are modelled as single stars (`components`
  in the catalogue records the truth).
- No n-body perturbation; patched conics only.
- Terrain has no persistence of modifications yet (the schema anticipates it).
- Collision is ground contact only — no hull, no other entities.
- `World.updateInterest` is the core's own system-streaming policy and has no
  production caller: both apps load one system and never stream another, and the
  client runs a separate starfield survey with its own radius and hysteresis.
  It is tested and left in place deliberately — wiring it into the frame loop
  changes what unloads mid-flight, which is a gameplay decision, not a cleanup.
