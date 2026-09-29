# ADR-0048: Accounts are Clerk's, and the Worker decides who is asking

Status: accepted · 29 Sep 2026. Fills the account routes reserved by
[ADR-0011](0011-application-shell-and-modes.md) and answers the account half of
the open question in [hosting](../hosting.md#open-questions).

## Context

The account routes have existed since the shell did: `/sign-in`, `/sign-up`,
`/profile` and `/auth/callback`, dialogs drawn over whatever mode is running,
each saying that accounts are designed and not built. Discovery credit and sync
across devices are the first things that need a person rather than a browser,
and a device-scoped token cannot follow somebody to a second machine.

Five forces shape how an identity provider can be added here, and most of them
are the architecture saying no to the obvious integration.

- **The site is static.** Astro writes one HTML file per route and the Worker
  serves `404.html` for anything else. Nothing renders on a server, so there is
  no middleware to read a cookie on a document request, and a provider's
  multi-step flow cannot invent addresses under `/sign-in` that the build did
  not write.
- **The shell mounts once.** `Root` holds the canvas's host outside every
  route (ADR-0011), and a document reload rebuilds the renderer, the catalog
  and the scene. A provider that navigates with `window.location` — or a
  provider mounted late, which changes the tree above the canvas — costs a
  boot per hop.
- **A dialog keeps its mode alive through `location.state`.** Every link
  inside a dialog has to carry the background on, or the mode behind it
  unmounts. A library that pushes its own paths knows nothing about that.
- **The Worker is the only backend**, it holds no user table, and anything it
  later attributes to a person has to be decided there rather than taken from
  the browser's word.
- **The repository is public.** A fork builds and runs without anybody's keys,
  and offline solo play is the base case (`docs/design/modes.md`): an account
  is an addition to a complete game, never a gate on it.

## Decision

**Clerk is the identity provider: the browser signs in against it inside the
shell, and the Worker verifies the session token it is handed at
`GET /api/account`, which is the verdict anything attributed will use.**

- **Optional per build.** Accounts exist where the client is built with
  `PUBLIC_CLERK_PUBLISHABLE_KEY` — `PUBLIC_` because Astro exposes nothing
  else to the browser — and the Worker has `CLERK_SECRET_KEY` (optionally
  `CLERK_JWT_KEY`, the PEM key, for a networkless check). Neither is committed.
  Without the publishable key there is no badge and the account pages say the
  build offers none; without the secret the Worker answers "not configured",
  which is a different sentence from "signed out".
- **`@clerk/react`, mounted in `Root` inside the router, unconditionally once
  there is a key.** Its `routerPush` and `routerReplace` go through
  `account/accounts.ts`'s `accountNavigation`, which opens an account dialog
  over `resolvedLocation` — the running mode — and carries no background on
  from a cold-loaded dialog. `ClerkProvider` forwards later prop changes for
  the appearance and localization only, so the router functions are stable
  and read the location from a ref, and `afterSignOutUrl` is a marker the
  adapter replaces with wherever the reader is.
- **Hash routing for Clerk's components.** A step is `/sign-in#/factor-one`:
  the document is an address the build wrote, and the fragment never reaches
  the server, so a reload mid-step or an OAuth return lands on a page that
  exists.
- **The token travels as `Authorization: Bearer`, never as the `__session`
  cookie.** The browser attaches a cookie to a request a hostile page starts;
  only this site's script can set a header. `getToken()` also refreshes on
  demand, where the cookie is refreshed on a timer a background tab throttles.
- **`verifyToken`, not `authenticateRequest`.** The latter reads the cookie,
  compares it with `__client_uat` and answers a stale one with a redirect
  handshake — machinery for a server that renders documents, which this
  Worker does not. Authorized parties are the origins of the host the request
  arrived at (`apps/server/src/origins.ts`, shared with the guide's origin
  check); an unrecognized host is refused outright, since Clerk skips the
  check on an empty list. A pending session reads as signed out.
- **A deployment fault is a 503, not a sign-out.** A key set that cannot be
  loaded, or a secret that is invalid, throws — and the package's root
  `verifyToken` throws for a bad token too, so anything that is not a verdict
  on the token is the deployment's.
- **The vendor stops at the adapters.** `@clerk/react` is in `apps/game`,
  `@clerk/backend` in `apps/server`; `packages/protocol` knows only
  `ACCOUNT_PATH` and `AccountStatus`, and nothing below the apps knows Clerk
  exists ([H-4](../hosting.md#h-4--the-vendor-stays-in-apps-and-a-new-package-holds-the-port)).
- **The guide's shared alpha password is unchanged.** Whether a Clerk account
  replaces it is an authorization question — who may spend the provider's
  budget — that this decision does not answer.

## Alternatives considered

**Clerk's Astro SDK.** It integrates through Astro middleware and server
output. This site is static, the Worker is not Astro's adapter, and the
interactive shell is one React tree that already owns navigation; adopting it
would mean a rendering model change to host a sign-in form.

**`authenticateRequest` reading the session cookie.** It works for a
same-origin request, and it makes every endpoint that trusts it a forgery
target, requires the publishable key on the Worker, and brings a document
handshake a JSON route has no use for.

**Path routing.** Clerk's own default. Every step and every OAuth return gets
an address under the page, each of which is a 404 in a static build unless the
build writes it — a list of Clerk's internal routes maintained in
`astro/siteRoutes.ts`, wrong at the first step Clerk adds.

**Clerk's modals (`openSignIn`).** No address, so no link to a sign-in, no
back button, and a second dialog system beside the routed one ADR-0011
settled on.

**A device-scoped token, as the hosting open question proposed.** Enough to
attribute a discovery to a browser, and useless for the sync across devices
the account exists to provide; it would be replaced by an account at the
first sync.

**Authentication built in the Worker.** A user table in D1, password hashing,
email verification, OAuth clients, rate limits and account recovery, all of
it security-critical and none of it the product.

**Mounting the provider after boot**, to keep Clerk's script off the critical
path. The provider wraps the canvas's host, and inserting it later changes the
tree above `GameLoader`, which remounts the renderer.

## Consequences

- Every visit to a build with a key fetches Clerk's script and UI bundle from
  Clerk's origin during boot, whether or not the visitor ever signs in. The
  cost to first light is unmeasured and recorded in `design/plans/perf.md`.
- Clerk is a runtime dependency of the account UI. If its script is blocked
  or unreachable the badge holds an empty slot and the account pages stay
  empty; the game is unaffected.
- A Clerk production instance is configured for one primary domain. The site
  answers on two hosts, and signing in on the second needs Clerk's satellite
  domains, which require a paid plan in production. Until one is chosen,
  accounts are available on one host only.
- Clerk's components render in this system's material only through
  `account/appearance.ts` and a `clerk` cascade layer below Tailwind's
  utilities; its styles arrive unlayered and would otherwise outrank every
  utility. A Clerk upgrade that renames an element key restyles silently.
- `/auth/callback` stays reserved and unused: Clerk's OAuth return comes back
  to `/sign-in#/sso-callback`.
- Nothing is attributed to an account yet. `GET /api/account` is the seam the
  first attributed write — a discovery claim, a guide session — decides on.
