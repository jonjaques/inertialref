import { Link, useParams } from 'react-router'
import {
  Camera,
  Keyboard,
  MonitorCog,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { CameraPanel, type CameraState } from '../hud/CameraPanel.tsx'
import { GraphicsPanel, type GraphicsState } from '../hud/GraphicsPanel.tsx'
import { CONTROL_HELP } from '../hud/useShipControls.ts'
import { FOCUS_RING } from '../hud/focus.ts'
import { OverlayPage } from './OverlayPage.tsx'
import { settingsSection } from './paths.ts'
import { useOverlay } from './useOverlay.ts'

/*
 * Settings, as a page with sections.
 *
 * The panels are the ones the dock already draws — the same components, the
 * same props, the same engine fields underneath. That is deliberate: inventing
 * a second set of controls for the same three knobs is how a build ends up with
 * two anti-aliasing switches that disagree.
 *
 * Sections are *routes* (`/settings/display`) rather than tabs in component
 * state, for the same reason the modes are: a link to a specific setting is a
 * thing people send each other, and "turn off the lens flare" is much easier to
 * answer with a URL than with three sentences of navigation.
 *
 * `docs/design/ux.md` puts settings here rather than in the dock, and the dock
 * is scaffolding rather than the shipping HUD, so the eventual move is out of
 * the dock and into this page. Both render today; neither is a copy.
 */

const SECTIONS = [
  { id: 'display', title: 'display', icon: MonitorCog },
  { id: 'camera', title: 'camera', icon: Camera },
  { id: 'controls', title: 'controls', icon: Keyboard },
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
}: {
  graphics: GraphicsState
  camera: CameraState
}) {
  const { section } = useParams<{ section?: string }>()
  /*
   * Every link that stays inside the dialog has to carry the background on.
   *
   * A section tab is a route, so clicking one is a navigation — and without
   * the state it clears `location.state`, `ModeRoutes` re-resolves at
   * `/settings/camera`, matches nothing, falls through to the menu and tears
   * down the mode behind the open dialog. `ShellBar`'s own gear link passed
   * the state; these did not.
   */
  const { keep } = useOverlay()
  // An unknown section falls back rather than 404s: the URL is hand-typed, and
  // `/settings/audio` from a future build should open settings, not nothing.
  const active: SectionId =
    SECTIONS.find((entry) => entry.id === section)?.id ?? DEFAULT_SECTION

  return (
    <OverlayPage title="settings" subtitle="the simulation keeps running">
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
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-[10px] tracking-widest uppercase transition-colors ${FOCUS_RING} ${
              entry.id === active
                ? 'bg-sky-500/15 text-sky-200'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <entry.icon aria-hidden className="size-3.5" />
            {entry.title}
          </Link>
        ))}
      </nav>

      {active === 'display' && <GraphicsPanel graphics={graphics} />}
      {active === 'camera' && <CameraPanel camera={camera} />}
      {active === 'controls' && <ControlsSection />}
    </OverlayPage>
  )
}

function ControlsSection() {
  return (
    <div className="flex flex-col gap-3">
      {/* The bindings as they actually are, read from the one table that
          defines them. `docs/design/ux.md` requires everything to be
          rebindable; until that exists, a reference beats a promise. */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {CONTROL_HELP.map(([keys, what]) => (
          <div key={keys} className="col-span-2 grid grid-cols-subgrid">
            <dt className="text-sky-300/80 tabular-nums">{keys}</dt>
            <dd className="text-slate-400">{what}</dd>
          </div>
        ))}
      </dl>

      <div className="border-t border-slate-800 pt-2">
        <h3 className="mb-1 flex items-center gap-1.5 text-[10px] tracking-widest text-sky-400/80 uppercase">
          <Sparkles aria-hidden className="size-3" />
          planetarium
        </h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {PLANETARIUM_HELP.map(([keys, what]) => (
            <div key={keys} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-sky-300/80 tabular-nums">{keys}</dt>
              <dd className="text-slate-400">{what}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="text-slate-500">
        Rebinding is designed and not built — see{' '}
        <span className="text-slate-400">docs/design/ux.md</span>.
      </p>
    </div>
  )
}

/**
 * The planetarium's own bindings.
 *
 * Here rather than beside `gestures.ts` because this is the *documentation* of
 * a mapping, and the mapping is a table in `keyAction`. Two lists that could
 * drift is a real risk and the alternative — deriving prose from a switch — is
 * worse; what stops the drift is that `gestures.test.ts` asserts each of these
 * behaviours by name.
 */
const PLANETARIUM_HELP: readonly (readonly [string, string])[] = [
  ['drag', 'orbit the target'],
  ['wheel / pinch', 'zoom, logarithmically'],
  ['click', 'focus whatever is under the pointer'],
  ['↑ ↓ ← →', 'orbit — hold shift for coarse'],
  ['+ / −', 'zoom in / out'],
  ['F', 'frame the target'],
  ['Home', 'back to Earth'],
]
