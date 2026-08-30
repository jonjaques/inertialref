import { useEffect, useState } from 'react'
import { type DocManifest, loadManifest } from './content.ts'

/*
 * The manifest fetch, as a hook.
 *
 * The article is already in the document. The rail, the breadcrumb and the
 * previous/next pair need the rest of the section, and that is one `GET` of
 * static JSON, cached by the module that fetches it, never refetched. What
 * a library would add here is a cache in front of a cache.
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

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))
