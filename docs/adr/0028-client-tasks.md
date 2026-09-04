# ADR-0028: Client tasks — the shared registry is what every host serves, and a host's worker entry adds what only it needs

Status: accepted · 3 Sep 2026

## Context

An atmosphere's scattering tables are baked from its authored haze — a recipe,
then a 512×64 transmittance table and a 32×32 multiple-scattering table
marched from it — in `@inertialref/rendering`, as pure arrays. The bake costs
20 to 40 ms of CPU per distinct haze, and it runs on the main thread the first
time a shell is drawn. Boot pays it behind the overlay for every haze in the
loaded systems. A jump to a generated system does not: its bodies carry hazes
boot has never seen, and the first look at one lands the bake inside the
arrival frame — measured at **39.7 ms inside a 43.3 ms frame**, the largest
single thing left in a transition once the ground moved to the GPU producer
([perf](../../design/plans/perf.md)). A watcher that polls the loaded-system
set once a second and drains one bake per macrotask spreads the cost across
frames without taking it out of any of them.

Nothing in the bake needs the main thread. It reads the haze and the shell
ratio the request carries and is the same function wherever it runs, which is
the property `universe.surfaceDetailFloor` was moved to the pool for
([ADR-0021](0021-the-ground.md)), and the shape is that task's: arrays back,
the half-float conversion and the GPU upload staying where the GPU is.

The obvious home is beside that task, in `packages/workers`. It cannot go
there. The bake lives in `packages/rendering`, `packages/workers` is the same
layer — both 5 — and `pnpm graph` allows a package to depend on strictly lower
layers only. So the question the perf plan raised was not where a `defineTask`
goes but what a registry is: whether the one set every host serves is the only
set there is.

## Decision

**The shared registry is what every host serves, and a host's own worker
entry registers what only that host needs.** `createTaskRegistry()` in
`packages/workers` stays the set the game, the headless runner and the tests
all serve. The game's entry point builds `createGameTaskRegistry()`
(`apps/game/src/workers/registry.ts`): the shared set plus
`render.bakeAtmosphere`, defined in `apps/game/src/render/atmosphereTask.ts`
over the pure bake in `@inertialref/rendering`.

- **The name carries the owner.** `universe.*` is the shared set; `render.*`
  is the client's. A task's prefix says which registry it is found in and
  which hosts can be asked for it.
- **The worker and the test engine build from the same registry.** The worker
  entry serves `createGameTaskRegistry()`, and `engine/headlessEngine.ts` hands
  it to the inline pool the engine tests drive, so a test's pool serves exactly
  the names the browser's does. A test holds the game registry to the shared
  names plus this one.
- **The response is arrays, transferred.** A worker has no GPU. The recipe and
  the two `Float32Array` tables cross the wire — 528 KB a bake, moved rather
  than copied — and `render/atmosphereLuts.ts` converts to half-float and
  uploads on the main thread, as it does for a bake made there.
- **The synchronous bake stays as the fallback, and the two never disagree.**
  `scatteringFor` still bakes on the main thread for a page with no pool. With
  a pool, a shell whose tables are not cached asks `scatteringVia`, which
  submits the job and answers `null`; the material keeps its 1×1 stand-ins —
  full transmittance, no scattering, a vacuum that draws nothing — until the
  tables land, and `Bodies.tsx` writes `setScattering` every frame the shell
  is drawn, so it picks them up on whichever frame that is. Whichever of the
  two paths fills the cache first wins, and the other reads it: a body never
  wears two bakes.
- **The watcher becomes a prefetch.** `watchSystemAtmospheres` submits every
  haze of a newly loaded system to the pool at once, so in the ordinary case
  the tables are cached before the shell is in view and the frame pays only
  the upload. The boot prebake stays synchronous behind the overlay, where the
  census already counts it.
- **Nothing in a client task may import `three/webgpu`.** The task file is part
  of the worker bundle. `packages/rendering` is arithmetic and imports no
  Three, which is what makes the bake movable at all.

## Alternatives considered

- **Move the scattering model down to `packages/universe`.** Layer 3, below
  both, and `HazeAuthoring` is derived from a `HazeLayer` universe already owns.
  Declined: the tables are presentational optics — how a renderer draws the
  air, calibrated against a tuned shell's brightness — and `universe` is the
  canonical generator, where a change is a version and a version moves saves.
  Putting a rendering integrator under the determinism rules would be a
  category error that the layer number happens to permit.
- **A new `packages/optics` at layer 4.** The honest home if two hosts needed
  the bake off-thread. Declined for now: one module with one consumer is a
  package for the sake of a package, and the second consumer here is the
  client's own worker, which can already import both layers. If the headless
  runner ever renders plates and wants the bake on a thread, the package is the
  next step, and this record names it.
- **Spread the main-thread bake further.** One bake per macrotask already;
  one per frame is the limit. Declined: a 40 ms task in a 16 ms frame is a
  dropped frame whichever frame it is given.
- **A GPU compute kernel, as the terrain producer is.** Declined: 528 KB once
  per haze, and the CPU bake is the reference — a kernel would be a port held
  to a measured bound, for a cost paid once per body.

## Consequences

- The worker bundle carries `@inertialref/rendering`'s bake beside the
  universe it already carried. The worker is a module worker and the import
  is pure; the size is a few kilobytes.
- A client task is not served by the headless runner. `pnpm sim` never asks
  for `render.bakeAtmosphere`, and a headless host that did would fail at
  dispatch with the task's name, which is the failure the registry is built
  to give.
- The rule that no `Worker` is constructed outside `browserWorker.ts` is
  untouched. This record is about what a worker serves, not who makes one.
- Two registries to keep in step, held by a test: the game's names are the
  shared names plus this one, and the shared set does not know it.
- Measured on the perf rig — the planetarium at Earth with `?timing=full`,
  then `ir.loadSystem('HIP71683')` and a look at its second body, the page's
  timing drained eight seconds later: **three** `bake atmosphere` entries on
  the page thread before, **none** after, with twelve bakes logged as made on
  the pool for that arrival and no error. The worker's own cost lands on its
  `Tasks` track, which a page-side drain cannot see and a trace can
  ([ADR-0022](0022-the-timeline.md)). A shell drawn inside the pool's latency
  draws without haze for those frames rather than with a stalled frame, which
  is the trade `surfaceDetailFloor` already made for the ground.
