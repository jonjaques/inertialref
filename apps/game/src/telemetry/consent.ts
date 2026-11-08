import { SITE } from '../site.ts'

/*
 * Whether this page reports to PostHog at all, and as which environment.
 *
 * Four conditions, each for a reason the obvious version gets wrong:
 *
 *   1. **A production build with a project token.** A dev server reload every
 *      time a file is saved is not a visit, and the token is a build variable
 *      kept out of this public repository (`apps/game/.env.example`), so a
 *      fork's build has none and reports nothing without a code change.
 *   2. **A host that is a deployment.** `inertialref.app` is production; a
 *      Workers preview answers on `*.workers.dev` and reports as `preview`,
 *      which the project's test-account filter keeps out of the dashboards
 *      while its errors stay searchable. Anything else — `localhost` under
 *      `pnpm preview`, a LAN address, the legacy host — is this build wearing
 *      another name and reports nothing.
 *   3. **Not against an explicit opt-out.** Global Privacy Control and Do Not
 *      Track are signals a person set on purpose; they override every switch
 *      on the settings page.
 *   4. **Not a driven browser.** `navigator.webdriver` is true under the rig,
 *      Playwright and every crawler that admits it, and a measurement run that
 *      lands in the visitor numbers is a measurement of ourselves.
 *
 * The visitor's own switch (`TELEMETRY_USAGE`) is the fifth condition, and it
 * is applied by `posthog.ts` rather than here because it can change while the
 * page is open.
 */

export type TelemetryEnvironment = 'production' | 'preview'

export interface Surroundings {
  readonly production: boolean
  readonly token: string
  readonly hostname: string
  readonly optedOut: boolean
  readonly automated: boolean
}

/** The environment this page reports as, or null for a page that reports nothing. */
export function environmentFor(
  surroundings: Surroundings,
): TelemetryEnvironment | null {
  if (!surroundings.production || surroundings.token === '') return null
  if (surroundings.optedOut || surroundings.automated) return null
  if (surroundings.hostname === SITE.host) return 'production'
  if (surroundings.hostname.endsWith('.workers.dev')) return 'preview'
  return null
}

/**
 * Global Privacy Control, and `navigator.doNotTrack` behind it.
 *
 * Neither is in `lib.dom` — GPC is a W3C draft and DNT was removed after
 * browsers stopped sending it — so both are read off widened views rather
 * than declared as if they were standard.
 */
export function hasOptedOut(): boolean {
  const gpc = (navigator as Navigator & { globalPrivacyControl?: boolean })
    .globalPrivacyControl
  const dnt = (navigator as Navigator & { doNotTrack?: string | null })
    .doNotTrack
  return gpc === true || dnt === '1'
}

/** This page's answer, read off the browser it is running in. */
export function currentSurroundings(token: string): Surroundings {
  return {
    production: import.meta.env.PROD,
    token,
    hostname: window.location.hostname,
    optedOut: hasOptedOut(),
    automated: navigator.webdriver,
  }
}
