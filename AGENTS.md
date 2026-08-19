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
- **Never persist anything regenerable.** A save stores references and
  mutations. If you are tempted to store generated content, you want a cache,
  and it is not a save.
- **Never import a hosting vendor's SDK below the adapter layer.** Nothing in
  `packages/*` may know what a Durable Object is.

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
layers. `pnpm graph` enforces layering and acyclicity, and prints the graph.

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

What to reach for:

- **Property-based tests** (`fast-check`) for anything mathematical: round
  trips, invariants, ordering. Several real bugs in this repository were found
  by a property test rather than an example.
- **Golden vectors** for the PRNG. Changing them is a deliberate act with an
  algorithm-version bump in the same commit.
- **State-hash equality** for anything about determinism. `world.stateHash()`
  is the canonical comparison.
- **Assert the physics, not the direction of change.** Capability check 5 once
  passed while reporting "fell from 57287 km to 57287 km"; it now compares
  against the analytic free-fall prediction.

When a bound is loose because of a real limit, say so in the test and name the
limit. `POSITION_RESOLUTION * 2` is a better assertion than `toBeCloseTo(x, 3)`
because it says where the number came from.

## Driving the game

The harness is on `window.ir` in the browser and is the same object the headless
runner uses, so a scenario that reproduces a bug in Chrome can be replayed in a
test.

```js
ir.help()                       // the whole API
ir.summary()                    // one line
ir.status()                     // everything, structured
ir.step(640) / ir.runSeconds(10)
ir.orbit('g:milky-way/s:SOL/b:2', 400)
ir.land('g:milky-way/s:SOL/b:0', 0.35, -1.1)
ir.face(address) / ir.burnToward(address)
ir.save() / ir.load(text)
await ir.selfTest()             // the twelve capabilities
await ir.scenario('surface')    // orbit | approach | surface | interstellar
```

`pnpm sim --self-test` does the same headlessly. `pnpm sim --help` lists the
flags.

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
