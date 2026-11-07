import { Suspense } from 'react'
import { LazyGuidePanel as GuidePanel } from '../tour/LazyGuidePanel.tsx'
import { Aperture, AudioLines, Eye, Image, Sun, Video } from 'lucide-react'
import type { DockPanelDefinition } from '../dock/panels.ts'
import { LensPanel } from '../hud/LensPanel.tsx'
import { Neighborhood, StarBody } from '../icons/index.tsx'
import type { PlanetariumContext } from './context.ts'
import { CameraPanel } from './CameraPanel.tsx'
import { NavigatorPanel } from './NavigatorPanel.tsx'
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
 *
 * **The order is the menu's, and the menu reads like the screen.** The left
 * pane's panels come first and the right pane's after, so the glyphs on the
 * left half of the bar open what appears on the left of the frame, and the
 * number keys count across the screen the same way. Within the right pane the
 * order is the order of the questions: what is this, show me something good,
 * where am I looking from, through what, and what is drawn over it — which
 * also puts the preset thumbnails above the fold on arrival, where a pane of
 * Object, Camera and then Presets left them under it at 1600×900.
 */
export function planetariumPanels(
  context: PlanetariumContext,
): readonly DockPanelDefinition[] {
  return [
    {
      id: 'catalog',
      title: 'Navigator',
      // The neighborhood rather than the span between two stars: this panel is
      // "what is around here", and `StellarSpan` is a *dimension* — a measure
      // with arrow heads. The two glyphs sat one menu apart meaning almost the
      // same thing, which in a bar read by shape is two buttons that look like
      // they do each other's job.
      icon: Neighborhood,
      zone: 'left',
      hint: 'Everything within reach — fold it, filter it, look at it',
      render: () => (
        <NavigatorPanel {...context} onCatalog={context.openCatalog} />
      ),
    },
    {
      id: 'time',
      title: 'Time',
      icon: Sun,
      zone: 'left',
      hint: 'The clock — pause it, warp it, set it',
      render: () => <TimePanel {...context} />,
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
      id: 'presets',
      title: 'Presets',
      // A picture, because the top tier of this panel is one: the thumbnails
      // are captures rather than drawings. `Layers` was right while the panel
      // was compositions alone and says nothing about a fixture.
      icon: Image,
      zone: 'right',
      hint: 'Pictures, compositions and the light, one press each',
      render: () => <PresetsPanel {...context} />,
    },
    {
      id: 'camera',
      title: 'Camera',
      /*
       * The scene camera — the movie camera every engine's editor draws for
       * the eye in a scene — and not the aperture, which is the Lens panel's
       * now that the glass has a panel of its own. A still camera would have
       * read as "take a picture", which is the Presets panel's save.
       */
      icon: Video,
      zone: 'right',
      hint: 'Where the eye is, and how it holds the subject',
      render: () => <CameraPanel {...context} />,
    },
    {
      id: 'lens',
      title: 'Lens',
      /*
       * The aperture — the glyph `GraphicsPanel` argues it must not have, for
       * exactly the reason it belongs here. An aperture is the one thing in an
       * optical system this panel is about, and the panel that carries
       * anti-aliasing and the extended-range output is about what the
       * *display* is asked to show.
       */
      icon: Aperture,
      zone: 'right',
      /*
       * Closed on arrival, as View is. The lens is already the one a first
       * view wants, and a panel of eight sliders opened over a first look at
       * Earth is the instrument describing itself to somebody who came to look
       * at the planet.
       */
      defaultOpen: false,
      hint: 'What the picture is taken through — the glass and the exposure',
      render: () => (
        <LensPanel
          glare={{ amount: context.flare, onAmount: context.onFlare }}
        />
      ),
    },
    {
      id: 'view',
      title: 'View',
      // The eye stays here, and it is the right glyph now that it is the only
      // thing on this panel: what is *drawn over* the sky is a question about
      // seeing rather than about optics.
      icon: Eye,
      zone: 'right',
      /*
       * Closed on arrival.
       *
       * Five switches, every one of them persisted and every one already at the
       * setting a first view wants — names on, paths on, minor bodies and the
       * ship off. A panel nobody has to touch is a panel that spends a quarter
       * of the right pane on arrival and pushes the presets off the bottom of
       * it. Reopening still puts it back in this pane, which is what
       * `defaultOpen` buys over `zone: 'hidden'`.
       */
      defaultOpen: false,
      hint: 'Names, orbit paths and the ship',
      render: () => <ViewPanel {...context} />,
    },
    /*
     * Last, and suppressed for anybody not granted it. A private alpha's panel
     * is a glyph that means nothing to most visitors, so it is not drawn — but
     * it stays in the list, where the layout keeps its slot, and at the end of
     * it, so the number row means the same panels whether or not the guide
     * has been granted, and does not shift when the Worker's answer arrives.
     */
    guidePanel(context),
  ]
}

function guidePanel(context: PlanetariumContext): DockPanelDefinition {
  return {
    id: 'guide',
    suppressed: context.guideAccess.state !== 'granted',
    title: 'Guide',
    icon: AudioLines,
    zone: 'right',
    defaultOpen: false,
    hint: 'A tour, a question, and time to look',
    render: () => (
      <Suspense
        fallback={<p className="type-ui text-slate-400">Opening guide…</p>}
      >
        <GuidePanel {...context} />
      </Suspense>
    ),
  }
}
