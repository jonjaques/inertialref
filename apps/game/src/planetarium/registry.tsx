import { Crosshair, Eye, Sparkles, Sun } from 'lucide-react'
import type { DockPanelDefinition } from '../dock/panels.ts'
import { StellarSpan } from '../icons/index.tsx'
import type { PlanetariumContext } from './context.ts'
import { CataloguePanel } from './CataloguePanel.tsx'
import { ObjectPanel } from './ObjectPanel.tsx'
import { PresetsPanel } from './PresetsPanel.tsx'
import { TimePanel } from './TimePanel.tsx'
import { ViewPanel } from './ViewPanel.tsx'

/**
 * The panels the planetarium offers, with the zone each one belongs in.
 *
 * A function of the context rather than a constant, so a panel's body is a
 * closure over what the mode already has and not a props type per panel. The
 * `zone` here is a *default* — where a panel appears the first time and where
 * reopening it puts it — and the stored layout overrides it from then on.
 *
 * The split between the two panes is by *subject*, not by size. Left is the
 * sky: what is out there, and when. Right is the thing you are pointed at and
 * how it is being shown to you. That is the arrangement a session actually
 * uses — pick something from the catalog on the left, read it on the right —
 * and it means the two panes are never both about the same question.
 */
export function planetariumPanels(
  context: PlanetariumContext,
): readonly DockPanelDefinition[] {
  return [
    {
      id: 'catalogue',
      title: 'Catalog',
      icon: StellarSpan,
      zone: 'left',
      hint: 'everything within reach, nearest first',
      render: () => <CataloguePanel {...context} />,
    },
    {
      id: 'object',
      title: 'Object',
      icon: Crosshair,
      zone: 'right',
      hint: 'what the camera is on, in detail',
      render: () => <ObjectPanel {...context} />,
    },
    {
      id: 'view',
      title: 'View',
      icon: Eye,
      zone: 'right',
      hint: 'names, orbits, the lens',
      render: () => <ViewPanel {...context} />,
    },
    {
      id: 'presets',
      title: 'Presets',
      icon: Sparkles,
      zone: 'right',
      hint: 'light, framing and six ready compositions',
      render: () => <PresetsPanel {...context} />,
    },
    {
      id: 'time',
      title: 'Time',
      icon: Sun,
      zone: 'left',
      hint: 'pause, warp and the simulated clock',
      render: () => <TimePanel {...context} />,
    },
  ]
}
