const KEY = 'ir.graphics-session'

/** A tab crash skips pagehide. Its replacement must not repeat GPU startup. */
export function createGraphicsSession(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
) {
  return {
    begin(): boolean {
      try {
        if (storage.getItem(KEY) !== null) return false
        storage.setItem(KEY, 'active')
      } catch {
        // Storage can be disabled independently of graphics support.
      }
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
