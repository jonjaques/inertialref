---
paths:
  - 'packages/universe/src/catalog/**'
  - 'apps/ingest/**'
---

# The star catalogue

Reasoning: `docs/guides/catalogue.md`, `docs/design/galaxy.md` Rule 1.

- **Never store what the catalogue can derive.** HYG ships a `lum` column that is its own
  `absmag` restated in the wrong band. The packed file carries _measurements_;
  temperature, luminosity, radius, mass and colour are computed at load. Same rule is why
  a Bayer designation is two small integers and `Alpha Centauri` is a string nobody stores.
- **Never make the catalogue ambient.** It is a generation input alongside the seed,
  passed as an argument everywhere: `resolveSystem`, `systemsWithin`, `new World({
catalog })`. A singleton would make the catalogue _version_ a hidden input, which
  invalidates every save the next time astronomy publishes.
- **`packages/universe/src/catalog/` decodes bytes; it does not fetch them.** No `fetch`,
  no `node:fs`, no `TextEncoder` — the root tsconfig has neither DOM nor Node lib. Each
  host supplies the bytes.
- **`data/catalog/` is committed.** Nothing about running the game or the tests requires
  rebuilding it. `pnpm catalog:report` prints the counts without writing; `catalog:build`
  writes; `--refresh` re-downloads rather than reusing `.data/raw`.
- **`data/catalog/manifest.json` records the digest of exactly what was used.** A rebuild
  that changes the counts is a deliberate act — say what moved and why.
