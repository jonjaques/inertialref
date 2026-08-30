import { useSyncExternalStore } from 'react'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { HOME, isOverlayPath } from './paths.ts'

/*
 * Dialogs over a mode, as a store over `history`.
 *
 * A cold load of `/settings/camera` is an Astro page — the dialog over the
 * menu, because there is no session behind a fresh tab. A warm open from a
 * mode is the chrome island's own dialog, with `history.pushState`, so the
 * planetarium stays mounted and the observatory keeps its target. The
 * address bar names the dialog either way; the mode is the document, or the
 * stored background when the document is still the mode and the URL is not.
 *
 * Overlay hops — a settings tab, the sign-in/sign-up cross-link — replace
 * rather than push, so Back leaves the dialog instead of walking its
 * sections. Closing a warm overlay replaces back to the mode. Closing a
 * cold one assigns `/`, because replaceState would leave the dialog's
 * document in place with a menu URL on it.
 */

export interface PageLocation {
  readonly pathname: string
  readonly search: string
  readonly hash: string
}

export function hrefOf(at: PageLocation): string {
  return `${at.pathname}${at.search}${at.hash}`
}

export function locationOf(href: string): PageLocation {
  const url = new URL(href, 'https://inertialref.invalid')
  return {
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  }
}

export interface LocationPort {
  pathname: string
  search: string
  hash: string
}

export function readLocation(source: LocationPort): PageLocation {
  return {
    pathname: source.pathname,
    search: source.search,
    hash: source.hash,
  }
}

/** The address bar: the dialog when one is open, otherwise the mode. */
export function displayOf(state: OverlaySnapshot): PageLocation {
  return state.overlay === null ? state.mode : locationOf(state.overlay)
}

export interface OverlaySnapshot {
  /** Dialog href, or `null` when no dialog is open. */
  readonly overlay: string | null
  /** The mode underneath. Menu on a cold overlay. */
  readonly mode: PageLocation
  /**
   * Whether the document is still the mode.
   *
   * True after `open` from a running mode (pushState). False on a cold
   * load, where the document *is* the dialog.
   */
  readonly warm: boolean
}

export interface HistoryPort {
  pushState(data: unknown, unused: string, url: string): void
  replaceState(data: unknown, unused: string, url: string): void
}

export interface OverlayPorts {
  readonly history: HistoryPort
  readonly location: LocationPort
  /** Load a different document. Cold-overlay close is this. */
  assign(url: string): void
  onPop(run: () => void): () => void
}

export interface OverlayApi {
  open(href: string): void
  hop(href: string): void
  close(): void
  replaceMode(href: string): void
  setModeSearch(search: string): void
  setModeHash(hash: string): void
  rehydrate(href: string): void
  rebind(ports: OverlayPorts): void
}

export type OverlayStore = StoreApi<OverlaySnapshot & OverlayApi>

const MENU: PageLocation = { pathname: HOME, search: '', hash: '' }

const noopPorts = (): OverlayPorts => {
  const location: PageLocation = { pathname: HOME, search: '', hash: '' }
  return {
    history: { pushState() {}, replaceState() {} },
    location,
    assign() {},
    onPop: () => () => {},
  }
}

export function browserPorts(): OverlayPorts {
  return {
    history: window.history,
    location: window.location,
    assign: (url) => window.location.assign(url),
    onPop: (run) => {
      window.addEventListener('popstate', run)
      return () => window.removeEventListener('popstate', run)
    },
  }
}

function snapshotFrom(href: string): OverlaySnapshot {
  const at = locationOf(href)
  if (isOverlayPath(at.pathname)) {
    return { overlay: hrefOf(at), mode: MENU, warm: false }
  }
  return { overlay: null, mode: at, warm: false }
}

export function createOverlayStore(initial: OverlayPorts): OverlayStore {
  let ports = initial
  let unlisten = (): void => {}

  const store = createStore<OverlaySnapshot & OverlayApi>((set, get) => {
    const syncFromWindow = (): void => {
      const at = readLocation(ports.location)
      if (isOverlayPath(at.pathname)) {
        set({ overlay: hrefOf(at) })
        return
      }
      set({ overlay: null, mode: at, warm: false })
    }

    const writeMode = (mode: PageLocation): void => {
      if (get().overlay === null) {
        ports.history.replaceState({}, '', hrefOf(mode))
      }
      set({ mode })
    }

    return {
      ...snapshotFrom(hrefOf(readLocation(ports.location))),
      open(href) {
        const dest = locationOf(href)
        const current = get()
        const warm = current.overlay === null ? true : current.warm
        ports.history.pushState({ ir: 'overlay' }, '', hrefOf(dest))
        set({ overlay: hrefOf(dest), mode: current.mode, warm })
      },
      hop(href) {
        const dest = locationOf(href)
        ports.history.replaceState({ ir: 'overlay' }, '', hrefOf(dest))
        set({ overlay: hrefOf(dest) })
      },
      close() {
        const current = get()
        if (current.overlay === null) return
        if (current.warm) {
          ports.history.replaceState({}, '', hrefOf(current.mode))
          set({ overlay: null, warm: false })
          return
        }
        ports.assign(HOME)
      },
      replaceMode(href) {
        writeMode(locationOf(href))
      },
      setModeSearch(search) {
        const next =
          search === '' || search.startsWith('?') ? search : `?${search}`
        writeMode({ ...get().mode, search: next })
      },
      setModeHash(hash) {
        const next = hash === '' || hash.startsWith('#') ? hash : `#${hash}`
        writeMode({ ...get().mode, hash: next })
      },
      rehydrate(href) {
        set(snapshotFrom(href))
      },
      rebind(next) {
        unlisten()
        ports = next
        unlisten = ports.onPop(syncFromWindow)
        set({
          ...snapshotFrom(hrefOf(readLocation(ports.location))),
        })
      },
    }
  })

  unlisten = ports.onPop(() => {
    const at = readLocation(ports.location)
    if (isOverlayPath(at.pathname)) {
      store.setState({ overlay: hrefOf(at) })
      return
    }
    store.setState({ overlay: null, mode: at, warm: false })
  })

  return store
}

const defaultPorts =
  typeof window === 'undefined' ? noopPorts() : browserPorts()

export const overlayStore = createOverlayStore(defaultPorts)

/**
 * Subscribe to a slice of the overlay store.
 *
 * Both snapshots read the live store. Zustand's default server snapshot is
 * the state at creation, which is wrong for a module singleton a test
 * rehydrates before `renderToStaticMarkup` — OverlayRoutes would paint no
 * dialog and every dialog test would see ''. The chrome island is
 * `client:only`, so a real document never server-renders this hook.
 */
export function useOverlayStore<T>(
  select: (state: OverlaySnapshot & OverlayApi) => T,
): T {
  return useSyncExternalStore(
    overlayStore.subscribe,
    () => select(overlayStore.getState()),
    () => select(overlayStore.getState()),
  )
}
