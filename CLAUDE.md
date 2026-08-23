# CLAUDE.md

Guidance for Claude Code working in this repository.

**Read [`AGENTS.md`](AGENTS.md) first.** It is the working guide — rules,
conventions, layering, testing and how to drive the game — and it is written for
humans and agents alike. This file holds only what is specific to Claude Code
and to this machine, and points at AGENTS.md for everything else.

## Orientation

| File                       | What it is                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `AGENTS.md`                | How to work here: rules, conventions, testing, the harness. Read first.              |
| `docs/`                    | Explanatory documentation — concepts, diagrams, guides, decision records.            |
| `docs/design/`             | The game design bible — what the game is, and why each mechanic is shaped that way.  |
| `docs/guides/catalogue.md` | The star catalogue: how it is built, what it stores, and what will bite you.         |
| `docs/vision.md`           | What the project is for, and the principles behind architectural choices.            |
| `docs/architecture.md`     | The system in one sitting.                                                           |
| `docs/adr/`                | The twelve foundational decisions, with alternatives and consequences.               |
| `docs/roadmap.md`          | What is deliberately not built yet, and the seam for each.                           |
| `CONTEXT.md`               | Build log — what exists, what was decided, which bugs must not return.               |
| `README.md`                | Overview and the twelve proven capabilities.                                         |
| `.claude/`                 | The machinery below — rules, skills, agents, hooks. `.claude/rules/README.md` first. |

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
pnpm textures:build            # planetary surface maps into data/textures

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
  **`react/no-multi-comp` is an error**, so one component per file is checked
  rather than remembered — the remedy is a file named after the component, and a
  constant or a type it needs goes in a sibling `.ts`. Both that rule and
  `react/only-export-components` are off for `apps/game/src/components/ui/*.tsx`,
  which shadcn/ui generates and rewrites.
- **The three typefaces are self-hosted from `@fontsource`** — Instrument Serif
  (display), Instrument Sans Variable (structure and prose), Martian Mono
  Variable (every reading). Imported in `src/index.css`, which also defines the
  nine `type-*` utilities the whole interface is set in. **Do not write a size,
  a weight and a tracking at a call site**; reach for a named step. A Google
  Fonts `<link>` would break offline, which is the base case here.
- **React DnD 16** (`react-dnd`, `react-dnd-html5-backend`,
  `react-dnd-touch-backend`) drives the dockable panels, and _only_ the gesture:
  what a drop means is pure arithmetic in `apps/game/src/dock/layout.ts` and
  `dock/floating.ts`, both property-tested. The backend is chosen once at mount from `(pointer: coarse)`
  because `DndProvider` cannot be handed a different one. ADR-0012.
- **shadcn/ui is installed and is what the overlay is built from** — `Button`,
  `Collapsible`, `Tabs`, `Slider`, `Switch`, `Toggle`, `ToggleGroup`,
  `Separator`, `Badge`, `Input`, `Tooltip`. Do not hand-roll a control the
  registry has; go through `hud/Action.tsx`, `hud/SwitchRow.tsx` or
  `hud/TransportButton.tsx`, which carry the two things the registry cannot know
  (`releaseFocus`, and that the accent is never a fill behind text).
  `ScrollArea` is installed and deliberately unused — its `display: table`
  viewport breaks the `truncate` every panel readout depends on.
  `docs/roadmap.md` § "The overlay refactor" is the map.
  (`apps/game/components.json`, style `new-york`, base `slate`, lucide icons.)
  Add a component with `pnpm dlx shadcn@latest add <name>` **run from
  `apps/game`**, then `pnpm format` — the registry writes double quotes and
  semicolons, prettier here does not. Its design tokens live in `src/index.css` and are pointed at
  the existing slate/sky palette rather than the generator's defaults; do not
  regenerate them with `shadcn init`, which would overwrite that file.
- **`@/` resolves to `apps/game/src`**, in three places that must agree:
  `apps/game/vite.config.ts`, `apps/game/tsconfig.json` (`paths`, and
  deliberately no `baseUrl` — TypeScript 6 errors on it) and the root
  `vitest.config.ts`. It exists for the registry's hard-coded imports; hand
  written code still imports relatively, with extensions.
- Node 26, pnpm 11. Node runs the TypeScript sources directly (type stripping),
  which is how `pnpm sim` works with no build step.

## The machinery in `.claude/`

Most of it is automatic. The parts worth knowing:

- **`rules/` load themselves.** Each file carries `paths:` globs and enters context only
  when a matching file does — so editing `dock/layout.ts` brings the dock's invariant with
  it. They exist because `AGENTS.md` holds thirty invariants and **nothing loads it**;
  "read AGENTS.md first" is a request, not a mechanism. `AGENTS.md` stays canonical and
  carries the reasoning; the rules carry only the imperative. The contract for keeping the
  two in step is in [`.claude/rules/README.md`](.claude/rules/README.md) — read it before
  editing either.

- **The Stop hook runs the gate.** After any turn that touched a `.ts`/`.tsx`/`.mjs`/`.json`
  file, `graph → lint → typecheck → test` runs (~6s) and a failure comes back as something
  to fix rather than a task reported complete. It blocks at most three times per prompt,
  then reports and lets go. `pnpm build` is not in it — the full `pnpm check` belongs at
  commit, which is what `/ship` runs. `IR_SKIP_GATE=1` disables it.

- **Edits are formatted for you.** Prettier runs on every file written. **Do not run
  `pnpm format` or `pnpm lint` by hand** — you would be re-reading output the hooks
  suppress.

- **A fresh checkout installs itself.** `SessionStart` runs `pnpm install` when
  `node_modules` is absent — ~3s, because pnpm hardlinks from the global store. This covers
  worktrees and cloud sessions. It does **not** fire for subagents: an agent working in a
  worktree must run `pnpm install --frozen-lockfile --prefer-offline` itself, first.

| Skill          | For                                                        |
| -------------- | ---------------------------------------------------------- |
| `/drive`       | driving the game — the harness, and the four browser traps |
| `/ship`        | full check → commit → PR. Never auto-invoked               |
| `/parallel`    | fanning work out across worktrees. Never auto-invoked      |
| `/adr`         | writing an ADR in house style                              |
| `/context-log` | appending to `CONTEXT.md`                                  |

| Agent                  | For                                                      |
| ---------------------- | -------------------------------------------------------- |
| `invariant-auditor`    | auditing a diff against the thirty invariants. Read-only |
| `property-tester`      | `fast-check` properties for anything mathematical        |
| `worktree-implementer` | one isolated change, in its own worktree                 |
| `docs-curator`         | checking the docs still describe the code                |

**Cloud sessions need one manual step.** Cloud images ship Node 20/21/22 and this
repository needs Node 26 for type stripping. Paste
[`scripts/cloud-setup.sh`](scripts/cloud-setup.sh) into the environment's **Setup script**
field at claude.ai/code — once per environment; the result is snapshotted. Until then
`claude --cloud` starts and fails at the first import.

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
