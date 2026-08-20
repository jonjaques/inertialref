import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { openSession } from '@inertialref/devtools'
import { HudDock } from './HudDock.tsx'
import { TargetRow } from './NavPanel.tsx'

/*
 * A smoke test for the overlay, in Node, with no DOM.
 *
 * It exists because the alternative is no test at all: vitest deliberately runs
 * without a browser environment, so nothing else in this repository would
 * notice a HUD that throws on its first render. Static markup is enough to
 * catch that — and to prove the panel is reading a real `HarnessStatus` and a
 * real target listing rather than props somebody hand-wrote to match.
 *
 * It says nothing about layout, and cannot: what it asserts is that the thing
 * renders and that the names in it came from the universe.
 */

function fakeEngine(harness: unknown): never {
  // The dock only reaches the engine to hand it to the panels; the panels only
  // reach the harness. Typing this as the engine would be a lie about what is
  // exercised, so the cast is confined to one line with this comment on it.
  return { harness } as never
}

describe('the dev dock', () => {
  it('renders the universe it is pointed at', () => {
    const session = openSession({ seed: 'inertialref', workers: null })
    const ir = session.harness

    const markup = renderToStaticMarkup(
      createElement(HudDock, {
        engine: fakeEngine(ir),
        status: ir.status(),
        open: true,
        onOpenChange: () => {},
        tab: 'telemetry' as const,
        onTabChange: () => {},
        onNotice: () => {},
        render: { preference: 'auto' as const, output: null, onCyclePreference: () => {} },
        commands: {
          togglePause: () => {},
          warp: () => {},
          toggleAssist: () => {},
          killRotation: () => {},
          save: () => {},
          load: () => {},
        },
      }),
    )

    // The overlay's whole justification is that the invisible state is visible.
    expect(markup).toContain(ir.status().world.stateHash)
    expect(markup).toContain('Debug One')
    expect(markup).toContain(session.system.name)
    session.dispose()
  })

  it('renders every destination the harness offers', () => {
    const session = openSession({ seed: 'inertialref', workers: null })
    const targets = session.harness.targets({ lightYears: 6 })

    const markup = targets
      .map((target) =>
        renderToStaticMarkup(
          createElement(TargetRow, { target, selected: false, onSelect: () => {} }),
        ),
      )
      .join('')
    // React escapes text for the markup, and one of the nearest stars is
    // Barnard's — the apostrophe arrives as an entity.
    const text = markup.replaceAll('&#x27;', "'")

    for (const target of targets) {
      expect(text).toContain(target.name)
      expect(text).toContain(target.distanceText)
    }
    // The listing is a tree, and a tree that renders flat is a listing you
    // cannot read: a moon must be indented further than the planet it orbits.
    expect(text).toContain('pl-7')
    session.dispose()
  })

  it('renders the navigation tab without a world to poll yet', () => {
    // The first paint happens before the status poll has fired once. A panel
    // that only renders once it has data is a panel that crashes on load.
    const session = openSession({ seed: 'inertialref', workers: null })
    const markup = renderToStaticMarkup(
      createElement(HudDock, {
        engine: fakeEngine(session.harness),
        status: null,
        open: true,
        onOpenChange: () => {},
        tab: 'navigate' as const,
        onTabChange: () => {},
        onNotice: () => {},
        render: { preference: 'auto' as const, output: null, onCyclePreference: () => {} },
        commands: {
          togglePause: () => {},
          warp: () => {},
          toggleAssist: () => {},
          killRotation: () => {},
          save: () => {},
          load: () => {},
        },
      }),
    )
    expect(markup).toContain('surveying')
    expect(markup).toContain('starting')
    // Scenario buttons come from the harness, not from a list written twice.
    for (const name of session.harness.scenarios()) expect(markup).toContain(name)
    session.dispose()
  })
})
