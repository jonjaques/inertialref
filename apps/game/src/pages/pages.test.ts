import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { HOME, SETTINGS } from './paths.ts'
import { OverlayRoutes } from './routes.tsx'

/*
 * The routed overlay, in Node, with no DOM — the same bargain `hud/hud.test.ts`
 * makes and for the same reason.
 *
 * What it is really guarding is the *stack*, not the markup. A page pulls in
 * four things nothing else in this repository used before it: the `@/` alias,
 * a shadcn/ui component, a lucide icon and Motion. Any one of them failing to
 * resolve or throwing on first render is a black overlay in the browser and
 * nothing anywhere else would notice — the alias in particular is configured in
 * three files (`vite.config.ts`, `apps/game/tsconfig.json`, `vitest.config.ts`)
 * that have no way of checking each other.
 */

/** The props a page receives, none of which it is asked to change here. */
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

describe('the routed overlay', () => {
  it('renders nothing at all while flying', () => {
    // The index route is the whole game: a route table that put anything on
    // screen at `/` would be chrome nobody asked for, in every screenshot.
    expect(at(HOME)).toBe('')
  })

  it('renders the settings page, with its panels and a way out', () => {
    const markup = at(SETTINGS)
    // The panels are the dock's own components rather than a second copy, so
    // their own strings are the proof that the page reached them.
    expect(markup).toContain('lens flare')
    expect(markup).toContain('65°')
    // The design's claim about this page, stated on the page.
    expect(markup).toContain('the simulation keeps running')
    // shadcn/ui's Button and a lucide icon, both resolved through `@/`.
    expect(markup).toContain('data-slot="button"')
    expect(markup).toContain('lucide-x')
    expect(markup).toContain('aria-label="Close (Escape)"')
  })

  it('ignores a path it does not know rather than erroring', () => {
    // The URL is the only way to reach a page, so a typed one is a normal
    // event. The game behind it is unaffected and there is nothing to say.
    expect(at('/almanac/does-not-exist')).toBe('')
  })
})
