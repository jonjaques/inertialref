import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldMatch, WorldQuery } from '@inertialref/universe'
import type { GameEngine } from '../engine/GameEngine.ts'

/*
 * A sweep of the volume, as something React can draw while it runs.
 *
 * The harness owns the fan-out — it holds the pool and the catalog, and the
 * console gets the same verb — so this is the subscription rather than the
 * search: it holds the rows found so far, how far along the sweep is, and the
 * one cancel that a second question has to call before it asks.
 *
 * **Results are appended, never replaced.** A batch answering is not a new
 * answer, it is more of the same one, and a hook that swapped the array on
 * each batch would make the list flash through eight partial states on the way
 * to one. The array identity changes, which is what React needs; the rows in
 * it only ever grow until a new search clears them.
 *
 * **And they are sorted here, by distance.** The sweep is dispatched nearest
 * first, but eight workers do not finish in the order they were given — so
 * arrival order is a race, and a list in it opens with whichever batch was
 * quickest. That is the ordering `travel.ts` already argues about: a query's
 * result is sorted for purity where it is produced and for a reader where it
 * is drawn, and this is where it is drawn.
 */

export interface WorldSearch {
  /** The nearest matches, sorted. Capped — see `total`. */
  readonly matches: readonly WorldMatch[]
  /** How many were found in all, which is more than `matches` once capped. */
  readonly total: number
  /** 0 before the first batch answers, 1 when the sweep is done. */
  readonly progress: number
  /** How many systems the sweep is walking. */
  readonly systems: number
  readonly running: boolean
  /** Null until a search has been run, so "no results" is distinguishable. */
  readonly asked: WorldQuery | null
  readonly run: (query: WorldQuery, lightYears: number) => void
  readonly stop: () => void
}

const IDLE = {
  matches: [] as readonly WorldMatch[],
  total: 0,
  progress: 0,
  systems: 0,
  running: false,
  asked: null as WorldQuery | null,
}

export function useWorldSearch(engine: GameEngine): WorldSearch {
  const [state, setState] = useState(IDLE)
  /** The sweep in flight. Cancelled by the next one, and by unmounting. */
  const live = useRef<{ cancel: () => void } | null>(null)

  const stop = useCallback(() => {
    live.current?.cancel()
    live.current = null
    setState((held) => (held.running ? { ...held, running: false } : held))
  }, [])

  // A sweep that outlived its panel is worker time nobody will read. The
  // pool has no idea the dialog closed; this is what tells it.
  useEffect(() => () => live.current?.cancel(), [])

  const run = useCallback(
    (query: WorldQuery, lightYears: number) => {
      live.current?.cancel()
      const search = engine.harness.findWorlds(query, {
        lightYears,
        onBatch: (found, progress, total) => {
          // The identity check is the guard against a cancelled sweep writing
          // over the one that replaced it: `cancel` drops the reference, and a
          // batch already in flight lands here afterwards.
          if (live.current !== handle) return
          setState((held) => ({
            ...held,
            // A fresh sort per batch rather than an insertion into a held
            // array: the batch is already sorted internally and the whole is
            // nearly sorted, which is the case a merge sort is fastest on, and
            // it keeps the accumulated array immutable for React. Bounded by
            // the harness's cap, which is what makes it affordable.
            matches: [...found].sort((a, b) => a.lightYears - b.lightYears),
            total,
            progress,
          }))
        },
      })
      const handle = { cancel: search.cancel }
      live.current = handle
      setState({
        matches: [],
        total: 0,
        progress: 0,
        systems: search.systems,
        running: search.systems > 0,
        asked: query,
      })
      void search.done.then(() => {
        if (live.current !== handle) return
        live.current = null
        setState((held) => ({ ...held, running: false, progress: 1 }))
      })
    },
    [engine],
  )

  return { ...state, run, stop }
}
