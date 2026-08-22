import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { openSession } from '@inertialref/devtools'
import { CameraPanel } from './CameraPanel.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { GraphicsPanel } from './GraphicsPanel.tsx'
import { HudDock } from './HudDock.tsx'
import { TargetRow } from './TargetRow.tsx'
import { type Connection, DISCONNECTED } from '../net/health.ts'
import { AA_LEVELS } from '../render/output.ts'
import { FOV_MAX, FOV_MIN } from './controls.ts'
import { TABS } from './tabs.ts'

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

/** The dock's props, minus the two every test actually varies. */
function dockProps(harness: unknown) {
  return {
    engine: fakeEngine(harness),
    status: null,
    open: true,
    onOpenChange: () => {},
    tab: 'telemetry' as const,
    onTabChange: () => {},
    onNotice: () => {},
    connection: DISCONNECTED,
    onCheckConnection: () => {},
    render: {
      preference: 'auto' as const,
      output: null,
      onCyclePreference: () => {},
    },
    graphics: {
      lensFlare: true,
      onLensFlare: () => {},
      aa: '2x' as const,
      onAa: () => {},
    },
    camera: { fov: 65, onFov: () => {} },
    commands: {
      togglePause: () => {},
      warp: () => {},
      toggleAssist: () => {},
      killRotation: () => {},
      save: () => {},
      load: () => {},
    },
  }
}

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
        connection: DISCONNECTED,
        onCheckConnection: () => {},
        render: {
          preference: 'auto' as const,
          output: null,
          onCyclePreference: () => {},
        },
        graphics: {
          lensFlare: true,
          onLensFlare: () => {},
          aa: '2x' as const,
          onAa: () => {},
        },
        camera: { fov: 65, onFov: () => {} },
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
          createElement(TargetRow, {
            target,
            selected: false,
            onSelect: () => {},
          }),
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

  it('reports being unable to reach a server without making it an error', () => {
    // The offline path is the normal one (docs/design/modes.md), so the overlay
    // has to state it plainly and the panel has to render it before the first
    // frame — which is exactly when a player on a plane will be looking.
    const offline: Connection = {
      state: 'unreachable',
      detail: 'Failed to fetch',
      health: null,
      checkedAt: null,
      failures: 3,
    }
    const markup = renderToStaticMarkup(
      createElement(HudDock, {
        engine: fakeEngine(null),
        status: null,
        open: true,
        onOpenChange: () => {},
        tab: 'telemetry' as const,
        onTabChange: () => {},
        onNotice: () => {},
        connection: offline,
        onCheckConnection: () => {},
        render: {
          preference: 'auto' as const,
          output: null,
          onCyclePreference: () => {},
        },
        graphics: {
          lensFlare: true,
          onLensFlare: () => {},
          aa: '2x' as const,
          onAa: () => {},
        },
        camera: { fov: 65, onFov: () => {} },
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
    expect(markup).toContain('no server')
    expect(markup).toContain('Failed to fetch')
    expect(markup).toContain('3 failed checks')
    expect(markup).toContain('the game does not need any of this')
    // The client build is half of "am I running the code I think I am"; the
    // other half only exists once a server has answered.
    expect(markup).toContain('client build')
  })

  it('renders the graphics and camera panels with their controls', () => {
    /*
     * These two tabs are pure controls over engine fields, so the whole test
     * is that they render and show the state they were given.
     *
     * Asserted through the ARIA state rather than through visible text, and
     * that is not a preference: the switch used to write the words `on` and
     * `off` beside the label, and `expect(graphics).toContain('off')` went on
     * passing after it stopped — because `off` is also one of the three
     * anti-aliasing levels, printed a few nodes away. A test that cannot fail
     * is worse than no test, so it now names the control it means.
     */
    const graphics = renderToStaticMarkup(
      createElement(GraphicsPanel, {
        graphics: {
          lensFlare: false,
          onLensFlare: () => {},
          aa: '2x' as const,
          onAa: () => {},
        },
      }),
    )
    expect(graphics).toContain('lens flare')
    // The lens-flare switch, off, and no other switch on this panel.
    expect(graphics.match(/role="switch"/g)).toHaveLength(1)
    expect(graphics).toMatch(/role="switch" aria-checked="false"/)
    // The anti-aliasing level as a radio group — all three offered, `2x`
    // checked. It was one button that cycled, where the two levels you were
    // not on had no representation in the tree at all.
    expect(graphics).toContain('role="radiogroup"')
    expect(graphics.match(/role="radio"/g)).toHaveLength(AA_LEVELS.length)
    expect(graphics.match(/role="radio" aria-checked="true"/g)).toHaveLength(1)
    expect(graphics).toMatch(/aria-checked="true"[^>]*>2x</)
    for (const level of AA_LEVELS) expect(graphics).toContain(`>${level}<`)

    const camera = renderToStaticMarkup(
      createElement(CameraPanel, { camera: { fov: 42, onFov: () => {} } }),
    )
    expect(camera).toContain('42°')
    expect(camera).toContain('reset')
    // The slider carries the value it will write, and the range it is bounded
    // to — `FOV_MIN`/`FOV_MAX`, which three surfaces now read from one place.
    expect(camera).toContain(`aria-valuemin="${FOV_MIN}"`)
    expect(camera).toContain(`aria-valuemax="${FOV_MAX}"`)
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
        connection: DISCONNECTED,
        onCheckConnection: () => {},
        render: {
          preference: 'auto' as const,
          output: null,
          onCyclePreference: () => {},
        },
        graphics: {
          lensFlare: true,
          onLensFlare: () => {},
          aa: '2x' as const,
          onAa: () => {},
        },
        camera: { fov: 65, onFov: () => {} },
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
    for (const name of session.harness.scenarios())
      expect(markup).toContain(name)
    session.dispose()
  })
  it('marks exactly one tab as the one that is showing', () => {
    /*
     * The tablist is what a screen reader and a keyboard have to navigate, and
     * `aria-selected` is the only thing distinguishing the active tab from the
     * four inactive ones — the underline that does it visually is a border.
     *
     * Asserted on the *contract* rather than on an id, because Radix owns the
     * ids now and generates them per mount. The old assertion named
     * `hud-tab-camera` and would have to be rewritten for any id scheme; these
     * three would hold for any correct tablist, which is the point — one
     * selected tab, it is the one that was asked for, and exactly one panel is
     * not hidden.
     */
    const session = openSession({ seed: 'inertialref', workers: null })
    const markup = renderToStaticMarkup(
      // `camera` rather than `perf`: the perf tab reads `engine.metrics`, and
      // the engine here is a harness in a trench coat. See `fakeEngine`.
      createElement(HudDock, { ...dockProps(session.harness), tab: 'camera' }),
    )
    expect(markup).toContain('role="tablist"')
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1)

    // The selected trigger is the one labelled `camera`.
    const selected = /<button[^>]*aria-selected="true"[^>]*>([^<]*)</.exec(
      markup,
    )
    expect(selected?.[1]).toBe('camera')

    // Five panels, four of them hidden. Radix unmounts an inactive panel's
    // children, which is what makes leaving a failed tab and coming back the
    // reset — see the boundary in `HudDock`.
    expect(markup.match(/role="tabpanel"/g)).toHaveLength(TABS.length)
    expect(markup.match(/role="tabpanel"[^>]*hidden=""/g)).toHaveLength(
      TABS.length - 1,
    )
    session.dispose()
  })

  it('leaves every truncated readout recoverable', () => {
    /*
     * The dock is 27rem wide and a state hash, a frame chain and a canonical
     * coordinate are none of them 27rem long, so the rows that carry the
     * invisible state are exactly the rows that truncate. A value you can
     * neither read nor hover is a value the panel is not actually showing,
     * which is the one thing this overlay exists to avoid.
     */
    const session = openSession({ seed: 'inertialref', workers: null })
    const status = session.harness.status()
    const markup = renderToStaticMarkup(
      createElement(HudDock, {
        ...dockProps(session.harness),
        status,
        tab: 'telemetry' as const,
      }),
    )
    expect(markup).toContain(`title="${status.world.stateHash}"`)
    session.dispose()
  })

  it('gives a destination row its name and address to hover', () => {
    const session = openSession({ seed: 'inertialref', workers: null })
    const target = session.harness.targets({ lightYears: 6 })[0]
    if (target === undefined) throw new Error('the survey found nothing')
    const markup = renderToStaticMarkup(
      createElement(TargetRow, { target, selected: false, onSelect: () => {} }),
    )
    expect(markup.replaceAll('&#x27;', "'")).toContain(
      `title="${target.name} · ${target.address}"`,
    )
    session.dispose()
  })

  it('turns a thrown non-Error into something a panel can print', () => {
    // A boundary's whole value is that it renders instead of the tree, and
    // `throw 'boom'` is legal JavaScript that would otherwise reach
    // `error.message` as undefined and render an empty fallback.
    expect(ErrorBoundary.getDerivedStateFromError('boom').error.message).toBe(
      'boom',
    )
    expect(
      ErrorBoundary.getDerivedStateFromError(new RangeError('out')).error
        .message,
    ).toBe('out')
  })
})
