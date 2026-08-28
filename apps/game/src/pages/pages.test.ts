import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { type Location, MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { LENS_PRESETS } from '@inertialref/rendering'
import {
  ABOUT,
  AUTH_CALLBACK,
  HOME,
  modeForPath,
  overlayBackground,
  overlaySurface,
  PROFILE,
  resolvedLocation,
  SETTINGS,
  settingsSection,
  SIGN_IN,
  SIGN_UP,
} from './paths.ts'
import { KeymapProvider } from '../input/KeymapProvider.tsx'
import { OverlayRoutes } from './OverlayRoutes.tsx'

/*
 * The routed dialogs, in Node, with no DOM — the same bargain `hud/hud.test.ts`
 * makes and for the same reason.
 *
 * What it is really guarding is the *stack*, not the markup. A page pulls in
 * four things nothing else in this repository used before it: the `@/` alias,
 * a shadcn/ui component, a lucide icon and Motion. Any one of them failing to
 * resolve or throwing on first render is a black overlay in the browser and
 * nothing anywhere else would notice — the alias in particular is configured in
 * three files (`vite.config.ts`, `apps/game/tsconfig.json`, `vitest.config.ts`)
 * that have no way of checking each other.
 *
 * The *mode* routes are deliberately not rendered here. Each one drives a live
 * engine — a camera, a worker pool, a WebGPU renderer — and a test that stubbed
 * all of that would be asserting against the stub. What is testable about them
 * without a browser is `modeForPath`, which is where that assertion lives
 * (`cinema/cinema.test.ts`).
 */

/** The props a dialog receives, none of which it is asked to change here. */
const state = {
  graphics: {
    lensFlare: true,
    onLensFlare: () => {},
    aa: '2x' as const,
    onAa: () => {},
  },
  camera: { lens: LENS_PRESETS.flight, onLens: () => {} },
  render: {
    preference: 'auto' as const,
    output: null,
    onPreference: () => {},
  },
}

/*
 * The keymap provider is part of the stack, so it is part of the render.
 *
 * A dialog claims the `dialog` context and takes `Escape` while it is up, which
 * means it calls `useKeyContext` — and a component that reaches for the
 * dispatcher outside a provider is a component that would throw in the browser
 * too. Stubbing the context instead would assert against the stub; this asserts
 * that the tree `main.tsx` builds is the tree these pages render in.
 */
const at = (path: string): string =>
  renderToStaticMarkup(
    createElement(
      KeymapProvider,
      null,
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(OverlayRoutes, state),
      ),
    ),
  )

describe('the routed dialogs', () => {
  it('renders nothing at all while a mode is running', () => {
    // The fallback route is the whole game: a dialog table that put anything on
    // screen at `/` or `/planetarium` would be chrome nobody asked for, in
    // every screenshot.
    expect(at(HOME)).toBe('')
    expect(at('/planetarium')).toBe('')
    expect(at('/play/solo')).toBe('')
  })

  it('renders settings, with its sections and a way out', () => {
    const markup = at(SETTINGS)
    // The panels are the workspace's own components rather than a second copy,
    // so their own strings are the proof that the page reached them.
    expect(markup).toContain('Lens Flare')
    // Title case in source — `type-title` does not shout for us.
    expect(markup).toContain('>Settings</h1>')
    // The design's claim about this page, stated on the page.
    expect(markup).toContain('The simulation keeps running')
    // shadcn/ui's Button and a lucide icon, both resolved through `@/`.
    expect(markup).toContain('data-slot="button"')
    expect(markup).toContain('lucide-x')
    expect(markup).toContain('aria-label="Close (Escape)"')
    // Sections are routes, so each one is a real link somebody can send.
    expect(markup).toContain(`href="${settingsSection('camera')}"`)
  })

  it('opens the section the URL names', () => {
    // The reason sections are routes at all: "turn off the lens flare" is much
    // easier to answer with a link than with three sentences of navigation.
    expect(at(settingsSection('camera'))).toContain('65°')
    // A row per action, from the one table — and the chord beside it, which is
    // the half that could not exist while the bindings were string literals in
    // five files.
    expect(at(settingsSection('controls'))).toContain('Flight Assist')
  })

  it('falls back rather than 404ing on a section it has never heard of', () => {
    // `/settings/audio` from a future build, or a typo. Opening settings is a
    // better answer than opening nothing.
    const markup = at(settingsSection('audio'))
    expect(markup).toContain('Lens Flare')
  })

  it('renders the informational and account pages', () => {
    const about = at(ABOUT)
    expect(about).toContain('>About</h1>')
    expect(about).toContain('7,123')
    expect(about).toContain('Pre-alpha')
    expect(about).toContain('Source on GitHub')
    expect(about).toContain('href="https://github.com/jonjaques/inertialref"')
    // The account pages must say they are unbuilt and must never render a
    // credential field that goes nowhere — people reuse passwords, and a form
    // that looks real is one they will type a real one into.
    for (const path of [SIGN_IN, SIGN_UP, PROFILE]) {
      const markup = at(path)
      expect(markup).toContain('designed and not built')
      expect(markup).not.toContain('type="password"')
      expect(markup).not.toContain('<form')
    }
  })

  it('handles an auth callback without leaving the code on screen', () => {
    // A code is a credential until it is redeemed. The page consumes the
    // parameters; it never prints them.
    const markup = at(`${AUTH_CALLBACK}?code=super-secret-authorization-code`)
    expect(markup).not.toContain('super-secret-authorization-code')
    expect(markup).toContain('Returning you')
  })

  it('shows a provider error, which is the only thing worth showing', () => {
    const markup = at(`${AUTH_CALLBACK}?error=access_denied`)
    expect(markup).toContain('access_denied')
    expect(markup).toContain('did not complete')
  })

  it('ignores a path it does not know rather than erroring', () => {
    // The URL is the only way to reach a page, so a typed one is a normal
    // event. The game behind it is unaffected and there is nothing to say.
    expect(at('/almanac/does-not-exist')).toBe('')
  })
})

/*
 * The background-location contract, as arithmetic.
 *
 * Only the pure half is reachable here — React Router does not serialize a
 * link's `state` into the anchor, so "every intra-dialog link carries the
 * background" has no observable in static markup and is checked by driving the
 * real app (`/drive`). What *is* checkable is the function everything else
 * agrees through, which is where the disagreement was.
 */
describe('the location a dialog is drawn over', () => {
  const location = (pathname: string, state?: unknown): Location =>
    ({
      pathname,
      search: '',
      hash: '',
      key: 'k',
      state: state ?? null,
    }) as Location

  it('resolves to the mode behind a dialog, not the dialog', () => {
    /*
     * The whole finding, as one assertion. `ModeRoutes` renders at the
     * background, so anything deriving "which mode is running" from the raw
     * pathname disagrees with the tree it is drawn over: from `/planetarium`,
     * opening `/settings` computed `menu` while `PlanetariumMode` was still
     * mounted. Over a cutscene the same disagreement unmounted the cinema
     * player, which stopped the scene, which remounted it — several times a
     * second.
     */
    const behind = location('/planetarium')
    const dialog = location(SETTINGS, { background: behind })
    expect(resolvedLocation(dialog)).toBe(behind)
    expect(modeForPath(resolvedLocation(dialog).pathname)).toBe('planetarium')
    expect(overlayBackground(dialog)).toBe(behind)
  })

  it('is the location itself on a cold load, which has nothing behind it', () => {
    // A fresh tab at `/settings` has no session behind it, and `menu` is the
    // honest answer rather than a fallback.
    const cold = location(SETTINGS)
    expect(resolvedLocation(cold)).toBe(cold)
    expect(overlayBackground(cold)).toBeNull()
    expect(modeForPath(resolvedLocation(cold).pathname)).toBe('menu')
  })

  it('survives history state written by something other than a link', () => {
    // `location.state` is whatever the history entry carries — a scroll
    // restoration key, a value from another app on the same origin, or null.
    for (const junk of [undefined, 42, 'planetarium', { background: null }]) {
      const odd = location('/cinema/tng-intro', junk)
      expect(resolvedLocation(odd)).toBe(odd)
      expect(modeForPath(resolvedLocation(odd).pathname)).toBe('cinema')
    }
  })
})

/*
 * The key `AnimatePresence` swaps dialogs on.
 *
 * The leak it exists to prevent is not reachable from Node — it needs a real
 * DOM, a compositor and an exit animation that completes. What *is* reachable
 * is the arithmetic that decides when a dialog re-enters at all, and that is the
 * half that regressed twice: once into a leaked pointer-blocking scrim, once
 * into the scene flashing dark on every settings tab.
 */
describe('the surface a dialog belongs to', () => {
  it('treats every settings section as one surface', () => {
    // A section change must not be an exit and an entrance. Two scrims
    // cross-fading stack to 91% and the scene visibly darkens.
    expect(overlaySurface(SETTINGS)).toBe(
      overlaySurface(settingsSection('camera')),
    )
    expect(overlaySurface(settingsSection('display'))).toBe(
      overlaySurface(settingsSection('controls')),
    )
  })

  it('keeps distinct dialogs distinct, so one replaces the other', () => {
    const surfaces = [ABOUT, SIGN_IN, PROFILE, SETTINGS].map(overlaySurface)
    expect(new Set(surfaces).size).toBe(surfaces.length)
  })

  it('collapses every non-dialog path to the absence of one', () => {
    // The `null` fallback route's key. A mode is not a surface, and two modes
    // must not look like two different dialogs closing.
    for (const path of [
      HOME,
      '/play/solo',
      '/planetarium',
      '/cinema/tng-intro',
    ])
      expect(overlaySurface(path)).toBe('none')
  })

  it('answers for a path it has never heard of without throwing', () => {
    // The URL is hand-typed here; `/settings` is a prefix of nothing else.
    expect(overlaySurface('/nonsense')).toBe('none')
    expect(overlaySurface('/')).toBe('none')
    expect(overlaySurface(SETTINGS + '/audio')).toBe(overlaySurface(SETTINGS))
  })
})
