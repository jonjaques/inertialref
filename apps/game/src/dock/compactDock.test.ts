import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Circle, Globe, Star } from 'lucide-react'
import { CompactDock } from './CompactDock.tsx'
import {
  EMPTY_LAYOUT,
  movePanel,
  openPanels,
  type DockLayout,
} from './layout.ts'
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
  panel('time', 'float'),
  panel('closed', 'right'),
]

const LAYOUT: DockLayout = movePanel(
  {
    ...EMPTY_LAYOUT,
    left: ['catalogue'],
    right: ['object'],
    float: ['time'],
  },
  'closed',
  'hidden',
)

/*
 * Inside a router, because the bar carries the two links that used not to exist
 * on a phone at all — the mark going home and the settings dialog. A memory
 * router is the whole dependency: nothing here reads a path, only writes one.
 */
const render = (layout: DockLayout = LAYOUT): string =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(CompactDock, {
        panels: PANELS,
        layout,
        mode: 'planetarium',
      }),
    ),
  )

describe('the compact dock', () => {
  it('offers every open panel, whatever zone it was in', () => {
    /*
     * The claim: on a phone the zones stop being read and nothing becomes
     * unreachable — floating included, since there is nothing on a 390 px
     * screen for a panel to float over that it would not also cover. A panel
     * stranded in a zone the layout no longer draws is exactly the failure
     * this arrangement replaces.
     *
     * Asserted against the census rather than the markup, because the picker
     * lives inside the sheet now and the sheet opens closed. That is not the
     * test being weakened: `openPanels` *is* what the picker renders, and a
     * static render could only ever have proved that a list was drawn, not
     * that it was the right list.
     */
    expect(openPanels(PANELS, LAYOUT).map((panel) => panel.id)).toEqual([
      'catalogue',
      'object',
      'time',
    ])
  })

  it('does not offer a closed panel', () => {
    // `hidden` is still a zone here: closing a panel on the desktop and opening
    // the same workspace on a phone must not resurrect it.
    expect(openPanels(PANELS, LAYOUT).map((panel) => panel.id)).not.toContain(
      'closed',
    )
    expect(render()).not.toContain('>closed</span>')
  })

  it('names the panels in words, and only inside the sheet', () => {
    /*
     * The bar is navigation and the sheet is the picker, which is the division
     * that fixed the old strip: eleven panel names cannot share one row across
     * a 390 px screen, and the row that tried scrolled the last of them off the
     * edge with nothing to say it had. The bar names the *open* panel, or the
     * affordance that opens one.
     */
    const markup = render()
    expect(markup).toContain('>Panels</span>')
    expect(markup).not.toContain('>catalog</span>')
    expect(markup).not.toContain('overflow-x-auto')
  })

  it('opens with the sky, not with a panel', () => {
    // Which tab was last open is a fact about one glance, not a preference. A
    // sheet restored on arrival puts a panel over the view before anyone has
    // asked for anything.
    const markup = render()
    expect(markup).not.toContain('catalog body')
    expect(markup).not.toContain('time body')
  })

  it('keeps the way out even when every panel is closed', () => {
    /*
     * This used to render nothing at all, on the argument that a strip of
     * chrome with no tabs in it is worse than no strip. That was true of a
     * strip which was only tabs, and it is what left a phone in the
     * planetarium with no route home and no settings — the browser's back
     * button was the entire navigation model. The bar carries the mark, the
     * place and the settings now, so it is never the thing that disappears;
     * the panel toggle goes disabled instead, visible, because its presence is
     * the information that this mode has panels at all.
     */
    const markup = render({ ...EMPTY_LAYOUT, hidden: PANELS.map((p) => p.id) })
    expect(markup).toContain('href="/"')
    expect(markup).toContain('planetarium')
    expect(markup).toContain('disabled')
    expect(markup).not.toContain('>catalog</span>')
  })

  it('offers the mode a route home and a route to settings', () => {
    const markup = render()
    expect(markup).toContain('aria-label="Back to the menu"')
    expect(markup).toContain('aria-label="Settings"')
  })

  it('keeps the tab strip clear of the home indicator', () => {
    // The bottom 34 px of a notched phone belong to the OS: anything drawn
    // there is dimmed and un-tappable, which for a tab bar means the whole
    // interface appears broken on exactly the devices it was built for.
    //
    // `var(--safe-bottom)` rather than `env(safe-area-inset-bottom)` written
    // out: `index.css` names the four insets once, at `:root`, so that the
    // fallback to zero exists in one place and a `calc` has something to hold.
    // The same file is what puts `viewport-fit=cover`'s insets in play at all.
    expect(render()).toContain('var(--safe-bottom)')
  })

  it('bleeds its ground to the edge of the display', () => {
    // The other half of the same rule: the *padding* keeps the controls off the
    // home indicator, and this keeps the bar's ground from stopping short of it
    // and leaving a strip of live sky under a tab bar. `.hud-layer` pads its
    // chrome clear of the safe areas, so a band pinned to the screen edge has
    // to say that it is one.
    expect(render()).toContain('hud-bleed-bottom')
  })

  it('never renames the control that opens the sheet', () => {
    /*
     * It used to take the open panel's title, so pressing a button marked
     * *Panels* left a button marked *Catalog* where it had been — a toggle
     * whose label is the state it produced rather than the thing it toggles,
     * and no label anywhere for the way back. Which panel is open is answered
     * by the picker inside the sheet; what belongs on the bar is this control's
     * own open/shut state, which the chevron and `aria-expanded` carry.
     */
    const markup = render()
    expect(markup).toContain('>Panels</span>')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('>catalogue</span>')
  })

  it('gives every tab a thumb-sized target', () => {
    // 44 px is the platform minimum for something hit one-handed while the
    // other hand is holding the device.
    expect(render()).toContain('min-h-11')
  })
})
