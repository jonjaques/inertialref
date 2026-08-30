# ADR-0021: The document is the shell, and the renderer is an island

Status: accepted · 30 Aug 2026

## Context

[ADR-0011](0011-application-shell-and-modes.md) put the canvas outside every
route so a navigation could not rebuild the `WebGPURenderer`. [ADR-0016](0016-documentation-as-a-mode.md)
made `/docs` a mode of that same application, so the masthead of a page about
the engine could be the engine. Both decisions hold. What they assumed was
one document, served for every path.

That assumption has three costs that grow with the site rather than with the
engine.

A social scraper does not run JavaScript. One document for every path means
one Open Graph card for every path — the home page's — unless the Worker
rewrites the head, which needs `run_worker_first` on `/*` and turns a free
asset request into a billed invocation. Hosting declined that trade for three
shareable pages. Nine hundred documentation pages make it the wrong trade for
a different reason: the card is now actually wrong, not merely generic.

A documentation page was a fetch of JSON that then painted. The first word
waited on the catalog, the worker pool, and `three/webgpu`, because the
document that arrived was a shell whose body was an empty `<div id="root">`.
The pitch that this runs in a browser tab is worth very little if the tab's
first paint is a black canvas. A crawler, a reader with JavaScript off, and
a person on a slow link all meet the same nothing.

And `sitemap.xml` was a hand-kept list of five URLs that `pnpm brand` had no
way to be right about. The documentation site is nine hundred addresses. A
list that does not know they exist is a sitemap that tells a crawler the
product is five pages long.

The constraint ADR-0011 will not give up: tearing down the canvas is the
black-screen class `render/presentationWatchdog.ts` exists to recover from,
arriving on purpose. The constraint ADR-0016 will not give up: the
documentation is not a second site. The shell has to become the document
without making the renderer a guest of the route.

## Decision

**Astro owns `<html>`. The renderer is one `client:only` island that
persists; the chrome is another. Every mode is a document. Dialogs are a
store over `history`.**

- **Two islands, on every page, in the same layout.**
  `SceneBackdrop` owns the `<Canvas>` and carries `transition:persist="scene"`.
  `Root` is the chrome. A page that omitted the backdrop would tear the
  engine down on the next navigation, once the router persists it. A second
  canvas, or a router over the whole tree, is the failure ADR-0011 already
  named. `client:only="react"` is the guard that keeps `three/webgpu` out of
  the HTML build; `@vitejs/plugin-react` must not also appear in
  `vite.plugins`, or JSX is transformed twice.

- **A path names a stance the way it names a mode.** `modeForPath` and
  `stanceForPath` are pure functions in `apps/game/src/pages/paths.ts`. The
  persisted island does not unmount, so a React lifecycle cannot be the
  writer: `usePageStance` applies the path on `astro:page-load`. Modes that
  drive the camera continuously — flight, the planetarium — still push their
  own layer on top of that floor. The front door holds a phase; it does not
  ramp one.

- **Dialogs are a store over `history`, not a router.** A cold load of
  `/settings` is an Astro page: the dialog over the menu, because a fresh
  tab has no session behind it. A warm open from a mode is
  `history.pushState`, so the planetarium stays mounted and the observatory
  keeps its target. Overlay hops replace rather than push. Closing a warm
  overlay replaces back to the mode; closing a cold one assigns `/`, because
  `replaceState` would leave the dialog's document in place with a menu URL
  on it. `stancePathOf` is the path whose stance the backdrop holds: the
  address bar on a mode document, the mode underneath while a warm overlay
  is open, the menu on a cold overlay.

- **Overlay links go through `OverlayLink`.** A mode link is an `<a href>`
  — the next page is a document, and a click loads it. Following `/settings`
  as a document from the planetarium would unmount the planetarium. A
  modified click (new tab, new window) is the browser's.

- **A documentation page is the document a reader is served.** Astro emits
  the article as HTML in `#doc-ssr` and the rest of the page record as a
  JSON script. The reading room hydrates from that, not from a second fetch
  of the same bytes. The rail still fetches a slim `manifest.json` — it is
  every page's navigation, and embedding it in each document would pay its
  size on every click. The search index stays a fetch: half a megabyte for
  the readers who type and nobody else. Page bodies are a build input under
  `apps/game/.doc-content/`; they are not files in `public/`.

- **The sitemap is every emitted page, from Astro.** `@astrojs/sitemap`
  knows the output by construction. Brand does not write `sitemap.xml`.
  `indexedPath` in `src/site.ts` is the filter both the sitemap and the
  robots file consult.

- **An unmatched path is a 404 page, not the home document.** Wrangler's
  `not_found_handling` is `404-page`; Astro's `404.astro` is the menu
  wearing that status. `html_handling` is `drop-trailing-slash`, pairing
  with Astro `build.format: 'file'` so `/planetarium` maps to
  `planetarium.html`.

- **The document head interpolates `src/site.ts` at build.** A scraper
  reads `astro/layouts/Base.astro`. `DocumentMeta` rewrites `<title>` on an
  overlay `pushState`, which does not load a new document. Per-route Open
  Graph is free because it is HTML on disk; the Worker does not run on a
  navigation.

- **`<ClientRouter />` swaps the document; it does not animate the
  picture.** `fallback="swap"` and `transition:animate="none"` on `<html>`,
  because a fade of the persisted canvas is a blink the persist exists to
  prevent. The island that owns the camera re-aims from `stanceForPath` on
  `astro:page-load`. Whether props re-flow to a persisted `client:only`
  island is not a property this codebase relies on.

- **`packages/*` and the engine do not know Astro exists.** The inversion
  stops at the document.

## Alternatives considered

**A separate Astro site beside the application.** Cheapest, and it is the
alternative ADR-0016 rejected: the masthead cannot be the engine if the
engine is in the application next door, and it splits the URL surface
ADR-0011 spent its argument on.

**Server-side rendering with `@astrojs/cloudflare`.** Real SSR, per-request.
Every page's content is known at build time, and it costs a billed
invocation on every navigation — the trade [hosting](../hosting.md) already
declines. Revisit only if a page ever depends on who is asking.

**Keep the SPA and prerender only `/docs`.** Two shells, two heads, two
service-worker strategies, and a reader crossing from a document into the
planetarium leaves one application for another. It is two sites wearing one
palette, reached from the other direction.

**Vite SSG plugins, or `vite-plugin-ssr`.** One build, one config, and the
React shell has to render on the server — which means `three/webgpu`,
`navigator.gpu` and a WebGPU canvas in a Node build graph, guarded by hand
at every import. Astro's `client:only` is that guard, declared once per
island by the framework.

**Treat overlays as document navigations.** Then there is no background
location, because the background is the document. It also unmounts the
planetarium on the first click of Settings. The store over `history` keeps
ADR-0011's property that a dialog is not a mode change.

**Delete `DocumentMeta` once the router is gone.** Overlay `pushState` does
not load a new document, so the tab title would keep naming the mode
underneath. The component stays for that rewrite and for nothing else.

**Generate the service worker's precache from the sitemap.** Nine hundred
documentation URLs in the install cache, for pages a player of the game
never opens. The precache is the four mode documents, by hand. A
documentation page nobody has visited, offline, is the browser's offline
page; a visited one is stale-while-revalidate as before.

**Embed the rail's manifest in every documentation document.** Then a click
inside `/docs` does not fetch. It also puts the whole navigation on every
HTML payload, paid on every ClientRouter swap. The article is in the
document because it is what the reader came for; the rail is shared and
stays a fetch.

**A `requestAnimationFrame` loop that ramps the observatory's phase.** The
front door's drift was behavior, not a declaration, so a stance prop cannot
cover it. Holding a phase and setting it once is the stance; a ramp is a
second clock next to the simulation's.

## Consequences

**A word of prose does not wait for a GPU.** The document is HTML. The
canvas fades in behind it. Content pages (`menu`, `docs`) have no boot
cover; interactive modes cover the mode's own box so an unlit canvas does
not flash through a cockpit.

**Per-route Open Graph is a file, not a rewrite.** `/docs/concepts/frames`
is a card about reference frames. The Worker does not run to make it so.

**One build, one world, one renderer, still.** ClientRouter plus
`transition:persist` is how a click between `/planetarium` and `/docs`
keeps the engine. The overlay store is how a click _inside_ a session
opens Settings without a document load. Two mechanisms, because they
answer two questions: "is this a new page" and "is this a dialog over
this page".

**The service worker precaches the four mode documents, by hand.** The game
offline is complete — the universe is a pure function of a seed, the catalog
is content-hashed under `/assets/`. A documentation page nobody has opened
is the browser's offline page; a visited one is stale-while-revalidate.

**`/keys` cannot be prerendered as prose.** `useActionTitle` exists so no
key name is ever a literal; a table of chords is a live reading of the
keymap. It stays a dialog. `/about` stays a dialog for the same shape of
reason: it is furniture over a mode, not a mode.

**The overlay is a second routing system.** It is small, tested in Node,
and it is the cost of not rebuilding the renderer on a settings click.
A document `<a href="/settings">` from a mode is the bug; `OverlayLink`
is the check.

**The Node test boundary ADR-0011 drew still holds**, extended to `.astro`
files. `pageMetaFor`, `modeForPath`, `stanceForPath`, the overlay store
and the docs route mapping are the testable surface. Astro pages stay
thin enough that there is nothing in them to assert.

## Related

- [ADR-0011](0011-application-shell-and-modes.md) — the shell this amends
- [ADR-0016](0016-documentation-as-a-mode.md) — the reading room, and how
  the article now reaches a reader
- [Hosting](../hosting.md) — H-7, the static head, and the invocation this
  avoids
- [Client](../guides/client.md) — the two islands and the overlay store
- [Plan](../plans/astro-shell.md) — the sequence this closed
