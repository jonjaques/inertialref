---
paths:
  - 'apps/server/**'
  - 'packages/net/**'
  - 'packages/protocol/**'
  - 'packages/persistence/**'
---

# The Worker and the wire

Reasoning: `docs/guides/development.md`, ADR-0007, ADR-0008.
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
- **`/media/*` is an allow-list, never a key prefix.** `src/media.ts` is the one table of
  what exists and where; `scripts/media.mjs` imports it rather than repeating it. The
  bucket is the site's general storage, so a prefix rule would make it world-readable.
- **Narrow `R2Range` on the value, not with `in`.** workerd sets all three keys, two of
  them `undefined`, so `'suffix' in range` is true for a range with no suffix and every
  number comes out `NaN` — silently. `routes.test.ts` has the regression.
- **`stored.range` is populated with or without a `Range` header.** Key the 206 off the
  request, or every plain GET is a partial response.
- **The media path's decisions live behind `MediaStores`, not behind `env`.** `index.ts`
  routes and passes bindings; `serveMedia.ts` owns which store answers and which of the
  four status codes says so, so all of it is reachable from a Node test.
- **One verdict on "is this the same universe?"** `versionDrift` in
  `packages/protocol/src/net.ts` compares both manifests — the generation versions and the
  catalog version — and the handshake, the save loader and the health panel all read it.
  An absent key is a mismatch, never a default.
- **A save stores references and mutations, never regenerable content.**
