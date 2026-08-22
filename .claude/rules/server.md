---
paths:
  - 'apps/server/**'
  - 'packages/net/**'
  - 'packages/protocol/**'
  - 'packages/persistence/**'
---

# The Worker and the wire

Reasoning: `AGENTS.md` § "Layout and layering", ADR-0007, ADR-0008,
`docs/hosting.md`.

- **The vendor SDK stops at the adapter.** `apps/server` may know what a Durable Object
  is; `packages/net`, `packages/protocol` and `packages/persistence` may not. They declare
  ports — `persistence/src/store.ts` is the pattern — and the host implements them.
- **Regenerate `worker-configuration.d.ts` after any change to `wrangler.jsonc`**, with
  `pnpm --filter @inertialref/server run types`, and commit it. It is generated and
  committed; add a binding without regenerating and the typecheck passes against a stale
  `Env`.
- **`apps/server/tsconfig.json` is neither the browser nor Node.** It type-checks against
  workerd globals and that generated `Env`.
- **`pnpm dev` proxies `/api` and `/ws` to 8787.** Without `pnpm dev:server` running, the
  client correctly reports "no server" — that is not a bug to fix in the client.
- **Deploy is `pnpm run deploy:worker`, not `pnpm deploy:worker`** — `deploy` is a pnpm
  built-in. It ships to the `inertialrefd` Worker.
- **A save stores references and mutations, never regenerable content.**
