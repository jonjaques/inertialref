# AGENTS.md

Working card for anyone changing this repository — human or coding agent.

Human documentation lives in [`docs/`](docs/README.md). The agent handbook is
[`docs/agents/`](docs/agents/README.md). Agent machinery is in
[`.claude/`](.claude/rules/README.md), with Cursor adapters in
[`.cursor/`](.cursor/README.md). Claude-specific orientation is
[`CLAUDE.md`](CLAUDE.md). The build log is [`CONTEXT.md`](CONTEXT.md).

---

## Before you change anything

1. Read the [ADR](docs/adr/README.md) for the area you are touching.
2. Run `pnpm check`. If it is already red, fix that first or say so.
3. Find the test that covers the behavior you are about to change. If there
   is not one, write it first.

Commands, toolchain, and conventions: [development](docs/guides/development.md).
How to start and finish work: [working](docs/agents/working.md).
Where each invariant is explained: [invariant map](docs/agents/invariants.md).

Each invariant below is mirrored as a path-scoped one-liner in
[`.claude/rules/`](.claude/rules/README.md), with thin Cursor path adapters in
`.cursor/rules/`. **This file is canonical.** If you change a rule here, grep
`.claude/rules/` for its imperative and keep the matching Cursor glob in step.
A drifted mirror is worse than none: it fires with authority and states the
previous rule.

---

## The rules that actually matter

Violating one of these is a rewrite later, not a refactor.

- **Never put an absolute position in a `Vec3`.** `UniverseVector` is the only
  type that may claim to be one. A `Vec3` is a displacement or a frame-local
  coordinate.
- **Never use `Math.random()`, `Date.now()`, or `performance.now()` in
  canonical code.** Generation derives from seeds. Simulation depends on the
  integer tick. Wall clock enters at exactly one call, `clock.advance`.
- **Never make generation depend on order.** Derive a seed from the address.
  Do not draw from a shared stream.
- **Never put canonical state in a React component,** and never put gameplay
  behavior in a lifecycle callback. Components consume snapshots from
  `apps/game/src/state/engineStore.ts`. Subscribe to the narrowest slice you
  need, and do not add a timer of your own — one sampler owns the rate.
- **Never write a presentation switch directly.** `showShip`, `showOrbits`,
  `flareArtifacts` and the observatory's target go through
  `engine.presentation`: a mode pushes a stance on mount and releases it on
  unmount, a panel's override is another push, and `release()` restores what
  was underneath rather than a literal.
- **Never construct a `Worker` outside `apps/game/src/engine/browserWorker.ts`.**
  Tasks are typed and versioned; the pool owns dispatch, cancellation, and
  instrumentation.
- **Never assemble a session by hand.** `openSession` in `packages/devtools`
  builds the world, the ship, the pool, the store, and the harness, in the
  one order that works. A host passes adapters in.
- **Never pass a bare `Vec3` to anything that samples terrain.** The argument
  is a `BodyFixedDirection`. The only producers are `bodyFixedDirection`,
  `geodeticDirection`, and `regionDirection`.
- **Never write entity state through `world.entities.update`.** Use `teleport`
  for a discontinuous move and `setControl` / `setFlightAssist` /
  `killRotation` for input. Those reset interpolation history and the landed
  set; `update` does not.
- **Never assert that something is landed.** Landedness is a consequence of
  the contact test, owned by `World.#land`. `teleport` has no such flag.
- **Never persist anything regenerable.** A save stores references and
  mutations. Generated content belongs in a cache, not a save.
- **Never make the star catalog ambient.** Pass it as an argument —
  `resolveSystem`, `systemsWithin`, `new World({ catalog })`. A singleton
  would hide the catalog version, which is what invalidates saves when
  astronomy publishes. [Galaxy, rule 1](docs/design/galaxy.md).
- **Never store what the catalog can derive.** The packed file carries
  measurements. Temperature, luminosity, radius, mass, and color are computed
  at load.
- **Never filter a survey to serve a search box.** `travelTargets` is a star
  sweep with a radius; `StarCatalog.search` is an index over the whole catalog.
  They answer different questions and only one of them can run per keystroke.
- **Never sort a system's planets by orbit and call it order.** `b:2` is the
  third body issued, not the third one out. `orbitalOrder` is for display.
  [ADR-0009](docs/adr/0009-issue-ordinal-addressing.md).
- **Never import a hosting vendor's SDK below the adapter layer.** Nothing in
  `packages/*` may know what a Durable Object is.
- **Never let React Compiler memoize a component that reads mutable state.**
  Opt out with `'use no memo'`. See `apps/game/src/hud/PerfPanel.tsx`. This is
  not license to hand-write `useMemo`.
- **Never put the `<Canvas>` inside a route,** and never let a mode assume it
  owns the page. `App` owns the canvas and `.hud-layer` for the life of the
  session. [ADR-0011](docs/adr/0011-application-shell-and-modes.md).
- **Never hold the current mode in React state.** It is
  `modeForPath(resolvedLocation(location).pathname)` in `pages/paths.ts`.
- **Never read the raw pathname when a dialog could be open over a mode.**
  Use `resolvedLocation`. Links that stay inside a dialog, and controls that
  close one, go through `pages/useOverlay.ts`.
- **Never place a compressed body about the render origin.** `placeAt` takes
  the eye in render space and compresses radially about _that_. The origin is a
  snapped grid point that lags the camera and jumps; compressing about it gives
  every far object a parallax error that sawtooths at the rebase cadence, which
  is small bodies visibly vibrating in their orbits.
  [ADR-0003](docs/adr/0003-render-coordinates.md).
- **Never size or position chrome against the viewport.** No `100vh`, no
  `100vw`, no `env(safe-area-inset-*)` at a call site. `.hud-layer` spends the
  four insets as **offsets** — padding cannot do it, because an absolutely
  positioned child resolves against the padding _edge_ — so an `absolute` child
  is already inside them; a surface that is _picture_ and must reach the
  display's own edges says so with `hud-bleed`, and a corner readout inside one
  of those is laid out in flow so the padding can reach it. The document itself
  is `100dvh` and cannot scroll.
- **Never add a second producer of the camera.** In `GameEngine.#step` the
  order is **cutscene, then observatory, then the ship.** No arm of that
  order may depend on a later one resolving. Only the last needs a player.
- **Never let the planetarium write canonical state.** The observatory
  resolves an address, asks the world where that is this tick, and returns a
  pose. No teleport, no clock, no entity write, no save.
  [Planetarium](docs/design/planetarium.md).
- **Never give a mode its chrome without `pointer-events-auto`.**
  `.hud-layer` is `pointer-events: none` so the scene stays reachable.
- **Never give `AnimatePresence` `mode="wait"` over the overlay routes,** and
  key it on the dialog's surface (`overlaySurface`), not its pathname.
- **Never guard a "run once" effect with a ref.** Reconcile against the
  state's actual owner (`observatory.target?.address === wanted`).
- **Never move a workspace panel by splicing an array at a call site.**
  `dock/layout.ts` owns every move. Use the updater form of the setter.
  [ADR-0012](docs/adr/0012-dockable-panels.md).
- **Never put two components in one file.** `react/no-multi-comp` is an
  error. A constant or type goes in a sibling `.ts`. Exemption:
  `apps/game/src/components/ui/*.tsx`.
- **Never hand-roll a control the registry already has.** Go through
  `hud/Action.tsx`, `hud/SwitchRow.tsx`, or `hud/TransportButton.tsx`.
- **Never let a cinematic effect fire off a script.** An effect is staging.
  It belongs in `CinematicEffects`, where a shot turns it on, and it is 0
  everywhere else. [Cinematics](docs/guides/cinematics.md).
- **Never write a label in the case you want to see it in.** Source strings
  are title case; `text-transform` on the type step decides what is shouted.
- **Never import from `three` in `apps/game`.** Import `three/webgpu` and
  `three/tsl`. `packages/*` may not import Three.js at all.
- **Never hand-write a compile-ahead.** `render/warmup.ts` owns the recipe —
  the visibility toggle `compileAsync` silently needs, the renderer cast, the
  swallowed rejection — and the census the boot progress totals. Registration
  is idempotent by label, because StrictMode does everything twice.
- **Never edit a file `pnpm brand` writes.** The mark is
  `design/brand/brandmark.svg`. `pnpm brand:check` is in `pnpm check`.
- **Never change what the site says about itself in only one place.**
  `src/site.ts` supplies shared values, `index.html` is what a scraper reads,
  and `pages/DocumentMeta.tsx` applies route-specific browser metadata.
- **Never load a third-party tag from `index.html`.** `src/analytics.ts` is
  the gate: production build, canonical host, no Global Privacy Control.

---

## Cursor Cloud specific instructions

The repository-managed environment is `.cursor/environment.json`. Its Debian
image pins Node 26 and pnpm 11, then a Build runs the frozen-lockfile install.
The image also ships `git`, `git-lfs`, `tmux`, and `en_US.UTF-8` — Cursor clones
and runs terminals inside the container, and a POSIX locale is how a custom
image builds then fails to open. Do not install dependencies in `start`; Builds
preserve files, not processes.

`pnpm dev` starts automatically in the **Game and Worker** terminal. It serves
Vite on port 5173 and the local Cloudflare Worker on 8787. Inspect that terminal
before starting another copy. The application and full test suite need no
Docker daemon, database, secret, or production credential.

The reference cutscene audio and production analytics are deliberately absent.
`pnpm build` may report that R2 credentials and `VITE_GA_MEASUREMENT_ID` are
missing; it must continue successfully, producing a silent, non-measuring
build. Never add production credentials merely to silence those messages.

---

## Definition of done

Not "the browser rendered something." Done means the implementation is
correct, the boundaries hold, determinism still holds, tests exist and pass,
`pnpm check` is green, the ADRs and `CONTEXT.md` reflect any meaningful
architectural change, and the debug tooling can inspect what you added.

When a defect exposes a missing invariant, add the regression test rather
than patching the symptom.

A Stop hook runs `graph → lint → typecheck → test` after a turn that touched
source. It is a safety net. The full `pnpm check` and `pnpm sim --self-test`
belong at commit — that is what the `ship` skill runs. `IR_SKIP_GATE=1`
disables the hook.
