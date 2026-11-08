# ADR-0061: Telemetry is PostHog through its browser SDK, gated by the page and chosen by the visitor

Status: accepted · 7 Nov 2026. Replaces the Google Analytics tag that
[Hosting](../hosting.md) described, and keeps
[ADR-0042](0042-the-guide-speaks-in-one-voice.md)'s rule that the Worker never
sees a transcript.

## Context

The game measured one thing about its visitors, a page view through Google
Analytics, and reported none of its failures. That was not an oversight
somebody could fix by adding an SDK: every fatal failure the client can detect
is caught on purpose so the page can explain itself. A lost device, a pipeline
that fails validation, a frame that throws and both React boundaries end in a
`RuntimeNotice` or a panel's own fallback, and a caught error never reaches
`window.onerror`, which is all an error SDK listens to. A universe worker's
uncaught throw reached DevTools and nowhere. The Guide held its conversation in
the browser, and `tour/loop.ts` recorded when transcript pieces arrived and
discarded the text, so how visitors talk to the guide and how well it calls its
tools were questions nothing in the system could answer.

A survey of twelve services on 7 Nov 2026 chose PostHog for the one thing the
others lack: one project takes exceptions, LLM traces,
product and web analytics, logs, flags and surveys, ingested with a public
project token, so the browser that holds the conversation can send it and the
Worker stays out. The research then argued for calling PostHog's HTTP APIs from a
client of our own, about 6 KB, on the grounds that posthog-js is 102 KB brotli
and owns storage, timers and consent this repository decides itself. The
choice made instead is the SDK: it is the shape PostHog's products are built
and tested against, it carries replay, heatmaps, web vitals, the toolbar and
survey definitions that a hand-written client would reimplement one wire format
at a time, and its cost can be confined to a chunk only a reporting page loads.

PostHog's wizard opened the first integration as a pull request, and a review
of it found the shape this decision has to rule out: the SDK statically
imported into the chunk boot waits on, loaded on dev servers and previews and
against Global Privacy Control, and sending the visitor's speech to a third
party nobody had told them about.

## Decision

**PostHog is the one telemetry service, reached only through
`apps/game/src/telemetry/client.ts`, loaded only after the page has decided it
reports and the visitor has not said no, and sending what was said to the
guide only with the visitor's explicit consent.**

### The gate

- **The page decides first** (`telemetry/consent.ts`): a production build with
  a project token, on `inertialref.app` (reported as `production`) or a Workers
  preview (`preview`), never against Global Privacy Control or Do Not Track,
  never from a driven browser. Anything else — `localhost`, `pnpm preview`, a
  LAN address, the legacy host — reports nothing. The token and the ingest
  host are Workers Builds build variables kept out of this public repository,
  so a fork reports nothing without a code change.
- **The visitor decides second**, with three preferences in
  `state/preferences.ts`: usage and crash reports (on by default, as GA was),
  guide transcripts (off), session recording (off). Settings › Data states what
  each sends; the transcript switch also sits beside the Guide's AI disclosure.
  Turning usage off opts the SDK out, drops its anonymous id and its queue.
- **The SDK is a dynamic import behind both.** A page that reports nothing
  never fetches it, and nothing waits on it: calls made while it loads are
  queued, bounded, and dropped if it never arrives.

### What is sent

- **Web and product analytics.** One pageview per route change, at the
  document's canonical path on the page's own origin; `mode entered`; a boot
  funnel (`boot started` → `boot completed` with first light and reveal →
  `boot failed`); the product's verbs as lowercase "object verb" events.
  Autocapture, rage clicks and heatmaps cover the interface and ignore the
  canvas, where a click changes no DOM and rapid clicking is play.
- **Every URL is cut to its origin, path and campaign keys** (`sanitize.ts`)
  before it leaves, because a shared picture link carries its typed label in
  the query and Clerk's callback puts a token-shaped fragment in the hash.
  Visitor-typed text sits under `ph-sensitive`.
- **Errors from where they are caught** (`failures.ts`): the runtime failure
  store, both boundaries with their component stacks, the universe worker, the
  guide's provider codes. GPU errors are named for their class and fingerprinted
  by a normalized message, because PostHog groups a resolved stack by its frames
  and every validation error fails through the same three.js frames. The first
  graphics failure waits 250 ms for the device loss that caused it. One error
  object is sent once; a page sends at most five. Stacks symbolicate from the
  production source maps the build already serves; releases are created by the
  deploy.
- **The guide's tours as AI traces**: a generation per backend response, a span
  per tool call under the response that made it, and the voice priced once per
  session at $0.05 a minute, because `gpt-live-1` is not in PostHog's price
  table. **Without transcript consent a tour sends no sentence** — no input,
  output, tool arguments or tool state — and still sends models, tokens, cost,
  latency and tool names.
- **Logs**: warnings and errors from `logHub` as written, and the twenty
  quieter records before a failure only when one is reported.
- **Performance**: web vitals, and a `perf window` event a minute with fixed
  frame-time buckets a population can sum. A feature flag, `perf-window`, stops
  it without a deploy.
- **Surveys in API mode**, drawn in the interface's own controls: after a
  shared tour, and at the end of a docs article.
- **Session replay of the interface only**, for a visitor who turned it on.
  rrweb's canvas capture is off: a WebGPU canvas reads back only inside the
  frame that drew it.
- **Crash reports**: the build writes a `Reporting-Endpoints` header naming
  PostHog's `/report/`, so a tab killed for memory or hung is reported on the
  next navigation.

### Where it goes

- **Through the Worker's relay** (`/api/relay/*`), same-origin, because
  content blockers drop PostHog's hosts. The relay forwards an allowlist of the
  SDK's paths, unread, without cookies.
- **Except the guide's `$ai_*` events**, which go straight to the ingest host,
  so ADR-0042's "the Worker never sees a transcript" holds as written.
- **Identity follows Clerk** and is reconciled against the SDK's persisted
  state; anonymous visitors are personless. A Clerk `user.deleted` webhook
  deletes the person and their events.

## Alternatives considered

**A client of our own over PostHog's HTTP APIs**, as the research proposed. It is
smaller by about 96 KB brotli and keeps storage in one module. It lost because
every facet becomes a wire format to reproduce and keep current — the stack
parser, session rotation, the pageview chain, flag caching, replay's snapshot
batching — each with a failure mode PostHog's server accepts silently (an
undeserializable exception is stored with no issue; an over-quota batch answers
200 and is dropped). The SDK's size is paid only by a page that reports.

**Sentry for errors beside PostHog for the rest**, or Better Stack's free
100k exceptions. Two vendors, two consent paths, two places a failure lives,
and neither keeps an LLM trace.

**Keeping GA beside PostHog.** GA answered one question PostHog's web analytics
answers too, and a second tag is a second gate to keep honest.

**Cookieless mode**, which stores nothing. The server removes the address
before GeoIP runs, so the world map is empty, and identities rotate daily,
which makes flags and experiments meaningless.

**The SDK's popover surveys.** A Preact widget with its own type and colors
over a canvas that owns every pixel, shown by display conditions that read
person properties a personless visitor never has.

**Sending the guide's events through the relay.** A blocked tour report would
still arrive, and ADR-0042 would change from "never sees" to "relays unread".
The people who take a tour are invited by hand; a blocked report is a message
to one of them.

**rrweb's canvas capture.** It reads the WebGPU canvas from its own animation
frame, sees a drawn frame or transparent black depending on which loop
registered first, and patches canvas APIs globally.

## Consequences

- posthog-js is a 102 KB brotli chunk on every page that reports, and it loads
  extensions — the recorder, survey definitions, web vitals — from PostHog's
  asset host through the relay at runtime. That is third-party code running on
  this origin, versioned to the SDK by its own path.
- **The SDK owns its `localStorage` keys**, the one exception to
  `state/preferences.ts` owning storage: it reads them before any code of ours
  could hand them over. `persistence: 'localStorage'` keeps it off cookies,
  which would ride on every `/api` request.
- **Crash reports cannot be stopped in the page**, not by the switch and not by
  GPC: the browser sends them from a response header. PostHog drops their query
  strings, creates no person, and the project discards addresses.
- Content blockers that block the relay's path, or the ingest host for the
  guide's events, still drop data; nothing reports that it was dropped.
- What a visitor is told is a promise PostHog keeps for us: events a year,
  recordings and AI content 30 days, addresses discarded. A change of plan or
  project setting changes the truth of Settings › Data.
- Identifying signed-in visitors is safe only while the deletion webhook is
  live; its secrets are optional on the Worker, and without them deletion
  answers 503 and Clerk retries.

What is still to come — a picture of the scene beside an exception, the scene
in a replay, renderer experiments, evaluations of the guide — is
[`design/plans/telemetry.md`](../../design/plans/telemetry.md).
