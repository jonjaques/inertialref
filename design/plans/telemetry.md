# Telemetry: what PostHog does next

[ADR-0061](../../docs/adr/0061-telemetry-is-posthog.md) is the decision and
describes what the product reports now: PostHog through its browser SDK, gated
by the page and by the visitor's three switches, with errors reported from
where they are caught, the guide's tours as AI traces, logs, web vitals, a
frame-time window, surveys drawn in the interface, interface-only replay,
crash reports, releases on deploy and account deletion through Clerk. This
plan holds what is still to come, and what only a live project can settle.

It is a plan, so it promises. When an item lands, its decision moves into an
ADR and the item goes.

**Where the facts come from.** PostHog's documentation at
`PostHog/posthog.com@2d6d56a`, the posthog-js monorepo at
`PostHog/posthog-js@eb11f00` and the server at `PostHog/posthog@0f072f8`, read
on 2026-11-07, and project 719084 on US Cloud.

---

## 1. Later

### 1.1 A picture of the scene beside an exception

A failure report says what threw and on which GPU, not what was on screen.
Every 10 s a timer would ask for an animation frame and, inside it, draw the
canvas into a 320×180 2D canvas and encode it as WebP, keeping the last three
in a ring because a lost device leaves nothing to read. One committed frame of
the renderer (`design/brand/og-plate.png`) encodes to 1.4 KB at that size. The
per-capture frame cost is not measured, and it gates the item: measure it with
`scripts/drive.mjs --cast` and the perf panel at two operating points, one of
them in a generated system.

### 1.2 The scene in a replay

Replay records the interface over a black rectangle (ADR-0061), because rrweb's
canvas capture reads a WebGPU canvas outside the frame that drew it. The scene
would come from our own sampler at 1 fps and 640×360, about 190 KB a minute,
appended as synthesized canvas mutations in the format PostHog's player
deserializes. It waits on the sampler's frame cost, measured as above, and on
one synthesized mutation played back in PostHog's player.

### 1.3 Experiments on the renderer

An experiment counts `$experiment_exposure`, which ingestion copies from a flag
call only when the response is a variant string other than `true` or `false`,
so an experiment flag is multivariate. Results need 50 exposures a variant and
a duration estimate needs 100 and a day. The first candidate is the default
picture for a visitor who never chose one — MSAA against temporal upscaling —
judged on `perf window` and session length. It changes what a visitor sees, so
it lands with `pnpm presets:compare` plates of both arms, and a first visit
always runs the code default because flags arrive after the renderer is built.
Experiments on guide prompts or voices are rejected: the Guide is granted by
hand, so the population never reaches significance.

### 1.4 Evaluating the guide

- **Hog checks**, free of model cost: a second camera call answered
  `rejected`, an `error` tool status, a malformed `resolve_name`. They read
  only metadata, so they run on every tour.
- **An LLM judge**, sampled, over tours with `guide_content: "full"` only. It
  runs on an OpenAI key stored in PostHog — a separate project key with its own
  budget, about 40k tokens a tour — and grades a reconstructed conversation,
  because the backend's real input lives inside Live; its prompt says so.
- **Turns.** A trace today is a backend response. A turn — visitor speech, an
  arrival or a linger prompt, the guide's answer — would close when no chain is
  in flight and the guide has been quiet for 2.5 s, so the Sessions tab reads
  as the conversation. The provider defines no turns; the threshold is tuned
  against recorded tours.

### 1.5 The Worker's own events and spans

`tour session created` and `tour refused` (with the refusing check) from the
Worker in `ctx.waitUntil`, only when the request carries the
`X-POSTHOG-DISTINCT-ID` header the SDK sets on same-origin calls, with `$ip`
from `CF-Connecting-IP`. They carry nothing Workers Logs does not already keep,
which now reach PostHog Logs through the `posthog-logs` destination. Linking a
browser exception to a Worker span needs the Worker to emit its own span with
the browser's trace id: Cloudflare's traces do not adopt an incoming
`traceparent`.

### 1.6 Transcripts in our own bucket

A batch export of the `$ai_*` events to R2 (`S3Compatible`, gzip JSONLines)
would give custody past PostHog's 30 days. It conflicts with erasure: exported
rows are never updated, a file holds every visitor of an interval, and keys
carry no person, so deleting one account from R2 means rewriting files, which
reads transcripts. It waits on an erasure design.

### 1.7 A content security policy

The site sends no CSP. When it does, its `report-to` names the same
`Reporting-Endpoints` entry the crash reports use, and violations arrive as
`$csp_violation`.

### 1.8 Metrics

`/i/v1/metrics` takes OTLP, delta temporality, histogram counts as JSON numbers
or they are dropped; it is an unpriced alpha with 30-day retention. The
`perf window` event carries the same histograms and joins to GPU, preset and
session, so nothing waits on it.

---

## 2. Still unconfirmed

Each comes from documentation or source, and only the live project or the rig
can settle it:

- The symbolicator fetching `/assets/*.map` through Cloudflare. It sends no
  `User-Agent`, and a failed fetch is remembered for 24 hours. The check after
  the first deploy:
  `curl -s -o /dev/null -w '%{http_code}' -H 'User-Agent:' https://inertialref.app/assets/<file>.js.map`.
- A release resolved from `$app_namespace` and `$app_version` on a web
  exception, and the release body `scripts/posthog-release.mjs` sends, which is
  read from the server's code.
- Whether a delegated `response.completed` reports the `service_tier` it was
  served; every backend generation is priced at the priority tier.
- Whether events recorded before `identify`, and personless `$ai_*` events, are
  deleted with the person. Deleting a test person who played anonymously first
  answers both.
- Cloudflare's mapping of console-object fields to OTLP attributes in the
  `posthog-logs` export.
- Chrome's crash reports for a GPU-process crash.
- Whether the five free insight alerts include log alerts.

---

## 3. Settings outside the repository

What the project and the platform hold, so a rebuild knows to set it again:

| Where                  | Setting                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostHog project 719084 | Discard client IP, GeoIP transformation, replay on for `https://inertialref.app` only, heatmaps, surveys, web vitals, test-account filter `environment = production` |
| PostHog project 719084 | The surveys "After a tour" and "Was this page useful?" (API, launched, no display conditions), the `perf-window` flag                                                |
| Workers Builds         | `PUBLIC_POSTHOG_PROJECT_TOKEN`, `PUBLIC_POSTHOG_HOST` on Production and Previews Base; `POSTHOG_RELEASE_KEY` as a Production build secret                            |
| Cloudflare             | The `posthog-logs` observability destination (OTLP logs to `https://us.i.posthog.com/i/v1/logs`)                                                                     |
| Clerk, production      | A `user.deleted` webhook to `https://inertialref.app/api/clerk/webhook`                                                                                              |
| The Worker             | `CLERK_WEBHOOK_SIGNING_SECRET`, `POSTHOG_PERSON_DELETE_KEY` (a personal key with `person:read` and `person:write` only)                                              |
