# CLAUDE.md

Guidance for Claude Code working in this repository.

**Read [`AGENTS.md`](AGENTS.md) first.** It is the working guide — rules,
conventions, layering, testing and how to drive the game — and it is written for
humans and agents alike. This file holds only what is specific to Claude Code
and to this machine, and points at AGENTS.md for everything else.

## Orientation

| File | What it is |
|---|---|
| `INITIALPROMPT.md` | The authoritative engineering spec. Read before any architectural decision. |
| `AGENTS.md` | How to work here: rules, conventions, testing, the harness. |
| `CONTEXT.md` | Build log — what exists, what was decided, what is deliberately unfinished. |
| `docs/adr/` | The eight foundational decisions, with alternatives and consequences. |
| `README.md` | Overview and the twelve proven capabilities. |

## Commands

Package manager is **pnpm** (`pnpm-lock.yaml`, lockfileVersion 9). The
machine-wide default is `bun`; the lockfile and the spec both say pnpm, so stay
on pnpm here.

```bash
pnpm install
pnpm dev          # vite dev server for apps/game
pnpm test         # vitest, node environment only
pnpm typecheck    # three tsconfig projects — see AGENTS.md for why three
pnpm lint         # oxlint — NOT eslint; oxlint --fix applies autofixes
pnpm graph        # dependency layering + cycle check
pnpm build        # typecheck, then vite build
pnpm check        # graph, lint, typecheck, test, build

pnpm sim --self-test           # headless Node run + the twelve capability checks
pnpm vitest run <substring>    # a single test file
```

`pnpm check` is the gate. Do not report a task complete without it passing.

## Toolchain facts that will otherwise surprise you

- **Vite 8** with `@vitejs/plugin-react` (Oxc transform) *and*
  `@rolldown/plugin-babel` running `reactCompilerPreset()`. **React Compiler is
  on** — do not hand-write `useMemo`/`useCallback` memoisation. `useMemo` for a
  stable Three.js object is a different thing and is fine.
- **`tsconfig.json` at the root is the `packages/*` project**, deliberately with
  no DOM lib. Apps have their own. Project references are not used; AGENTS.md
  explains why.
- **`strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly` and
  `verbatimModuleSyntax` are all on.** No enums, no parameter properties,
  `import type` for types, and local imports carry their `.ts` extension.
- **oxlint** runs the `react`, `typescript` and `oxc` plugins. Type-aware rules
  are off; enabling them needs `oxlint-tsgolint` plus `options.typeAware`.
- Node 26, pnpm 11. Node runs the TypeScript sources directly (type stripping),
  which is how `pnpm sim` works with no build step.

## Working style here

- The spec's twelve engineering rules are not advisory. AGENTS.md lists the ones
  that are expensive to violate.
- Prefer a property-based test to an example when the thing under test is
  mathematical. Several real bugs here were found that way and would not have
  been found otherwise.
- When a test's bound is loose because of a real limit, name the limit in the
  assertion rather than picking a tolerance that happens to pass.
- Report completion as: Implemented / Architecture decisions / Tests &
  verification / Known limitations / Recommended next step.
