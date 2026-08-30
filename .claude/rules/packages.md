---
paths:
  - 'packages/**/*.ts'
  - 'packages/*/package.json'
---

# packages/\* — the portable core

Reasoning: `docs/guides/development.md`, `pnpm graph`.

- **No third-party runtime dependency.** The core runs unchanged in a browser, a worker
  and Node; depending on nothing but itself is the cheapest guarantee of that.
- **No Three.js import at all**, and no hosting vendor's SDK. Nothing here may know what
  a Durable Object is.
- **Depend only on strictly lower layers.** The layer is declared in each
  `package.json` as `inertialref.layer`: shared 0, procedural/spatial 1, physics 2,
  universe 3, simulation/protocol 4, net/persistence/rendering/workers 5, devtools 6.
- **No DOM lib and no Node lib.** The root `tsconfig.json` is this project. `TextEncoder`,
  `fetch` and `node:fs` are all out of scope — `catalog/` decodes bytes a host supplies.
- **A host capability is a port.** Declare an interface here, let the host implement it —
  `workers/src/transport.ts`, `persistence/src/store.ts`. That is why the worker pool can
  be driven by an in-process fake in Node tests.
- **No `performance.` and no `console.timeStamp` anywhere here.** They are host globals,
  their types are not in scope, and Node's `console.timeStamp` is not Chrome's. Emit
  through a `Timer` from `shared/src/timing.ts`; `Span.end()` returns `void`, so nothing
  here can observe a duration. `apps/headless/src/coreHostApis.test.ts` greps for it,
  because a global is not an import and `pnpm graph` cannot see one. ADR-0022.
- **Imports carry their `.ts` extension.** `allowImportingTsExtensions` is on and Node
  runs the sources directly.
- **No `enum`, no parameter properties, no runtime namespaces** — `erasableSyntaxOnly`.
  Use `const` objects plus union types. `import type` for types — `verbatimModuleSyntax`.
