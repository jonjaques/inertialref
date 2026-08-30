import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LENS_PRESETS } from '@inertialref/rendering'
import {
  ABOUT,
  AUTH_CALLBACK,
  CINEMA,
  HOME,
  cinemaSceneFrom,
  overlaySurface,
  playModeFrom,
  PROFILE,
  SETTINGS,
  settingsSection,
  settingsSectionFrom,
  SIGN_IN,
  SIGN_UP,
} from './paths.ts'
import { overlayStore } from './overlay.ts'
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
 * that the tree `Root.tsx` builds is the tree these pages render in.
 */
const at = (path: string): string => {
  overlayStore.getState().rehydrate(path)
  return renderToStaticMarkup(
    createElement(KeymapProvider, null, createElement(OverlayRoutes, state)),
  )
}

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

describe('the rest of a path after a mode prefix', () => {
  it('reads the play variant, and treats an unknown one as solo', () => {
    expect(playModeFrom('/play/solo')).toBe('solo')
    expect(playModeFrom('/play/online')).toBe('online')
    expect(playModeFrom('/play/multiplayer')).toBe('multiplayer')
    expect(playModeFrom('/play/audio')).toBe('solo')
    expect(playModeFrom(HOME)).toBe('solo')
  })

  it('reads the cinema scene, and nothing at the library', () => {
    expect(cinemaSceneFrom(CINEMA)).toBeUndefined()
    expect(cinemaSceneFrom('/cinema/tng-intro')).toBe('tng-intro')
    expect(cinemaSceneFrom('/cinema/tng-intro/extra')).toBe('tng-intro')
    expect(cinemaSceneFrom(HOME)).toBeUndefined()
  })

  it('reads the settings section, and nothing at the dialog root', () => {
    expect(settingsSectionFrom(SETTINGS)).toBeUndefined()
    expect(settingsSectionFrom(settingsSection('camera'))).toBe('camera')
    expect(settingsSectionFrom(HOME)).toBeUndefined()
  })
})
