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

/** Every event property that holds a URL of this site or of a referrer. */
const URL_PROPERTIES = [
  '$current_url',
  '$referrer',
  '$initial_current_url',
  '$initial_referrer',
  '$prev_pageview_pathname',
] as const

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

function cleanBag(bag: Bag | undefined): void {
  if (bag === undefined) return
  for (const key of URL_PROPERTIES) {
    const value = bag[key]
    if (typeof value === 'string') bag[key] = cleanUrl(value)
  }
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
  cleanBag(event.$set)
  cleanBag(event.$set_once)
  const nested = event.properties?.['$set_once']
  if (typeof nested === 'object' && nested !== null) cleanBag(nested as Bag)
  const nestedSet = event.properties?.['$set']
  if (typeof nestedSet === 'object' && nestedSet !== null)
    cleanBag(nestedSet as Bag)
  return event
}
