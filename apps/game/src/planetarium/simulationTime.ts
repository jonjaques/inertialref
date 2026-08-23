import { instantMillis } from '@inertialref/shared'

/*
 * The simulated instant, in the reader's own time zone.
 *
 * The mapping from simulation seconds to a real instant lives in
 * `@inertialref/shared` because it is a fact about the ephemeris — every orbit
 * is solved from J2000 elements at `epoch: 0`. The *formatting* lives here
 * because a time zone is a property of whoever is looking, which is the one
 * thing a package with no DOM and no host has no business deciding.
 *
 * Local rather than UTC, deliberately. A planetarium's clock answers "when am I
 * looking at" and the only calendar a person can check that against without
 * arithmetic is their own. UTC stays reachable as the `title` on the readout,
 * for the case where the answer has to be compared against an ephemeris.
 */

/**
 * `Intl` formatters are expensive to build and immutable once built, so the two
 * are made once at module scope rather than per poll — this panel repaints at
 * 8 Hz and would otherwise construct sixteen of them a second.
 *
 * Built lazily through a getter rather than eagerly, because module evaluation
 * happens in the Node test run too, and a formatter constructed against
 * whatever locale CI happens to have is a dependency nobody declared.
 */
let cached: {
  readonly date: Intl.DateTimeFormat
  readonly time: Intl.DateTimeFormat
  readonly zone: string
} | null = null

function formatters(): NonNullable<typeof cached> {
  cached ??= {
    // `1 Jan 2000` — a short month name rather than a numeric one, because
    // 01/02 means two different days on two sides of an ocean and this readout
    // has no room to say which convention it is using.
    date: new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
    // Seconds included: at 1× this is the only part that moves, and a clock
    // that never changes is a clock the reader stops believing.
    time: new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }),
    zone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
  return cached
}

/** The reader's IANA zone, e.g. `Europe/London`. Named under the readout. */
export const localZone = (): string => formatters().zone

/** The simulated instant as a date and a time, already localised. */
export function simulationInstant(seconds: number): {
  readonly date: string
  readonly time: string
  /** The same instant in UTC, for the `title` — an ephemeris speaks UTC. */
  readonly utc: string
} {
  const at = new Date(instantMillis(seconds))
  const { date, time } = formatters()
  return {
    date: date.format(at),
    time: time.format(at),
    utc: `${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
  }
}
