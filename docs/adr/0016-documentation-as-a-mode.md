# ADR-0016: The documentation is a mode of the application, generated at build and fetched at runtime

Status: accepted · 27 Aug 2026

Amended by [ADR-0021](0021-the-astro-shell.md): a documentation page is the
document a reader is served; the rail still fetches a slim manifest.

## Context

`docs/` is a hundred and twenty thousand words across seventy markdown files —
the design bible, ten concept pages, fifteen decision records, the guides and
the agent handbook — with eighty-three Mermaid diagrams in them. `packages/*`
carries another eight hundred and twenty exports whose doc comments are, in
places, the most carefully written prose in the repository. All of it was
readable only on GitHub, by somebody who already knew the repository existed.

The obvious thing is a documentation site: Docusaurus, VitePress, Starlight, or
TypeDoc's own HTML. Any of them would be running the same afternoon.

What none of them can do is the thing this project has and they do not. The
front door is a menu over a running simulation, framed on Earth, and the pitch
`PRODUCT.md` makes is that it is _the only pitch a screenshot cannot fake_. A
documentation site published beside the application cannot put the engine at the
top of a page about the engine — it can put a picture of it there, which is a
different claim.

There is a second force, and it is the one that decides between the remaining
options. The URL is this product's public surface ([ADR-0011](0011-application-shell-and-modes.md)):
everything addressable is reachable and everything reachable is addressable, and
a navigation is a single router. A themed TypeDoc output embedded in the page
would satisfy the first force and break this one — it arrives with its own
navigation, its own search, its own page shell and its own idea of what a link
is, so a reader crossing from a concept page into the reference leaves the
masthead, the rail and the router behind. That is two sites wearing one palette.

## Decision

**`/docs` is a mode, like the planetarium and the player. Its content is
rendered at build time and fetched at runtime, and the reference is drawn from
TypeDoc's reflection tree by this application's own components.**

- **A mode, not a dialog and not a second site.** `modeForPath` answers `docs`;
  the route renders inside `.hud-layer` as a sibling of the canvas, so the
  engine is running behind it and no navigation can rebuild the renderer. It is
  a mode rather than a dialog because a dialog opens _over_ a mode, and two of
  them driving the observatory is the fourth camera producer AGENTS.md forbids.
- **`pnpm docs:build` renders every page.** Markdown through `marked`, listings
  through Shiki against a theme written from this system's palette, links
  resolved against a route table that mirrors the repository's own paths. The
  output is JSON under `apps/game/public/doc-content/`, gitignored, staged into
  `dist` by the same build that produces the bundle.
- **TypeDoc's JSON, not its HTML.** The serialized reflection tree is the
  complete model — every signature, every comment part, every resolved
  `{@link}` target, every source position — so `scripts/docs/api.mjs` prints
  types itself and turns a reference to a documented symbol into a link into
  this site. An API page and a concept page are then the same page with
  different content in it.
- **Fetched, not bundled.** The manifest, the search index and every page body
  are same-origin `GET`s. `public/sw.js` already serves that directory
  stale-while-revalidate, so the documentation is available offline, which is
  this project's base case rather than its degraded one.
- **The build refuses to publish quietly.** A markdown file under `docs/` that
  no wing lists fails the build, and TypeDoc's `validation.invalidLink` fails it
  on a cross-reference to a renamed symbol.

## Alternatives considered

**A separate static site** — Docusaurus or VitePress at `docs.` or `/docs` on
another origin. Cheapest by a wide margin, and it loses the one thing worth
having: the masthead cannot be the engine, because the engine is a WebGPU
renderer in the application it would be published beside. It also splits the
URL surface in two, which ADR-0011 spent its whole argument on.

**TypeDoc's HTML with a custom theme, embedded.** The shortest road to a
reference that is nearly the right colour, and the one that produces two sites
wearing one palette: separate navigation, separate search, separate shell, and
links that leave the router. Rejected on structure rather than on looks.

**`typedoc-plugin-markdown`, feeding the same pipeline as the prose.** Genuinely
attractive — one renderer for everything — and it discards the model on the way
through. A signature becomes a string of backticks, so a type in it cannot be
made a link, and cross-references become markdown links this build would have to
re-resolve against a name table TypeDoc had already resolved correctly.

**A custom TypeDoc output plugin**, emitting our page JSON from inside TypeDoc's
renderer. The same result as what was built, reached by depending on
`app.renderer`'s internals — which are not the stable half of that library. The
serializer is, and the transform is then ours and testable in Node.

**Bundling the pages through `import.meta.glob`.** Vite would content-hash them
and the service worker's cache-first branch would cover them for nothing. At
nine hundred pages it is nine hundred dynamic imports, which is a chunk manifest
larger than most of the pages it indexes.

**Server-side rendering, for crawlers.** The right answer eventually and not
today: it needs the Worker on every navigation, which turns a free static asset
request into a billed invocation — the same trade `src/site.ts` records for the
Open Graph tags. Only `/docs` is in `sitemap.xml` until that changes.

## Consequences

**The documentation is offline, addressable, and inside the product.** A link to
`/docs/concepts/frames#the-frame-chain` opens the reading room over a live
simulation of the thing being described, from a cold tab, with no network.

**The reference can be followed rather than only read.** `UniverseVector` in a
signature is a link to its page, across package boundaries, because the address
of every export was resolved before anything was rendered.

**A page is a fetch, so the first paint of an article is not instant.** The
manifest arrives before the navigation can be drawn, and the mode shows the
shape of a paragraph while it does. Offline and on a second visit it is a cache
hit.

**The build is slower by about eight seconds**, almost all of it TypeDoc
converting twelve packages under the root `tsconfig.json`. It runs on every
`pnpm build`, because a documentation site that is one forgotten command away
from being stale is a stale documentation site.

**Mermaid ships to the client.** Laying out a graph needs a DOM with real fonts,
so the alternative is a headless browser in the toolchain. It is a lazy import,
only on a page that has a diagram, and the source is what is on screen until it
resolves — and forever if it never does.

**Nothing may hand-edit `apps/game/public/doc-content/`.** It is derived, the
same way the brand artifacts are, and the markdown is the source. See
[development](../guides/development.md).
