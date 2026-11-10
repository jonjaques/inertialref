# ADR-0039: The server renders the shell before the browser starts the scene

Status: accepted · 8 Sep 2026 · amended 10 Nov 2026

Supersedes the document and boot ownership in
[ADR-0011](0011-application-shell-and-modes.md) and the client-fetched initial
page in [ADR-0016](0016-documentation-as-a-mode.md). Camera precedence, one
persistent canvas, and the documentation build pipeline remain in force.

## Context

A documentation page must carry its article, navigation and page identity in
the first HTML response. Waiting for a catalog or a graphics device makes a
reading task depend on a simulation it does not need. A client-only island
inside an Astro document cannot satisfy that requirement: the framework can
render the document while leaving its useful contents empty.

The game has a different constraint. Navigation must preserve its engine,
workers, renderer, warm-up state and current world. Reconstructing that runtime
for each document would turn a link into another game startup.

## Decision

**Astro pre-renders a complete React page shell; one persistent client runtime
adds the scene after hydration.**

Astro 7 owns route files, the HTML document and generated sitemap. Every
published docs route comes from the existing documentation manifest.
The same Markdown, TypeDoc and Shiki pipeline supplies article HTML to the
server and to subsequent client navigation. `Root` receives the initial URL
and documentation through props. Its content belongs to that render, never to
a mutable module-global current page.

Every build, `main` included, pre-renders prose, one API loading shell at
`/docs/api`, and each package's own reference page. No build pre-renders an API
member page; its article loads through the existing JSON requests. Rendering
the 1,858 member pages is 50 of the bundle stage's 61 seconds on an Apple M6,
and each package page already links every member it exports. TypeDoc
conversion, link validation and all API JSON assets remain part of every build.

One static-asset rewrite per package, `/docs/api/<package>/*`, sends its
member addresses to `/docs/api` while retaining the requested URL. Aliases
redirect to their canonical spelling first, and trailing-slash and `.html`
spellings redirect to the canonical address before any rewrite applies. The
table grows with the package count and the case-colliding exports, never with
the export count, so Cloudflare's 2,000 static rules bound the aliases alone.
An unknown address under a known package reaches the shell, which finds no
page for it in the manifest and renders its not-found state with a 200; an
address under no package retains a 404. With no initial manifest or article,
the loading shell renders identical markup at every API address and hydrates
before fetching the requested page. Development serves those shells on demand.
This needs no request-rendering adapter or Worker invocation. The build rejects
a table above Cloudflare's 2,000 static or 100 dynamic rules instead of
letting Cloudflare drop rules without a word.

API exports whose paths differ only in case receive stable suffixes derived
from their exact original paths. Case-insensitive filesystems must not let
one exported symbol overwrite another's document. Generated links use the
canonical paths; the manifest and hosting redirects retain the old addresses.

`Root` renders `PageShell` on the server and hydrates it with `client:load`.
Home, docs, navigation and dialogs are visible without JavaScript. Game modes
render an admission message and navigation while their live controls await
the runtime. Preferences and media queries expose server defaults during
hydration, then expose the browser's settings without writing those defaults
over stored values.

React Router continues to handle navigation after hydration. There is no
second client router and no document swap around the canvas. `GameLoader`
loads browser services, then starts the App import and catalog request
concurrently. Direct interactive visits also preload their selected mode during
hydration, sharing the same import promise with the lazy route. `App` remains
outside every route and owns the engine, canvas,
frame loop and renderer warm-up. A contained runtime failure leaves the
reading shell mounted. The home/docs boot cover stays behind readable content;
game modes retain their first-light admission cover.

Renderer initialization failures, device loss, failed render pipelines and
frame exceptions publish a terminal runtime failure. The shell replaces the
interactive view with a graphics notice and retains reading routes. WebGPU is
preferred; the WebGL fallback requires floating-point scene targets. GPU error
observers belong to their device so a late error from a retired renderer cannot
stop its replacement.

A tab-scoped session-storage marker is set before the runtime import and
cleared on an orderly `pagehide`. It counts consecutive unclean ends: a
replacement document that finds it takes one strike, and the second strike
in a row leaves graphics stopped until an explicit retry. A session that has
run for a minute resets the count, because a document that drew for that long
and then vanished was discarded, slept or killed rather than crashed on boot.
This bounds browser crash/reload loops without persisting a hardware ban and
without refusing the routine reload of a hung tab. A browser that discards
session storage during a crash cannot provide this evidence; storage denial
does not itself reject graphics. The marker records interrupted sessions,
not proof of their cause.

`site.ts` supplies route metadata. `documentHead.ts` renders the shared head,
including the route's canonical address and social tags. Unknown paths return 404. The Worker continues to serve pre-rendered assets without an invocation;
its API, websocket and media routing stays in the adapter. Request-time SSR
can use the same shell with request-scoped props when a route needs it; this
change adds no request-rendering adapter or server-side game instance.

The service worker caches navigation HTML by document address. Cached HTML
must describe the requested page, because hydrating another page's markup
would discard the server-rendered content. An uncached offline document gets
an explicit offline response. Hashed game assets use the current and previous build caches, promoting only
requested files into the current build. Startup resource reporting covers assets
loaded before service-worker control. The [hosting policy](../hosting.md#service-worker-storage-and-updates)
defines retention, storage failures and the two production origins.

## Alternatives considered

**Two client-only islands for chrome and scene.** This separates mount points
but supplies no server-rendered chrome. A static import from chrome into the
engine can still pull graphics code into its startup dependency graph.

**An Astro client router with a persisted canvas island.** This gives Astro
ownership of soft navigation, but requires replacing the established overlay
background, query and history behavior. Keeping React Router preserves those
semantics and avoids introducing another renderer persistence mechanism.

**A second copy of public content below a client-only app.** Hiding one tree
and copying its HTML into another creates a second content lifetime and can
remove the article before its replacement exists. Hydration keeps one shell.

**Pre-render every API member page.** It keeps every unknown address a 404
from a static table, at 50 of the bundle stage's 61 seconds on every build. An
exact proxy for each member instead keeps the 404 without the render, but the
table grows with the export count: 126 aliases, 12 package pages and 1,858
members made 1,996 static rules against Cloudflare's 2,000.

**Render every request in the Worker.** Static public content needs no request
data. Pre-rendering supplies the complete HTML while retaining free static
asset delivery; a future dynamic route can opt into request rendering.

## Consequences

Prose and package pages remain readable when scripting or graphics fails. The
API index and member pages require JavaScript, because the index is the shell;
their no-script notice links to the pre-rendered documentation. A member page's
first response is the shell, whose canonical URL is `/docs/api`, so the sitemap
lists package pages and not members, and a crawler reaches a member's article
only by running the page. The engine keeps its existing frame path, and neither
document navigation nor hydration adds a renderer. Astro templates and the
emitted site need verification in addition to the existing TypeScript and
runtime tests.

The docs HTML carries its initial navigation model and article props as well
as rendered markup. That makes direct docs responses larger, while avoiding
an initial manifest-and-article fetch sequence. Later navigation uses the
existing JSON cache. Search and Mermaid remain client enhancements.
