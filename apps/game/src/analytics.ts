import { SITE } from './site.ts'

/*
 * Google Analytics, on exactly one hostname.
 *
 * The tag is not in `index.html`, which is where Google's own snippet goes,
 * because the snippet has no condition in it and this needs three:
 *
 *   1. **Production builds only.** A dev server reload every time a file is
 *      saved is not a visit.
 *   2. **The canonical host only.** The same bundle answers on
 *      `inertialrefd.jaquers.workers.dev`, on a Wrangler versions preview URL,
 *      and on `localhost:8787` under `pnpm preview` — all of which are this
 *      build wearing a different name. Measuring them puts the maintainer's own
 *      testing in the numbers that are supposed to describe strangers.
 *   3. **Not against an explicit opt-out.** Global Privacy Control is a signal
 *      a person set on purpose, and honouring it costs a line. Delete the check
 *      if it should not be honoured; do not weaken it into a heuristic.
 *
 * The measurement id is a build-time public variable, `VITE_GA_MEASUREMENT_ID`,
 * and it is deliberately **not in the repository**. This repository is public.
 * The id is not a credential — it ships in the bundle and is visible in every
 * request the tag makes — but an id committed here is an id every fork measures
 * into, and the person who owns the property is not the person who forked it.
 *
 * It is set as a Workers Builds **build variable** in Cloudflare, and in
 * `apps/game/.env.production` (gitignored) for a deploy run from a developer's
 * machine. Vite gives a real environment variable precedence over a file of the
 * same name, so CI wins where both exist. With neither, this is empty and
 * nothing loads — which is the correct behaviour for a fork and needs no code
 * change to get. `apps/game/.env.example` is the committed documentation.
 *
 * `new Date()` in `gtag('js', ...)` is Google's required call shape. It is
 * allowed here for the same reason `vite.config.ts` may read a clock and
 * `packages/*` may not: nothing derived from it enters the simulation.
 * ADR-0006's ban is on canonical code.
 */

const MEASUREMENT_ID: string = import.meta.env.VITE_GA_MEASUREMENT_ID ?? ''

const TAG_SRC = 'https://www.googletagmanager.com/gtag/js'

declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: (...args: unknown[]) => void
  }
}

/**
 * Whether this page is the one deployment that is measured.
 *
 * Exported so a test can state the rule rather than trust the comment above it.
 */
export function isMeasured(
  environment: {
    production: boolean
    hostname: string
    measurementId: string
    optedOut: boolean
  } = {
    production: import.meta.env.PROD,
    hostname: window.location.hostname,
    measurementId: MEASUREMENT_ID,
    optedOut: hasOptedOut(),
  },
): boolean {
  return (
    environment.production &&
    environment.measurementId !== '' &&
    environment.hostname === SITE.host &&
    !environment.optedOut
  )
}

/**
 * Global Privacy Control, and `navigator.doNotTrack` behind it.
 *
 * Neither is in `lib.dom` — GPC is a W3C draft and DNT was removed after
 * browsers stopped sending it — so both are read off widened views rather than
 * declared as if they were standard.
 */
function hasOptedOut(): boolean {
  const gpc = (navigator as Navigator & { globalPrivacyControl?: boolean })
    .globalPrivacyControl
  const dnt = (navigator as Navigator & { doNotTrack?: string | null })
    .doNotTrack
  return gpc === true || dnt === '1'
}

let started = false

/**
 * Load the tag, once.
 *
 * `send_page_view: false` and then an explicit `page_view` per navigation
 * (`recordPageView`). GA4's automatic collection fires on load and — with
 * enhanced measurement on — again on a history change, which for a client-side
 * router means either one view per session or two views per navigation
 * depending on a setting in a web console that this repository cannot see.
 * Sending them by hand is the only version whose behaviour is written down.
 */
export function startAnalytics(): void {
  if (started || !isMeasured()) return
  started = true

  const tag = document.createElement('script')
  tag.async = true
  tag.src = `${TAG_SRC}?id=${encodeURIComponent(MEASUREMENT_ID)}`
  document.head.append(tag)

  window.dataLayer = window.dataLayer ?? []
  window.gtag = function gtag() {
    /*
     * `arguments`, not a rest array, and this is the one line of Google's
     * snippet that must be copied rather than modernised. gtag.js reads each
     * queued entry as an `Arguments` object; a plain array pushed in its place
     * is queued, never processed, and never reported as an error — the tag
     * loads, the network requests never happen, and the property stays empty.
     */
    window.dataLayer?.push(arguments)
  }
  window.gtag('js', new Date())
  window.gtag('config', MEASUREMENT_ID, { send_page_view: false })
}

/** One navigation. Called by `pages/DocumentMeta.tsx`, which already knows both. */
export function recordPageView(location: string, title: string): void {
  window.gtag?.('event', 'page_view', {
    page_location: location,
    page_title: title,
  })
}
