import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { openSession } from '@inertialref/devtools'
import { CameraPanel } from './CameraPanel.tsx'
import type { DevContext } from './context.ts'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { GraphicsPanel } from './GraphicsPanel.tsx'
import { devPanels } from './registry.tsx'
import { TargetRow } from './TargetRow.tsx'
import { type Connection, DISCONNECTED } from '../net/health.ts'
import { AA_LEVELS, OUTPUT_PREFERENCES } from '../render/output.ts'
import { LENS_PRESETS, lensForFov } from '@inertialref/rendering'
import { FOCAL_MAX, FOCAL_MIN } from './controls.ts'

/*
 * A smoke test for the author's instruments, in Node, with no DOM.
 *
 * It exists because the alternative is no test at all: vitest deliberately runs
 * without a browser environment, so nothing else in this repository would
 * notice a panel that throws on its first render. Static markup is enough to
 * catch that — and to prove the panel is reading a real `HarnessStatus` and a
 * real target listing rather than props somebody hand-wrote to match.
 *
 * It says nothing about layout, and cannot: what it asserts is that the thing
 * renders and that the names in it came from the universe.
 *
 * These were five tabs in one dock and are now six panels in a workspace, so
 * the test goes through `devPanels` rather than through a component: the
 * registry is what `App` actually hands to a mode, and rendering a panel by
 * importing its component directly would prove nothing about whether it is
 * reachable.
 */

/** The context every instrument reads, minus whatever a test varies. */
function devContext(
  harness: unknown,
  overrides: Partial<DevContext> = {},
): DevContext {
  return {
    // The panels only ever reach the harness through the engine. Typing this
    // as the engine would be a lie about what is exercised, so the cast is
    // confined to one line with this comment on it.
    engine: { harness } as never,
    status: null,
    render: {
      preference: 'auto',
      output: null,
      onPreference: () => {},
    },
    graphics: {
      lensFlare: true,
      onLensFlare: () => {},
      aa: '2x',
      onAa: () => {},
    },
    camera: { lens: LENS_PRESETS.flight, onLens: () => {} },
    connection: DISCONNECTED,
    onCheckConnection: () => {},
    commands: {
      togglePause: () => {},
      warp: () => {},
      toggleAssist: () => {},
      killRotation: () => {},
      save: () => {},
      load: () => {},
    },
    onNotice: () => {},
    ...overrides,
  }
}

/**
 * One instrument's body, rendered.
 *
 * Through the registry rather than by importing the component, because the
 * registry is what `App` actually hands a mode — a panel that renders perfectly
 * and is not in the list is a panel nobody can open. A missing id throws rather
 * than returning empty markup, so a renamed panel fails here instead of quietly
 * making every assertion below vacuous.
 *
 * No `ErrorBoundary` around it, deliberately: a boundary here would catch the
 * throw this test exists to see and report it as markup that merely fails an
 * assertion, with the stack gone.
 */
function panelMarkup(context: DevContext, id: string): string {
  const panel = devPanels(context).find((entry) => entry.id === id)
  if (panel === undefined) throw new Error(`no ${id} panel in the registry`)
  return renderToStaticMarkup(createElement('div', null, panel.render()))
}

describe('the author’s instruments', () => {
  it('renders the universe it is pointed at', () => {
    const session = openSession({ seed: 'inertialref', workers: null })
    const ir = session.harness

    const markup = panelMarkup(
      devContext(ir, { status: ir.status() }),
      'telemetry',
    )

    // The overlay's whole justification is that the invisible state is visible.
    expect(markup).toContain(ir.status().world.stateHash)
    expect(markup).toContain('Debug One')
    expect(markup).toContain(session.system.name)
    session.dispose()
  })

  it('offers one panel per instrument, each with a pane to open into', () => {
    /*
     * What the tab strip used to assert, restated against the thing that
     * replaced it. A tablist could only be wrong about which of five was
     * showing; a registry can be wrong in the two ways that actually strand a
     * readout — a duplicate id, which makes `normalizeLayout` drop one of them
     * silently, and a zone that is not a pane, which puts a panel somewhere
     * with no drop target and no way back.
     */
    const session = openSession({ seed: 'inertialref', workers: null })
    const panels = devPanels(devContext(session.harness))

    const ids = panels.map((panel) => panel.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('navigate')
    expect(ids).toContain('perf')
    for (const panel of panels) {
      expect(['left', 'right']).toContain(panel.zone)
      // The menu is icon-only, so the hint is the panel's name to anyone who
      // cannot see the glyph. An empty one is an unlabelled button.
      expect(panel.hint.length).toBeGreaterThan(0)
    }
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
      drift: [],
      checkedAt: null,
      failures: 3,
    }
    const markup = panelMarkup(
      devContext(null, { connection: offline }),
      'telemetry',
    )
    expect(markup).toContain('no server')
    expect(markup).toContain('Failed to fetch')
    expect(markup).toContain('3 failed checks')
    expect(markup).toContain('the game does not need any of this')
    // The client build is half of "am I running the code I think I am"; the
    // other half only exists once a server has answered.
    expect(markup).toContain('Client Build')
  })

  it('renders the navigate panel without a world to poll yet', () => {
    // The first paint happens before the status poll has fired once. A panel
    // that only renders once it has data is a panel that crashes on load.
    const session = openSession({ seed: 'inertialref', workers: null })
    const markup = panelMarkup(devContext(session.harness), 'navigate')
    // The destination list before the first survey has returned. `starting…`
    // used to be asserted alongside it and is gone with the thing that said it:
    // it was the dock header's one-line summary of the world, and a header
    // shared by five tabs is exactly what a workspace of six panels replaces.
    expect(markup).toContain('surveying')
    // Scenario buttons come from the harness, not from a list written twice.
    for (const name of session.harness.scenarios())
      expect(markup).toContain(name)
    session.dispose()
  })

  it('leaves every truncated readout recoverable', () => {
    /*
     * A pane is 19rem wide and a state hash, a frame chain and a canonical
     * coordinate are none of them 19rem long, so the rows that carry the
     * invisible state are exactly the rows that truncate. A value you can
     * neither read nor hover is a value the panel is not actually showing,
     * which is the one thing these readouts exist to avoid.
     */
    const session = openSession({ seed: 'inertialref', workers: null })
    const status = session.harness.status()
    const markup = panelMarkup(
      devContext(session.harness, { status }),
      'telemetry',
    )
    expect(markup).toContain(`title="${status.world.stateHash}"`)
    session.dispose()
  })

  it('puts the clock, the attitude helpers and the save slot on one panel', () => {
    /*
     * The transport strip was a band under the dock's header that stayed on
     * screen whichever tab was showing. With no tabs there is nothing for it to
     * stay on screen over, so it is a panel — and the thing worth asserting is
     * that nothing was dropped on the way, because each of these is a verb with
     * a key binding it duplicates.
     */
    const markup = panelMarkup(devContext(null), 'controls')
    // Title case in the source, because `type-label` and `type-heading` carry
    // the `text-transform` and the strings have to read as language wherever
    // the CSS is not — a `title`, an `aria-label`, a copied string.
    for (const verb of ['Pause', 'Flight Assist', 'Stop Spin', 'Save', 'Load'])
      expect(markup).toContain(verb)
  })

  it('renders the graphics and camera panels with their controls', () => {
    /*
     * These two are pure controls over engine fields, so the whole test is that
     * they render and show the state they were given.
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
        render: {
          preference: 'auto' as const,
          output: null,
          onPreference: () => {},
        },
      }),
    )
    expect(graphics).toContain('Lens Flare')
    // The lens-flare switch, off, and no other switch on this panel.
    expect(graphics.match(/role="switch"/g)).toHaveLength(1)
    expect(graphics).toMatch(/role="switch" aria-checked="false"/)
    // Two radio groups now, and both used to be a button that cycled: the
    // anti-aliasing level and the extended-range override. The states you were
    // not on had no representation in the tree at all.
    expect(graphics.match(/role="radiogroup"/g)).toHaveLength(2)
    expect(graphics.match(/role="radio"/g)).toHaveLength(
      AA_LEVELS.length + OUTPUT_PREFERENCES.length,
    )
    // One checked per group.
    expect(graphics.match(/role="radio" aria-checked="true"/g)).toHaveLength(2)
    expect(graphics).toMatch(/aria-checked="true"[^>]*>2x</)
    for (const level of AA_LEVELS) expect(graphics).toContain(`>${level}<`)
    // The extended-range override moved here from the transport strip. It is a
    // rendering preference and this is the rendering panel.
    for (const preference of OUTPUT_PREFERENCES)
      expect(graphics).toContain(`>${preference}<`)
    expect(graphics).toMatch(/aria-checked="true"[^>]*>auto</)
    // `auto` is the one state whose resolved answer can disagree with it, and
    // saying which way it went is the whole reason the override exists. With
    // no renderer yet there is nothing to report, so the line is absent rather
    // than reading "auto → null".
    expect(graphics).not.toContain('auto →')

    const camera = renderToStaticMarkup(
      createElement(CameraPanel, {
        camera: { lens: lensForFov(42), onLens: () => {} },
      }),
    )
    // The focal length is what the panel is about, and the angle rides beside
    // it — 42° is 31.3 mm on the 24 mm gauge.
    expect(camera).toContain('31.3 mm')
    expect(camera).toContain('42°')
    expect(camera).toContain('Reset')
    // All four channels are drawn, not just the focal length: an aperture the
    // depth-of-field readout depends on and no control for it is a readout
    // nobody can move.
    for (const channel of ['Focal Length', 'Zoom', 'Aperture', 'Focus'])
      expect(camera).toContain(channel)
    // The travel is the scrub, not the value — a logarithmic slider whose
    // `aria` range was the millimeters would announce a position it does not
    // hold. `FOCAL_MIN`/`FOCAL_MAX` are the ends it maps onto.
    expect(camera).toContain('aria-valuemin="0"')
    expect(camera).toContain('aria-valuemax="1000"')
    expect(FOCAL_MIN).toBeCloseTo(8.4, 1)
    expect(FOCAL_MAX).toBeCloseTo(68.06, 1)
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
