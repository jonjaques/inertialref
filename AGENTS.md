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
  behaviour in a lifecycle callback. Components consume snapshots.
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
- **Never import a hosting vendor's SDK below the adapter layer.** Nothing in
  `packages/*` may know what a Durable Object is.
- **Never let React Compiler memoise a component that reads mutable state.** It
  assumes the values it derives are pure functions of their inputs, and an engine
  or a metrics buffer is a stable reference whose *contents* change every frame —
  so the component renders once and shows that forever. `'use no memo'` is the
  opt-out, and `apps/game/src/hud/PerfPanel.tsx` is the worked example. This is
  not licence to hand-write `useMemo`; see CLAUDE.md.
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
  `allowImportingTsExtensions` is on and Node runs the sources directly.
- **No `enum`, no parameter properties, no runtime namespaces** —
  `erasableSyntaxOnly` is on. Use `const` objects plus union types.
- **`import type` for type-only imports** — `verbatimModuleSyntax` is on.
- Comments explain *why*, and specifically why the obvious thing does not work.
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
emit, and declaration-emitting eleven source-only packages to satisfy `tsc -b`
buys nothing. Three independent tsconfig projects type-check the three real
environments instead:

| Project | Covers | Environment |
|---|---|---|
| `tsconfig.json` | `packages/*/src` | **no DOM lib** — must run in a browser, a worker and Node |
| `apps/game/tsconfig.json` | the client | DOM, WebWorker, JSX |
| `apps/headless/tsconfig.json` | the Node runner | Node types |

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
ir.help()                       // the whole API
ir.summary()                    // one line
ir.status()                     // everything, structured
ir.step(640) / ir.runSeconds(10)
ir.targets()                    // everywhere you can go, nearest first
ir.goTo('HIP71683') / ir.goTo('b:2')   // system or body; dispatches
ir.loadSystem('HIP71683')       // generate a system without travelling to it
ir.orbit('g:milky-way/s:SOL/b:2', 400)
ir.land('g:milky-way/s:SOL/b:0', 0.35, -1.1)
ir.face(address) / ir.burnToward(address)
ir.save() / ir.load(text)
await ir.selfTest()             // the twelve capabilities
await ir.scenario('surface')    // orbit | approach | surface | interstellar
```

**Start with `ir.targets()`.** Every other verb takes an address and none of
them will tell you one; that is the call that answers "where am I and what else
is there". `goTo` is the only verb that accepts all the forms a human types —
`SOL`, `s:SOL/b:2`, `b:2` relative to the system you are in — because
`parseAddress` is deliberately strict everywhere else.

`pnpm sim --self-test` does the same headlessly, and `pnpm sim --targets
--goto b:2` is the same navigation from a terminal. `pnpm sim --help` lists the
flags.

The same verbs are on the dev dock, top right in the browser: **navigate** lists
the destinations with a button per manoeuvre, **telemetry** is the inspection
overlay, **perf** plots frame time, engine time, ticks per frame, draw calls,
worker queue and heap over a rolling window. `Tab` collapses the whole thing,
`G` opens navigation and `P` opens perf. It calls the harness and nothing else,
so anything you can do by clicking is reproducible in a test.

**Look at the perf tab before optimising anything, and before believing a
performance claim in a design document.** The first thing it found was that time
warp had never worked above 5×.

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
