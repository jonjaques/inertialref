# CLAUDE.md

Guidance for Claude Code working in this repository.

**Read [`AGENTS.md`](AGENTS.md) first.** It is the working guide — rules,
conventions, layering, testing and how to drive the game — and it is written for
humans and agents alike. This file holds only what is specific to Claude Code
and to this machine, and points at AGENTS.md for everything else.

## Orientation

| File                       | What it is                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `AGENTS.md`                | How to work here: rules, conventions, testing, the harness. Read first.             |
| `docs/`                    | Explanatory documentation — concepts, diagrams, guides, decision records.           |
| `docs/design/`             | The game design bible — what the game is, and why each mechanic is shaped that way. |
| `docs/guides/catalogue.md` | The star catalogue: how it is built, what it stores, and what will bite you.        |
| `docs/vision.md`           | What the project is for, and the principles behind architectural choices.           |
| `docs/architecture.md`     | The system in one sitting.                                                          |
| `docs/adr/`                | The nine foundational decisions, with alternatives and consequences.                |
| `docs/roadmap.md`          | What is deliberately not built yet, and the seam for each.                          |
| `CONTEXT.md`               | Build log — what exists, what was decided, which bugs must not return.              |
| `README.md`                | Overview and the twelve proven capabilities.                                        |

## Commands

Package manager is **pnpm** (`pnpm-lock.yaml`, lockfileVersion 9). The
machine-wide default is `bun`; this repository's lockfile is pnpm's, so stay on
pnpm here.

```bash
pnpm install
pnpm dev          # vite dev server for apps/game
pnpm test         # vitest, node environment only
pnpm typecheck    # five tsconfig projects — see AGENTS.md for why
pnpm lint         # oxlint — NOT eslint; oxlint --fix applies autofixes
pnpm graph        # dependency layering + cycle check
pnpm build        # typecheck, then vite build
pnpm check        # graph, lint, typecheck, test, build

pnpm sim --self-test           # headless Node run + the twelve capability checks
pnpm vitest run <substring>    # a single test file

# The star catalogue. `data/catalog/` is committed, so none of these is needed
# to run the game or the tests — only to rebuild after astronomy publishes.
pnpm catalog:report            # build and print the counts, without writing
pnpm catalog:build             # ...and write data/catalog
pnpm catalog:build --refresh   # re-download rather than using .data/raw

# The Cloudflare Worker (apps/server). `pnpm dev` proxies /api and /ws to 8787,
# so without dev:server running the client correctly reports "no server".
pnpm dev:server                # wrangler dev on 127.0.0.1:8787
pnpm run deploy:worker         # pnpm build, then wrangler deploy
```

**`pnpm run deploy:worker`, not `pnpm deploy:worker`** — `deploy` is a pnpm
built-in, and the `:worker` suffix keeps the two from being confused. It
deploys to the `inertialrefd` Worker, live at
<https://inertialrefd.jaquers.workers.dev>. Regenerate
`apps/server/worker-configuration.d.ts` with
`pnpm --filter @inertialref/server run types` after any change to
`wrangler.jsonc`, and commit it.

`pnpm check` is the gate. Do not report a task complete without it passing.

## Toolchain facts that will otherwise surprise you

- **Vite 8** with `@vitejs/plugin-react` (Oxc transform) _and_
  `@rolldown/plugin-babel` running `reactCompilerPreset()`. **React Compiler is
  on** — do not hand-write `useMemo`/`useCallback` memoisation. `useMemo` for a
  stable Three.js object is a different thing and is fine.
- **`tsconfig.json` at the root is the `packages/*` project**, deliberately with
  no DOM lib. Apps have their own. Project references are not used; AGENTS.md
  explains why. It has no Node lib either, so `TextEncoder`, `fetch` and
  `node:fs` are all out of scope there — `packages/universe/src/catalog/` decodes
  bytes and each host supplies them.
- **`strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly` and
  `verbatimModuleSyntax` are all on.** No enums, no parameter properties,
  `import type` for types, and local imports carry their `.ts` extension.
- **oxlint** runs the `react`, `typescript` and `oxc` plugins. Type-aware rules
  are off; enabling them needs `oxlint-tsgolint` plus `options.typeAware`.
- Node 26, pnpm 11. Node runs the TypeScript sources directly (type stripping),
  which is how `pnpm sim` works with no build step.

## Working style here

- The engineering rules in AGENTS.md are not advisory — each one exists because
  violating it is a rewrite later rather than a refactor.
- Prefer a property-based test to an example when the thing under test is
  mathematical. Several real bugs here were found that way and would not have
  been found otherwise.
- When a test's bound is loose because of a real limit, name the limit in the
  assertion rather than picking a tolerance that happens to pass.
- Report completion as: Implemented / Architecture decisions / Tests &
  verification / Known limitations / Recommended next step.
