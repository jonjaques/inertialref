# CLAUDE.md

Guidance for Claude Code working in this repository.

**Read [`AGENTS.md`](AGENTS.md) first.** It is the working guide — rules,
conventions, layering, testing and how to drive the game — and it is written for
humans and agents alike. This file holds only what is specific to Claude Code
and to this machine, and points at AGENTS.md for everything else.

## Orientation

| File | What it is |
|---|---|
| `AGENTS.md` | How to work here: rules, conventions, testing, the harness. Read first. |
| `docs/` | Explanatory documentation — concepts, diagrams, guides, decision records. |
| `docs/design/` | The game design bible — what the game is, and why each mechanic is shaped that way. |
| `docs/vision.md` | What the project is for, and the principles behind architectural choices. |
| `docs/architecture.md` | The system in one sitting. |
| `docs/adr/` | The nine foundational decisions, with alternatives and consequences. |
| `docs/roadmap.md` | What is deliberately not built yet, and the seam for each. |
| `CONTEXT.md` | Build log — what exists, what was decided, which bugs must not return. |
| `README.md` | Overview and the twelve proven capabilities. |

## Commands

Package manager is **pnpm** (`pnpm-lock.yaml`, lockfileVersion 9). The
machine-wide default is `bun`; this repository's lockfile is pnpm's, so stay on
pnpm here.

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

- The engineering rules in AGENTS.md are not advisory — each one exists because
  violating it is a rewrite later rather than a refactor.
- Prefer a property-based test to an example when the thing under test is
  mathematical. Several real bugs here were found that way and would not have
  been found otherwise.
- When a test's bound is loose because of a real limit, name the limit in the
  assertion rather than picking a tolerance that happens to pass.
- Report completion as: Implemented / Architecture decisions / Tests &
  verification / Known limitations / Recommended next step.
