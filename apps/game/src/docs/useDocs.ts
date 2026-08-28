import { useEffect, useState } from 'react'
import {
  type DocManifest,
  type DocPage,
  loadManifest,
  loadPage,
} from './content.ts'

/*
 * The two fetches the reading room makes, as hooks.
 *
 * Deliberately hand-written rather than a data library: there are two requests
 * in this whole section, both are `GET`s of static JSON, both are cached by the
 * module that fetches them, and neither is ever refetched or invalidated. What
 * a library would add here is a cache in front of a cache.
 *
 * The one thing they do have to get right is **the stale response**. A reader
 * clicking down a rail changes the route faster than the network answers, and
 * without the generation check below the third page can arrive after the fourth
 * and replace it. `live` rather than an `AbortController` because the request
 * is worth completing — it populates the module cache, so going back is
 * instant — and only its *result* is stale.
 */

export interface Loaded<T> {
  readonly value: T | null
  readonly error: Error | null
  readonly pending: boolean
}

const nothing = <T>(pending: boolean): Loaded<T> => ({
  value: null,
  error: null,
  pending,
})

export function useManifest(): Loaded<DocManifest> {
  const [state, setState] = useState<Loaded<DocManifest>>(() => nothing(true))

  useEffect(() => {
    let live = true
    loadManifest().then(
      (value) => {
        if (live) setState({ value, error: null, pending: false })
      },
      (cause: unknown) => {
        if (live)
          setState({ value: null, error: asError(cause), pending: false })
      },
    )
    return () => {
      live = false
    }
  }, [])

  return state
}

/**
 * One page's body, for a route the manifest knows.
 *
 * `null` for `manifest` or an unknown route is a legitimate state rather than
 * an error — the manifest is still in flight, or the reader followed a link to
 * a page that no longer exists — and the article draws each of those
 * differently, so neither is thrown.
 */
export function usePage(
  manifest: DocManifest | null,
  route: string,
): Loaded<DocPage> {
  const [state, setState] = useState<Loaded<DocPage>>(() => nothing(true))
  const entry = manifest?.pages[route]

  useEffect(() => {
    if (entry === undefined) {
      setState(nothing(manifest === null))
      return
    }
    let live = true
    setState(nothing(true))
    loadPage(entry).then(
      (value) => {
        if (live) setState({ value, error: null, pending: false })
      },
      (cause: unknown) => {
        if (live)
          setState({ value: null, error: asError(cause), pending: false })
      },
    )
    return () => {
      live = false
    }
  }, [entry, manifest])

  return state
}

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))
