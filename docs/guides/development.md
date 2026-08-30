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
pnpm presets:plates   # recapture the seven preset thumbnails through the renderer
pnpm presets:check    # every picture has a plate, every composition it names resolves
pnpm docs:build       # render docs/ and packages/* into the documentation site
pnpm build            # optional media pull, docs, typecheck, then Vite build
pnpm check            # graph, brand, presets, format, lint, typecheck, test, build

pnpm sim --self-test           # headless run plus the twelve capability checks
pnpm vitest run <substring>    # a single test file

pnpm drive --help              # drive Chrome over CDP: --js, --shot, --sample, --down
pnpm drive --trace 3000        # record a Chrome trace, with ?timing=trace on the url
pnpm timing --help             # read one back: per-track p50/p95 and which span was slow
pnpm sim --profile             # the same report headlessly, over the worker pool

# Vendored data. Everything under data/ is committed; these rebuild it.
pnpm catalog:fetch             # download the star catalog sources into .data/raw
pnpm catalog:report            # build the catalog and print, without writing
pnpm catalog:build             # build the catalog and write data/catalog
pnpm catalog:build --refresh   # ...re-downloading rather than using the cache
pnpm textures:build            # surface maps into data/textures (1.5 GB in, 25 MB out)
pnpm shapes:build              # measured shape models into data/shapes
pnpm solar:fetch               # data/reference/solar-system.json, from JPL

pnpm dev:client                # Vite only
pnpm dev:server                # wrangler on 127.0.0.1:8787
pnpm run deploy:worker         # build, then wrangler deploy
pnpm media:pull                # reference audio from R2; not in git
pnpm media:push
```

**`pnpm dev` needs a `dist/` to exist, which a fresh worktree does not have.**
`apps/server/wrangler.jsonc` binds its assets to `../game/dist`, and `wrangler
dev` refuses to start when that directory is absent — so in a worktree created
by [`/parallel`](../../.claude/skills/parallel/SKILL.md), or in any clone that
has never built, the Worker half exits immediately and `scripts/dev.mjs` stops
the Vite half with it. The failure names the directory and nothing else, and it
is easy to read as a broken checkout.

Two ways out, and which one you want depends on why you are serving:

```bash
pnpm dev:client   # Vite alone on 5173 — everything except the Worker's routes
pnpm build        # once, then `pnpm dev` works for the life of the worktree
```

`pnpm check` runs `pnpm build`, so a worktree that has been through the gate
once is already fixed. **`pnpm drive` walks into this**: `--serve` is on by
default and starts `scripts/dev.mjs`, so on a fresh worktree it waits its full
sixty seconds for a server that died in the first two and then reports that
nothing is answering. Serve with `pnpm dev:client` yourself and pass
`--no-serve`, or build once.

`pnpm run deploy:worker`, not `pnpm deploy:worker` — `deploy` is a pnpm
built-in. After any change to `wrangler.jsonc`, regenerate
`apps/server/worker-configuration.d.ts` with
`pnpm --filter @inertialref/server run types` and commit it.

`pnpm check` is the gate. Do not report a task complete without it passing.

None of the four data commands are needed to build or run the game — their
outputs are committed. Run one when the upstream publishes; the diff is the news.
`textures:build` and `shapes:build` download 1.5 GB between them into the
gitignored `.data/`, and only the processed outputs are committed. The
[catalog guide](catalogue.md) has the provenance rules each of them follows.

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
write files outside the hooks still need `pnpm format` — the shadcn CLI, and
**any edit an agent makes through the shell** rather than through its edit
tool, which is the case the hooks cannot see and the one that reaches CI as a
`format:check` failure.

**ImageMagick and ffmpeg** are what the frame tools shell out to. `magick`
differences a run of rendered frames and is required by `scripts/frameDiff.mjs`,
`--cast` and `scripts/traceFrames.mjs`; `ffmpeg` turns a cast into the clip worth
attaching to a pull request and is optional, skipped rather than fatal when absent.
`brew install imagemagick ffmpeg`.

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
`src/icons/brandmark.ts`. `pnpm brand:check` is in `pnpm check`. The share
card has a second source, `design/brand/og-plate.png` — a captured frame of the
renderer that its type is composited over. `scripts/brand/og.mjs` carries the
framing it was shot at, so it can be shot again.

**Preset plates** are the thumbnails under the planetarium's Presets panel, in
`apps/game/public/presets/`. `pnpm presets:plates` recaptures them — all seven,
or one by id — by driving Chrome against `pnpm dev`, so a dev server has to be
up and the machine needs a GPU. They are vendored for the reason the share card
is: a build that needed a GPU would not run in CI, on a fork, or on a machine
with no display, and the one thing a thumbnail may not do is be absent.
`pnpm presets:check` is in `pnpm check` and proves only that each picture has a
plate and names a composition that still resolves — nothing can check that a
plate still _looks_ like the picture, because comparing it to what the renderer
produces now is the review itself. Recapture, and a diff in `git status` is the
signal.

**The documentation site** at `/docs` is generated. `pnpm docs:build` renders
every markdown file under `docs/`, plus `AGENTS.md`, and every export of
`packages/*` through TypeDoc, into `apps/game/public/doc-content/` — which is
gitignored, staged by `pnpm build` before the client build, and fetched at
runtime. Editing a page means editing the markdown; the site has no copy of
its own. Two things it will refuse to do: a markdown file under `docs/` that
no wing in `scripts/docs/wings.mjs` lists fails the build rather than
publishing nowhere, and a `{@link}` pointing at a renamed symbol fails it
rather than rendering as words that link to nothing. `scripts/docs/build.mjs`
carries the rest.

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
[`.cursor/Dockerfile`](../../.cursor/Dockerfile), which also installs `git`,
`git-lfs`, `tmux`, and a UTF-8 locale — Cursor clones and runs terminals inside
that image, not beside it. Claude cloud environments that still ship Node 20–22
use [`scripts/cloud-setup.sh`](../../scripts/cloud-setup.sh); until the correct
runtime is installed, type stripping fails at the first import.

---

## Debugging

Four configurations in [`.vscode/launch.json`](../../.vscode/launch.json),
shared by VS Code and Cursor. The play button on **Launch Browser** starts
the game.

| Configuration      | Debuggee                                      | Port |
| ------------------ | --------------------------------------------- | ---- |
| **Launch Browser** | the client; the editor starts Vite + wrangler | 5173 |
| **Attach Browser** | Chrome already running with remote debugging  | 9222 |
| **Launch Node**    | `apps/headless` (`--self-test`)               | —    |
| **Attach Node**    | `pnpm sim` (`node --inspect=127.0.0.1:9229`)  | 9229 |

Launch Browser runs `node scripts/dev.mjs --ensure` as a background task. If
5173 is already up, it reuses that process and does not kill it when debugging
stops; if it is not, the task is `pnpm dev` and stopping debugging stops both
children.

Wrangler's workerd inspector is on **9230** so it does not steal Node's
default. Press `d` in a wrangler terminal to open it. Source maps ship in
`pnpm dev` and in the production JS (including the universe worker);
`build.sourcemap: true` is the switch, and a build that omitted the
`sourceMappingURL` comment fails the gate. Production CSS has no map — Vite 8
minifies it with lightningcss and does not expose that option. Dev CSS maps
are `css.devSourcemap`.

The configurations, the inspect flag, and the inspector port are checked by
`scripts/debug.test.mjs`. How to use them: [`.vscode/README.md`](../../.vscode/README.md).

---

## Related

- [Getting started](getting-started.md) — clone to flying
- [Testing](testing.md) — what to test, and how
- [Extending](extending.md) — adding a body type, a task, a save field
- [Agent handbook](../agents/README.md)
- [Editor debug configurations](../../.vscode/README.md)
