# AGENTS.md

Working guide for anyone — human or coding agent — changing this repository.
`README.md` is the overview, `CONTEXT.md` is the build log, `docs/adr/` holds
the reasoning behind the decisions you are not expected to relitigate.

## Before you change anything

1. Read the ADR for the area you are touching. They are short and they exist
   because these decisions are expensive to reverse.
2. Run `pnpm check`. If it is red before your change, fix that first or say so.
3. Find the test that covers the behaviour you are about to change. If there
   isn't one, that is the first thing to write.

## The rules that actually matter

These are the ones where a violation is a rewrite later rather than a refactor.

Each is mirrored as a path-scoped one-liner in `.claude/rules/`, which loads
itself when a matching file is opened — this file is canonical, and nothing
loads it. **Change an invariant here and grep `.claude/rules/` for its
imperative.** A mirror that has drifted is worse than no mirror: it fires with
authority at the moment of the edit, and states the previous rule.
`.claude/rules/README.md` holds the contract.

- **Never put an absolute position in a `Vec3`.** `UniverseVector` is the only
  thing that may claim to be an absolute position. A `Vec3` is a displacement or
  a frame-local coordinate.
- **Never use `Math.random()`, `Date.now()` or `performance.now()` in anything
  canonical.** Generation derives from seeds; simulation depends on the integer
  tick. Wall clock enters at exactly one call, `clock.advance`.
- **Never make generation depend on order.** Derive a seed from the address; do
  not draw from a shared stream. If you can change one object's output by
  generating a different object first, it is wrong.
- **Never put canonical state in a React component**, and never put gameplay
  behaviour in a lifecycle callback. Components consume snapshots. The snapshot
  arrives through `apps/game/src/state/engineStore.ts` — a zustand store holding
  the last `HarnessStatus`, republished at 8 Hz by one sampler. Subscribe to the
  narrowest slice you need; `useEngine((s) => s.status)` is a fresh object every
  sample and never bails out of a re-render. A store that held the _world_ would
  be this rule broken, not followed.
- **Never construct a `Worker` outside `apps/game/src/engine/browserWorker.ts`.**
  Tasks are typed and versioned; the pool owns dispatch, cancellation and
  instrumentation.
- **Never assemble a session by hand.** `openSession` in `packages/devtools`
  builds the world, the ship, the pool, the store and the harness, in the one
  order that works. Five places used to do it independently and two of them had
  already drifted apart. A host passes adapters in; it does not construct them.
- **Never pass a bare `Vec3` to anything that samples terrain.** The argument is
  a `BodyFixedDirection`, and the only producers are `bodyFixedDirection`,
  `geodeticDirection` and `regionDirection`. Sampling in inertial axes has
  shipped twice.
- **Never write entity state through `world.entities.update`.** Use `teleport`
  for a discontinuous move and `setControl` / `setFlightAssist` /
  `killRotation` for input; those reset the interpolation history and the
  landed set, and `update` does not.
- **Never assert that something is landed.** Landedness is a consequence of the
  contact test, owned by `World.#land`. `teleport` deliberately has no flag.
- **Never persist anything regenerable.** A save stores references and
  mutations. If you are tempted to store generated content, you want a cache,
  and it is not a save.
- **Never make the star catalogue ambient.** It is a generation input alongside
  the seed, and it is passed as an argument everywhere — `resolveSystem`,
  `systemsWithin`, `new World({ catalog })`. A singleton would be smaller and
  would make the catalogue _version_ a hidden input, which is what invalidates
  every save the next time astronomy publishes. `docs/design/galaxy.md` Rule 1.
- **Never store what the catalogue can derive.** HYG ships a `lum` column that is
  its own `absmag` restated in the wrong band. The packed file carries
  measurements; temperature, luminosity, radius, mass and colour are computed at
  load. The same rule is why a Bayer designation is two small integers and
  `Alpha Centauri` is a string nobody stores.
- **Never sort a system's planets by orbit and call it order.** `b:2` is the
  third body _issued_, not the third one out. Confirming a planet interior to
  every known orbit must not renumber anything. `orbitalOrder` is for display;
  see ADR-0009.
- **Never import a hosting vendor's SDK below the adapter layer.** Nothing in
  `packages/*` may know what a Durable Object is.
- **Never let React Compiler memoise a component that reads mutable state.** It
  assumes the values it derives are pure functions of their inputs, and an engine
  or a metrics buffer is a stable reference whose _contents_ change every frame —
  so the component renders once and shows that forever. `'use no memo'` is the
  opt-out, and `apps/game/src/hud/PerfPanel.tsx` is the worked example. This is
  not licence to hand-write `useMemo`; see CLAUDE.md.
- **Never put the `<Canvas>` inside a route, and never let a mode assume it owns
  the page.** `App` owns the canvas and `.hud-layer` for the life of the
  session; every route renders _inside_ that layer as a sibling of the canvas. A
  router over the whole tree rebuilds a `WebGPURenderer` on every navigation,
  which is the black-screen class `render/presentationWatchdog.ts` exists to
  recover from, arriving on purpose several times a minute. ADR-0011.
- **Never hold the current mode in React state.** It is
  `modeForPath(resolvedLocation(location).pathname)`, a pure function in
  `pages/paths.ts`, so a reload, a back button and a pasted link land in the
  same place by construction. The same rule covers everything else the URL
  carries — the planetarium's subject (`?at=`) and the cinema player's frame
  (`?t=`).
- **Never read the raw pathname when a dialog could be open over a mode.** A
  dialog records the mode's location in `location.state.background` and
  `ModeRoutes` renders at _that_; `resolvedLocation` is the one function that
  resolves it, and everything deciding what is on screen must agree with it.
  The same state has to be carried by every link that stays inside a dialog and
  read by every control that closes one — `pages/useOverlay.ts` is that half.
  Ignored, a dialog's close button returns the player to the main menu and
  tears down the mode behind it; over a running cutscene it unmounts and
  remounts the cinema player several times a second.
- **Never add a second producer of the camera.** There is one precedence order,
  in `GameEngine.#step`: **cutscene, then observatory, then the ship.** Each is a
  presentation eye handed to `buildScene`. A camera pushed at the Three.js
  object instead would leave LOD, apparent star brightness, `up` and flare
  occlusion all being told about a different viewpoint from the one on screen.
  **No arm of that order may depend on a later one resolving**, and only the
  last needs a player: with the cutscene sample below `#step`'s missing-player
  return, one frame during a load left the director unsampled forever,
  `engine.cinematic` latched non-null, and every piece of chrome — including
  the control that stops a cutscene — unmounted for the rest of the session.
- **Never let the planetarium write canonical state.** The observatory resolves
  an address, asks the world where that is _this tick_, and returns a pose. No
  teleport, no clock, no entity write, no save. `observatory.test.ts` compares
  `world.stateHash()` across a session of flying around, and that test is the
  design promise, not a nicety — see `docs/design/planetarium.md`.
- **Never give a mode its chrome without `pointer-events-auto`.** `.hud-layer` is
  `pointer-events: none` so the scene beneath stays reachable, and
  `ErrorBoundary`'s `className` styles its _fallback_, not a wrapper — so
  nothing between a mode and the layer turns them back on. Getting this wrong is
  silent: the hit target at every pixel is the canvas.
- **Never give `AnimatePresence` `mode="wait"` over the overlay routes, and key
  it on the dialog's surface rather than its pathname.** `mode="wait"` stopped
  the exit completing, so a closed dialog left its scrim in the DOM at
  `opacity: 0` with `pointer-events: auto` — an invisible full-viewport layer
  that swallowed every click on the mode behind it. This fails the same silent
  way as the rule above and is harder to see: the scene is still rendering, so
  nothing looks wrong. Keying on the pathname instead makes every settings tab a
  fresh entrance, and two 70% scrims stack to 91%. `overlaySurface` in
  `pages/paths.ts` is the pure half and is tested.
- **Never guard a "run once" effect with a ref.** React re-runs effects while
  refs survive, so a latch plus a cleanup means the cleanup wins and the effect
  never fires again — the planetarium came up with the camera on nothing.
  Reconcile against the state's actual owner instead
  (`observatory.target?.address === wanted`), which is idempotent by
  construction.
- **Never move a dock panel by splicing an array at a call site.**
  `dock/layout.ts` owns every move and preserves one invariant: _every known
  panel is in exactly one zone, exactly once._ Property-tested. Use the
  **updater** form of the setter — one gesture can deliver two drops, and two
  moves composed against the same captured snapshot discard the first. ADR-0012.
- **Never import from `three` in `apps/game`.** It is `three/webgpu` and
  `three/tsl`. Both share `three.core.js`, so `Mesh` is the same class either way
  and nothing breaks loudly — but only `three/webgpu` carries the node system, and
  a material taken from `three` is a classic material the renderer has to convert
  behind your back. `packages/*` may not import Three.js at all; `pnpm graph`
  enforces that half.

## Conventions

- **Units are SI internally** — metres, seconds, kilograms, radians. Presentation
  units are branded types and exist only for display.
- **Axes are right-handed, +Y up.** A system's reference plane is XZ, forward is
  −Z. Textbook orbital mechanics is +Z up, so `physics/frameConvention.ts`
  converts once at that boundary and nowhere else. Do not add a second
  conversion.
- **Terrain is sampled in body-fixed axes.** Sampling in inertial axes leaves
  the mountains behind as the planet rotates. This was a real bug.
- **Imports carry their extension** (`./foo.ts`), because
  `allowImportingTsExtensions` is on and Node runs the sources directly. The one
  exception is `@/` in `apps/game`, which resolves to `apps/game/src` — it
  exists because shadcn/ui's registry writes `@/lib/utils` into every component
  it generates, and it is configured in `vite.config.ts`, that app's
  `tsconfig.json` and the root `vitest.config.ts`. Code written by hand still
  imports relatively.
- **No `enum`, no parameter properties, no runtime namespaces** —
  `erasableSyntaxOnly` is on. Use `const` objects plus union types.
- **`import type` for type-only imports** — `verbatimModuleSyntax` is on.
- Comments explain _why_, and specifically why the obvious thing does not work.
  Do not restate the code.

## Layout and layering

`packages/*` are source-only workspace packages resolved through pnpm links, so
there is no build step between an edit and a test. Each declares
`inertialref.layer` in its `package.json` and may depend only on strictly lower
layers. `pnpm graph` enforces layering and acyclicity, prints the graph, and rejects any
**third-party runtime dependency** in `packages/*`. The core has to run unchanged
in a browser, a worker and Node; depending on nothing but itself is the cheapest
way to guarantee that, and it is the mechanical form of "no hosting vendor's SDK
below the adapter layer".

There are no TypeScript project references: a referenced project may not disable
emit, and declaration-emitting twelve source-only packages to satisfy `tsc -b`
buys nothing. Four independent tsconfig projects type-check the four real
environments instead:

| Project                       | Covers              | Environment                                                 |
| ----------------------------- | ------------------- | ----------------------------------------------------------- |
| `tsconfig.json`               | `packages/*/src`    | **no DOM lib, no Node lib** — must run in all three         |
| `apps/game/tsconfig.json`     | the client          | DOM, WebWorker, JSX                                         |
| `apps/headless/tsconfig.json` | the Node runner     | Node types                                                  |
| `apps/server/tsconfig.json`   | the Worker          | workerd globals and `Env`, from `worker-configuration.d.ts` |
| `apps/ingest/tsconfig.json`   | the catalogue build | Node types; runs offline, never at play time                |

The fourth is neither the browser nor Node, and its types are **generated**:
`pnpm --filter @inertialref/server run types` writes `worker-configuration.d.ts`
from `wrangler.jsonc`, and that file is committed. Add a binding to the config
without regenerating and the typecheck passes against a stale `Env`.

If a package needs a host capability, it declares a **port** and the host
implements it. See `packages/workers/src/transport.ts` and
`packages/persistence/src/store.ts` for the pattern. That is why the worker pool
can be driven by an in-process fake in Node tests.

## Testing

Tests live beside the code and run in plain Node — that is the check that the
core stays free of DOM, React and WebGL. Nothing registers a browser
environment.

That check has a cost worth naming: **a TSL node graph cannot be evaluated in
Node**, so shader code is verified on a GPU or not at all. Do not write a scalar
mirror of a shader and test that instead — it passes while the graph it claims to
describe drifts, which is the terrain-normals trap one paragraph down. And a
headless GPU check is not the same as a real one: the renderer bug that killed a
tab on every load reproduced only at devicePixelRatio 2.

What to reach for:

- **Property-based tests** (`fast-check`) for anything mathematical: round
  trips, invariants, ordering. Several real bugs in this repository were found
  by a property test rather than an example.
- **Golden vectors** for the PRNG. Changing them is a deliberate act with an
  algorithm-version bump in the same commit.
- **State-hash equality** for anything about determinism. `world.stateHash()`
  is the canonical comparison, and it covers position, velocity, orientation,
  angular velocity, control input, flight assist and landedness. If you add a
  field to canonical state, add it there too — the fields it omitted were
  exactly the ones a shipped bug lived in.
- **Assert the physics, not the direction of change.** Capability check 5 once
  passed while reporting "fell from 57287 km to 57287 km"; it now compares
  against the analytic free-fall prediction.

When a bound is loose because of a real limit, say so in the test and name the
limit. `POSITION_RESOLUTION * 2` is a better assertion than `toBeCloseTo(x, 3)`
because it says where the number came from.

**Check that a regression test can actually fail.** Reintroduce the bug and watch
it go red before you keep it. The terrain-normals test asserted that normals were
unit length, which a radial normal also is — so it passed both before and after
the fix for the bug it was written to guard.

Tests run for `packages/*` and `apps/*` alike. `apps/game` is drivable under Node
because `GameEngine` takes its worker factory and save store as arguments; see
`apps/game/src/engine/gameEngine.test.ts`.

## Driving the game

The harness is on `window.ir` in the browser and is the same object the headless
runner uses, so a scenario that reproduces a bug in Chrome can be replayed in a
test.

```js
ir.help() // the whole API
ir.summary() // one line
ir.status() // everything, structured
ir.step(640) / ir.runSeconds(10)
ir.targets() // everywhere you can go, nearest first
ir.goTo('HIP71683') / ir.goTo('b:2') // system or body; dispatches
ir.loadSystem('HIP71683') // generate a system without travelling to it
ir.orbit('g:milky-way/s:SOL/b:2', 400)
ir.land('g:milky-way/s:SOL/b:0', 0.35, -1.1)
ir.face(address) / ir.burnToward(address)
ir.save() / ir.load(text)
await ir.selfTest() // the twelve capabilities
await ir.scenario('surface') // orbit | approach | surface | interstellar
ir.play('tng-intro') // a scripted scene; Esc skips, the ship comes back
ir.pause()
ir.seekCutscene(1150) // frame-exact stills against a reference edit
```

**Start with `ir.targets()`.** Every other verb takes an address and none of
them will tell you one; that is the call that answers "where am I and what else
is there". `goTo` is the only verb that accepts all the forms a human types —
`SOL`, `s:SOL/b:2`, `b:2` relative to the system you are in — because
`parseAddress` is deliberately strict everywhere else.

`pnpm sim --self-test` does the same headlessly, and `pnpm sim --targets
--goto b:2` is the same navigation from a terminal. `pnpm sim --help` lists the
flags.

**`ir.look` is the planetarium's whole verb, and the difference from `goTo` is
the point**: `goTo` teleports the _ship_ and changes canonical state; `look`
moves only a camera. Both end with Jupiter filling the frame and only one leaves
you in orbit of it. `ir.observatory` is the camera itself — `drag`, `zoom`,
`setPhase`, `frameTarget`, `clear`.

The same verbs are on the dev dock, top right in the browser: **navigate** lists
the destinations with a button per manoeuvre, **telemetry** is the inspection
overlay, **perf** plots frame time, engine time, ticks per frame, draw calls,
worker queue and heap over a rolling window. `H` collapses the whole thing,
`G` opens navigation and `P` opens perf. It calls the harness and nothing else,
so anything you can do by clicking is reproducible in a test.

**Look at the perf tab before optimising anything, and before believing a
performance claim in a design document.** The first thing it found was that time
warp had never worked above 5×.

### The modes, and where their code lives

The client is a shell with a route table over it (ADR-0011). Four modes, and
each answers "who owns the camera" differently:

| Mode          | Path                      | Camera                    | Code                                                   |
| ------------- | ------------------------- | ------------------------- | ------------------------------------------------------ |
| `menu`        | `/`, and any unknown path | the observatory, drifting | `pages/HomePage.tsx`                                   |
| `flight`      | `/play/:mode`             | the ship's chase rule     | `flight/`                                              |
| `planetarium` | `/planetarium?at=…`       | the observatory           | `planetarium/`, `packages/devtools/src/observatory.ts` |
| `cinema`      | `/cinema/:scene?t=&play=` | the cutscene director     | `cinema/`                                              |

The split between pure and applied is the same one the cinematic director uses,
and for the same reason — the arithmetic is testable in Node and the application
is not:

- **`packages/rendering/src/observer.ts`** — the orbit camera as arithmetic:
  drag, zoom, log-space easing, framing, phase angles. No world, no addresses.
- **`packages/devtools/src/observatory.ts`** — the same camera bound to a live
  world: resolves an address, follows a moving body, produces an eye. Exposed on
  the harness. One deliberate difference from `CutsceneDirector`: its `sample`
  _does_ touch the world, because it is following something that moves.
- **`packages/devtools/src/orbitPaths.ts`** — orbit traces. Two rules the naive
  version gets wrong: a trace is relative to its primary and re-anchored to now
  (or a moon's trace is an open corkscrew), and each point is placed with the
  _body's own radius_ (or render compression draws the curve at a completely
  different depth from the planet).
- **`apps/game/src/dock/`** — the panel layout algebra (pure, property-tested)
  and the React DnD wiring over it. ADR-0012.
- **`apps/game/src/planetarium/`** — gestures, picking, labels, panels. The
  gesture and pick arithmetic is in `gestures.ts` and `pick.ts` and is tested;
  what is in the components is the bookkeeping only a browser has.

### Scripted scenes (the cutscene director)

The engine plays authored scenes over the live world — ADR-0010 is the
contract, and the trail for anyone extending it runs:

- **Pure arithmetic** in `packages/rendering/src/cinematic.ts` — easings, fade
  envelopes, camera routes, screen-space routes, composition solvers.
  Property-tested in Node.
- **Director and scripts** in `packages/devtools/src/cutscene.ts` and
  `cutscenes/` — a script's `prepare(world)` resolves the stage once, its
  `sample(frame)` is pure, and time derives from `renderTime`, never a wall
  clock. A new scene is a new file exporting a `CutsceneScript`; add it to the
  registry in `harness.ts`.
- **A scene is a shot list, not a camera move.** Each shot owns its camera,
  placed against its own subject; the cuts between them hide in darkness,
  behind a flash, or under a body filling the frame. Authored as one continuous
  spline a scene becomes a camera crossing astronomical units between beats and
  aiming at whatever it is between — which is what the first `tng-intro` was.
- **Choreograph in the frame.** A hull's beats are
  `(frame, screen x, screen y, range)` via `screenOffset`, the same terms a
  tracked bounding box reports, and `screenRoutePosition` interpolates range in
  log space so a four-decade approach does not overshoot through the lens.
- **Application** in `apps/game` — `engine.cinematic` (render-space, on the
  engine singleton for the HMR reason `hull` documents), the warp-effects
  quads, the DOM title overlay, and the dock's cutscene section.
- **The proving scene** (`tng-intro`) is timed against a frame-analysed
  reference edit that lives outside this repository in `~/Developer/tng-inertial`
  — `analysis/timeline.json` is the measured spec, `data/frames/` the
  per-frame imagery — and its measured numbers (credit grid, fade windows, the
  locked camera, the flash envelope) are regression tests in
  `cutscene.test.ts`. Change those numbers only to make the recreation _more_
  faithful, and say so.
- **Hard-won authoring rules** are in CONTEXT.md § "The cinematic director" and
  § "The title sequence, re-cut against its own frames": camera-relative
  choreography is offset beats, never absolute beats off a moving camera; never
  per-frame look-at a hull near the lens; light is staging, and a key's screen
  position is a _product_ of two dot products that must both carry the right
  sign; whiteouts are honest scene changes; ask the font for its cap height
  rather than guessing it. Reread both before authoring a second scene.
- The reference audio and any full-sequence render carry third-party rights —
  the audio path is gitignored on purpose, and publishing a render needs a
  rights check first.

One gotcha when driving a browser: Chrome throttles `requestAnimationFrame` in
backgrounded tabs, so a freshly reloaded page that is not focused sits at tick 0
until it is. That is the browser, not a bug in the clock.

## Definition of done

Not "the browser renders something". Done means: the implementation is correct,
the architectural boundaries hold, determinism is still determinism, tests exist
and pass, `pnpm check` is green, the ADRs and `CONTEXT.md` reflect any
meaningful architectural change, and the debug tooling can inspect whatever you
added.

When a defect exposes a missing invariant, add the regression test rather than
patching the symptom.

Most of that is checked for you rather than remembered: a Stop hook runs
`graph → lint → typecheck → test` after any turn that touched a source file, and
a failure returns as work still to do rather than a task reported complete. It
deliberately stops short of `pnpm build` and of the commit — the full
`pnpm check` and `pnpm sim --self-test` belong at the point of commit, which is
what `.claude/skills/ship` runs. `IR_SKIP_GATE=1` disables it.
