# The deepening plan: what is left

The second architecture review walked the three places the last month of
commits landed — the terrain pipeline, the engine and shell, and the harness
layer every headless test crosses — and found eighteen frictions. Six are in
the tree, each carrying its reasoning in its own file:

| Landed                                                       | Where                                                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| The band stack's composition is one description              | [`packages/universe/src/bandStack.ts`](../../packages/universe/src/bandStack.ts), ADR-0023 § Consequences       |
| A mesh that wears the ground is dressed in one place         | [`apps/game/src/render/groundWear.ts`](../../apps/game/src/render/groundWear.ts), `render/wear.ts`              |
| The harness is built over one host                           | `Host` and `renderHost` in [`packages/devtools/src/harness.ts`](../../packages/devtools/src/harness.ts)         |
| The preference registry owns every knob the frame loop reads | [`apps/game/src/state/engineKnobs.ts`](../../apps/game/src/state/engineKnobs.ts)                                |
| The entity store hands out its read half                     | `EntityView` in [`packages/simulation/src/entity.ts`](../../packages/simulation/src/entity.ts), `spawnShip`     |
| The heightfield request carries the surface                  | `HeightfieldSource.submit(surface, request)` and `WireSurface` in `packages/workers/src/tasks.ts`, ADR-0023 § 3 |

The vocabulary is the design skill's: a **module** has an interface and an
implementation; it is **deep** when a small interface hides a lot of behavior;
a **seam** is where the interface lives, an **adapter** is what satisfies it
there, and one adapter is a hypothetical seam where two make a real one. Depth
buys callers **leverage** and maintainers **locality**. The deletion test —
does deleting the module concentrate complexity, or just move it — is what
separates a candidate from a wrapper.

This page is the remainder: three deepenings still worth making, each with the
shape it should take, five smaller items, what the landed six deliberately
left, and what is settled.

---

## 1. The flying verbs get a module with a name

**Files.** `packages/devtools/src/harness.ts` (`orbit`, `#toStar`,
`#trackOrbit`, `#orbitStar`, `shot`, `land`, `goTo`, `#arriveAt`,
`goToSystem`, `face`, `burnToward`, `#lookAt` — about 375 lines),
`packages/devtools/src/shots.ts` (`placeShot`'s geometry alone),
`packages/devtools/src/inspect.ts` (`EntityInspection`: pose, speed, altitude,
landed, coasting, partition — no heading, no phase),
`packages/devtools/src/devtools.test.ts` § "going places".

**The friction.** Of the harness's sixty-one methods, about twenty-five are
one-line forwards and ten are unit-and-address adapters; the flying group is
the behavior — two-body speed, sunward placement, orbit-rate spin, the
sphere-of-influence clamp, nose-on-target — inline in a class whose other
fourteen hundred lines forward. Its tests drive through the interface and
verify through the world, reading `entities.require(player).state.orientation`
and recomputing phase from `frames.pose`, because the interface cannot answer
what the verbs promise. `goToSystem` and `burnToward` have no test at all.

**The shape.** A module — `packages/devtools/src/maneuvers.ts` — whose
interface is the verbs over a `World` and a player, each returning what it
promises: the state it wrote, the heading, the orbital phase, and whether the
move dropped a rails epoch. The harness forwards to it the way it forwards to
the observatory. `EntityInspection` gains heading and phase, so
`ir.status().player` answers "arrives looking at it" and the tests assert on
the return and the inspection rather than on the world. The rails question —
what a bookmark that writes angular velocity and switches assist off does to
the epoch — is answered in the module's header: every bookmark is a
`teleport`, and `teleport` drops the epoch by construction (ADR-0025).

**What tests hold it.** The "going places" tests move onto the returned record;
`goToSystem`, `burnToward` and `face` get their own; the placement geometry in
`shots.ts` keeps its property tests.

---

## 2. The engine's derived state keys on one generation

**Files.** `apps/game/src/engine/GameEngine.ts` — the starfield survey
(`#survey`, `#starFieldWorld`, the sweep), the orbit-trace cache, and
`#invalidateDerived`, which lists eleven caches by hand;
`apps/game/src/scene/Starfield.tsx` and `OrbitTraces.tsx`, one consumer each;
`packages/rendering/src/scene.ts` (`buildScene` requires an entity).

**The friction.** One class holds the frame loop, the three camera arms, a
survey and an orbit cache with one consumer apiece, and invalidates its
derived state through a list a maintainer keeps by hand — the build log
records that splitting the list across `replaceWorld` and `load` is how the
starfield came to survive a jump of four light years. The orbit cache keys on
a counter named for the starfield. And `buildScene` requires a camera entity
though the arms only need an eye, so `#step` returns before the scene when
there is no player and a playerless observatory draws a stale one.

**The shape.** Two modules with one consumer each: `engine/starSurvey.ts`,
whose interface is `update(generation, eye)` → `StarField` with the
hysteresis and the in-flight-world guard inside, and `engine/orbitTraces.ts`,
keyed on the generation and the scope. The engine names the world generation
once — one counter, bumped where the world is replaced — and hands it to
both; `#invalidateDerived` becomes that bump and two `reset()` calls. The
scene takes the eye the arms resolved, with the entity optional, so the
no-player frame draws. Zero-caller members go: `loadedSystemIds()`, and
`player()` / `pool()` as public methods the session already answers.

**What tests hold it.** `gameEngine.test.ts` gains a playerless observatory
frame that produces a scene; the survey and the cache get unit tests over a
fake pool and a fake world generation, which they cannot have as private
methods of a 1,500-line class.

---

## 3. Bodies: the mapping from a body to its uniforms becomes pure

**Files.** `apps/game/src/scene/Bodies.tsx` — the frame closure runs
`:408–979`, seven concerns: visual lifecycle and eviction, tessellation tiers,
tuning and adaptation, the orbital bake, per-frame uniforms for four
materials, the star as a body, the build-ahead queue and the boot census.

**The friction.** None of it is reachable from Node; `materials.gpu.test.ts`
covers the materials and not the mapping into them. The eviction at
`MAX_BODIES`, the requeue-at-cap fix and the census `finish()` are all
"must not come back" items with no test that can reach them. And the
flattening ADR-0013 says is spent once, on the mesh, is applied again to the
cloud shell and the atmosphere shell outside the branch — whether any figured
body carries clouds or haze today is unverified; the rule is what is not
literally true.

**The shape.** `render/bodyUniforms.ts`: a pure mapping from a `RenderBody`
and the frame's context — sun, eye, adaptation — to the uniform records of
the planet, the clouds, the rings and the atmosphere, with `tuningFor` and
`adaptationFor` exported and the figure branch taken once, the shells on its
side. The frame closure applies the records, comparing before it writes. The
eviction and the requeue-at-cap move into a small `scene/visualSet.ts` with
its own test.

**What tests hold it.** `bodyUniforms.test.ts` in Node: a figured body yields
shells with no flattening; a mapped body's tuning; the star as a body.
`visualSet.test.ts`: the cap, the requeue. The GPU suite keeps compiling the
materials.

---

## Smaller, each a line

- **The command table has two adapters the interface does not name.**
  `App.tsx` says every command exists exactly once; `TimePanel.tsx`
  re-implements pause, warp and real-time against `engine.world.clock`
  without the flash notice. `TimePanel` takes `commands: HudCommands` through
  the planetarium context, and a test holds `clock.setTimeScale` to one
  writer in `apps/game/src` the way the `localStorage` rule is held.
- **The director is reached through three seams of the same eight verbs.**
  Eight harness forwards, eight `CutsceneHost` closures, and the playhead's
  `mine` guard defending against the console it sits on; the script registry
  is `[TNG_INTRO]` in the harness constructor. Expose the director as
  `ir.cutscene` the way `ir.observatory` is exposed, let `CutsceneHost` take
  it, and make the scripts a session option. ADR-0010 supports the director
  itself.
- **The driver holds two app facts as strings the harness could answer.**
  Readiness is `window.engine.gl` and the boot cover is the selector
  `.hud-bleed.z-50.bg-black`; a rename costs twelve silent seconds a cold
  boot. `ir.status()` grows a `booted` answer from the presentation host,
  which has `firstLight`'s phase, and the driver reads that.
- **Radians at `ir.land` and `ir.observatory.*`, degrees everywhere else.**
  One console object, two conventions, and `Radians` a bare number — the
  2,578° defect. A branded `Degrees` at the harness seam; `ir.land` takes
  what every other verb takes; `simulateDescent` takes what `ir.sites`
  prints.
- **Six scene consumers re-derive "whose frame is this" from
  `engine.cinematic === null`.** A `frameOwner` the engine resolves once per
  frame in `#step` — cutscene, observatory, ship — and the consumers switch
  on it. ADR-0010 chose the null check; this names the same fact once.

---

## What the landed five left, deliberately

- **The band stack's bodies are still two.** The kernel does not walk
  `BAND_STACK`; it reads its gates from it. A kernel that walked the table
  would be the scalar mirror ADR-0023 refuses, one level up, and the
  tolerance test is left holding exactly the arithmetic only it can hold.
- **The world-replaced rule is still six checks.** The director's identity
  checks, the observatory's guards and the engine's generation counter each
  answer a different consequence of the same event, and each is correct
  locally. A `Host.onWorldReplaced` subscription would let the director and
  the observatory register instead of check; it is a separate design, and
  candidate 2 above is where the engine's half of it goes.
- **`RENDER_HDR` and `RENDER_AA` stay in `App`.** Both are facts about the
  renderer it builds — a constructor argument and the drawing buffer's
  ratio — and the canvas key reads them. The knobs the frame loop reads are
  the ones the registry binds.
- **The streamer still caches the palette for the renderer.** `TerrainState`
  carries `palette`, `datumRadius`, `orientation`, `centre` and `lens` so the
  renderer has them in the frame the drawn set is empty; the streamer holds
  three palette fields for it. Small, and its home is `TerrainPatches`
  reading the body.
- **The Saturn frame-spike figure is not re-measured.** Held over from the
  previous review: worst main-thread frame 2.3 ms across a warm Saturn
  approach, zero over 8 ms. `ir.profile` over a Saturn approach with
  `?presentation=occluded` is the way to read it, and the caveats in
  [perf](perf.md) apply.

---

## Settled, not reopened

Named here so a later review does not relitigate them; each has a home that
carries the argument.

- **Per-route Open Graph through HTMLRewriter** — declined in
  [`docs/hosting.md`](../../docs/hosting.md), which also names the trigger that
  would reopen it. `run_worker_first` bills every asset request.
- **Generating `index.html`** — a generator fights `pnpm format`;
  `scripts/brand/checkHead.mjs` is a gate instead
  ([`scripts/brand/build.mjs`](../../scripts/brand/build.mjs) carries the
  reasoning).
- **Anything multiplayer** —
  [ADR-0008](../../docs/adr/0008-multiplayer-partitions.md) is
  design-only, and the single `AuthorityPort` adapter cannot rot because no
  `if (online)` branch exists.
- **Wiring `World.updateInterest`** — a gameplay decision, per the build log.
- **A kernel that walks the band stack's table** — the scalar mirror
  [ADR-0023](../../docs/adr/0023-the-gpu-producer.md) refuses; the table is a
  description.
- **A whole-store write verb on the world** — the store's write half is the
  world's alone by `EntityView`; a ship that starts moving is spawned moving,
  and every later write is a verb that carries its bookkeeping.

---

## Related

- [ADR index](../../docs/adr/README.md) — the decisions each candidate sits under
- [Terrain — what is left](terrain.md) · [Perf](perf.md) — the plan candidate 2 touches, and the terrain plan beside it
- [Harness](../../docs/guides/harness.md) — the surface candidate 1 reshapes
