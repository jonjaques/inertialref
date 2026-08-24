import { Link, useParams } from 'react-router'
import { Camera, Keyboard, MonitorCog, type LucideIcon } from 'lucide-react'
import { CameraPanel } from '../hud/CameraPanel.tsx'
import type {
  CameraState,
  GraphicsState,
  HudRenderState,
} from '../hud/controls.ts'
import { GraphicsPanel } from '../hud/GraphicsPanel.tsx'
import { FOCUS_RING } from '../hud/focus.ts'
import { ControlsSection } from './ControlsSection.tsx'
import { OverlayPage } from './OverlayPage.tsx'
import { settingsSection } from './paths.ts'
import { useOverlay } from './useOverlay.ts'

/*
 * Settings, as a page with sections.
 *
 * The panels are the ones the workspace already draws — the same components,
 * the same props, the same engine fields underneath. That is deliberate:
 * inventing a second set of controls for the same three knobs is how a build
 * ends up with two anti-aliasing switches that disagree.
 *
 * Sections are *routes* (`/settings/display`) rather than tabs in component
 * state, for the same reason the modes are: a link to a specific setting is a
 * thing people send each other, and "turn off the lens flare" is much easier to
 * answer with a URL than with three sentences of navigation.
 *
 * `docs/design/ux.md` puts settings here rather than in a panel, and the
 * author's instruments are scaffolding rather than the shipping HUD, so the
 * eventual move is out of the workspace and into this page. Both render today;
 * neither is a copy.
 */

const SECTIONS = [
  { id: 'display', title: 'Display', icon: MonitorCog },
  { id: 'camera', title: 'Camera', icon: Camera },
  { id: 'controls', title: 'Controls', icon: Keyboard },
] as const satisfies readonly {
  id: string
  title: string
  icon: LucideIcon
}[]

type SectionId = (typeof SECTIONS)[number]['id']

const DEFAULT_SECTION: SectionId = 'display'

export function SettingsPage({
  graphics,
  camera,
  render,
}: {
  graphics: GraphicsState
  camera: CameraState
  render: HudRenderState
}) {
  const { section } = useParams<{ section?: string }>()
  /*
   * Every link that stays inside the dialog has to carry the background on.
   *
   * A section tab is a route, so clicking one is a navigation — and without
   * the state it clears `location.state`, `ModeRoutes` re-resolves at
   * `/settings/camera`, matches nothing, falls through to the menu and tears
   * down the mode behind the open dialog. The IR menu's own gear link passes
   * the state; these did not.
   */
  const { keep } = useOverlay()
  // An unknown section falls back rather than 404s: the URL is hand-typed, and
  // `/settings/audio` from a future build should open settings, not nothing.
  const active: SectionId =
    SECTIONS.find((entry) => entry.id === section)?.id ?? DEFAULT_SECTION

  return (
    <OverlayPage title="Settings" subtitle="The simulation keeps running">
      <nav
        aria-label="Settings sections"
        className="mb-3 flex gap-1 border-b border-slate-800 pb-2"
      >
        {SECTIONS.map((entry) => (
          <Link
            key={entry.id}
            to={settingsSection(entry.id)}
            state={keep}
            replace
            aria-current={entry.id === active ? 'page' : undefined}
            className={`type-label flex min-h-7 items-center gap-1.5 rounded px-2 py-1 transition-colors ${FOCUS_RING} ${
              entry.id === active
                ? 'bg-sky-500/15 text-sky-200'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            <entry.icon aria-hidden className="size-3.5" />
            {entry.title}
          </Link>
        ))}
      </nav>

      {active === 'display' && (
        <GraphicsPanel graphics={graphics} render={render} />
      )}
      {active === 'camera' && <CameraPanel camera={camera} />}
      {active === 'controls' && <ControlsSection />}
    </OverlayPage>
  )
}
