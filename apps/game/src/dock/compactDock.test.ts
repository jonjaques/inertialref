import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Circle, Globe, Star } from 'lucide-react'
import { CompactDock } from './CompactDock.tsx'
import { EMPTY_LAYOUT, movePanel, type DockLayout } from './layout.ts'
import type { DockPanelDefinition } from './panels.ts'

/*
 * The phone layout, in Node.
 *
 * It is here rather than in a browser because it is the one part of the dock
 * that a browser cannot easily be made to show: the desktop and compact
 * arrangements are chosen by a media query, and no automation in this project
 * can reliably drive a window to 390 px. Rendering the component directly asks
 * the question that actually matters — *is every panel reachable* — without
 * needing a viewport at all.
 *
 * What it guards is the claim `CompactDock` makes in its own header: the zones
 * stop being read, but the panel *set* is the same one the desktop arranged, so
 * a workspace survives being opened on a phone and rotating back.
 */

const panel = (id: string, zone: DockPanelDefinition['zone']) =>
  ({
    id,
    title: id,
    icon: id === 'catalogue' ? Star : id === 'object' ? Globe : Circle,
    zone,
    hint: `the ${id} panel`,
    render: () => createElement('p', null, `${id} body`),
  }) satisfies DockPanelDefinition

const PANELS = [
  panel('catalogue', 'left'),
  panel('object', 'right'),
  panel('time', 'bottom'),
  panel('closed', 'right'),
]

const LAYOUT: DockLayout = movePanel(
  {
    ...EMPTY_LAYOUT,
    left: ['catalogue'],
    right: ['object'],
    bottom: ['time'],
  },
  'closed',
  'hidden',
)

const render = (layout: DockLayout = LAYOUT): string =>
  renderToStaticMarkup(createElement(CompactDock, { panels: PANELS, layout }))

describe('the compact dock', () => {
  it('offers every docked panel as a tab, whatever zone it was in', () => {
    // The claim: on a phone the zones stop being read and nothing becomes
    // unreachable. A panel stranded in a zone the layout no longer draws is
    // exactly the failure this replaces.
    const markup = render()
    for (const id of ['catalogue', 'object', 'time']) {
      expect(markup).toContain(`>${id}</span>`)
    }
  })

  it('does not offer a closed panel', () => {
    // `hidden` is still a zone here: closing a panel on the desktop and opening
    // the same workspace on a phone must not resurrect it.
    expect(render()).not.toContain('>closed</span>')
  })

  it('opens with the sky, not with a panel', () => {
    // Which tab was last open is a fact about one glance, not a preference. A
    // sheet restored on arrival puts a panel over the view before anyone has
    // asked for anything.
    const markup = render()
    expect(markup).not.toContain('catalogue body')
    expect(markup).not.toContain('time body')
  })

  it('renders nothing at all when every panel is closed', () => {
    // Not an empty bar: a strip of chrome with no tabs in it is worse than no
    // strip, and the rail on the desktop is the way back either way.
    expect(render({ ...EMPTY_LAYOUT, hidden: PANELS.map((p) => p.id) })).toBe(
      '',
    )
  })

  it('keeps the tab strip clear of the home indicator', () => {
    // The bottom 34 px of a notched phone belong to the OS: anything drawn
    // there is dimmed and un-tappable, which for a tab bar means the whole
    // interface appears broken on exactly the devices it was built for.
    expect(render()).toContain('env(safe-area-inset-bottom)')
  })

  it('gives every tab a thumb-sized target', () => {
    // 44 px is the platform minimum for something hit one-handed while the
    // other hand is holding the device.
    expect(render()).toContain('min-h-11')
  })
})
