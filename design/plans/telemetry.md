# Telemetry: the game reports its failures, and the guide keeps its transcripts

The game measures one thing about its visitors: a page view, through Google
Analytics, on one hostname. It reports none of its failures. Every fatal
failure the client can detect is caught on purpose, so the page can explain
itself: a lost GPU device, a render pipeline that does not validate, a frame
that throws, a React subtree that dies. A caught error reaches the console and
nowhere else. The Guide holds its conversation in the browser, and nothing in
the system assembles what was said: `tour/loop.ts` keeps the time of the last
transcript delta and discards its text.

This plan adds both: exceptions with stacks a person can fix from, and tour
sessions that read as a conversation, with every tool call and its result. It
comes from a vendor survey run on 2026-11-07, and it recommends PostHog for
both.

It is a plan, so it promises. When a phase lands, its decision moves into an
ADR and the section here goes.

| Reads with                                                                                     | For                                                             |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [ADR-0041](../../docs/adr/0041-the-guide-requests-the-view.md)                                 | The executor whose calls become spans                           |
| [ADR-0042](../../docs/adr/0042-the-guide-speaks-in-one-voice.md)                               | The conversation lives in the browser; the Worker never sees it |
| [ADR-0048](../../docs/adr/0048-accounts-are-clerks-and-the-worker-decides-who-is-asking.md)    | The account and the grant that admits a tour                    |
| [`apps/game/src/analytics.ts`](../../apps/game/src/analytics.ts)                               | The measurement gate this follows                               |
| [Hosting § The private Planetarium guide](../../docs/hosting.md#the-private-planetarium-guide) | What the Worker logs, and what it cannot                        |

---

## 1. What the tree reports today

| Failure                                            | Caught by                                                        | Goes to                           |
| -------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------- |
| Device loss, `onError`, render-pipeline validation | `render/rendererErrors.ts` → `runtimeFailure.report('graphics')` | The `RuntimeNotice`               |
| A frame that throws                                | `runGraphicsFrame` in `runtimeFailure.ts`                        | Console and the notice            |
| The runtime subtree                                | `GameRuntimeBoundary.componentDidCatch`                          | Console and the notice            |
| A HUD panel                                        | `hud/ErrorBoundary.componentDidCatch`                            | Console, with the component stack |
| No WebGPU                                          | `render/createRenderer.ts` → `report('unsupported')`             | The notice                        |
| A universe worker                                  | Nothing: `engine/browserWorker.ts` registers no `error` listener | DevTools                          |
| A provider error in a tour                         | `tour/loop.ts` → `onError(code, message)`                        | The Guide panel                   |
| Anything uncaught                                  | Nothing                                                          | Console                           |

Two facts follow, and they shape the integration more than the vendor does:

- **An SDK's global handler sees none of the failures that matter.** Every
  vendor hooks `window.onerror` and `unhandledrejection`, and every row above
  the last is caught before it gets there. The capture call goes in
  `runtimeFailure.report`, which is already the one funnel, and in
  `ErrorBoundary`, which is the other.
- **`runtimeFailure` keeps the first failure and drops the rest**, and that is
  the right reporting rule as well. The first is the cause; a lost device
  produces a cascade behind it.

**Symbolication needs no upload step.** Production ships public source maps:
`build.sourcemap: true`, and `vite.config.ts` fails the build when a hashed
asset lacks its `sourceMappingURL` comment. Sentry fetches a map from that
comment by default. PostHog's documentation asks for an upload only "if your
source maps are not publicly hosted". Either way, no vendor token enters
Workers Builds, provided the service fetches the map before the next deploy
replaces the asset.

---

## 2. The survey

Figures are from each vendor's own pricing page, read on 2026-11-07, except
where marked †: those come from search summaries that cite the vendor page.

| Service                     | Free each month                                                        | First paid                                       | Retention, free | Seats, free | Transcripts and tool calls                                                 |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ | --------------- | ----------- | -------------------------------------------------------------------------- |
| **PostHog**                 | 100k exceptions · 100k LLM events · 1M events · 5k replays · 1 project | $0.00037 per exception past 100k; no base fee    | 1 year          | No limit    | `$ai_generation`, `$ai_span`, `$ai_session_id`; the ingest token is public |
| Sentry                      | 5k errors · 50 replays · 5 GB logs                                     | Team, $26/mo annual or $29 monthly, 50k errors   | 30 days         | 1           | Agent tracing, listed on every plan; not evaluated here                    |
| Better Stack                | 100k exceptions · 5k replays · 3 GB logs kept 3 days                   | $0.000075 per exception (US)                     | Not stated      | No limit    | None; takes the Sentry SDK unchanged                                       |
| Rollbar                     | 5k occurrences · 1k replays                                            | Essentials; the page states no price             | 30 days         | No limit    | None                                                                       |
| TrackJS                     | None; a trial                                                          | Starter, $49/mo, 100k page views                 | 10 days, paid   | No limit    | None                                                                       |
| Honeybadger†                | 5k errors                                                              | Team, $26/mo, 50k                                | 15 days         | 1           | None                                                                       |
| GlitchTip†                  | 1k events hosted; self-hosting is free                                 | $15/mo for 100k                                  | 30 days         | No limit    | None                                                                       |
| Grafana Cloud Faro†         | 50k frontend sessions                                                  | $0.75 per 1k sessions, beside a $19 platform fee | —               | —           | None                                                                       |
| LaunchDarkly Observability† | 5k errors and replays                                                  | Overage                                          | —               | —           | None. This is Highlight.io, which shut down on 2026-02-28 and moved here   |
| Langfuse                    | 50k units; a unit is any trace, span, generation or score              | Core, $29/mo, 100k units, then $8 per 100k       | 30 days         | 2           | Sessions, traces and scores; ingesting a trace needs the secret key        |
| Cloudflare Workers Logs     | 0.5 GB/day ingest from 2026-12-01                                      | $0.25/GB past 50 GB on Workers Paid              | 7 days          | —           | Raw JSON                                                                   |
| Cloudflare Issues           | Free in open beta                                                      | Not announced                                    | Not stated      | —           | None. Groups the Worker's own failures; the fingerprint is not documented  |

TrackJS and Rollbar, the two the project has used elsewhere, both still work.
TrackJS has no free tier, and its $49 Starter keeps ten days. Rollbar's free
5k is Sentry's, without the rest of Sentry.

---

## 3. What each SDK costs the bundle

Measured 2026-11-07. Each SDK was initialized with exception capture and
bundled alone by esbuild 0.28.2 (`--bundle --minify --format=esm
--target=es2022`), then compressed at brotli quality 11 and gzip level 9.

| Entry                                                       | Minified | gzip     | brotli       |
| ----------------------------------------------------------- | -------- | -------- | ------------ |
| `posthog-js` 1.447.3, default                               | 367 KB   | 120.9 KB | **102.0 KB** |
| `posthog-js/dist/module.no-external` (nothing from its CDN) | 413 KB   | 125.4 KB | 105.2 KB     |
| `module.slim` with `ErrorTrackingExtensions`                | 179 KB   | 60.6 KB  | 52.1 KB      |
| `module.slim` alone, which captures no exception by itself  | 153 KB   | 51.9 KB  | 45.3 KB      |
| `@sentry/browser` 11.11.0, `init` defaults                  | 92 KB    | 31.3 KB  | **28.0 KB**  |
| `@sentry/browser`, `BrowserClient` and three integrations   | 64 KB    | 21.9 KB  | 19.8 KB      |
| `rollbar` 4.2.0                                             | 85 KB    | 26.3 KB  | 23.5 KB      |

For scale, a production build of commit `8515221` on the same day emits an
`App` chunk of 460.3 KB brotli and a `three.core` chunk of 90.8 KB. PostHog's
default entry is 22% of the first; Sentry's is 6%.

PostHog costs 3.6 times what Sentry does. The slim entry halves that, but it
reaches the error extension through `__extensionClasses`, and the 1.447.3
types mark that option `@internal`. It is not an interface to build on until
PostHog documents it.

Whichever SDK ships loads in its own chunk once the scene is up, so it sits
outside the cold-load budget. A buffer of a few lines, installed at startup,
holds `error` and `unhandledrejection` events until the chunk arrives.

---

## 4. The recommendation: PostHog for both

- **One SDK does both jobs, free, at volumes this project does not reach.**
  Only a crash loop reaches 100k exceptions a month, and reporting just the
  first runtime failure rules one out. A tour of 40 turns and 60 tool calls is
  about 100 LLM events, so the free 100k covers roughly 1,000 tours a month,
  and every guide grant is set by hand. That count is estimated from the
  loop's shape, not measured.
- **The ingest token is public, so the Worker stays out of the conversation.**
  ADR-0042 holds that the Worker never sees a prompt, a response or a
  transcript fragment. PostHog accepts capture with the same project token the
  page ships, so the browser that holds the conversation sends it. Langfuse
  needs its secret key to ingest, which puts the Worker in the relay, and
  ADR-0042 would have to reverse.
- **Its LLM model fits GPT Live as it is.** `$ai_session_id` groups traces in
  the Sessions tab: one tour is one session, a visitor's turn is a trace, the
  guide's reply is a `$ai_generation`, and every tool call the executor runs is
  a `$ai_span` under it, with its arguments, result, latency and
  `$ai_is_error`. An exception raised during a tour carries the same session
  id, so a tour and its failures come back from one search.
- **It can retire the Google tag later.** Web analytics with
  `cookieless_mode: 'always'` sets no cookie and writes no storage, which takes
  away the reason to keep gtag. That is phase 3, and it is optional.

**The runner-up, if bytes decide it:** `@sentry/browser` (19.8 to 28.0 KB)
pointed at Better Stack's Sentry-compatible endpoint, which takes 100k
exceptions a month free, with transcripts kept in whatever store the GPT Live
research picks. It ships a quarter of the bytes, through two vendors and two
consoles, with no conversation viewer.

**Not Cloudflare alone.** A `/api/telemetry` route that writes Workers Logs
costs the fewest dollars and the most code: no grouping, no symbolication, no
viewer, and seven days of retention. Issues groups the Worker's own
exceptions. Nothing documents what it does with a browser stack relayed
through `console.error`, and the stack it records names the Worker's frames,
not the page's.

---

## 5. Phases

### Phase 1: exceptions

- **`apps/game/src/telemetry.ts`, beside `analytics.ts`, with a gate of its
  own.** Production builds only. It measures `inertialref.app` and every
  preview, with an `environment` property naming which, since the free plan
  holds one project. It never measures `localhost`, and it honors GPC and DNT
  with the check `analytics.ts` makes. The token is a build variable,
  `VITE_POSTHOG_TOKEN`, kept out of the repository for the reason the GA id
  is: a fork would measure into this project.
- **Configuration:** `capture_exceptions: true`, `autocapture: false`,
  `disable_session_recording: true`, and `persistence: 'memory'` until phase 3
  decides otherwise.
- **Call sites:** `runtimeFailure.report`, with the kind as a property.
  `unsupported` is an event rather than an exception, because a browser
  without WebGPU is not a bug. `ErrorBoundary.componentDidCatch`, with `what`
  and the component stack. An `error` listener on each universe worker. The
  tour's `onError`.
- **Release:** the commit the build is cut from, so an exception names its
  deploy.
- **Done when** an error thrown on a preview appears in PostHog with a
  source-mapped frame in `apps/game/src`, and Workers Builds has no upload
  step.

### Phase 2: tour transcripts

A recorder in `apps/game/src/tour/` subscribes to the events `loop.ts` already
receives and assembles text from deltas. Today nothing keeps that text.

| GPT Live event                                    | PostHog                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `session.started`                                 | `$ai_session_id` is the session id; a `tour started` event carries the voice and the opening scene                      |
| `session.input_transcript.delta`                  | Accumulated into the visitor's turn, which becomes `$ai_input`                                                          |
| `response.created` through `response.completed`   | One `$ai_generation`: `$ai_model`, `$ai_output_choices` assembled from `session.output_transcript.delta`, `$ai_latency` |
| `response.output_item.done` with `function_call`  | One `$ai_span` per call when the executor returns: name, arguments, result, latency, `$ai_is_error`                     |
| `session.delegation.created`                      | A span for the hand-off to the delegated backend                                                                        |
| `response.failed`, `response.incomplete`, `error` | `$ai_is_error` on the generation, and an exception                                                                      |
| `session.usage.updated`, `session.closed`         | A `tour ended` event: voice seconds and the reason                                                                      |

- **Only with consent.** A switch in the Guide panel, beside the AI
  disclosure: _Share this tour's transcript to improve the guide._ It is
  stored through `state/preferences.ts`, and GPC forces it off. With the
  switch off the recorder sends nothing. An exception raised during a tour
  never carries transcript text in its message.
- **`distinct_id` is the Clerk user id**, so a grant can be matched to its
  tours. Identified events are free to 1M a month.
- **Done when** a recorded tour in the Sessions tab reads as the conversation
  it was, with each tool call under the turn that asked for it.

### Phase 3: the Google tag retired (optional)

PostHog web analytics with `cookieless_mode: 'always'`. `recordPageView`
points at PostHog, and the gtag loader goes.

---

## 6. Content blockers, and the Worker as a relay

Content blockers commonly block the ingestion hosts of every vendor surveyed,
and both PostHog and Sentry document a same-origin relay for that reason:
PostHog's reverse proxy, and Sentry's `tunnel` option. A `/ingest/*` route on
the existing Worker that forwards bytes unread would recover those reports.
It would also carry transcripts through the Worker, opaque but present, and
ADR-0042 says the Worker never sees one. Decide this together with the consent
switch, before phase 2 ships.

---

## 7. Decisions open

1. **The transcript store.** The GPT Live research is surveying Cloudflare
   storage for the same transcripts. Keep one store, not two: PostHog if the
   viewer matters more than custody, R2 if custody matters more.
2. **The consent default for granted accounts.** Off with a switch, as
   written, or on with a disclosure, since every account is invited by hand.
3. **The relay** in §6.
4. **The bytes.** Accept 102 KB in a deferred chunk, wait for a documented
   slim entry, or take the runner-up.

---

## 8. Still unmeasured

- **PostHog fetching a public map.** That reading comes from its
  documentation and has not been tested. Sentry's fetching is documented
  outright.
- **Events per tour.** Estimated from the loop's shape, not counted.
- **What `posthog-js` fetches from its CDN at init** with this configuration.
  It matters for privacy and for any future CSP. The `no-external` entry
  costs 3.2 KB more if the answer is "something".
- **A preview's map after the next deploy** replaces its assets.

---

## Sources

- [PostHog pricing](https://posthog.com/pricing.md) ·
  [error tracking pricing](https://posthog.com/docs/error-tracking/pricing) ·
  [source maps](https://posthog.com/docs/error-tracking/upload-source-maps) ·
  [LLM manual capture](https://posthog.com/docs/ai-observability/installation/manual-capture)
- [Sentry pricing](https://sentry.io/pricing/) ·
  [hosting source maps publicly](https://docs.sentry.io/platforms/javascript/sourcemaps/hosting-publicly)
- [Better Stack pricing](https://betterstack.com/pricing.md)
- [Rollbar pricing](https://rollbar.com/pricing/)
- [TrackJS pricing](https://trackjs.com/pricing/)
- [Langfuse pricing](https://langfuse.com/pricing)
- [Honeybadger plans](https://honeybadger.io/plans) ·
  [GlitchTip pricing](https://glitchtip.com/pricing) ·
  [Grafana Frontend Observability](https://grafana.com/products/cloud/frontend-observability) ·
  [Highlight's move to LaunchDarkly](https://www.highlight.io/blog/launchdarkly-migration)
- [Cloudflare observability pricing](https://developers.cloudflare.com/observability/pricing/) ·
  [Workers Issues](https://developers.cloudflare.com/workers/observability/issues/) ·
  [Cloudflare's observability update, 2026-10-02](https://blog.cloudflare.com/one-observability-platform/)
