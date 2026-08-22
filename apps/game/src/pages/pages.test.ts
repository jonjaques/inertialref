import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import {
  ABOUT,
  AUTH_CALLBACK,
  HOME,
  PROFILE,
  SETTINGS,
  settingsSection,
  SIGN_IN,
  SIGN_UP,
} from './paths.ts'
import { OverlayRoutes } from './routes.tsx'

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
  camera: { fov: 65, onFov: () => {} },
}

const at = (path: string): string =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(OverlayRoutes, state),
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
    // The panels are the dock's own components rather than a second copy, so
    // their own strings are the proof that the page reached them.
    expect(markup).toContain('lens flare')
    // The design's claim about this page, stated on the page.
    expect(markup).toContain('the simulation keeps running')
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
    expect(at(settingsSection('controls'))).toContain('flight assist')
  })

  it('falls back rather than 404ing on a section it has never heard of', () => {
    // `/settings/audio` from a future build, or a typo. Opening settings is a
    // better answer than opening nothing.
    const markup = at(settingsSection('audio'))
    expect(markup).toContain('lens flare')
  })

  it('renders the informational and account pages', () => {
    expect(at(ABOUT)).toContain('7,123')
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
    const markup = at(`${AUTH_CALLBACK}?code=super-secret-authorisation-code`)
    expect(markup).not.toContain('super-secret-authorisation-code')
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
