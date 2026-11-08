import type {
  CaptureResult,
  LogAttributes,
  PostHog,
  PostHogConfig,
  Properties,
} from 'posthog-js'
import { BUILD_ID } from '../build.ts'
import {
  read,
  subscribe,
  TELEMETRY_REPLAY,
  TELEMETRY_USAGE,
} from '../state/preferences.ts'
import {
  currentSurroundings,
  environmentFor,
  type TelemetryEnvironment,
} from './consent.ts'
import { type FailureReport, FailureReporter } from './failures.ts'
import { cleanUrl, sanitizeEvent } from './sanitize.ts'

/*
 * PostHog, and the only module that talks to its SDK.
 *
 * Every product PostHog has that answers a question InertialRef asks rides on
 * this one client: web and product analytics, error tracking, session replay,
 * heatmaps, web vitals, logs, feature flags, surveys and the guide's AI
 * traces. `docs/adr/0061-telemetry-is-posthog.md` is the decision; this is
 * where its rules are enforced.
 *
 * **Gated before anything loads.** `consent.ts` answers whether the page is a
 * deployment that reports at all, and the visitor's `TELEMETRY_USAGE` switch
 * answers whether this visitor does. The SDK is a dynamic import behind both:
 * a static import put about 120 KB gzip in the chunk `runtimeLoader.prepare`
 * awaits, ahead of the App import and the catalog fetch, on every cold visit
 * and in builds that report nothing. Work asked for while it loads waits for
 * it; nothing waits on it. A page that reports nothing costs a function call
 * and a null check per call site.
 *
 * **Same-origin, through the Worker.** `api_host` is the Worker's relay
 * (`apps/server/src/relay.ts`), because content blockers drop requests to
 * PostHog's own hosts. The guide's `$ai_*` events are the exception and go
 * straight to the ingest host, so the Worker never carries a transcript, as
 * ADR-0042 promises; a blocked tour report is a message to one invited
 * visitor, not a hole in the numbers.
 *
 * **Storage is the SDK's.** posthog-js keeps its identity and queue in
 * `localStorage` under its own keys, which is the one exception to
 * `state/preferences.ts` owning storage: the SDK reads them before any code of
 * ours could hand them over. `persistence: 'localStorage'` rather than the
 * cookie default, because a cookie on `inertialref.app` rides along on every
 * `/api` request the Worker serves.
 */

const TOKEN: string = import.meta.env.PUBLIC_POSTHOG_PROJECT_TOKEN ?? ''
/** The ingest host, `https://us.i.posthog.com`; the relay forwards to it. */
const HOST: string = (import.meta.env.PUBLIC_POSTHOG_HOST ?? '').replace(
  /\/+$/,
  '',
)
/** The Worker's relay to `HOST`. `apps/server/src/relay.ts`. */
const RELAY_PATH = '/api/relay'

/** Where a toolbar or a replay link opens: the app host beside the ingest one. */
export const uiHostFor = (ingest: string): string =>
  ingest.replace('.i.posthog.com', '.posthog.com')

type Run = (posthog: PostHog) => void

/** `off` — this page never reports; `declined` — the visitor said no. */
let state: 'idle' | 'off' | 'declined' | 'loading' | 'ready' = 'idle'
let client: PostHog | null = null
let environment: TelemetryEnvironment | null = null
/** What was asked for before the SDK arrived; dropped if it never does. */
let waiting: Run[] = []
/** Clerk's user, or null signed out; undefined until Clerk has answered. */
let account: string | null | undefined
/** Super properties registered before the SDK arrived. */
const context: Record<string, unknown> = {}

/** Begin reporting, once, if this page and this visitor do. Idempotent. */
export function startTelemetry(): void {
  if (state !== 'idle') return
  environment = HOST === '' ? null : environmentFor(currentSurroundings(TOKEN))
  if (environment === null) {
    state = 'off'
    waiting = []
    return
  }
  subscribe(TELEMETRY_USAGE, (on) => (on ? resume() : decline()))
  subscribe(TELEMETRY_REPLAY, (on) =>
    withClient((posthog) => replay(posthog, on)),
  )
  if (read(TELEMETRY_USAGE)) load()
  else decline()
}

/** Whether events are being sent, or would be once the SDK arrives. */
export const isReporting = (): boolean =>
  state === 'loading' || state === 'ready'

function load(): void {
  if (environment === null) return
  state = 'loading'
  const env = environment
  void import('posthog-js').then(
    ({ default: posthog }) => {
      if (state !== 'loading') return
      posthog.init(TOKEN, configFor(env, window.location.origin))
      // The switch says yes; an opt-out the SDK persisted earlier must not
      // outvote it. `reset` first, as the SDK asks, so nothing carries over.
      if (posthog.has_opted_out_capturing()) {
        posthog.reset()
        posthog.opt_in_capturing()
      }
      posthog.register({
        environment: env,
        $app_namespace: 'inertialref',
        $app_version: BUILD_ID,
        ...context,
      })
      client = posthog
      state = 'ready'
      const queued = waiting
      waiting = []
      // Identity first, so what was queued before it is attributed to it.
      if (account !== undefined) reconcileAccount(posthog, account)
      for (const run of queued) attempt(run, posthog)
    },
    () => {
      // An unreachable chunk is a page that reports nothing, not an error.
      state = 'off'
      waiting = []
    },
  )
}

/** The visitor turned usage off: stop, forget the anonymous id, drop the queue. */
function decline(): void {
  waiting = []
  if (client !== null) {
    attempt((posthog) => {
      posthog.stopSessionRecording()
      posthog.opt_out_capturing()
      posthog.reset()
    }, client)
  }
  state = 'declined'
}

/** The visitor turned usage back on. A new anonymous id, as after a reset. */
function resume(): void {
  if (state !== 'declined') return
  if (client === null) {
    load()
    return
  }
  state = 'ready'
  attempt((posthog) => {
    posthog.opt_in_capturing()
    if (account !== undefined) reconcileAccount(posthog, account)
    replay(posthog, read(TELEMETRY_REPLAY))
  }, client)
}

function replay(posthog: PostHog, on: boolean): void {
  if (on) posthog.startSessionRecording()
  else posthog.stopSessionRecording()
}

/**
 * The SDK's configuration. Exported so a test can read the decisions rather
 * than trust the comments beside them.
 */
export function configFor(
  env: TelemetryEnvironment,
  origin: string,
): Partial<PostHogConfig> {
  return {
    api_host: `${origin}${RELAY_PATH}`,
    ui_host: uiHostFor(HOST),
    // A pinned date, not `latest`: a defaults change is a behavior change, and
    // it arrives with a reviewed bump of this line rather than with a lockfile.
    defaults: '2026-08-30',
    persistence: 'localStorage',
    person_profiles: 'identified_only',
    respect_dnt: true,

    // `pages/DocumentMeta.tsx` sends each pageview, on a route change and not
    // on a query change: `?at=` moves with the camera and is not a page.
    capture_pageview: false,
    capture_pageleave: true,

    /*
     * Autocapture for the interface, never for the scene. A click on the
     * canvas changes no DOM, so every one would be an event about nothing, and
     * rapid clicking on the sky is play rather than rage. Text a visitor wrote
     * — a picture's label, a search — sits under `ph-sensitive`, which the SDK
     * reads as "capture the click, not the words".
     */
    autocapture: {
      dom_event_allowlist: ['click', 'change', 'submit'],
      css_selector_ignorelist: ['canvas', '.scene-surface'],
      capture_copied_text: false,
    },
    rageclick: { css_selector_ignorelist: ['canvas', '.scene-surface'] },
    capture_dead_clicks: false,
    capture_heatmaps: true,

    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      // Every caught failure is reported where it is caught (`failures.ts`);
      // console errors would report each of them a second time.
      capture_console_errors: false,
    },
    error_tracking: { captureExtensionExceptions: false },

    capture_performance: { web_vitals: true, network_timing: true },

    /*
     * Replay is the visitor's choice, off by default, and records the
     * interface only. A WebGPU canvas reads back inside the frame that drew it
     * and nowhere else, so rrweb's own canvas capture sees a drawn frame or
     * transparent black depending on which loop registered first, and it
     * patches canvas APIs globally to try: off. The sky's label layer writes
     * every label every frame and floats over the black rectangle anyway, so
     * it is blocked rather than recorded as a mutation storm.
     */
    disable_session_recording: !read(TELEMETRY_REPLAY),
    enable_recording_console_log: true,
    session_recording: {
      maskAllInputs: true,
      // Status lines repeat what a press did, and a press on a saved picture
      // names it: "Saved My dog's window."
      maskTextSelector:
        '.ph-sensitive, .ph-sensitive *, [role="status"], [aria-live]',
      blockSelector: '.ph-no-capture, [data-replay-block]',
      captureCanvas: { recordCanvas: false },
      recordHeaders: false,
      recordBody: false,
    },

    // Surveys are drawn by `telemetry/surveys.ts` in this interface's own
    // controls; the SDK supplies the definitions and nothing on screen.
    disable_surveys: false,
    disable_surveys_automatic_display: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,

    logs: {
      serviceName: 'inertialref-web',
      environment: env,
      serviceVersion: BUILD_ID,
    },

    // Same-origin calls carry the session, so a Worker log record and the
    // browser event that caused it share a search.
    tracing_headers: [new URL(origin).hostname],

    before_send: (event: CaptureResult | null) =>
      event === null ? null : sanitizeEvent(event),
  }
}

function attempt(run: Run, posthog: PostHog): void {
  try {
    run(posthog)
  } catch {
    // Measurement never interrupts what it measures.
  }
}

/**
 * Calls held while the SDK loads. Bounded, because a page that never starts
 * telemetry — a test, a mode that mounts before the shell — would otherwise
 * hold every event it asked for until the tab closed.
 */
const MAX_WAITING = 500

function withClient(run: Run): void {
  if (client !== null && state === 'ready') attempt(run, client)
  else if (
    (state === 'idle' || state === 'loading') &&
    waiting.length < MAX_WAITING
  )
    waiting.push(run)
}

/** One product event. Properties are categorical: never what a visitor typed. */
export function recordEvent(event: string, properties?: Properties): void {
  withClient((posthog) => posthog.capture(event, properties))
}

/**
 * A navigation, at the document's canonical path on this page's own origin.
 *
 * Canonical because a docs alias is one document under two addresses, and
 * the router replaces the alias after this has run; on this origin because a
 * preview's pageview belongs to the preview. The campaign keys of the address
 * bar ride along (`sanitize.ts` keeps nothing else). The SDK chains each view
 * to the previous one for duration and scroll depth.
 */
export function recordPageview(path: string, title: string): void {
  withClient((posthog) =>
    posthog.capture('$pageview', {
      title,
      $current_url: cleanUrl(
        `${window.location.origin}${path}${window.location.search}`,
      ),
      $pathname: path,
    }),
  )
}

/**
 * Properties every later event carries: the GPU backend once the renderer
 * has one, the adapter's vendor. Held here until the SDK arrives.
 */
export function registerContext(properties: Record<string, unknown>): void {
  Object.assign(context, properties)
  withClient((posthog) => posthog.register(properties))
}

/**
 * A guide event, straight to the ingest host and never through the relay
 * (above). Batched apart from the rest so a tour's events leave together.
 */
export function recordAiEvent(event: string, properties: Properties): void {
  withClient((posthog) =>
    posthog.capture(event, properties, {
      _url: `${HOST}/e/`,
      _batchKey: 'ai',
    }),
  )
}

const failures = new FailureReporter(
  (report: FailureReport) =>
    withClient((posthog) =>
      posthog.captureException(report.error, { ...report.properties }),
    ),
  (run, ms) => setTimeout(run, ms),
)

/**
 * A failure the page caught. `failures.ts` decides whether it is sent, how it
 * groups, and how many one page may send.
 */
export const reportFailure: FailureReporter['report'] = (
  source,
  cause,
  properties,
) => {
  if (state === 'off' || state === 'declined') return
  failures.report(source, cause, properties)
  for (const listener of failureListeners)
    try {
      listener()
    } catch {
      // As `attempt`: a listener's failure is not the page's.
    }
}

const failureListeners = new Set<() => void>()

/** Told of every reported failure; the log sink sends its context then. */
export function onFailureReported(listener: () => void): () => void {
  failureListeners.add(listener)
  return () => failureListeners.delete(listener)
}

/**
 * A feature flag's value, or `undefined` before the SDK has one — on a first
 * visit, or a page that reports nothing — in which case the caller runs its
 * code default. The SDK applies the last response from its own storage at
 * load and sends the exposure event on read.
 */
export function featureFlag(key: string): string | boolean | undefined {
  if (client === null || state !== 'ready') return undefined
  try {
    return client.getFeatureFlag(key)
  } catch {
    return undefined
  }
}

/** The launched surveys, for `surveys.ts`. Never called on a page that reports nothing. */
export function loadSurveys(run: (surveys: readonly unknown[]) => void): void {
  withClient((posthog) => posthog.getSurveys((found) => run(found)))
}

/**
 * Follow Clerk's answer to "who is signed in".
 *
 * Stored and reconciled rather than forwarded, because the two startups are
 * not ordered: Clerk can answer before the SDK has loaded, and a call made
 * then is the one that matters. Identifying a person is safe because their
 * deletion reaches PostHog too: the Worker's Clerk webhook deletes the person
 * and their events when the account is deleted (`apps/server/src/clerkWebhook.ts`).
 */
export function identifyAccount(userId: string | null): void {
  account = userId
  if (client !== null && state === 'ready')
    attempt((posthog) => reconcileAccount(posthog, userId), client)
}

/** The parts of the SDK identity is reconciled against. */
export type IdentityPort = Pick<
  PostHog,
  'get_distinct_id' | '_isIdentified' | 'identify' | 'reset'
>

/**
 * Make the SDK's persisted identity agree with the account.
 *
 * Against the SDK's own state, not a remembered previous value: a sign-out
 * in another tab, or a session that lapsed between visits, leaves the SDK
 * identified as somebody this page never saw sign in. An account switch
 * resets first, PostHog's documented order, so nothing captured under the
 * previous account's id follows into the next.
 */
export function reconcileAccount(
  posthog: IdentityPort,
  userId: string | null,
): void {
  if (userId !== null && posthog.get_distinct_id() === userId) return
  if (posthog._isIdentified()) posthog.reset()
  if (userId !== null) posthog.identify(userId)
}

/** A structured log record, OTLP to PostHog Logs. Fixed text, categorical attributes. */
export function sendLog(
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
  body: string,
  attributes?: LogAttributes,
): void {
  withClient((posthog) => posthog.logger[level](body, attributes))
}
