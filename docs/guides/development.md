# Development

Commands, toolchain, and the conventions that surprise people. For the rules
those conventions exist to protect, see [`AGENTS.md`](../../AGENTS.md). For
how an agent should start and finish work, see the
[agent handbook](../agents/README.md).

---

## Commands

Package manager is **pnpm**. The lockfile is pnpm's; do not use npm, yarn, or
bun to change dependencies.

```bash
pnpm install
pnpm dev              # Vite on 5173 and wrangler on 8787
pnpm preview          # production build, served by the real Worker on 8787
pnpm test             # Vitest, Node environment only
pnpm typecheck        # five tsconfig projects
pnpm lint             # oxlint, not eslint
pnpm graph            # dependency layering and cycle check
pnpm brand            # regenerate brand artifacts from design/brand/brandmark.svg
pnpm build            # optional media pull, typecheck, then Vite build
pnpm check            # graph, brand, format, lint, typecheck, test, build

pnpm sim --self-test           # headless run plus the twelve capability checks
pnpm vitest run <substring>    # a single test file

# Star catalog. data/catalog/ is committed; these rebuild it.
pnpm catalog:fetch
pnpm catalog:report
pnpm catalog:build
pnpm catalog:build --refresh
pnpm textures:build

pnpm dev:client                # Vite only
pnpm dev:server                # wrangler on 127.0.0.1:8787
pnpm run deploy:worker         # build, then wrangler deploy
pnpm media:pull                # reference audio from R2; not in git
pnpm media:push
```

`pnpm run deploy:worker`, not `pnpm deploy:worker` — `deploy` is a pnpm
built-in. After any change to `wrangler.jsonc`, regenerate
`apps/server/worker-configuration.d.ts` with
`pnpm --filter @inertialref/server run types` and commit it.

`pnpm check` is the gate. Do not report a task complete without it passing.

The site deploys to the `inertialrefd` Worker. Canonical URL:
<https://inertialref.jonjaques.com>, and the only address it answers on. To
check a build before trusting DNS, `pnpm --filter @inertialref/server run
versions:upload` uploads a version without promoting it and prints its own
preview URL; analytics and `<link rel="canonical">` name the custom domain, so a
preview never counts as a visit.

---

## Five TypeScript projects, no project references

A referenced project may not disable emit. Emitting declarations for twelve
source-only packages to satisfy `tsc -b` buys nothing. Five independent
tsconfig projects type-check the portable core and four host environments:

| Project                       | Covers            | Environment                                                               |
| ----------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `tsconfig.json`               | `packages/*/src`  | **No DOM lib, no Node lib** — must run in the browser, a worker, and Node |
| `apps/game/tsconfig.json`     | the client        | DOM, WebWorker, JSX                                                       |
| `apps/headless/tsconfig.json` | the Node runner   | Node types                                                                |
| `apps/server/tsconfig.json`   | the Worker        | workerd globals and `Env`, from `worker-configuration.d.ts`               |
| `apps/ingest/tsconfig.json`   | the catalog build | Node types; runs offline, never at play time                              |

`packages/*` are source-only workspace links. There is no build step between
an edit and a test. Each package declares `inertialref.layer` in
`package.json` and may depend only on strictly lower layers. `pnpm graph`
enforces layering, acyclicity, and the ban on third-party runtime dependencies
in `packages/*`.

If a package needs a host capability, it declares a **port** and the host
implements it. See `packages/workers/src/transport.ts` and
`packages/persistence/src/store.ts`. That is why the worker pool can be driven
by an in-process fake in Node tests.

---

## Conventions

- **SI internally** — meters, seconds, kilograms, radians. Presentation units
  are branded types and exist only for display.
- **Axes are right-handed, +Y up.** A system's reference plane is XZ, forward
  is −Z. Textbook orbital mechanics is +Z up, so `physics/frameConvention.ts`
  converts once at that boundary and nowhere else.
- **Terrain is sampled in body-fixed axes.** Sampling in inertial axes leaves
  the mountains behind as the planet rotates.
- **Imports carry their `.ts` extension.** `allowImportingTsExtensions` is on
  and Node runs the sources directly. The exception is `@/` in `apps/game`,
  which resolves to `apps/game/src` because the shadcn registry writes
  `@/lib/utils`. Its definitions in `apps/game/vite.config.ts`,
  `apps/game/tsconfig.json`, and the root `vitest.config.ts` must agree.
  TypeScript 6 rejects `baseUrl`, so the tsconfig uses `paths` without it.
  Hand-written code still imports relatively.
- **No `enum`, no parameter properties, no runtime namespaces** —
  `erasableSyntaxOnly` is on. Use `const` objects plus union types.
- **`import type` for type-only imports** — `verbatimModuleSyntax` is on.
- **One React component per file.** `react/no-multi-comp` is an error. A
  constant or type the component needs goes in a sibling `.ts`. The exemption
  is `apps/game/src/components/ui/*.tsx`, which the shadcn registry rewrites.
- Comments explain _why_, and specifically why the obvious thing does not
  work. Do not restate the code.

---

## Toolchain

**Vite 8** with `@vitejs/plugin-react` (Oxc transform) and
`@rolldown/plugin-babel` running `reactCompilerPreset()`. React Compiler is
on: do not hand-write `useMemo` / `useCallback` memoization. `useMemo` for a
stable Three.js object is a different thing and is fine.

**oxlint** runs the `react`, `typescript`, and `oxc` plugins. Type-aware rules
are off. `react/no-multi-comp` is an error. Both that rule and
`react/only-export-components` are off for `apps/game/src/components/ui/*.tsx`.

**Prettier** formats files written through the edit hooks. Do not run
`pnpm format` or `pnpm lint` merely to duplicate those hooks. Commands that
write files outside the hooks, including the shadcn CLI, still need
`pnpm format`.

**Three typefaces**, self-hosted from `@fontsource`: Archivo Variable
(condensed display), Instrument Sans Variable (structure and prose), Martian
Mono Variable (every reading). There is no serif. They are imported in
`src/index.css`, which also defines the nine `type-*` utilities. Do not write
a size, a weight, and a tracking at a call site — use a named step. A Google
Fonts `<link>` would break offline, which is the base case.

**React DnD 16** drives dockable panels, and only the gesture. What a drop
means is arithmetic in `apps/game/src/dock/layout.ts` and `dock/floating.ts`.
The backend is chosen once at mount from `(pointer: coarse)` because
`DndProvider` cannot be handed a different one. [ADR-0012](../adr/0012-dockable-panels.md).

**shadcn/ui** is the overlay control set. Do not hand-roll a control the
registry has. Go through `hud/Action.tsx`, `hud/SwitchRow.tsx`, or
`hud/TransportButton.tsx`. They call `releaseFocus` after a pointer click so
flight controls regain the keyboard, and they enforce the accent-as-material
rule: `Button`'s solid `default` variant is wrong for the primary tone; use
`outline` plus the `sky-500/15` wash. `ScrollArea` is installed and unused:
its `display: table` viewport breaks `truncate`. Add a component with
`pnpm dlx shadcn@latest add <name>` **from `apps/game`**, then run
`pnpm format` — the registry writes double quotes and semicolons. Do not run
`shadcn init`; it would overwrite `src/index.css`.

**Brand** is generated from `design/brand/brandmark.svg` via `pnpm brand`.
Never hand-edit `favicon.svg`, the `.ico`, the apple-touch and PWA icons, the
share card, the web manifest, `robots.txt`, `sitemap.xml`, or
`src/icons/brandmark.ts`. `pnpm brand:check` is in `pnpm check`.

**Site metadata** is duplicated on purpose: `src/site.ts` for the running
client, `index.html` for scrapers that do not run JavaScript, and
`pages/DocumentMeta.tsx` for per-route title, description, and canonical URL.
Change all affected copies together.
[`docs/hosting.md`](../hosting.md) records why they are not a single Worker
render.

**Analytics** loads from `src/analytics.ts`, only in a production build, only
on the canonical host, and only without Global Privacy Control. The
measurement id is `VITE_GA_MEASUREMENT_ID` and is **not in the repository**.
Workers Builds supplies it as a build variable. A deploy from this machine
reads the same name from gitignored `apps/game/.env.production`; a real
environment variable wins over the file. `apps/game/.env.example` documents
the setup. Nothing secret may go in either place because every `VITE_*` value
ships in the bundle.

**Reference audio** is not in git. It lives in R2 and reaches the browser
from one table, `apps/server/src/media.ts`: `pnpm media:pull` copies it into
gitignored `apps/game/public/media/`, and the Worker's `MEDIA` binding serves
it when a credential-less build did not. `/media/*` is an allow-list, never a
key prefix. See [hosting](../hosting.md) H-8 for the two workerd traps around
`R2Range`.

**Three.js:** in `apps/game`, import `three/webgpu` and `three/tsl`, never
`three`. `packages/*` may not import Three.js at all; `pnpm graph` enforces
that half.

**Node 26** is required. Cursor Cloud gets it from
[`.cursor/Dockerfile`](../../.cursor/Dockerfile). Claude cloud environments
that still ship Node 20–22 use
[`scripts/cloud-setup.sh`](../../scripts/cloud-setup.sh); until the correct
runtime is installed, type stripping fails at the first import.

---

## Related

- [Getting started](getting-started.md) — clone to flying
- [Testing](testing.md) — what to test, and how
- [Extending](extending.md) — adding a body type, a task, a save field
- [Agent handbook](../agents/README.md)
