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

export function useManifest(
  initial: DocManifest | undefined,
  enabled: boolean,
): Loaded<DocManifest> {
  const [state, setState] = useState<Loaded<DocManifest>>(() =>
    initial === undefined
      ? nothing(enabled)
      : { value: initial, error: null, pending: false },
  )

  useEffect(() => {
    if (!enabled || initial !== undefined) return
    let live = true
    setState(nothing(true))
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
  }, [enabled, initial])

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
  initial: DocPage | null | undefined,
): Loaded<DocPage> {
  const seeded = initial?.route === route ? initial : null
  const [state, setState] = useState<Loaded<DocPage>>(() =>
    seeded === null
      ? nothing(manifest === null || manifest.pages[route] !== undefined)
      : { value: seeded, error: null, pending: false },
  )
  const entry = manifest?.pages[route]

  useEffect(() => {
    if (seeded !== null) return
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
  }, [entry, manifest, seeded])

  // The response's page stays available when a reader goes back to it. A
  // pending request for another route cannot replace those server-rendered words.
  if (seeded !== null) return { value: seeded, error: null, pending: false }
  if (state.value !== null && state.value.route !== route)
    return nothing(manifest === null || entry !== undefined)
  return state
}

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))
