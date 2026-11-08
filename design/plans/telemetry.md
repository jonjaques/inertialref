# Telemetry: PostHog, called directly

The game measures one thing about its visitors, a page view through Google
Analytics, and reports none of its failures. Every fatal failure the client can
detect is caught on purpose so the page can explain itself, and a caught error
reaches the console and nowhere else. The Guide holds its conversation in the
browser, and nothing in the system keeps what was said: `tour/loop.ts` records
the time of the last transcript delta and discards its text.

This plan replaces Google Analytics with PostHog and uses every PostHog product
that answers a question InertialRef has: who plays and how they arrive, what
breaks and on which GPU, what the Guide says and how well it calls its tools,
how the frame and the boot perform in the field, and what visitors think. It
uses **no PostHog SDK**. The browser and the Worker call PostHog's HTTP APIs
from code in this repository, and posthog-js is read only for the wire formats
and the behavior that code must reproduce.

It is a plan, so it promises. When a phase lands, its decision moves into an
ADR and the section here goes.

| Reads with                                                                                        | For                                                             |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [ADR-0041](../../docs/adr/0041-the-guide-requests-the-view.md)                                    | The executor whose calls become spans                           |
| [ADR-0042](../../docs/adr/0042-the-guide-speaks-in-one-voice.md)                                  | The conversation lives in the browser; the Worker never sees it |
| [ADR-0048](../../docs/adr/0048-accounts-are-clerks-and-the-worker-decides-who-is-asking.md)       | The account, the grant, and the Clerk id a person is keyed by   |
| [ADR-0058](../../docs/adr/0058-settings-hold-the-person-and-the-viewport-holds-its-instrument.md) | Where the person's data choices live                            |
| [Hosting § The private Planetarium guide](../../docs/hosting.md#the-private-planetarium-guide)    | What the Worker logs, and what it cannot                        |

**Where the facts come from.** PostHog's documentation at
`PostHog/posthog.com@2d6d56a`, the posthog-js monorepo at
`PostHog/posthog-js@eb11f00`, and the PostHog server at `PostHog/posthog@0f072f8`,
all read on 2026-11-07. Where the documentation and the server disagree, the
server is what this plan follows, and the disagreement is named. **No request in
this plan has been sent to a live PostHog project.** Every payload is built from
documentation and source, and §16 lists what only a live project can confirm.

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

An SDK's global handler would see none of the rows above the last: they are
caught before `window.onerror`. The capture calls go in `runtimeFailure.report`,
which is already the one funnel, and in `ErrorBoundary`, which is the other.
`runtimeFailure` keeps the first failure and drops the rest, and that is the
right reporting rule too: the first is the cause, and a lost device produces a
cascade behind it.

---

## 2. Why PostHog, and why no SDK

A survey of twelve services on 2026-11-07 chose PostHog for one reason the
others lack: a single project takes exceptions, LLM traces, product and web
analytics, logs, flags and surveys, ingested with a **public** project token.
The browser that holds the conversation can send it, so the Worker stays out of
it.

| Service      | Free each month                                                                                               | Notes                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **PostHog**  | 1M events, 100k exceptions, 100k LLM events, 5k replays, 10 GB logs, 1M flag requests, 1,500 survey responses | 1 project; 1-year event retention; no seat charge                 |
| Sentry       | 5k errors                                                                                                     | 1 seat, 30 days                                                   |
| Better Stack | 100k exceptions                                                                                               | Takes the Sentry SDK; no LLM view                                 |
| Rollbar      | 5k occurrences                                                                                                | —                                                                 |
| TrackJS      | None                                                                                                          | $49/mo minimum, 10-day retention                                  |
| Langfuse     | 50k units                                                                                                     | Ingesting a trace needs the secret key, so the Worker would relay |

The SDK is the wrong shape for this client. Measured with esbuild 0.28.2 at
brotli quality 11, against an `App` chunk of 460.3 KB:

| Entry                                                                        | brotli   |
| ---------------------------------------------------------------------------- | -------- |
| `posthog-js` 1.447.3, default                                                | 102.0 KB |
| `posthog-js`, slim plus the error-tracking extension (an `@internal` option) | 52.1 KB  |
| `@sentry/browser` 11.11.0, defaults                                          | 28.0 KB  |

Bytes are the smaller half of it. posthog-js owns its own storage, timers,
consent, retry queue and remote-config fetches, and it loads extensions from
PostHog's CDN. This repository keeps local storage in one module
(`state/preferences.ts`), already has the one failure funnel, and decides
consent itself. The client in §5 is the subset of posthog-js behavior the
products below depend on, and nothing else. Its budget is a target until it is
built: **6 KB brotli** always loaded, everything else in chunks that load only
when used.

What the decision gives up: autocapture, the toolbar, PostHog's heatmap and
replay recorders, popover surveys, product tours and the support widget. §12
says why none is missed.

---

## 3. The facets

| Product                     | Verdict                | For InertialRef                                                                                   |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| Capture and identity        | **Now**                | The envelope every other facet rides in (§6)                                                      |
| Web analytics               | **Now**                | Replaces GA: pageviews, channels, entry and exit, bounce, geography, devices, the Live tab (§7)   |
| Product analytics           | **Now**                | Funnels from boot to play, modes entered, tours started; cohorts by grant (§7.4)                  |
| Error tracking              | **Now**                | Every `runtimeFailure`, boundary, worker and tour failure, symbolicated from the public maps (§8) |
| AI observability            | **Now**                | Tour sessions, turns, tool calls, costs, the Tools tab, evaluations (§9)                          |
| Logs                        | **Now**                | The client `logHub` over OTLP, and the Worker's logs through Cloudflare's export (§10)            |
| Web Vitals                  | **Now**                | `/docs`, the menu and HUD input; the canvas is not an LCP candidate (§10.3)                       |
| Health checks               | **Now**                | Free daily checks that catch mistakes in a hand-written wire format (§10.5)                       |
| Alerts and subscriptions    | **Now**                | Boot-failure rate, exception rate, crash reports, a dead-deploy floor, a weekly digest (§13.4)    |
| Feature flags               | **Now**, scoped        | The upscaler's rollout first, device-bucketed, one request per boot (§11)                         |
| Surveys, API mode           | **Now**                | A post-tour survey and docs-page feedback, drawn in our own UI (§11.4)                            |
| Annotations, releases       | **Now**                | Every production deploy marked on every chart, and named on every exception (§13.2)               |
| Person deletion             | **Now**, with identify | A Clerk `user.deleted` webhook deletes the person and their events (§13.1)                        |
| MCP and the query API       | **Now**                | Agents in this repository triage through a read-only key (§13.5)                                  |
| CSP and crash reports       | **Decision**           | The browser sends them itself, so in-page consent cannot gate them (§10.4)                        |
| Session replay              | **Later**              | Upstream rrweb and our own transport, with our own canvas frames, after a rig measurement (§12.1) |
| Heatmaps on `/docs`         | **Later**, optional    | Free to ingest; three URL patterns on the free plan (§12.2)                                       |
| Experiments                 | **Later**              | On renderer flags, when traffic reaches 50 exposures per variant (§11.3)                          |
| Batch export to R2          | **Later**              | Custody of transcripts in our own bucket, once erasure is solved (§13.6)                          |
| Metrics, distributed traces | **Later**              | Metrics are an unpriced alpha; traces need the Worker to emit its own spans (§10.6)               |
| Everything else             | **Reject**             | §12.3                                                                                             |

---

## 4. Consent and the gate

The gate decides, per stream, whether anything is sent. It replaces
`isMeasured()` in `analytics.ts` and keeps its three rules: production builds
only, never against Global Privacy Control or DNT, and nothing at all without a
token, which is how a fork measures nothing.

| Tier                 | Default                                           | Set where                                             | Sends                                                                                |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| None                 | GPC or DNT; no token; `localhost`; `pnpm preview` | —                                                     | Nothing                                                                              |
| Usage and crash data | On, as GA is today                                | A switch in `pages/DataSection.tsx`                   | Analytics events, exceptions, logs, performance, flags, metadata-only `$ai_*` events |
| Tour transcripts     | Off                                               | A switch in the Guide panel, beside the AI disclosure | Full `$ai_*` content, the post-tour survey                                           |
| Session recording    | Off                                               | Settings, when §12.1 lands                            | `$snapshot` events                                                                   |

- **Every choice is a preference** declared in `state/preferences.ts`, so
  export, import and the live subscription carry it. GPC and DNT override every
  switch.
- **Turning usage off** stops the transport, clears its queue, and drops the
  anonymous id, so turning it on again starts a new one.
- **The anonymous id lives in local storage.** That is non-essential storage,
  and whether it needs a banner for EU visitors is a decision, not a fact this
  plan can settle (§15). Cookieless mode, which stores nothing, is rejected: the
  server removes the IP before GeoIP runs, so the world map is empty, and it
  rotates every visitor daily, which makes flags and experiments useless.
- **What visitors are told.** A page states what each tier sends, where it goes,
  and how long it is kept: events a year, LLM content 30 days, logs 14 days,
  replays 30 days. It lands in the same change as the first event.

**Environments.** The free plan holds one project, and every project shares the
allowance. Production and previews send, each event stamped `environment:
production | preview`; `localhost` and `pnpm preview` send nothing. The
project's test-account filter is `environment != production`, so a preview's
errors are searchable and its pageviews stay out of the dashboards.

---

## 5. The client

`apps/game/src/telemetry/`, one file per concern. Nothing here enters
`packages/*`, which may not read a clock, and nothing writes canonical state.

| File            | Holds                                                                                                    | Loaded            |
| --------------- | -------------------------------------------------------------------------------------------------------- | ----------------- |
| `gate.ts`       | The tiers above, GPC and DNT, the token, the environment                                                 | Always            |
| `uuidv7.ts`     | UUIDv7 from `crypto.getRandomValues`, monotonic within a millisecond                                     | Always            |
| `identity.ts`   | The anonymous id, `$identify` on Clerk sign-in, reset on sign-out and on account deletion                | Always            |
| `session.ts`    | `$session_id` and `$window_id`, with PostHog's rotation rules                                            | Always            |
| `transport.ts`  | The queue, batching, gzip, `fetch` with `keepalive`, retries, the rate limiter, the blocked-host breaker | Always            |
| `pageviews.ts`  | `$pageview` and `$pageleave`, the referrer, campaign parameters, the pageview chain                      | Always            |
| `exceptions.ts` | The stack parser, `$exception` building, fingerprints, the client limiter, the thumbnail ring            | Always            |
| `perf.ts`       | Boot events, the `perf window` histograms, Web Vitals                                                    | After first frame |
| `logs.ts`       | A `LogSink` on `logHub` that batches OTLP records                                                        | After first frame |
| `flags.ts`      | One `/flags` per boot, the cached result, exposure events                                                | After first frame |
| `surveys.ts`    | Survey definitions, eligibility, the three survey events                                                 | On demand         |
| `guide.ts`      | The tour recorder: turns, generations, spans, costs                                                      | In the tour chunk |

A buffer installed by `clientStartup.ts` holds `error` and `unhandledrejection`
events from the first instruction, so a failure before the transport is ready
is still sent.

### 5.1 Behavior reproduced from posthog-js

| Behavior       | Rule                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Event ids      | A client UUIDv7 on every event. Capture mints a new one on each retry otherwise, and deduplication needs the same `uuid`, `event`, `timestamp` and `distinct_id`                                                         |
| Session        | UUIDv7. Rotates after 30 minutes without activity or 24 hours from its start. Activity is any player input, recorded locally without sending anything. The server needs only a v7 timestamp at or before the first event |
| Window         | UUIDv7 per tab in `sessionStorage`, new when the session rotates. A duplicated tab is detected by a flag cleared on `pagehide`. `sessionStorage` joins `state/preferences.ts`, under the rule that holds local storage   |
| Batching       | Flush every 3 s, at 100 events, on route change and on `pagehide`. One POST never mixes tokens                                                                                                                           |
| Compression    | `CompressionStream('gzip')`, sent as `text/plain` so a cross-origin request needs no preflight. The server detects gzip by its magic bytes. Never base64: the logs endpoint cannot decode it                             |
| Unload         | `fetch` with `keepalive`, whose bodies share a 64 KB in-flight budget. AI events flush at turn close, never at unload                                                                                                    |
| Retries        | On a network failure, 408, 429 and 5xx: 3 s × 2ⁿ with ±50% jitter, three attempts, `Retry-After` honored. A 413 halves the batch. Any other 4xx drops it: one bad event fails the whole request                          |
| Rate limit     | A token bucket of 10 events a second, burst 100, so a frame loop that captures cannot flood                                                                                                                              |
| Blocked host   | Three consecutive status-0 failures stop sending until `online` fires                                                                                                                                                    |
| Bots           | `navigator.webdriver` sends nothing; the rest is the server's `$virt_is_bot`                                                                                                                                             |
| Library        | `$lib: "inertialref-web"`, `$lib_version: <commit>`. Sending `"web"` would grade our version as an outdated posthog-js in SDK health                                                                                     |
| String hygiene | Strip lone surrogates from every string. A single one fails a whole OTLP request                                                                                                                                         |

### 5.2 The relay

Content blockers block PostHog's ingest hosts. The Worker relays
`/api/relay/*` to the ingest host, inside the existing `runWorkerFirst`
`/api/*` route, so nothing in `cloudflare.config.ts` changes.

- **An allowlist, not a pass-through.** POST and OPTIONS only, to `/batch/`,
  `/i/v0/e/`, `/flags/`, `/api/surveys/` and `/i/v1/logs`, and later `/s/`.
- **Headers.** Forward `Content-Type`, `Content-Encoding` and `User-Agent`.
  **Delete `Cookie`**: on `inertialref.app` it carries Clerk's `__session`. Set
  `X-Forwarded-For` from `CF-Connecting-IP`, which is where capture reads the
  client's address.
- **Unread.** The Worker forwards the gzip body as bytes and never decodes it.
- **`$lib_custom_api_host`** on every event names the relay. The "no reverse
  proxy" health check reads it.
- **AI events do not use it.** `$ai_*` events go straight to the ingest host, so
  ADR-0042's "the Worker never sees a transcript" stays true as written. The
  people who take a tour are invited by hand, and a blocked tour report is a
  message to one of them. Routing them through the relay instead is decision 3
  in §15.

---

## 6. Capture and identity

**Hosts.** The ingest host, `https://us.i.posthog.com` or
`https://eu.i.posthog.com`, takes everything a browser sends. The app host,
`us.posthog.com` or `eu.posthog.com`, serves the private API and is never called
from a browser. The region is fixed when the project is created (§15). The
examples below use the US hosts; an EU project uses `eu.` in each.

**The envelope.** `POST /batch/` with `{api_key, sent_at, batch: [...]}`. Each
event is `{uuid, event, distinct_id, timestamp, properties}`. With both
`timestamp` and `sent_at`, the stored time is corrected for clock skew. An event
may be about 1 MB, a body 20 MB.

| Property on every event                        | Value                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `$session_id`, `$window_id`                    | §5.1                                                                     |
| `$current_url`, `$host`, `$pathname`           | From `location`, with query parameters other than campaign keys removed  |
| `$raw_user_agent`                              | `navigator.userAgent`. The server derives browser, OS and device from it |
| `$screen_*`, `$viewport_*`                     | Numbers                                                                  |
| `$browser_language`, `$timezone`               | `navigator.language`; an IANA zone name                                  |
| `$lib`, `$lib_version`, `$lib_custom_api_host` | §5.1, §5.2                                                               |
| `environment`                                  | `production` or `preview`                                                |
| `$process_person_profile`                      | `false` until sign-in, set last so nothing overrides it                  |

**Responses.** 200 means accepted, and it also means "dropped for quota": the v0
path reports no `quota_limited` for analytics events, so usage is watched in the
app. 400 is a malformed body, a non-boolean `$cookieless_mode`, or **any** event
without a name or a `distinct_id`, which rejects the whole batch. PostHog's own
capture page says that case returns 200; the server returns 400.

### 6.1 Identity

| Moment          | Wire                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First visit     | `distinct_id` is a new UUIDv7, also sent as `$device_id`, with `$process_person_profile: false`. Personless events are up to four times cheaper past the free tier and create no profile                                                                                                 |
| Clerk sign-in   | `{"event": "$identify", "distinct_id": "<Clerk user id>", "properties": {"$anon_distinct_id": "<anonymous id>", "$set": {"features": ["tour"]}}}`, sent from `account/AccountBridge.tsx` when `userId` first appears. Later events use the Clerk id with `$process_person_profile: true` |
| Sign-out        | A new anonymous id and a new session, as posthog-js's `reset()` does                                                                                                                                                                                                                     |
| Account deleted | The same reset, and §13.1 on the server. A new event under the deleted id would recreate the person                                                                                                                                                                                      |

The person holds no name and no email; Clerk holds those. `$set` carries only
what segments a chart: the granted features and the account's creation month.
`$device_id` stays the first anonymous id through sign-in, which is what keeps a
device-bucketed flag stable (§11).

---

## 7. Web analytics, in place of GA

### 7.1 Pageviews

`pages/DocumentMeta.tsx` already sees every navigation, and it calls
`telemetry.pageview()` where it calls `recordPageView()` today, on a pathname
change only.

| Property                                                                                           | Rule                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `$pageview_id`                                                                                     | The pageview's own `uuid`                                                                                             |
| `$referrer`, `$referring_domain`                                                                   | `document.referrer`, once per tab. **`"$direct"`** when there is none: the Direct channel requires exactly that value |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `gclid`, `fbclid`           | **No `$` prefix.** PostHog's default-properties table shows `$utm_source`, and the wire disagrees                     |
| `title`                                                                                            | The document title                                                                                                    |
| `$prev_pageview_id`, `_pathname`, `_duration`, `_max_scroll_percentage`, `_max_content_percentage` | On the next `$pageview` and on `$pageleave`, from the previous page                                                   |

`$pageleave` fires on `pagehide` and before each route change. It carries the
previous-pageview chain, which is what scroll depth and the `$pageleave` health
check read, and it keeps a real session from counting as a bounce. A bounce is
fewer than two pageviews and under ten seconds.

### 7.2 What the server derives

- **Location** from the request address, through the free GeoIP transformation.
- **Browser, OS and device** from `$raw_user_agent`, through the free User Agent
  Populator transformation. Capture parses nothing itself.
- **Channel, bounce, duration, entry and exit, bot classification**, at query
  time.
- **The address is not kept.** "Discard client IP data" removes `$ip` after the
  transformations run, so the country survives and the address does not.

### 7.3 The dashboard

Path-cleaning rules collapse `/docs/<page>` where a breakdown wants sections,
and `?at=` and `?t=` never reach `$current_url`. Conversion goals are custom
events: `tour started`, `mode entered` with `mode: solo`. The Live tab needs
nothing more.

### 7.4 Product events

| Event            | When                                  | Properties                                                  |
| ---------------- | ------------------------------------- | ----------------------------------------------------------- |
| `mode entered`   | `modeForPath` changes                 | `mode`, `from`                                              |
| `boot started`   | Once per boot                         | `gpu_backend`, `dpr`                                        |
| `boot completed` | The scene is revealed                 | `ms_first_light`, `ms_revealed`, `adapter_vendor`, `preset` |
| `boot failed`    | `runtimeFailure.report` before reveal | `failure_kind`                                              |
| `tour started`   | A Live session opens                  | `voice`, `guide_prompt_version`, `transcript_consent`       |
| `tour ended`     | `session.closed`                      | `reason`, `voice_seconds`, `turns`                          |

Names are lowercase "object verb", the form PostHog's own survey events use. A
funnel from `boot started` to `boot completed` to `mode entered` is the
cold-load budget measured in the field.

---

## 8. Error tracking

### 8.1 The event

`$exception` through capture, with a quota of its own. The server never parses a
stack string: it reads `$exception_list`, so **the browser parses stacks**.

```json
{
  "event": "$exception",
  "properties": {
    "$exception_list": [
      {
        "type": "TypeError",
        "value": "Cannot read properties of undefined (reading 'x')",
        "mechanism": {
          "type": "inertialref.runtime",
          "handled": false,
          "synthetic": false,
          "exception_id": 0
        },
        "stacktrace": {
          "type": "raw",
          "frames": [
            {
              "platform": "web:javascript",
              "filename": "https://inertialref.app/assets/App.Byb2DXyx.js",
              "function": "tick",
              "lineno": 1,
              "colno": 88017,
              "in_app": true
            }
          ]
        }
      }
    ],
    "$exception_level": "fatal",
    "$exception_fingerprint": "…",
    "failure_kind": "runtime",
    "$app_namespace": "inertialref",
    "$app_version": "<commit>",
    "tour_session_id": "…"
  }
}
```

| Field                         | Rule                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `type`                        | Required; 255 bytes                                                                                       |
| `value`                       | 10,000 bytes                                                                                              |
| `platform`                    | `"web:javascript"` on every frame. Without it a frame can be retagged as Python                           |
| `filename`, `lineno`, `colno` | An absolute `https` URL and both numbers, 1-based, or the frame is not looked up                          |
| Frame order                   | **Entry point first, crash site last**, the reverse of `Error.stack`                                      |
| `in_app`                      | Defaults to true; the server demotes `node_modules` and ignore-listed sources itself                      |
| Chains                        | Outermost first; a cause carries `mechanism: {type: "chained", source: "cause", exception_id, parent_id}` |

The parser follows posthog-js: Chrome and Gecko line forms, lines over 1,024
characters skipped, at most 50 frames, exact recursion cycles collapsed so a
stack overflow keeps one fingerprint, and frames from `chrome-extension://`,
`moz-extension://` and `safari-web-extension:` dropped along with any error that
carries only those. **A payload that fails to deserialize is stored, not
dropped**, with `$cymbal_errors` and no issue, so it never appears in Error
Tracking. After the first deploy, a query for `$exception` events carrying
`$cymbal_errors` is the check.

### 8.2 Source maps

Production already serves public maps, and `vite.config.ts` fails a build that
does not. The symbolicator fetches the script named in the frame, finds its map
from the `SourceMap` header, the trailing `//# sourceMappingURL=` comment, or
`<url>.map`, and stores the pair keyed by URL, so a map fetched once survives the
deploy that replaces its asset. No token enters Workers Builds.

Three limits, all in the server's code: 25 MB per response, a 30 s timeout, and
**no `User-Agent` header**. A failed fetch is remembered for **24 hours** before
that URL is tried again. A Cloudflare bot rule could refuse a request without a
user agent, so the first deploy checks
`curl -s -o /dev/null -w '%{http_code}' -H 'User-Agent:' https://inertialref.app/assets/<file>.js.map`
and exempts `/assets/*` if it is refused. If public fetching fails anyway, maps
upload from CI through `symbol_sets/bulk_start_upload`, a presigned PUT and
`bulk_finish_upload`, with a personal key. The body is PostHog's binary
container, not a raw map, and frames then carry a `chunk_id` derived from the
hashed file name.

### 8.3 InertialRef's failures

| Failure             | `type` and `mechanism.type`               | Fingerprint                           | Notes                                                                                                                                  |
| ------------------- | ----------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Device loss         | `GPUDeviceLost`, `webgpu.device.lost`     | `gpu-device-lost:<reason>`            | No stack: it is a promise callback. `reason: "destroyed"` is our own `releaseRenderer` and is not sent                                 |
| Pipeline validation | `GPUValidationError`, `webgpu.validation` | `gpu-validation:<normalized message>` | `GPUError` has no stack; `rendererErrors.ts` records `new Error().stack` where it wraps `createRenderPipeline`, sent `synthetic: true` |
| A throwing frame    | The error's own, `inertialref.frame`      | Automatic                             | —                                                                                                                                      |
| React boundary      | The error's own, `react.error-boundary`   | Automatic                             | `react_component_stack` and the boundary's `what` as properties                                                                        |
| Universe worker     | The error's own, `worker`                 | Automatic                             | A module worker's `error` event reaches the page with `error: null`, so the worker catches and posts `{name, message, stack}`          |
| Tour                | `TourError`, `guide`                      | `tour:<code>`                         | The provider's code only, never its message, which can quote the conversation                                                          |
| No WebGPU           | Not an exception                          | —                                     | A `boot failed` event with `failure_kind: unsupported`                                                                                 |

Custom fingerprints are needed because automatic grouping leaves the message out
whenever a stack resolves, and every validation error fails through the same
three.js frames: without one, every shader defect is one issue. A validation
error can arrive before `device.lost` resolves, so a `graphics` report waits one
task, about 200 ms, and sends the device loss instead if one appears.

**Context.** Any property is filterable in the issue list and in alert filters:
`failure_kind`, `tour_session_id`, `boundary`, `adapter_vendor`, `preset`. Free
text search covers only type, message, function names and file paths.

**The thumbnail.** Every 10 s a timer asks for an animation frame, and inside it
the canvas is drawn into a 320×180 2D canvas and encoded as WebP. A WebGPU
canvas reads back only inside the frame that drew it, which is what
`render/presentationWatchdog.ts` already relies on. The ring keeps the last
three, because a lost device leaves nothing to read, and the newest rides on
`$exception`. One committed frame of the renderer (`design/brand/og-plate.png`)
encodes to 1.4 KB at that size. The per-capture frame cost is not measured, and
it gates this item.

### 8.4 Limits and releases

- **Client.** A token bucket per exception type (10, refilling one every 10 s),
  a cap of five per page load, and a `WeakSet` so one `Error` is never reported
  twice: `GameLoader` and `GameRuntimeBoundary` can both report the same one.
  posthog-js applies its burst limit only to autocaptured errors, so this one is
  ours.
- **Server.** A project rate limit and a per-issue limit of 100 an hour, set in
  the UI. Suppressed and rate-limited events are not billed.
- **Releases.** `$app_namespace: "inertialref"` and `$app_version: <commit>` on
  every exception. The production deploy creates the matching release with one
  `POST /api/projects/:id/error_tracking/releases/`, whose `hash_id` is
  `sha512_hex("inertialref" + commit)`, before the deploy goes live: release
  lookups, misses included, are cached for five minutes. This path is read from
  the server's code and is not documented for web.

---

## 9. The Guide

### 9.1 The mapping

No SDK or documentation covers a realtime voice model, so the mapping is built
from what the trace view, the Sessions tab, the Tools tab, the cost views and
the evaluation judge each read.

| Tour                                                                | PostHog                                                                           | Properties                                                                                                                                                     |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The minted Live session                                             | `$ai_session_id` on every event                                                   | Session evaluations grade only generations that carry it                                                                                                       |
| One turn: visitor speech, an arrival or linger prompt, the greeting | A trace: a client UUIDv7 `$ai_trace_id`, and one `$ai_trace` event when it closes | `$ai_span_name` is the turn's kind, `$ai_latency` its duration                                                                                                 |
| The voice over that turn                                            | `$ai_generation`, `gpt-live-1`, captured **last**                                 | `$ai_input`: the running history plus this turn's visitor words. `$ai_output_choices`: `[{role: "assistant", content: <guide transcript>}]`                    |
| `session.delegation.created`                                        | `$ai_span` keyed by the delegation id, under the voice generation                 | `$ai_span_name: "delegation"`                                                                                                                                  |
| Each backend response                                               | `$ai_generation`, `gpt-6-astra`, keyed by the response id, under the delegation   | `$ai_output_choices` in OpenAI chat form with `tool_calls`; `$ai_tools`: `GUIDE_TOOLS`; tokens from `response.usage`                                           |
| Each executed `function_call`                                       | `$ai_span` keyed by `call_id`, under its response                                 | `$ai_span_name`: the tool. `$ai_input_state`: decoded arguments. `$ai_output_state`: the `GuideToolOutput`. `$ai_latency`. `$ai_is_error` on `status: "error"` |
| A provider `error`                                                  | `$ai_span` `provider_error` in the open trace                                     | `$ai_is_error: true`, `$ai_error: "<code>"`                                                                                                                    |
| `session.closed`                                                    | A last trace with the residual voice seconds                                      | `$ai_stop_reason`: the close reason                                                                                                                            |

Why each choice:

- **A turn closes** when no chain is in flight and the guide has been quiet for
  2.5 s. The provider defines no turns, so this is ours to tune against recorded
  sessions; a barge-in inside an open turn appends to its input.
- **Timing.** A node starts at `timestamp − $ai_latency`, so each event is
  captured when its operation ends, with its latency.
- **The voice generation goes last**, because the Sessions tab renders each turn
  from the trace's latest generation.
- **The input carries the running history**, capped near 60 KB, because that
  tab hides repeated messages by count; without it a visitor's second "yes"
  disappears.
- **OpenAI chat form** is the one shape the trace view, tool-name extraction and
  the judge all parse.
- **A `$ai_trace` event per turn** gives the trace its own latency; without it
  the list sums generations and counts the nested backend time twice.
- **Never one event per delta.** Transcript deltas arrive about every 200 ms and
  are assembled per turn. The recorder reads them before `channel.ts`'s trace
  filter drops output transcripts.

### 9.2 Costs

`gpt-6-astra` is in PostHog's price table. Sending `$ai_provider: "openai"` and
`$ai_service_tier: "priority"` prices it at the priority rate; without the tier
it prices at half. Tokens are `input_tokens`, `cached_tokens` as
`$ai_cache_read_input_tokens`, `output_tokens` and reasoning tokens. Whether a
delegated `response.completed` reports the tier it was served is not confirmed.

`gpt-live-1` is not in the table, and an unmatched model gets no cost at all.
Each voice generation sends `$ai_cost_passthrough: true` and
`$ai_total_cost_usd`, computed from the change in `session.usage.updated`'s
cumulative `seconds` since the last capture, at OpenAI's $0.05 a minute, so the
session sums exactly. A cost on a span is never summed.

The Worker adds `liveModel`, `backendModel`, `promptVersion` and the voice rate
to `GuideSessionCreated`, so the browser stamps what the Worker configured
rather than repeating `LIVE_MODEL`, `BACKEND_MODEL` and `PROMPT_VERSION`.

### 9.3 Content, consent and retention

PostHog strips nothing: privacy mode is a client decision.

| Tier               | `$ai_*` events                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| No usage consent   | None                                                                                                                                                 |
| Usage consent      | Metadata only: no `$ai_input`, `$ai_output_choices`, state or error text. `$ai_tools_called` is sent explicitly, because extraction needs the output |
| Transcript consent | Full content, with `guide_content: "full"` so evaluations filter to traces that carry it                                                             |

Tool arguments are model text made from speech, so they are content. The six
large properties live 30 days and everything else a year, so **transcript text
never goes in a custom property**. Live runs with `store: false`, so PostHog
holds the only copy of a transcript, and the consent copy says so.
Summarization and clusters send content to PostHog's AI providers and are
**off**. Each event stays under 100 KB, past which bytes are billed by size.

### 9.4 Evaluations

- **Hog checks**, free of model cost: a second camera call answered `rejected`,
  an `error` status, a malformed `resolve_name`.
- **An LLM judge**, sampled, with the whole tour as its target. It sees the tool
  catalog, each call with its id, and its result. It runs on an OpenAI key
  stored in PostHog, a separate project key with its own budget: about 40k
  tokens a tour, $0.004 on a small model and $0.08 on a large one. The judge
  grades a reconstructed conversation, because the backend's real input lives
  inside Live, and its prompt says so.
- **Trace reviews** for the manual half: a queue of tours read by a person.

Sentiment is English-only and reads only user messages: later. Clusters need
1,000 traces a week: rejected.

### 9.5 Volume

About 7.5 events a turn and 150 for a twenty-turn tour, so the free 100k is
roughly 650 tours a month, and $0.05 a tour past it. The voice time of the same
tour costs $0.75 at OpenAI.

---

## 10. Logs, performance and browser reports

### 10.1 Client logs

`logs.ts` adds a sink to `logHub` that batches warn and error records, plus the
last 20 records of any level before a failure, as OTLP.

- `POST /i/v1/logs?token=phc_…` through the relay, `Content-Type: text/plain`,
  gzip. Never base64. The body limit is 2 MiB; a timestamp more than 24 h off is
  replaced.
- Resource attributes: `service.name: inertialref-web`, `service.version`,
  `deployment.environment`.
- Record attributes **`posthogDistinctId`** and **`sessionId`**, spelled
  exactly, link a record to its person and to the session's related errors, and
  they must be the ids the event client sends. Also `log.scope`, `log.seq` and
  `failure.kind`.
- `LogRecord` carries no wall time by design (`packages/shared/src/log.ts`), so
  the sink stamps `Date.now()` as nanoseconds, `ms + "000000"`, when it receives
  a record. Severity: trace 1, debug 5, info 9, warn 13, error 17.
- Records are kept 14 days. PII scrubbing is on as a backstop. Log bodies never
  carry transcripts, SDP, tokens or query strings, which `apps/server/src/log.ts`
  already forbids on the Worker.

### 10.2 Worker logs

A Cloudflare Observability destination of type Logs, endpoint
`https://us.i.posthog.com/i/v1/logs` with `Authorization: Bearer phc_…`, added
to `observability.logs.destinations` beside `persist: true`. No code. Each
`/api/*` record gains `posthogDistinctId`, `sessionId` and a `trace_id` from
headers the browser sets on same-origin calls (`X-POSTHOG-DISTINCT-ID`,
`X-POSTHOG-SESSION-ID`, `traceparent`), so a browser failure and the Worker's
record of the same request share a search. How Cloudflare maps console-object
fields to OTLP attributes needs one test export; PostHog's "JSON parse logs"
setting extracts up to 50 fields if they arrive as a body.

### 10.3 Performance

- **`perf window`**, every 60 s while rendering and once at `pagehide`:
  `period_p50`, `period_p95`, `engine_p95`, `dropped_frames` (over 25 ms),
  `draw_calls_p95`, `heap_mb`, `gpu_ms` where measured, and fixed-bound
  histograms (`period_buckets`, bounds 8, 12, 16.7, 20, 25, 33.4, 50 and 100 ms)
  that HogQL's `sumForEach` turns into population percentiles a per-session p95
  cannot give. The numbers come from `engine/frameMetrics.ts`, which the perf
  panel reads.
- **`$web_vitals`**, for `/docs`, the menu and HUD input. The dashboard reads
  `$pathname` and `$web_vitals_{INP,LCP,CLS,FCP}_value` (ms; CLS has no unit).
  `$pathname` comes from the metric's own navigation, so a late INP is not filed
  under the next route. Values of 15 minutes or more are dropped. A WebGPU
  canvas is never an LCP candidate, so in the game LCP measures the boot cover's
  text, and `boot completed` is the figure for "the scene is up". Google's
  `web-vitals` library or a PerformanceObserver of our own feeds it, whichever
  measures smaller.

### 10.4 CSP and crash reports

`POST <ingest>/report/?token=…` turns `report-to` and `report-uri` bodies into
`$csp_violation` and `$browser_crash_report` events. Crash reports are the
valuable half: a tab killed for memory, or hung, never reaches `runtimeFailure`.
The browser sends them itself, from response headers, so **neither the consent
switch nor GPC can stop them**. The server drops query strings and creates no
person, but it attaches the IP, which the project's discard setting then
removes. The repository has no CSP yet, so the first form is a
`Reporting-Endpoints` header naming only `default`, the one endpoint crash
reports go to. Whether to send it is decision 6 in §15. Whether Chrome reports
GPU-process crashes this way is not confirmed.

### 10.5 Health checks

Free and daily: missing `$pageleave`, missing `$web_vitals`, no reverse proxy,
ingestion warnings. They are how a mistake in a hand-written wire format shows
up. SDK health ignores a custom `$lib`.

### 10.6 Later

- **Metrics** (`/i/v1/metrics`, OTLP, delta temporality, histogram counts as
  JSON numbers or they are dropped): an unpriced alpha with 30-day retention.
  The `perf window` event carries the same histograms and joins to GPU, preset
  and session.
- **Distributed traces.** Cloudflare's traces do not adopt an incoming
  `traceparent`, and Cloudflare's own page says PostHog accepts no OTLP traces,
  though PostHog's capture service has a `/i/v1/traces` route. Linking a browser
  exception to a Worker span means the Worker emitting its own span with the
  browser's trace id. The `trace_id` on Worker logs gives most of the value now.

---

## 11. Flags, experiments and surveys

### 11.1 Flags

The first flag is the upscaler's rollout: a percentage of visitors, a kill
switch without a deploy, and frame time and failure rate broken down by
`$feature/upscaler`.

```http
POST /api/relay/flags/?v=2
Content-Type: text/plain;charset=UTF-8

{"token":"phc_…","distinct_id":"…","$device_id":"…",
 "person_properties":{"environment":"production","gpu_tier":"discrete"},
 "evaluation_contexts":["game"],"geoip_disable":true}
```

- **One request per boot**, after the first frame, plus one after `identify` and
  one after a reset. posthog-js polls every five minutes, and every poll is
  billed. A request is billed if it evaluates any active billable flag, and
  naming `flag_keys` does not reduce that.
- **Cache first.** The last response lives in `state/preferences.ts` and applies
  synchronously at boot. A boot-time choice such as the renderer path takes a
  changed value on the next boot. A first visit runs the code default and sends
  no exposure.
- **Device bucketing** on every flag a visitor can see before sign-in. The hash
  is `sha1(key + "." + id)`, so a sign-in that changes the distinct id would
  flip a user-bucketed variant; `$device_id` does not change. A device-bucketed
  flag requested without `$device_id` comes back false.
- **Response.** `{"flags": {"upscaler": {"enabled", "variant", "metadata":
{"id", "version", "payload"}}}, "requestId", "evaluatedAt"}`. A flag marked
  `failed` keeps its cached value. A quota-limited response is a 200 with
  `"flags": {}` and `"quotaLimited": ["feature_flags"]`, and leaves the cache
  alone.
- **Retries.** Once after 500 ms on 502, 504 or a timeout; never on status 0.
- **Targeting** reads `person_properties` sent with the request, so a
  personless visitor is targetable by GPU tier or preset without a profile.
- **Contexts** `game`, `docs` and `worker` keep a flag in its runtime; the one
  project holds them all.

### 11.2 Exposures

`$feature_flag_called` with `$feature_flag`, `$feature_flag_response`,
`$feature_flag_id`, `$feature_flag_version`, `$feature_flag_request_id`, and
`$used_bootstrap_value: true` when the value came from the cache. It is sent
once per flag and value per distinct id, and the reported set is cleared on
`identify` and reset. No request and no exposure without usage consent: those
visitors run code defaults, and a rollout covers consenting visitors only.
Exposure and survey events are not billed.

### 11.3 Experiments, later

An experiment counts `$experiment_exposure`, which ingestion copies from a flag
call only when the response is a variant string other than `true` or `false`,
so an experiment flag is multivariate. Results need 50 exposures; a duration
estimate needs 100 and a day. The upscaler A/B test, on frame time and session
length, waits for that traffic. Experiments on guide prompts or voices are
rejected: the Guide is granted by hand, so the population never reaches
significance, and the visitor chooses the voice. `guide_prompt_version` on every
`$ai_*` event compares prompt versions without one.

The Worker can evaluate a flag with the same request and
`"evaluation_runtime": "server"`, which it must set: a Worker's `fetch` sends no
`Origin`, and without the runtime PostHog drops client-only and server-only
flags. Local evaluation needs a `phs_` secret and a port of an 800-line matcher,
and is rejected.

### 11.4 Surveys

Two, both drawn in our own UI:

- **After a tour.** "How was the tour?", with a rating and a line of text, shown
  when a tour ends, only to a visitor who gave transcript consent, and linked by
  `tour_session_id`.
- **On a docs page.** "Was this page useful?", personless, fetched when the
  widget scrolls into view.

The flow, without the SDK:

1. `GET /api/relay/api/surveys/?token=phc_…` returns the launched surveys.
   Drafts are never returned, and a just-launched survey can take a moment to
   appear.
2. Every display condition in PostHog stays empty. Our code triggers the survey
   and keeps "already seen" through `state/preferences.ts`; PostHog's own check
   reads person properties and never excludes a personless visitor.
3. Events: `survey shown` with `$survey_id` and `$survey_iteration`. `survey
sent` with `$survey_id`, `$survey_name`, `$survey_iteration`,
   `$survey_submission_id`, `$survey_completed`, `$survey_questions` as
   `[{id, question}]`, and one `$survey_response_<question id>` per answer.
   `survey dismissed`, never after a final `survey sent`. A signed-in respondent
   also gets `$set: {"$survey_responded/<id>": true}`.
4. **Ratings are sent as strings.** PostHog's documentation says strings, its
   agent skill says numbers, and the server reads responses as strings.

Responses bill once per submission id, and 1,500 are free. Whether the free plan
can create API surveys is not settled by the documentation, and is checked at
setup.

---

## 12. Later, and rejected

### 12.1 Session replay

A replay of the game without canvas frames is the HUD over a black rectangle.
The design, when it lands:

- **Upstream `@rrweb/record`**, 21.7 KB brotli measured, plus the console plugin
  at 2.9 KB, in a chunk loaded only for a visitor who turned recording on,
  starting on a trigger: a tour starts, or a failure is reported. A trigger
  buffer keeps a minute of lead-in.
- **Our transport to `/s/`.** `$snapshot` events with `$snapshot_data` as plain
  rrweb events, gzip on the body. **One POST holds exactly one session and one
  window**: capture takes both from the first event and applies them to the
  batch. `/s/` answers 200 when the project's replay switch is off and drops the
  data, so the switch is part of setup.
- **Canvas frames from our own sampler** at 1 fps and 640×360, about 190 KB a
  minute, appended as synthesized canvas mutations in the format PostHog's
  player deserializes. rrweb's own canvas recording reads the WebGPU canvas from
  its own animation frame and sees a drawn frame or transparent black depending
  on which loop registered first, and it patches canvas APIs globally: rejected.
  PostHog's defaults would upload about 1.4 MB a minute.
- **Masking.** `maskAllInputs: true`, account pages blocked, `/settings/*` text
  masked, and the `SkyLabels` layer blocked, since it writes every label every
  frame and floats over the black canvas anyway.

It waits on two things: a rig measurement of the recorder's and the sampler's
frame cost with `scripts/drive.mjs --cast` and the perf panel, and one
synthesized canvas mutation played back in PostHog's player.

### 12.2 Heatmaps on `/docs`

`$$heatmap` with `$heatmap_data: {"<url>": [{x, y, target_fixed, type}]}` and
numeric `$viewport_width` and `$viewport_height`, or the event is dropped. Free
to ingest; the free plan covers three URL patterns. Over the game, screen
coordinates under a moving camera point at nothing, and no heatmap backdrop can
show a WebGPU scene.

### 12.3 Rejected

| Product                                                     | Why not                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Autocapture, the toolbar                                    | They need posthog-js on the page                                                                                                      |
| Dead clicks                                                 | A click on the scene changes no DOM, so every one would count, and each is a billed event                                             |
| Rage clicks from the SDK                                    | Rapid clicking can be play. With replay, we emit `$rageclick` ourselves on HUD elements only                                          |
| Replay Vision                                               | It would watch a black canvas, sends video to Gemini, and needs organization-wide AI processing                                       |
| Network recording                                           | Our traffic is static assets and three `/api` routes the Worker already logs                                                          |
| Product tours, popover and hosted surveys                   | posthog-js renderers; product tours' docs are withdrawn                                                                               |
| Early access features                                       | Clerk grants already gate features, and a "Labs" switch in settings needs no vendor                                                   |
| Local evaluation, HTML bootstrapping, experience continuity | A secret and a ported matcher; a PostHog round trip before the first byte of HTML; a database read per evaluation                     |
| Prompt management                                           | Prompts are reviewed code in `apps/server/src/tour/prompts.ts`; fetching them needs a personal key at runtime                         |
| Clusters                                                    | 1,000 traces a week                                                                                                                   |
| Cookieless mode                                             | No geography, and a daily rotation that breaks flags (§4)                                                                             |
| PostHog AI, the Slack app, self-driving, the skills store   | All need organization-wide AI processing, which would send transcripts to outside models; the repository keeps one copy of its skills |
| Workflows                                                   | The game messages nobody, and no workflow action deletes a person                                                                     |
| The Clerk warehouse source                                  | It copies emails into PostHog and cannot process a deleted user                                                                       |
| Endpoints                                                   | A read API behind a secret; it matters only for a public stats page the Worker would serve                                            |
| The support widget                                          | posthog-js                                                                                                                            |
| Self-hosting                                                | A 16 GB VM, unsupported, for a project far under PostHog's own 1M-event guidance                                                      |
| Importing GA history                                        | It needs a GA4 export to BigQuery that this property never had                                                                        |

---

## 13. The server side

Private calls go to the app host with `Authorization: Bearer phx_…`, a personal
API key. A project secret key (`phs_`) can make none of them. Personal keys
belong to one PostHog user, at most ten each, and die with that user; GitHub's
secret scanning rolls any found in a public repository.

### 13.1 Deleting a person

A new route, `POST /api/clerk/webhook`, verifies the Svix signature with
`CLERK_WEBHOOK_SIGNING_SECRET` and, on `user.deleted`, calls:

```http
POST https://us.posthog.com/api/projects/{id}/persons/bulk_delete/
Authorization: Bearer $POSTHOG_PERSON_DELETE_KEY

{"distinct_ids":["<Clerk user id>"],"delete_events":true,"delete_recordings":true}
```

- 202 is the answer. Success is `persons_queued_for_deletion > 0`, or
  `persons_found: 0` for an account that never signed in while measured.
  Entries in `deletion_errors` are retried; a repeated request queues no
  duplicate.
- The person goes in minutes, but **events go in a weekly batch**, on weekends,
  with a two-day cutoff, so the account page says "within about two weeks".
- The single-person `DELETE …/persons/{uuid}/?delete_events=false` deletes
  events too, because the server tests only that the parameter is present. This
  plan uses `bulk_delete`.
- Two questions stay open, and deleting a test person who played anonymously
  first answers both: whether events recorded **before** `identify` carry the
  deleted person's id, and whether personless `$ai_*` events are deleted with
  the person.

**Identify ships with deletion.** Until this route is live, every event is
personless and nobody is identified.

### 13.2 Releases and annotations

The production deploy, after `cf deploy`, with `WORKERS_CI_COMMIT_SHA` and
`WORKERS_CI_BRANCH`:

```http
POST https://us.posthog.com/api/projects/{id}/annotations/
{"content":"Release <sha> (main)","date_marker":"<now>","scope":"project","creation_type":"GIT"}
```

`scope: "project"` is required: the default attaches the marker to no chart. An
annotation cannot be deleted, only patched with `deleted: true`. The same step
creates the error-tracking release (§8.4). Both keys are **Production** build
secrets, so the step does nothing on a preview or a fork.

### 13.3 Worker events

The Worker sends `tour session created` and `tour refused` (with the refusing
check) to the ingest host in `ctx.waitUntil`, with the public token, and only
when the request carries `X-POSTHOG-DISTINCT-ID`, which the browser sets only
under usage consent. It sets `$ip` from `CF-Connecting-IP`, or every event
locates to a Cloudflare data center, and `$raw_user_agent` from the request, or
every event is classified as automation. Its `$lib` is `inertialref-worker`.
These carry nothing Workers Logs does not already keep.

### 13.4 Alerts, subscriptions, limits

| Alert                   | Watches                                                | Free plan                         |
| ----------------------- | ------------------------------------------------------ | --------------------------------- |
| Boot failure rate       | `boot failed / boot started` above a threshold, hourly | Insight alerts: 5, hourly at most |
| Exception rate          | The `$exception` trend                                 | Insight alerts                    |
| Crash reports           | `$browser_crash_report` count                          | Insight alerts                    |
| A dead deploy           | `boot completed` below a floor                         | Insight alerts                    |
| Error logs              | `service.name` errors over 50 in 10 min, every 5 min   | Log alerts                        |
| New and reopened issues | Error tracking's own alert, to Slack                   | Error tracking alerts             |

Error tracking's native alert reaches Slack, Discord, Teams or a webhook; email
comes from an insight alert or the weekly digest, a dashboard subscription.
**Billing limits** are set on every product: the project token is public, and
anyone holding it can spend the quota. Over a limit PostHog drops data, does not
queue it, and still answers 200. It warns at 80% and 100%.

### 13.5 Agents

Claude Code and Codex in this repository read PostHog through its MCP server,
`https://mcp.posthog.com/mcp`, with the skills installed under `.claude/skills`:
error triage, symbolication, LLM traces, evaluations, logs, dashboards, bots,
path cleaning, surveys, ingestion warnings, billing and stale flags.

- **The key** is made from the **"Read-only access"** preset and limited to the
  one project. `x-posthog-read-only` only filters the tool list, and the "MCP
  Server" preset the documentation links grants write on every scope.
- **`?features=`** leaves out replay, and transcripts are read deliberately or
  not at all: whatever an agent reads goes to its model provider, and a
  transcript is visitor-written text an agent will follow if it can.
- **`POSTHOG_MCP_KEY`** is each developer's own environment variable, never
  committed.
- **The query API** (`POST /api/projects/{id}/query/`, `HogQLQuery`,
  `query:read`) serves scripts: 240 a minute, 10 s of execution, and a 20 GB an
  hour read budget on the free plan.

PostHog's `instrument-*`, `installing-posthog-*` and `implementing-api-surveys`
skills are not installed: each begins by installing an SDK.

### 13.6 Transcripts in our own bucket, later

A batch export of the `$ai_*` events to R2 exists, as an `S3Compatible`
destination writing gzip JSONLines every 5 minutes to every week, with 1M rows a
month free. It would give custody past PostHog's 30 days. It conflicts with
erasure: exported rows are never updated, a file holds every visitor of an
interval, and keys carry no person, so deleting one account from R2 means
rewriting files, which reads transcripts. Decision 5 in §15.

### 13.7 Credentials

| Name                           | Kind                           | Lives in                                         | Scope                                               |
| ------------------------------ | ------------------------------ | ------------------------------------------------ | --------------------------------------------------- |
| `VITE_POSTHOG_TOKEN`           | Public project token           | Workers Builds build variable, `.env.production` | Ingest only. Not committed, so a fork sends nothing |
| `VITE_POSTHOG_REGION`          | `us` or `eu`                   | The same                                         | —                                                   |
| `POSTHOG_TOKEN`                | Public project token           | Worker variable                                  | Worker events and flags                             |
| `POSTHOG_PERSON_DELETE_KEY`    | Personal key                   | Worker secret                                    | `person:write`, `person:read`                       |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Svix secret                    | Worker secret                                    | —                                                   |
| `POSTHOG_RELEASE_KEY`          | Personal key                   | Production build secret                          | `annotation:write`, `error_tracking:write`          |
| `POSTHOG_MCP_KEY`              | Personal key, read-only preset | Each developer's environment                     | Every scope at `:read`, one project                 |
| The judge's key                | OpenAI project key             | PostHog, write-only                              | Its own budget                                      |

---

## 14. Setup and phases

### 14.1 The project, once

The region (§15). GeoIP and the User Agent Populator transformations on, and
"Discard client IP data" on. The test-account filter `environment !=
production`. Path-cleaning rules for `/docs`. Replay, heatmaps, summarization
and organization AI processing off. Error-tracking rate limits, billing limits
on every product, the alerts and the digest, and the read-only MCP key. Whether
GeoIP and the populator are on by default for a new project is checked here.

### 14.2 Phases

| Phase | Lands                                                                                                                                                                                                                                                                                                                                                                                                              | Done when                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | The gate, the client core, the relay, pageviews and product events, the data page and the usage switch. **GA goes**: `analytics.ts`, its calls in `clientStartup.ts` and `DocumentMeta.tsx`, `VITE_GA_MEASUREMENT_ID` in `env.d.ts` and `.env.example`, `vite.config.ts`'s build-log check (which then checks the PostHog token), `docs/hosting.md`, `docs/guides/development.md`, and the Workers Builds variable | The web analytics dashboard shows a day of production with geography, devices and channels; health checks pass; the GA property is deleted after          |
| **1** | Exceptions, the parser, fingerprints, the worker listener, releases and annotations                                                                                                                                                                                                                                                                                                                                | A preview's thrown error shows a source-mapped frame in `apps/game/src`, and no `$exception` carries `$cymbal_errors`                                     |
| **2** | Client logs, the Worker's log export, `perf window`, boot events, Web Vitals, the alerts                                                                                                                                                                                                                                                                                                                           | A Worker record and a browser record of one request share a search, and the boot funnel matches the perf panel on the rig                                 |
| **3** | The tour recorder, the transcript switch, costs, Hog checks, the sampled judge, the post-tour survey, docs feedback                                                                                                                                                                                                                                                                                                | A recorded tour in the Sessions tab reads as the conversation it was, each tool call under the turn that asked for it, its cost within a cent of OpenAI's |
| **4** | Identify and the Clerk deletion webhook, together                                                                                                                                                                                                                                                                                                                                                                  | A test account that played, signed in and was deleted has no person, and the weekend batch removes its events                                             |
| **5** | The upscaler flag                                                                                                                                                                                                                                                                                                                                                                                                  | A 10% rollout shows frame time by variant                                                                                                                 |
| Later | The thumbnail, once its frame cost is measured; replay; docs heatmaps; the R2 export; metrics; traces; the upscaler experiment                                                                                                                                                                                                                                                                                     | —                                                                                                                                                         |

`CONTEXT.md` takes an entry per phase, through `/context-log`.

---

## 15. Decisions open

1. **Region.** EU keeps visitors' data in the EU, which removes the transfer
   question for EU visitors, and discards addresses by default; US is PostHog's
   default. This plan recommends EU. The region cannot change after the project
   is created.
2. **The consent default.** Usage on by default, with a switch and GPC honored,
   is GA's posture today. Whether an anonymous id in local storage needs a
   banner for EU visitors is a question for whoever owns the risk, not one this
   plan answers.
3. **Tour events and the relay.** As written, `$ai_*` events skip the relay and
   ADR-0042 stands unchanged. Through the relay, a blocked tour still reports,
   and ADR-0042 changes from "never sees" to "relays unread".
4. **The transcript consent default.** Off with a switch, as written, or on with
   a disclosure, since every account that can take a tour is invited by hand.
5. **Custody.** PostHog as the only transcript store, deleted by §13.1, or an R2
   export as well, with a file-rewriting job for erasure that reads transcripts.
6. **Crash reports.** A `Reporting-Endpoints` header that no in-page switch can
   stop, for the one failure the page cannot see.

---

## 16. Still unconfirmed

Each of these comes from documentation or source, and only a live project or
the rig can settle it:

- The symbolicator reaching `/assets/*.map` through Cloudflare without a user
  agent (§8.2).
- A release resolved from `$app_namespace` and `$app_version` on a web event
  (§8.4).
- A delegated `response.completed` reporting `service_tier` (§9.2).
- Whether the free plan creates experiments and API surveys (§11).
- Pre-`identify` events and personless `$ai_*` events under person deletion
  (§13.1).
- Cloudflare's OTLP attribute mapping, and a Traces destination at
  `/i/v1/traces` (§10.2, §10.6).
- Chrome's crash reports for a GPU-process crash (§10.4).
- A synthesized canvas mutation in PostHog's replay player (§12.1).
- The frame cost of the thumbnail sampler and of rrweb's observers.
- Whether the five free insight alerts include log alerts.
- Production body limits, which the code gives only as defaults.
- The 6 KB budget of §2, until the client exists.
