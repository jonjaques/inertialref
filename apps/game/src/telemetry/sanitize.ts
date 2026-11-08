/*
 * What leaves the page in a URL.
 *
 * The SDK copies `location.href` into `$current_url` on every event and into
 * the person's `$initial_current_url`, and a URL here carries what a visitor
 * made: a shared picture link holds its typed label, `?at=` holds where they
 * were looking, a cinema link holds a frame. None of that is analytics, and a
 * query string is where personal text ends up when nobody is watching for it.
 * So every URL is cut to its origin and path, and the only query parameters
 * kept are the campaign keys web analytics derives its channels from.
 *
 * The hash goes too: posthog-js keeps it unless told otherwise, and Clerk's
 * sign-in callback puts a token-shaped fragment there.
 */

/** The parameters PostHog's channel attribution reads. Spelled without `$`. */
const CAMPAIGN_KEYS: ReadonlySet<string> = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'gad_source',
  'fbclid',
  'msclkid',
  'twclid',
  'li_fat_id',
  'ref',
])

/**
 * Every event property that holds a URL of this site or of a referrer. The
 * session-entry pair is the address the session began at, which the SDK puts
 * on every event of the session: a visit that began on a shared picture link
 * would otherwise carry its label to the last click.
 */
const URL_PROPERTIES = [
  '$current_url',
  '$referrer',
  '$initial_current_url',
  '$initial_referrer',
  '$prev_pageview_pathname',
  '$session_entry_url',
  '$session_entry_referrer',
] as const

/** The URLs inside each web vital's own record, `$web_vitals_<name>_event`. */
const VITAL_URL_PROPERTIES = ['$current_url', 'navigationURL'] as const

/** A URL with its campaign keys and nothing else after the path. */
export function cleanUrl(href: string): string {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    // `$direct`, a bare path, or something that is not a URL at all.
    return href
  }
  const kept = new URLSearchParams()
  for (const [key, value] of url.searchParams)
    if (CAMPAIGN_KEYS.has(key.toLowerCase())) kept.append(key, value)
  const query = kept.toString()
  return `${url.origin}${url.pathname}${query === '' ? '' : `?${query}`}`
}

type Bag = Record<string, unknown>

function cleanKeys(bag: Bag, keys: readonly string[]): void {
  for (const key of keys) {
    const value = bag[key]
    if (typeof value === 'string') bag[key] = cleanUrl(value)
  }
}

function cleanBag(bag: Bag | undefined): void {
  if (bag === undefined) return
  cleanKeys(bag, URL_PROPERTIES)
}

const isBag = (value: unknown): value is Bag =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/*
 * The two SDK events that carry a URL below the top level: each web vital's
 * record, and the heatmap batch, which is keyed by `location.href` itself.
 * Keys that clean to one address merge, so the points stay on their page.
 */
function cleanNested(properties: Bag | undefined): void {
  if (properties === undefined) return
  for (const [key, value] of Object.entries(properties))
    if (
      key.startsWith('$web_vitals_') &&
      key.endsWith('_event') &&
      isBag(value)
    )
      cleanKeys(value, VITAL_URL_PROPERTIES)
  const heatmap = properties['$heatmap_data']
  if (!isBag(heatmap)) return
  const byPage: Bag = {}
  for (const [href, points] of Object.entries(heatmap)) {
    const page = cleanUrl(href)
    const held = byPage[page]
    byPage[page] =
      Array.isArray(held) && Array.isArray(points)
        ? [...(held as unknown[]), ...(points as unknown[])]
        : points
  }
  properties['$heatmap_data'] = byPage
}

/** The part of a captured event `before_send` is handed that this edits. */
export interface CapturedShape {
  properties?: Bag
  $set?: Bag
  $set_once?: Bag
}

/**
 * Clean an event in place and hand it back. In place because the SDK passes
 * the object it is about to send, and a copy would cost an allocation per
 * event for nothing.
 */
export function sanitizeEvent<T extends CapturedShape>(event: T): T {
  cleanBag(event.properties)
  cleanNested(event.properties)
  cleanBag(event.$set)
  cleanBag(event.$set_once)
  const nested = event.properties?.['$set_once']
  if (typeof nested === 'object' && nested !== null) cleanBag(nested as Bag)
  const nestedSet = event.properties?.['$set']
  if (typeof nestedSet === 'object' && nestedSet !== null)
    cleanBag(nestedSet as Bag)
  return event
}
