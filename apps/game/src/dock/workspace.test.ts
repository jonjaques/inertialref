import { describe, expect, it } from 'vitest'
import { Aperture } from 'lucide-react'
import { allPanels, type DockPanelDefinition } from './panels.ts'
import { groupsFor, visiblePanels } from './workspace.ts'

const panel = (
  id: string,
  extra: Partial<DockPanelDefinition> = {},
): DockPanelDefinition => ({
  id,
  title: id,
  icon: Aperture,
  zone: 'right',
  hint: id,
  render: () => null,
  ...extra,
})

const DEV = { panels: [panel('perf')], open: false, onOpenChange: () => {} }

describe('suppressed panels', () => {
  it('stay known to the layout while nothing draws them', () => {
    // The guide before the Worker has answered: its slot must survive, so
    // the layout still knows it; the menu, the panes and the number row
    // must not show it.
    const groups = groupsFor(
      'Planetarium',
      [panel('catalog'), panel('guide', { suppressed: true })],
      DEV,
    )
    expect(allPanels(groups).map((one) => one.id)).toContain('guide')
    expect(visiblePanels(groups, true).map((one) => one.id)).toEqual([
      'catalog',
      'perf',
    ])
  })
})
