# ADR-0048: Accounts are Clerk's, and the Worker decides who is asking

Status: accepted · 29 Sep 2026, amended the same day: the account routes are
pages and a mode signs in through a modal, and the guide is granted per
account. Fills the account routes reserved by
[ADR-0011](0011-application-shell-and-modes.md), answers the account half of
the open question in [hosting](../hosting.md#open-questions), and amends the
guide's authorization in [ADR-0042](0042-the-guide-speaks-in-one-voice.md).

## Context

The account routes have existed since the shell did: `/sign-in`, `/sign-up`,
`/profile` and `/auth/callback`, reserved as dialogs that said accounts were
designed and not built. Discovery credit and sync across devices are the first
things that need a person rather than a browser, and a device-scoped token
cannot follow somebody to a second machine. The guide, meanwhile, sat behind a
shared alpha password: one principal for everybody who knew it, and a secret
that leaks by being shared.

Six forces shape how an identity provider can be added here, and most of them
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
- **A mode is an address.** The planetarium's target, a cinema frame, a flight
  in progress are all the URL (ADR-0011). Anything that navigates while a mode
  is up either carries the mode along in `location.state` or unmounts it, and
  a library that pushes its own paths knows nothing about that — the first
  version of this, with the account routes as dialogs over the mode, lost the
  planetarium the moment Clerk moved between the profile's sections with a
  bare `#/security`.
- **The Worker is the only backend**, it holds no user table, and anything it
  attributes to a person — a guide session today — has to be decided there
  rather than taken from the browser's word.
- **The guide spends money.** Every minute of conversation is billed to the
  OpenAI project, so who may open a session is a grant, not a consequence of
  having signed up.
- **The repository is public.** A fork builds and runs without anybody's keys,
  and offline solo play is the base case (`docs/design/modes.md`): an account
  is an addition to a complete game, never a gate on it.

## Decision

**Clerk is the identity provider: the browser signs in against it — on pages
of the menu, or through Clerk's modal inside a mode — and the Worker verifies
the session token it is handed, which is the verdict anything attributed
uses. The guide is granted by `admin: true` or `tour: true` in the account's
private metadata, which the Worker reads.**

- **Optional per build, and one instance per environment.** Accounts exist
  where the client is built with a usable `PUBLIC_CLERK_PUBLISHABLE_KEY` —
  `PUBLIC_` because Astro exposes nothing else to the browser — and the Worker
  has its secret key. Production signs in against Clerk's production instance
  and everything else — version previews, `pnpm dev` — against the development
  instance. The browser's key is a build variable per Workers Builds trigger;
  the Worker holds `CLERK_SECRET_KEY` and `CLERK_PREVIEW_SECRET_KEY` and picks
  by the host a request arrived at (`accountKeys`), because a version preview
  inherits the Worker's secrets and cannot hold a different value under the
  same name. Nothing is committed. Without a usable publishable key there is no
  badge and the account pages say the build offers none; without the secret
  the Worker answers "not configured", which is a different sentence from
  "signed out", and the guide is unavailable.
- **Two ways in, by where the visitor stands.** From the menu, or by address,
  `/sign-in`, `/sign-up` and `/profile` are pages of the menu over its own
  scene, and the front door links to them. Inside a mode the badge at the end
  of the IR menu opens Clerk's modal, and the address does not change.
- **`@clerk/react`, mounted in `Root` inside the router, unconditionally once
  there is a key.** Its navigations go through `accountNavigation`, which
  resolves them against the current address — a bare fragment is a step of the
  page it was asked from — and treats a modal finishing where it opened as
  nowhere to go. `ClerkProvider` forwards later prop changes for the
  appearance and localization only, so the router functions are stable and
  read the location from a ref, and `afterSignOutUrl` is a marker the adapter
  replaces with wherever the reader is: the mode, from the badge; the menu,
  from the profile page.
- **Hash routing for Clerk's components on the pages.** A step is
  `/sign-in#/factor-one`: the document is an address the build wrote, and the
  fragment never reaches the server, so a reload mid-step or an OAuth return
  lands on a page that exists.
- **Everything outside `account/` reads `AccountContext`,** written by one
  bridge inside the provider, and code that is not a component asks
  `sessionToken()`. Clerk's hooks throw outside the provider, and a module that
  is not about accounts — the guide, the front door — should not know which
  vendor answers.
- **The token travels as `Authorization: Bearer`, never as the `__session`
  cookie.** The browser attaches a cookie to a request a hostile page starts;
  only this site's script can set a header. `getToken()` also refreshes on
  demand, where the cookie is refreshed on a timer a background tab throttles.
- **`verifyToken`, not `authenticateRequest`.** The latter reads the cookie,
  compares it with `__client_uat` and answers a stale one with a redirect
  handshake — machinery for a server that renders documents, which this
  Worker does not. Authorized parties are the origins of the host the request
  arrived at (`apps/server/src/origins.ts`, shared with the origin check); an
  unrecognized host is refused outright, since Clerk skips the check on an
  empty list. A pending session reads as signed out.
- **The guide's grant is private metadata, decided in `tour/access.ts`.** The
  account module answers who is asking and fetches the user's private
  metadata with the secret key; the tour module alone says that `admin` or
  `tour`, strictly `true`, grants the guide. The planetarium asks
  `/api/tour/capabilities` once per signed-in user and offers the Guide panel
  only on a yes; the Worker refuses a session to anybody else — 401 signed
  out, 403 without the grant — whatever the menu showed.
- **A deployment fault is a 503, not a refusal.** A key set that cannot be
  loaded, a secret that is invalid, or Clerk's API unreachable during the
  grant lookup throws — and the package's root `verifyToken` throws for a bad
  token too, so anything that is not a verdict on the token is the
  deployment's.
- **The vendor stops at the adapters.** `@clerk/react` is in `apps/game`,
  `@clerk/backend` in `apps/server`; `packages/protocol` knows only
  `ACCOUNT_PATH` and `AccountStatus`, and nothing below the apps knows Clerk
  exists ([H-4](../hosting.md#h-4--the-vendor-stays-in-apps-and-a-new-package-holds-the-port)).

## Alternatives considered

**Account dialogs over the mode.** The first version: the reserved routes as
routed dialogs, with the mode kept alive behind them through
`location.state`. It made every Clerk navigation a translation problem, and
the translation failed on the first bare fragment. A page of the menu is the
honest shape for arriving by address, and a modal with no address is the
honest shape for an interruption.

**Clerk's Astro SDK.** It integrates through Astro middleware and server
output. This site is static, the Worker is not Astro's adapter, and the
interactive shell is one React tree that already owns navigation; adopting it
would mean a rendering model change to host a sign-in form.

**`authenticateRequest` reading the session cookie.** It works for a
same-origin request, and it makes every endpoint that trusts it a forgery
target, requires the publishable key on the Worker, and brings a document
handshake a JSON route has no use for.

**Path routing on the pages.** Clerk's own default. Every step and every OAuth
return gets an address under the page, each of which is a 404 in a static
build unless the build writes it — a list of Clerk's internal routes
maintained in `astro/siteRoutes.ts`, wrong at the first step Clerk adds.

**Clerk Billing features for the guide.** Clerk's `has({ feature })` checks
features that come from a subscription plan. It needs Billing enabled, a plan
per grant, and the user subscribed to it; there is no administrator call that
puts one user on a plan, and production billing needs a payment provider. An
alpha allowlist is not a product anybody pays for.

**Public metadata copied into the session token.** Networkless — the grant
would arrive in the verified claims — but readable by the visitor, and it
needs the instance's session token customized. Private metadata costs one
Backend API call per capabilities check and per session, a few an hour, and
is the grant nobody but an administrator can see or change.

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
- Clerk's modal renders outside `.hud-layer`. It is held at standard range by
  its element classes, and the key dispatcher refuses keys from any
  `aria-modal` outside the layer, which a Clerk modal is.
- A Clerk production instance is configured for one primary domain. The site
  answers on two hosts, and signing in on the second needs Clerk's satellite
  domains, which require a paid plan in production. Until one is chosen,
  accounts are available on one host only.
- Clerk's components render in this system's material only through
  `account/appearance.ts` and a `clerk` cascade layer below Tailwind's
  utilities; its styles arrive unlayered and would otherwise outrank every
  utility. A Clerk upgrade that renames an element key restyles silently.
- A grant is a hand edit in Clerk's dashboard, and revoking one takes effect
  at the next capabilities check or session, not in a session already open.
- `/auth/callback` stays reserved and unused: Clerk's OAuth return comes back
  to `/sign-in#/sso-callback`.
