const KEY = 'ir.graphics-session'

/**
 * How long a session has to run before its next unclean end is forgiven.
 *
 * A crash loop is a document that dies during or just after boot, again and
 * again. A document that has drawn for a minute and then vanishes without
 * `pagehide` is a tab Chrome discarded under memory pressure, a laptop that
 * slept, a hung page the person killed from the "unresponsive" bar — none of
 * them a reason to stop the next one from starting.
 */
export const SETTLED_MS = 60_000

/**
 * Unclean ends in a row, none of them settled, before graphics stop.
 *
 * One is forgiven: a tab discard, a kill, a reload of a hung page all end
 * without `pagehide`, and a guard that stopped graphics on the first of them
 * met the developer's routine — hang, reload — with a notice and a button on
 * every reload. Two in a row is the loop the guard exists for.
 */
export const STRIKES = 2

/**
 * A tab crash skips `pagehide`, and its replacement must not repeat GPU
 * startup forever.
 *
 * The marker is the count of consecutive unclean ends. It is written at
 * startup, reset to zero once the session has settled, and removed on an
 * orderly `pagehide`; a replacement that finds it has one more strike than
 * it says. Session storage, so it is tab-scoped and a crash in one tab bans
 * nothing in another; and a count rather than a flag, so a single bad end is
 * a fact recorded and not a sentence served.
 */
export function createGraphicsSession(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  settle: (run: () => void) => void = (run) => {
    setTimeout(run, SETTLED_MS)
  },
) {
  const read = (): number | null => {
    const raw = storage.getItem(KEY)
    if (raw === null) return null
    const strikes = Number.parseInt(raw, 10)
    // A marker this build did not write is a session that ended unclean and
    // nothing more: one strike, the same as any other.
    return Number.isFinite(strikes) ? strikes : 0
  }
  const write = (strikes: number): void => {
    try {
      storage.setItem(KEY, String(strikes))
    } catch {
      // Storage can be disabled independently of graphics support.
    }
  }
  return {
    begin(): boolean {
      let prior: number | null = null
      try {
        prior = read()
      } catch {
        // Storage can be disabled independently of graphics support.
      }
      const strikes = prior === null ? 0 : prior + 1
      // Left in place, so every reload is refused until an explicit retry
      // clears it: the loop is bounded here, not merely delayed.
      if (strikes >= STRIKES) return false
      write(strikes)
      settle(() => write(0))
      return true
    },
    end(): void {
      try {
        storage.removeItem(KEY)
      } catch {
        // The readable shell does not depend on browser storage.
      }
    },
  }
}

let session: ReturnType<typeof createGraphicsSession> | null = null

export function beginGraphicsSession(): boolean {
  try {
    session = createGraphicsSession(window.sessionStorage)
  } catch {
    return true
  }
  if (!session.begin()) return false
  window.addEventListener('pagehide', () => session?.end())
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) session?.begin()
  })
  return true
}

export function allowGraphicsRetry(): void {
  session?.end()
}
