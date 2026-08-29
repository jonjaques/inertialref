import { useEffect, useState } from 'react'
import type { TravelTarget } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'

/*
 * Where can I go — asked once, by the one panel that asks it.
 *
 * Two panels owned a copy of this: a poll, a try/catch, a "has the survey
 * completed once" flag and a filter each, and they had drifted to two radii and
 * two rates, with only one of them distinguishing "surveying…" from "there is
 * nothing here". Both filtered the survey's *result* with `.includes()`, which
 * made a search box a search of a few light years rather than of the catalog.
 *
 * There is one panel now — `planetarium/CataloguePanel.tsx`, drawn in the
 * planetarium and in flight with a verb that depends on the mode — and this
 * hook is still separate from it, because the survey is a question about the
 * sky rather than about a component.
 *
 * The interface splits by question, which is what `StarCatalog.search` and
 * `travelTargets` now are:
 *
 *   - **empty query** → the survey. A star sweep, at 1 Hz, because it depends
 *     on where you are and that changes as you fly.
 *   - **a query** → the index, over the whole 150 light-year catalog, on the
 *     keystroke. Measured at 0.14–0.30 ms; the sweep is not in that league and
 *     never could be.
 *
 * The poll stays a poll rather than joining the engine snapshot, and
 * deliberately: a survey is a star sweep, not a field read, and sampling two of
 * them eight times a second is the cost the snapshot exists to avoid.
 */

export interface TravelListing {
  readonly rows: readonly TravelTarget[]
  /**
   * Whether an answer has arrived at least once.
   *
   * "surveying…" and "there is nothing here" are different answers, and the
   * panels used to give the first for both — so flying out past the survey
   * radius produced a list that looked permanently mid-load. Only one of the
   * two has a next step, and it was the one being hidden.
   */
  readonly ready: boolean
  /** Why the last read failed, or null. */
  readonly failure: string | null
}

export interface TravelListingOptions {
  readonly lightYears: number
  readonly origin?: 'player' | 'observer'
  /** What was typed. Empty means "show me what is near", not "match nothing". */
  readonly query: string
  /** How often the survey re-reads distances. A sweep is not free. */
  readonly refreshMs?: number
  /** Bumped by a caller's action, so the listing refreshes on the spot. */
  readonly generation?: number
}

export function useTravelTargets(
  engine: GameEngine,
  options: TravelListingOptions,
): TravelListing {
  const {
    lightYears,
    origin,
    query,
    refreshMs = 1_000,
    generation = 0,
  } = options
  const [listing, setListing] = useState<TravelListing>({
    rows: [],
    ready: false,
    failure: null,
  })
  const needle = query.trim()

  useEffect(() => {
    const read = (): void => {
      try {
        const rows =
          needle === ''
            ? engine.harness.targets({
                lightYears,
                ...(origin === undefined ? {} : { origin }),
              })
            : engine.harness.search(needle, {
                ...(origin === undefined ? {} : { origin }),
              })
        setListing({ rows, ready: true, failure: null })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        // Identical state bails out of the re-render, so a failure that keeps
        // happening is free — every second, forever, with nothing new to say.
        setListing((current) =>
          current.failure === message
            ? current
            : { ...current, failure: message },
        )
      }
    }
    read()
    // A search is answered from an index and does not go stale as you fly; only
    // the survey's distances do. Polling a query would re-run it every second
    // to produce the identical rows.
    if (needle !== '') return
    const timer = window.setInterval(read, refreshMs)
    return () => window.clearInterval(timer)
  }, [engine, lightYears, origin, needle, refreshMs, generation])

  return listing
}
