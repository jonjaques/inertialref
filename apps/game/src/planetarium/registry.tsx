import { Eye, Layers, Mountain, Sun } from 'lucide-react'
import type { DockPanelDefinition } from '../dock/panels.ts'
import { Neighbourhood, StarBody } from '../icons/index.tsx'
import type { PlanetariumContext } from './context.ts'
import { CataloguePanel } from './CataloguePanel.tsx'
import { ObjectPanel } from './ObjectPanel.tsx'
import { PresetsPanel } from './PresetsPanel.tsx'
import { SurfacePanel } from './SurfacePanel.tsx'
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
      // The neighborhood rather than the span between two stars: this panel is
      // "what is around here", and `StellarSpan` is a *dimension* — a measure
      // with arrow heads. The two glyphs sat one menu apart meaning almost the
      // same thing, which in a bar read by shape is two buttons that look like
      // they do each other's job.
      icon: Neighbourhood,
      zone: 'left',
      hint: 'what is within reach — fold it, filter it, fly to it',
      render: () => <CataloguePanel {...context} />,
    },
    {
      id: 'object',
      title: 'Object',
      // A body, not a reticle. `Crosshair` is the *aiming* glyph and this
      // panel stopped being about the camera the moment its readouts moved to
      // the Camera instrument — it is the record of a thing in the sky now.
      icon: StarBody,
      zone: 'right',
      hint: 'the record: mass, orbit, air, light',
      render: () => <ObjectPanel {...context} />,
    },
    {
      id: 'view',
      title: 'View',
      icon: Eye,
      zone: 'right',
      hint: 'names, orbit traces, the ship and the lens',
      render: () => <ViewPanel {...context} />,
    },
    {
      id: 'presets',
      title: 'Shots',
      // Layers, because a shot is where the light and the framing are stacked
      // into one press. `Sparkles` was the registry's "something magic happens"
      // glyph and said nothing about what.
      icon: Layers,
      zone: 'right',
      hint: 'nine composed shots, the light, and the way out',
      render: () => <PresetsPanel {...context} />,
    },
    {
      id: 'surface',
      title: 'Surface',
      // A mountain, because that is what the panel is for: the arm below the
      // orbit clamp exists so terrain can be looked at, and terrain only exists
      // down there.
      icon: Mountain,
      zone: 'right',
      hint: 'stand on it — named sites, a descent from orbit to two meters',
      render: () => <SurfacePanel {...context} />,
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
