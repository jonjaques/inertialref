# ADR-0039: The server renders the shell before the browser starts the scene

Status: accepted · 8 Sep 2026

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

Production builds from `main` pre-render every documentation page. Other
branches pre-render prose and one API loading shell; API articles load through
the existing JSON requests. TypeDoc conversion, link validation and all API
JSON assets remain part of every build. `IR_PRERENDER_API=1` selects full HTML
for production verification on another branch; `0` selects asynchronous API
pages. Workers Builds and GitHub source-branch variables take precedence over
the local branch, so a pull request targeting `main` remains a preview build.

The manifest records this choice once for Astro and the hosting rules. Exact
static-asset proxies send known API routes to `/docs/api` while retaining the
requested URL; aliases redirect to their canonical spelling first. Unknown
paths retain a 404. With no initial manifest or article, the loading shell
renders identical markup at every API address and hydrates before fetching the
requested page. Development serves those shells on demand. This needs no
request-rendering adapter or Worker invocation. The build rejects a routing
table above Cloudflare's static redirect limit instead of silently dropping
API paths.

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
cleared on an orderly `pagehide`. If a replacement document finds that marker,
it leaves graphics stopped until an explicit retry. This bounds browser
crash/reload loops without persisting a hardware ban. A browser that discards
session storage during a crash cannot provide this evidence; storage denial
does not itself reject graphics. The marker records an interrupted session,
not proof of its cause.

`site.ts` supplies route metadata. `documentHead.ts` renders the shared head,
including the route's canonical address and social tags. Unknown paths return 404. The Worker continues to serve pre-rendered assets without an invocation;
its API, websocket and media routing stays in the adapter. Request-time SSR
can use the same shell with request-scoped props when a route needs it; this
change adds no request-rendering adapter or server-side game instance.

The service worker caches navigation HTML by document address. Cached HTML
must describe the requested page, because hydrating another page's markup
would discard the server-rendered content. An uncached offline document gets
an explicit offline response. Immutable game assets retain their existing
cache policy.

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

**Render every request in the Worker.** Static public content needs no request
data. Pre-rendering supplies the complete HTML while retaining free static
asset delivery; a future dynamic route can opt into request rendering.

## Consequences

Production public content remains readable when scripting or graphics fails.
Preview API pages require JavaScript; their no-script notice links to the
pre-rendered documentation. The engine
keeps its existing frame path, and neither document navigation nor hydration
adds a renderer. Astro templates and the emitted site need verification in
addition to the existing TypeScript and runtime tests.

The docs HTML carries its initial navigation model and article props as well
as rendered markup. That makes direct docs responses larger, while avoiding
an initial manifest-and-article fetch sequence. Later navigation uses the
existing JSON cache. Search and Mermaid remain client enhancements.
