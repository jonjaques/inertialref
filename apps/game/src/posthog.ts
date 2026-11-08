import type { LogAttributes, PostHog, Properties } from 'posthog-js'
import { hasOptedOut, isMeasured } from './analytics.ts'

/*
 * PostHog: product events, identity, unhandled errors, the guide's AI traces
 * and three lifecycle logs.
 *
 * Gated exactly as Google's tag is, by `isMeasured` in `analytics.ts`: a
 * production build, the canonical host, no Global Privacy Control. The reasons
 * are the same — a dev server, a versions preview and `pnpm preview` are this
 * build under another name, and GPC is a signal a person set on purpose. The
 * project token and host are public build variables, `PUBLIC_POSTHOG_*`, kept
 * out of the repository for the reason the GA id is; left unset, nothing
 * loads.
 *
 * The SDK is imported dynamically, after the gate. A static import put its
 * ~120 KB (gzip) in the chunk `runtimeLoader`'s `prepare` awaits, ahead of the
 * App import and the catalog fetch, on every cold visit and in every build
 * that measures nothing. Work asked for while it loads waits for it; nothing
 * waits on it.
 *
 * Every call site goes through this module and never through the SDK, so a
 * page that is not measured costs a function call and a null check.
 */

const PROJECT_TOKEN: string = import.meta.env.PUBLIC_POSTHOG_PROJECT_TOKEN ?? ''
const HOST: string = import.meta.env.PUBLIC_POSTHOG_HOST ?? ''

let client: PostHog | null = null
/** What was asked for while the SDK loads; null when it is not loading. */
let waiting: ((posthog: PostHog) => void)[] | null = null
/** Clerk's user, or null signed out; undefined until Clerk has answered. */
let account: string | null | undefined

/** Load and initialize the SDK, once, if this page is measured. */
export function startPostHog(): void {
  if (client !== null || waiting !== null) return
  const measured =
    HOST !== '' &&
    isMeasured({
      production: import.meta.env.PROD,
      hostname: window.location.hostname,
      measurementId: PROJECT_TOKEN,
      optedOut: hasOptedOut(),
    })
  if (!measured) return
  waiting = []
  void import('posthog-js').then(
    ({ default: posthog }) => {
      posthog.init(PROJECT_TOKEN, {
        api_host: HOST,
        defaults: '2026-01-30',
        logs: {
          serviceName: 'inertialref-game-web',
          environment: 'production',
        },
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
      })
      client = posthog
      const queued = waiting ?? []
      waiting = null
      // Identity first, so what was queued before it is attributed to it.
      if (account !== undefined) reconcileAccount(posthog, account)
      for (const run of queued) attempt(run, posthog)
    },
    () => {
      // An unreachable chunk is a page that measures nothing, not an error.
      waiting = null
    },
  )
}

function attempt(run: (posthog: PostHog) => void, posthog: PostHog): void {
  try {
    run(posthog)
  } catch {
    // Measurement never interrupts what it measures.
  }
}

function withClient(run: (posthog: PostHog) => void): void {
  if (client === null) waiting?.push(run)
  else attempt(run, client)
}

/** One product event. Properties are categorical: never what a visitor typed. */
export function recordEvent(event: string, properties?: Properties): void {
  withClient((posthog) => posthog.capture(event, properties))
}

/**
 * Follow Clerk's answer to "who is signed in".
 *
 * Stored and reconciled rather than forwarded, because the two startups are
 * not ordered: Clerk can answer before the SDK has loaded, and a call made
 * then is the one that matters.
 */
export function identifyAccount(userId: string | null): void {
  account = userId
  if (client !== null)
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

/** Lifecycle records, fixed text and categorical attributes only. */
export const posthogLog = {
  clientStarted(timingLevel: string): void {
    log('info', 'game client services started', { timing_level: timingLevel })
  },

  interactiveRuntimeLoaded(): void {
    log('info', 'interactive runtime loaded')
  },

  interactiveRuntimeFailed(): void {
    log('warn', 'interactive runtime failed to load')
  },
}

function log(
  level: 'info' | 'warn',
  body: string,
  attributes?: LogAttributes,
): void {
  withClient((posthog) => posthog.logger[level](body, attributes))
}
