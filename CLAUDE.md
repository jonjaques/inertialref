# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository currently is

**Greenfield.** `src/` is still the stock Vite + React + TypeScript template (`App.tsx` is the
Vite landing page, `assets/` holds the template logos). None of the simulation described below
exists yet. There is no git repository here either — `git init` before assuming any git workflow.

**`INITIALPROMPT.md` at the repo root is the authoritative engineering spec** for InertialRef, a
browser-based 6-DoF simulation of the Milky Way spanning galactic-to-inch scales. Read it before
making any architectural decision — it defines the target architecture, twelve engineering rules,
the first milestone's vertical slice, and the definition of done. The invariants below are its
load-bearing parts; the spec itself has the reasoning.

`README.md` is still the template README. Its one useful section is the documented upgrade path to
type-aware oxlint rules; treat the rest as stale, not as project documentation.

## Commands

Package manager is **pnpm** (`pnpm-lock.yaml`, lockfileVersion 9). The machine-wide default is
`bun`, but the lockfile and the spec's workflow both say pnpm — stay on pnpm here.

```bash
pnpm install
pnpm dev        # vite dev server
pnpm build      # tsc -b && vite build  (project-reference build, then bundle)
pnpm lint       # oxlint — NOT eslint; oxlint --fix applies autofixes
pnpm preview
pnpm exec tsc -b    # type-check only; there is no `typecheck` script yet
```

Missing relative to the spec (§18): `test`, `typecheck`, and an aggregate `check`. Add them as
part of the first change that introduces testable code — the spec requires
`pnpm dev/test/lint/typecheck/build` plus `pnpm check`, all non-interactive with meaningful exit
codes so agents can run them unattended. No test runner is installed yet; when one is chosen,
record the **single-test** invocation in this section — the spec expects heavy unit, integration,
round-trip, and property-based testing of the spatial math and generators.

## Toolchain facts that will otherwise surprise you

- **Vite 8** with `@vitejs/plugin-react` (Oxc transform) *and* `@rolldown/plugin-babel` running
  `reactCompilerPreset()`. **React Compiler is on** — don't hand-write `useMemo`/`useCallback`
  memoization. It also measurably slows dev and build.
- **tsconfig is project-referenced**: root `tsconfig.json` has no files, only references to
  `tsconfig.app.json` (`include: ["src"]`, DOM lib) and `tsconfig.node.json` (`vite.config.ts`
  *only*). Anything new that must be type-checked — workers, tests, server, packages — needs its
  own project added to the references, or `tsc -b` silently ignores it.
- **`strict` is not set** in `tsconfig.app.json`. Spec §16 mandates `strict: true`. Turn it on
  (and consider `noUncheckedIndexedAccess`) *before* writing coordinate/physics math, not after.
- **`erasableSyntaxOnly: true`** — no `enum`, no constructor parameter properties, no runtime
  namespaces. Express the spec's discriminated unions with `const` objects plus union types.
- **`verbatimModuleSyntax: true`** — type-only imports need `import type`.
- **`allowImportingTsExtensions`** — local imports carry their extension (`./App.tsx`). Match it.
- oxlint runs the `react`, `typescript`, and `oxc` plugins. Type-aware rules are **off**; enabling
  them needs `oxlint-tsgolint` plus `options.typeAware` in `.oxlintrc.json`.
- This machine: Node 26, pnpm 11.

## Architectural invariants

These are the constraints that make the eventual galaxy possible. Violating one is a rewrite later,
not a refactor.

**Coordinates are layered, and Three.js is the bottom layer only.**
`authoritative simulation position → reference-frame transforms → local scene coordinates → Three.js`.
No absolute universe position ever lives in a `Vector3`. Canonical positions are high-precision
(double, or integer/fixed-point where it helps) inside a hierarchical frame; render coordinates are
single-precision and local to a rebased origin. Rebasing a local frame must not change any entity's
identity or canonical location. There is no gameplay-visible "space mode" vs "planet mode".

**Generation is deterministic and order-independent.**
`global seed + stable address + algorithm version → same result`, regardless of traversal order,
worker count, or async scheduling. Derive seeds hierarchically (universe → system → body → region →
object) through an explicit seeded PRNG. Never `Math.random()` for canonical content. Sequential
`rng.next()` streams where inserting an object shifts everything after it are the specific failure
mode to avoid. Version generation algorithms so changes don't silently mutate persisted worlds.

**Identity is an address, not a pointer.**
Stable IDs must not derive from array order, memory, Three.js object IDs, render lifecycle, worker
scheduling, or connection order. The same addressing scheme (galaxy/system/body/region/entity)
serves persistence, generation, network messages, saves, replay, and debug tooling. An entity exists
canonically whether or not it currently has a Three.js object.

**The simulation core is framework-free.** It must be runnable in a Web Worker and on a server with
no React, DOM, or WebGL. React consumes simulation state and owns UI/HUD/devtools; canonical state
never lives in component state, and gameplay behavior never lives in lifecycle callbacks.

**Time is explicit.** Fixed simulation timestep, interpolated presentation, no canonical state
derived from `Date.now()` or frame rate. 144 Hz and 60 Hz must produce the same universe. Plan for
pause, time warp, deterministic stepping, and replay.

**Streaming is the normal case.** Nothing may assume the universe is loaded. Keep universe
existence, persistent state, generated state, simulation state, network relevance, and render
visibility as separate concerns; load/unload is ordinary control flow, not a special case.

**Workers go through one abstraction** — typed messages, explicit task contracts, job IDs,
cancellation, pooling, instrumented queue latency. No ad-hoc `new Worker()` at call sites. Worker
task logic should be testable outside a worker.

**Offline-first, then multiplayer.** Single-player must run with no server after assets are cached.
Persistence = deterministic base universe + versioned persistent mutations; never persist procedural
output that regenerates from its seed. Multiplayer (likely Cloudflare Workers + Durable Objects,
partitioned by star system) is an authority layer *over* the local simulation, reached through
adapters — core simulation code must not import Cloudflare APIs.

**Units are SI internally** — meters, seconds, kilograms, radians, m/s, m/s². Feet, miles, AU, and
light-years are presentation-layer conversions. Encode units in type or API names where it prevents
mistakes; no implicit conversions.

**LOD is architecture, not a graphics tweak.** Separate an entity from its current representation so
a planet can be a point, a sphere, orbital terrain, or walkable surface without changing identity.

## Repository structure and its expected migration

Target boundaries are domain-shaped, not framework-shaped: `apps/{game,server}` plus `packages/`
(`simulation`, `spatial`, `universe`, `procedural`, `physics`, `networking`, `persistence`,
`protocol`, `workers`, `rendering`, `ui`, `shared`, `devtools`). The exact layout is negotiable;
the property that matters is that `simulation`, `spatial`, and `procedural` can run unchanged in the
browser main thread, a worker, Node tests, and on a server. Keep foundational packages low in the
dependency graph and avoid cycles.

The current single-app `src/` tree is fine until a second consumer appears (a worker, a server, or
Node-run tests). That is the moment to restructure — don't defer it past that point, and don't
restructure before there is code to place.

Architectural decision records live in `docs/adr/` (Context / Decision / Alternatives /
Consequences). The spec requires ADRs for eight decisions before the systems they cover are built:
universe coordinates, reference frames, render coordinates, entity addressing, procedural seeds,
simulation clock, persistence, multiplayer partitions.

## Definition of done

A rendered browser window is not done. Done means: correct implementation, architectural boundaries
respected, determinism preserved, tests exist and pass, `tsc -b` passes, `oxlint` passes, the build
passes, docs/ADRs reflect meaningful architectural changes, and debug tooling can actually inspect
the new state (entity ID, universe address, frame, local and canonical coordinates, velocity, tick,
seed, active LOD, loaded region, authority, worker queue). Prefer structured logging over scattered
`console.log`. When a defect exposes a missing invariant, add the regression test.

Report completion as: Implemented / Architecture decisions / Tests & verification / Known
limitations / Recommended next step.

The first milestone is the vertical slice in `INITIALPROMPT.md` — a galaxy with two-plus systems,
star, planet, local surface frame, and a debug spacecraft, proving all twelve listed capabilities
with primitive graphics. Build the proof, not feature breadth.

## Keeping this file current

The spec (§18) also asks for `AGENTS.md`. When it exists, keep the two consistent rather than
duplicating: put shared guidance in `AGENTS.md` and let this file point at it. Update the Commands
section the moment `test`/`typecheck`/`check` scripts land.
