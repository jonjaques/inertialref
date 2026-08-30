import { describe, expect, it } from 'vitest'
import {
  ABOUT,
  HOME,
  PLANETARIUM,
  SETTINGS,
  cinemaScene,
  modeForPath,
  planetariumLink,
  settingsSection,
} from './paths.ts'
import {
  createOverlayStore,
  displayOf,
  hrefOf,
  locationOf,
  type OverlayPorts,
  type LocationPort,
} from './overlay.ts'

/*
 * Dialogs over `history`, as arithmetic.
 *
 * The React half is OverlayRoutes and OverlayLink; what is checkable in Node
 * is the contract those sit on: a warm open keeps the mode, a cold close
 * loads the menu document, a hop does not pile sections onto Back, and
 * writing `?at=` while Settings is open does not rename the address bar.
 */

interface Session {
  readonly ports: OverlayPorts
  readonly href: () => string
  readonly assigned: string[]
  back(): void
  apply(href: string): void
}

function sessionAt(start: string): Session {
  const url = new URL(start, 'https://inertialref.invalid')
  const location: LocationPort = {
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  }
  const stack = [hrefOf(location)]
  let index = 0
  const assigned: string[] = []
  const listeners: Array<() => void> = []

  const apply = (href: string): void => {
    const next = new URL(href, url)
    location.pathname = next.pathname
    location.search = next.search
    location.hash = next.hash
  }

  const ports: OverlayPorts = {
    location,
    history: {
      pushState(_data, _unused, href) {
        apply(href)
        stack.splice(index + 1)
        stack.push(hrefOf(location))
        index = stack.length - 1
      },
      replaceState(_data, _unused, href) {
        apply(href)
        stack[index] = hrefOf(location)
      },
    },
    assign(href) {
      assigned.push(href)
      apply(href)
    },
    onPop(run) {
      listeners.push(run)
      return () => {
        const at = listeners.indexOf(run)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
  }

  return {
    ports,
    assigned,
    href: () => hrefOf(location),
    apply,
    back() {
      if (index === 0) return
      index -= 1
      apply(stack[index] as string)
      for (const run of listeners) run()
    },
  }
}

describe('href arithmetic', () => {
  it('round-trips a path with a query and a hash', () => {
    const href = '/planetarium?at=s%3ASOL%2Fb%3A2#x'
    expect(hrefOf(locationOf(href))).toBe(href)
  })
})

describe('a document load', () => {
  it('treats a mode URL as no dialog', () => {
    const session = sessionAt(PLANETARIUM)
    const store = createOverlayStore(session.ports)
    const state = store.getState()
    expect(state.overlay).toBeNull()
    expect(state.warm).toBe(false)
    expect(state.mode.pathname).toBe(PLANETARIUM)
    expect(modeForPath(state.mode.pathname)).toBe('planetarium')
    expect(displayOf(state).pathname).toBe(PLANETARIUM)
  })

  it('treats a dialog URL as a cold overlay over the menu', () => {
    const session = sessionAt(settingsSection('camera'))
    const store = createOverlayStore(session.ports)
    const state = store.getState()
    expect(state.overlay).toBe('/settings/camera')
    expect(state.warm).toBe(false)
    expect(state.mode.pathname).toBe(HOME)
    expect(modeForPath(state.mode.pathname)).toBe('menu')
    expect(displayOf(state).pathname).toBe('/settings/camera')
  })
})

describe('opening a dialog from a mode', () => {
  it('keeps the mode and names the dialog in the address bar', () => {
    const session = sessionAt(planetariumLink('s:SOL/b:5'))
    const store = createOverlayStore(session.ports)
    store.getState().open(SETTINGS)
    const state = store.getState()
    expect(state.warm).toBe(true)
    expect(state.overlay).toBe(SETTINGS)
    expect(state.mode.pathname).toBe(PLANETARIUM)
    expect(state.mode.search).toBe('?at=s%3ASOL%2Fb%3A5')
    expect(modeForPath(state.mode.pathname)).toBe('planetarium')
    expect(session.href()).toBe(SETTINGS)
    expect(displayOf(state).pathname).toBe(SETTINGS)
  })

  it('replaces inside the dialog so Back still leaves it', () => {
    const session = sessionAt(PLANETARIUM)
    const store = createOverlayStore(session.ports)
    store.getState().open(SETTINGS)
    store.getState().hop(settingsSection('camera'))
    expect(session.href()).toBe('/settings/camera')
    expect(store.getState().mode.pathname).toBe(PLANETARIUM)
    session.back()
    expect(session.href()).toBe(PLANETARIUM)
    expect(store.getState().overlay).toBeNull()
    expect(store.getState().mode.pathname).toBe(PLANETARIUM)
  })
})

describe('closing a dialog', () => {
  it('replaces back to the mode when the document is still the mode', () => {
    const session = sessionAt(PLANETARIUM)
    const store = createOverlayStore(session.ports)
    store.getState().open(SETTINGS)
    store.getState().close()
    expect(session.href()).toBe(PLANETARIUM)
    expect(session.assigned).toEqual([])
    expect(store.getState().overlay).toBeNull()
    expect(store.getState().mode.pathname).toBe(PLANETARIUM)
  })

  it('loads the menu document when the dialog was the page', () => {
    const session = sessionAt(SETTINGS)
    const store = createOverlayStore(session.ports)
    store.getState().close()
    expect(session.assigned).toEqual([HOME])
    expect(store.getState().overlay).toBe(SETTINGS)
  })
})

describe('the mode URL behind an open dialog', () => {
  it('accepts a query rewrite without renaming the address bar', () => {
    const session = sessionAt(PLANETARIUM)
    const store = createOverlayStore(session.ports)
    store.getState().open(SETTINGS)
    store.getState().setModeSearch('?at=s%3ASOL%2Fb%3A4')
    expect(session.href()).toBe(SETTINGS)
    expect(store.getState().mode.search).toBe('?at=s%3ASOL%2Fb%3A4')
    store.getState().close()
    expect(session.href()).toBe('/planetarium?at=s%3ASOL%2Fb%3A4')
  })

  it('rewrites the address bar when no dialog is open', () => {
    const session = sessionAt(cinemaScene('tng-intro'))
    const store = createOverlayStore(session.ports)
    store.getState().setModeSearch('?t=1150')
    expect(session.href()).toBe('/cinema/tng-intro?t=1150')
    expect(store.getState().mode.search).toBe('?t=1150')
  })
})

describe('a second dialog from a cold overlay', () => {
  it('stays cold, so close still loads the menu', () => {
    const session = sessionAt(SETTINGS)
    const store = createOverlayStore(session.ports)
    store.getState().open(ABOUT)
    expect(store.getState().warm).toBe(false)
    expect(store.getState().mode.pathname).toBe(HOME)
    expect(session.href()).toBe(ABOUT)
    store.getState().close()
    expect(session.assigned).toEqual([HOME])
  })
})
