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
pnpm install --frozen-lockfile
pnpm dev              # Astro on 5173 and wrangler on 8787
pnpm preview          # production build, served by the real Worker on 8787
pnpm test             # Vitest, Node environment only
pnpm test:gpu         # the shader suite on the real GPU via Dawn; not in check
pnpm test:slow        # terrain descent and galaxy convergence/population checks; in check and CI
pnpm typecheck        # five tsconfig projects and Astro templates
pnpm lint             # oxlint, not eslint
pnpm graph            # dependency layering and cycle check
pnpm brand            # regenerate brand artifacts from design/brand/brandmark.svg
pnpm presets:plates   # recapture the built-in preset thumbnails through the renderer
pnpm presets:check    # every picture has a plate, every composition it names resolves
pnpm docs:build       # render docs/ and packages/* into the documentation site
pnpm build            # optional media pull, docs, typecheck, then Astro build
pnpm check            # graph, brand, presets, format, lint, typecheck, test, test:slow, build

# The four instruments. They read the tree; none of them gates it.
pnpm fta              # complexity per file; fta:check exits 1 above a score of 91
pnpm knip             # what nothing imports; knip:check narrows to the four hard classes
pnpm spelling         # British spellings left in the source, graded by rename cost
pnpm test:coverage    # the suite again, writing coverage/coverage-final.json

pnpm sim --self-test           # headless run plus the twelve capability checks
pnpm vitest run <substring>    # a single test file

pnpm drive --help              # drive Chrome over CDP: --js, --shot, --sample, --down
pnpm drive --trace 3000        # record a Chrome trace. Needs ?timing=trace on --url,
                               # or the recording carries none of our tracks
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

pnpm dev:client                # Astro only
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
the Astro half with it. The failure names the directory and nothing else, and it
is easy to read as a broken checkout.

Two ways out, and which one you want depends on why you are serving:

```bash
pnpm dev:client   # Astro alone on 5173 — everything except the Worker's routes
pnpm build        # once, then `pnpm dev` works for the life of the worktree
```

`pnpm check` runs `pnpm build`, so a worktree that has been through the gate
once is already fixed. **`pnpm drive` walks into this**: `--serve` is on by
default and starts `scripts/dev.mjs`, so on a fresh worktree it reports that
`pnpm dev` exited without serving, a few seconds in, and the reason is in
`.data/drive/dev.log`. Serve with `pnpm dev:client` yourself and pass
`--no-serve`, or build once.

**Astro daemonizes itself when it detects a coding agent.** Astro 7 sniffs the
environment for Claude Code, Codex, Cursor and the rest, and a detected `astro
dev` or `astro preview` spawns a detached copy of itself, writes a lock file
under `apps/game/.astro/`, and returns: from a terminal, a server that outlives
the session; under `scripts/dev.mjs`, a client child that exits cleanly a
second in and takes wrangler with it. The game package's `dev` and `preview`
scripts set `ASTRO_DEV_BACKGROUND` and `ASTRO_PREVIEW_BACKGROUND`, the
variables Astro gives its own detached child so that it does not daemonize
twice, and so every route into Astro stays in the foreground. They are the only
switch: `--ignore-lock` throws once an agent is detected. The cost is that the
lock file records the server as background, so `astro dev logs` points at a
log nobody writes.

**`pnpm dev` refuses a taken port before either child starts.** A live Astro on
5173 is named by pid from its lock file while that pid is alive. Astro removes
the file only on a graceful stop, so after a Ctrl-C it names a pid that is
gone, and `pnpm dev` then says so and points at `lsof` instead;
`pnpm --filter @inertialref/game exec astro dev stop` ends a live one. A held
8787 is refused the same way, except under `--ensure`, which starts the client
alone and lets Vite proxy to the Worker already there.

`pnpm run deploy:worker`, not `pnpm deploy:worker` — `deploy` is a pnpm
built-in. After any change to `wrangler.jsonc`, regenerate
`apps/server/worker-configuration.d.ts` with
`pnpm --filter @inertialref/server run types` and commit it.

`pnpm check` is the gate. Do not report a task complete without it passing.

**None of the four instruments is in it, and that is deliberate.**
`fta` scores complexity and coverage counts what the suite executed; `knip`
asks the question neither of them can, which is whether a file needs to exist
at all, since something nothing imports scores and covers like anything else.
`pnpm spelling` reads declarations through the TypeScript checker rather than a
regex, because an identifier that also appears as a key in checked-in data is a
rename with a second half the compiler cannot perform. `fta` and `knip` each
pair a report that always exits 0 with a `:check` that exits 1, and the
threshold lives on the command line rather than in `fta.json` or `knip.jsonc` —
a severity in the config applies to the report too, which turns the report into
something that exits 1 while printing the answer. `knip:check` is red today, and
a ratchet installed while it already fails teaches people to pass
`--no-exit-code`. The findings, and the case for wiring any of them into the
gate, are [the complexity report](../../design/reports/complexity.md) and
[the spelling plan](../../design/plans/british-english.md).

None of the four data commands are needed to build or run the game — their
outputs are committed. Run one when the upstream publishes; the diff is the news.
`textures:build` and `shapes:build` download 1.5 GB between them into the
gitignored `.data/`, and only the processed outputs are committed. The
[catalog guide](catalogue.md) has the provenance rules each of them follows.

The site deploys to the `inertialrefd` Worker. Canonical URL:
<https://inertialref.app>. It also serves <https://inertialref.jonjaques.com>
without redirecting, so existing installations retain access to their
origin-scoped saves and service worker. To
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

**Astro 7** with `@astrojs/react` over Vite 8 and
`@rolldown/plugin-babel` running `reactCompilerPreset()`. The standalone Vite
config remains available for focused build tests. React Compiler is
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
(condensed display), IBM Plex Sans Variable (prose and controls, upright and
italic), IBM Plex Mono (every reading, static 400/500/600). There is no
serif. Symbol coverage is self-hosted beside them: two subsets cut from the
desktop Plex TTFs carry the mathematical operators under the same family
names (`src/assets/fonts/`), and two Noto subsets carry the planetary sigils no
text family draws — `☉` and `⊕` are not among them, and
`design/plans/type-coverage.md` says why. All are imported in `src/index.css`,
which also defines the ten `type-*` utilities. Do not write a size, a weight,
and a tracking at a call site — use a named step. A Google Fonts `<link>`
would break offline, which is the base case.

**React DnD 16** drives dockable panels, and only the gesture. What a drop
means is arithmetic in `apps/game/src/dock/layout.ts` and `dock/floating.ts`.
The backend is chosen once at mount from `(pointer: coarse)` because
`DndProvider` cannot be handed a different one. [ADR-0012](../adr/0012-dockable-panels.md).

**Two headless libraries carry the long lists.**
`@tanstack/react-virtual` windows the navigator's tree and the catalog
dialog's results — at fifty light years the survey is fourteen hundred systems
and reconciling them twice a second beside the render loop is the stutter, not
the arithmetic. It is headless, so the tree keeps its own markup, its single tab
stop and its keyboard. `@leeoniya/ufuzzy` ranks the navigator's search: the
catalog's own index is exact-then-prefix-then-substring, which is right for an
address and cannot find `proxmia`. It returns match ranges rather than markup,
which is what lets a row light the matched characters without
`dangerouslySetInnerHTML` over catalog data.

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
share card, the web manifest, `robots.txt`, or
`src/icons/brandmark.ts`. `pnpm brand:check` is in `pnpm check`. The share
card has a second source, `design/brand/og-plate.png` — a captured frame of the
renderer that its type is composited over. `scripts/brand/og.mjs` carries the
framing it was shot at, so it can be shot again. Astro's sitemap integration
emits the route sitemap during the application build.

**Preset plates** are the thumbnails under the planetarium's Presets panel, in
`apps/game/public/presets/`. `pnpm presets:plates` recaptures the built-in set,
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
every markdown file under `docs/`, plus the two adopted from the root —
`AGENTS.md` at `/docs/working-card` and `STYLE.md` at `/docs/style`, because
the pages under `docs/` cite both and a site that answered those links with a
hop to GitHub would send the reader out of the building — and every export of
`packages/*` through TypeDoc, into `apps/game/public/doc-content/`, which is
gitignored, staged by `pnpm build` before the client build, and fetched at
runtime. Editing a page means editing the markdown; the site has no copy of
its own. Two things it will refuse to do: a markdown file under `docs/` that
no wing in `scripts/docs/wings.mjs` lists fails the build rather than
publishing nowhere, and a `{@link}` pointing at a renamed symbol fails it
rather than rendering as words that link to nothing. `scripts/docs/build.mjs`
carries the rest.

API articles always ship as JSON. Builds from `main` also pre-render their
HTML; other branches emit one API loading shell and fetch articles when opened.
Prose remains pre-rendered in both cases. Workers Builds uses
`WORKERS_CI_BRANCH`; GitHub uses the source branch; a local build uses the
checked-out branch. To verify the complete production output on a feature
branch, run `IR_PRERENDER_API=1 pnpm build`. Set it to `0` to force asynchronous
API pages. Use `pnpm preview` for built API deep links because the Worker asset
server applies their generated proxy rules; `astro preview` does not. During
`pnpm dev`, Astro renders API loading shells on demand.

**`design/` is the other half of that division, and it is not published.**
Plans, working reviews and the complexity report live there; `docs/` is the
finished account of what the system does and `design/` is the working one. A
reader who reaches a documentation site expects the system to already behave
the way the page says, and a plan is the one document that promises the
opposite — so `routeFor` returns `null` for a path under `design/`, and a link
from a published page into a plan resolves to GitHub rather than to a route
that does not exist. Brand sources and the reference imagery are there for the
same reason: they are inputs, not pages.

**Site metadata** comes from `src/site.ts`. `documentHead.ts` renders it into
every Astro document, and `pages/DocumentMeta.tsx` updates it on client
navigation. The sitemap comes from the emitted routes. Production public pages
are pre-rendered; the Worker serves their HTML as static assets.
[ADR-0039](../adr/0039-the-shell-before-the-scene.md) records the boundary.

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

| Configuration      | Debuggee                                       | Port |
| ------------------ | ---------------------------------------------- | ---- |
| **Launch Browser** | the client; the editor starts Astro + wrangler | 5173 |
| **Attach Browser** | Chrome already running with remote debugging   | 9222 |
| **Launch Node**    | `apps/headless` (`--self-test`)                | —    |
| **Attach Node**    | `pnpm sim` (`node --inspect=127.0.0.1:9229`)   | 9229 |

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
