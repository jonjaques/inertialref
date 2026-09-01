import { Aperture, Eye, Image, Sun } from 'lucide-react'
import type { DockPanelDefinition } from '../dock/panels.ts'
import { Neighbourhood, StarBody } from '../icons/index.tsx'
import type { PlanetariumContext } from './context.ts'
import { CameraPanel } from './CameraPanel.tsx'
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
      // The neighborhood rather than the span between two stars: this panel is
      // "what is around here", and `StellarSpan` is a *dimension* — a measure
      // with arrow heads. The two glyphs sat one menu apart meaning almost the
      // same thing, which in a bar read by shape is two buttons that look like
      // they do each other's job.
      icon: Neighbourhood,
      zone: 'left',
      hint: 'Everything within reach — fold it, filter it, look at it',
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
      hint: 'The record — mass, orbit, air, light',
      render: () => <ObjectPanel {...context} />,
    },
    {
      id: 'camera',
      title: 'Camera',
      /*
       * The aperture — the glyph `GraphicsPanel` argues it must not have, for
       * exactly the reason it belongs here. An aperture is the one thing in an
       * optical system this panel is actually about, and the panel that carries
       * anti-aliasing and the extended-range output is about what the *display*
       * is asked to show. In a bar read by shape and position, the two of them
       * signed over to the same idea was two buttons that looked like they did
       * each other's job.
       */
      icon: Aperture,
      zone: 'right',
      hint: 'The eye — where it looks from, and through what',
      render: () => <CameraPanel {...context} />,
    },
    {
      id: 'view',
      title: 'View',
      // The eye stays here, and it is the right glyph now that it is the only
      // thing on this panel: what is *drawn over* the sky is a question about
      // seeing rather than about optics.
      icon: Eye,
      zone: 'right',
      hint: 'Names, orbit paths and the ship',
      render: () => <ViewPanel {...context} />,
    },
    {
      id: 'presets',
      title: 'Presets',
      // A picture, because the top tier of this panel is one: the thumbnails
      // are captures rather than drawings. `Layers` was right while the panel
      // was compositions alone and says nothing about a fixture.
      icon: Image,
      zone: 'right',
      hint: 'Pictures, compositions, the light and the way out',
      render: () => <PresetsPanel {...context} />,
    },
    {
      id: 'time',
      title: 'Time',
      icon: Sun,
      zone: 'left',
      hint: 'The clock — pause it, warp it, read it',
      render: () => <TimePanel {...context} />,
    },
  ]
}
