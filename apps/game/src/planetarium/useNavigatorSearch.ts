import { useEffect, useRef, useState } from 'react'
import uFuzzy from '@leeoniya/ufuzzy'
import type { SearchEntry, TravelTarget } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { Highlight } from './navigator.ts'

/*
 * What was typed, as rows — with a typo, out of order, or half a name.
 *
 * The catalog's own `search` is exact, then prefix, then substring over
 * normalized keys, and it answers in a quarter of a millisecond. That is right
 * for a console and short of what a search box owes a person: `proxmia` finds
 * nothing, `centauri alpha` finds nothing, and `europa` finds nothing because
 * the index is stars. This ranks instead, over every designation the catalog
 * holds and every body the world has generated, and it lights the characters
 * that matched so the reader can see *why* a row answered.
 *
 * `uFuzzy` does the matching. It is built for exactly this — a short needle
 * against tens of thousands of short strings, per keystroke, with the errors a
 * typing hand makes — and it returns ranges rather than markup, which is what
 * lets the row draw them without `innerHTML`. It lives here, in the client,
 * because `packages/*` may carry no third-party dependency; the harness hands
 * the names out (`searchEntries`) and takes the addresses back (`rowsFor`),
 * and the matcher never sees a world.
 *
 * The index is rebuilt only when `searchIndexVersion` changes — the catalog is
 * a value, and the loaded set moves at the rate the camera crosses systems —
 * because building 24,000 strings on every keystroke would cost more than the
 * search.
 */

/**
 * One error per term: an inserted, substituted, transposed or dropped
 * character. `intraMode: 1` is the setting the library documents for a
 * typeahead; the default mode admits any number of gaps inside a term, which
 * ranks `Rigel` for `rl` and fills the list with noise on two letters.
 */
const MATCHER = new uFuzzy({
  intraMode: 1,
  intraIns: 1,
  intraSub: 1,
  intraTrn: 1,
  intraDel: 1,
})

/** How many rows a search shows. Past this a reader types another letter. */
const LIMIT = 40

/**
 * How many raw matches the ranker is willing to score.
 *
 * One letter matches thousands of designations, and scoring every one of them
 * is what makes a first keystroke stutter. Above this the library returns the
 * unranked matches and the list shows the first `LIMIT` of them — which is
 * the honest answer for a one-letter query anyway.
 */
const RANK_LIMIT = 4_000

export interface NavigatorSearch {
  readonly rows: readonly TravelTarget[]
  /** By address: which designation matched, and where. */
  readonly highlights: ReadonlyMap<string, Highlight>
  /** Whether an answer has arrived for the current query. */
  readonly ready: boolean
}

const NOTHING: NavigatorSearch = {
  rows: [],
  highlights: new Map(),
  ready: false,
}

interface Index {
  readonly version: string
  readonly entries: readonly SearchEntry[]
  /** Mutable only because the library's signature says so; nothing writes it. */
  readonly haystack: string[]
}

export function useNavigatorSearch(
  engine: GameEngine,
  query: string,
  options: { readonly origin?: 'player' | 'observer' } = {},
): NavigatorSearch {
  const needle = query.trim()
  const origin = options.origin
  const index = useRef<Index | null>(null)
  const [result, setResult] = useState<NavigatorSearch>(NOTHING)

  useEffect(() => {
    if (needle === '') {
      setResult(NOTHING)
      return
    }
    const harness = engine.harness
    const version = harness.searchIndexVersion()
    let held = index.current
    if (held === null || held.version !== version) {
      const entries = harness.searchEntries()
      held = { version, entries, haystack: entries.map((entry) => entry.text) }
      index.current = held
    }

    const from = origin === undefined ? {} : { origin }
    /*
     * A typed address first, whatever the ranker thinks. `s:SOL/b:2` matches
     * no designation — the normalizer strips the punctuation that makes it an
     * address — and the placeholder promises an address works. `rowsFor`
     * answers with the one row or none.
     */
    const exact = harness.rowsFor([needle], from)
    const addresses: string[] = exact.map((row) => row.address)
    const highlights = new Map<string, Highlight>()

    const [idxs, info, order] = MATCHER.search(
      held.haystack,
      needle,
      // Out of order, for up to five terms — the library's own ceiling.
      // `centauri alpha` is a query a person types, and refusing it is a
      // refusal they cannot see the reason for.
      5,
      RANK_LIMIT,
    )
    const take = (
      haystackIndex: number,
      ranges: readonly number[],
    ): boolean => {
      const entry = held.entries[haystackIndex]
      if (entry === undefined || highlights.has(entry.address)) return false
      highlights.set(entry.address, { text: entry.text, ranges })
      if (!addresses.includes(entry.address)) addresses.push(entry.address)
      return addresses.length >= LIMIT
    }
    if (info !== null && order !== null) {
      for (const at of order) {
        const haystackIndex = info.idx[at]
        if (haystackIndex === undefined) continue
        if (take(haystackIndex, info.ranges[at] ?? [])) break
      }
    } else if (idxs !== null) {
      // Too many to rank. Unlit, because there is nothing to say which part
      // of a thousand answers was the answer.
      for (const haystackIndex of idxs) if (take(haystackIndex, [])) break
    }

    const rows = harness.rowsFor(addresses, from)
    // A row the exact resolver produced needs no highlight; one the ranker
    // produced that the resolver could not draw — a body of a system that has
    // since unloaded — is dropped by `rowsFor` and its highlight is moot.
    setResult({ rows, highlights, ready: true })
  }, [engine, needle, origin])

  return result
}
