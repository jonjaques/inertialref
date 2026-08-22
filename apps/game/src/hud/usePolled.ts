import { useEffect, useRef, useState } from 'react'

/**
 * Poll a value off the engine at a human rate.
 *
 * The dock's own arrangement, and the reason it is a poll rather than a
 * subscription: the harness is not an observable and deliberately is not one —
 * `AGENTS.md` keeps canonical state out of React entirely, so a panel *asks*
 * rather than being told. Six times a second is faster than anyone reads.
 *
 * `read` is intentionally not a dependency. It closes over the engine, which is
 * a session-long singleton, so the closure differs every render while the thing
 * it reads never does; listing it would tear down and restart the interval on
 * every tick of the interval it started.
 */
export function usePolled<T>(read: () => T, hz = 6): T {
  const [value, setValue] = useState(read)
  const latest = useRef(read)
  latest.current = read
  useEffect(() => {
    const timer = window.setInterval(
      () => setValue(() => latest.current()),
      1000 / hz,
    )
    return () => window.clearInterval(timer)
  }, [hz])
  return value
}
