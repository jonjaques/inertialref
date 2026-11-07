import { Link, useParams } from 'react-router'
import {
  Database,
  Gamepad2,
  Keyboard,
  MonitorCog,
  PanelsTopLeft,
  type LucideIcon,
} from 'lucide-react'
import type { HudRenderState } from '../hud/controls.ts'
import { useDisplayDefaults } from '../hud/displayDefaults.ts'
import { GraphicsPanel } from '../hud/GraphicsPanel.tsx'
import { FOCUS_RING } from '../hud/focus.ts'
import { ControllerSection } from './ControllerSection.tsx'
import { ControlsSection } from './ControlsSection.tsx'
import { DataSection } from './DataSection.tsx'
import { InterfaceSection } from './InterfaceSection.tsx'
import { OverlayPage } from './OverlayPage.tsx'
import { modeForPath, settingsSection } from './paths.ts'
import { RestoreDefaults } from './RestoreDefaults.tsx'
import {
  type PageDefaults,
  useInterfaceDefaults,
  useKeyDefaults,
  usePadDefaults,
} from './settingsDefaults.ts'
import { useOverlay } from './useOverlay.ts'

/*
 * Settings, as a page with sections.
 *
 * The display rows are the ones the author's dock draws — the same component,
 * the same engine fields underneath — because inventing a second set of
 * controls for the same knobs is how a build ends up with two anti-aliasing
 * switches that disagree.
 *
 * Sections are *routes* (`/settings/display`) rather than tabs in component
 * state, for the same reason the modes are: a link to a specific setting is a
 * thing people send each other, and "turn off the lens flare" is much easier to
 * answer with a URL than with three sentences of navigation.
 *
 * **There is no camera section.** The lens is the viewport's instrument: the
 * planetarium and flight each carry a Lens panel beside the picture it shapes,
 * and a copy of its sliders here was a second place to set one value from a
 * page that cannot show the picture — opened over the menu, it showed none.
 * `/settings/camera` from an older link opens the display page, as every
 * unknown section does.
 *
 * The frame is one size on every section (`OverlayPage`'s `fixed`). Each
 * section sized the dialog to its content, so every tab press resized the
 * panel and re-centered it under the pointer. The tabs stay a row across the
 * top rather than becoming a rail down the side: the controller's page is a
 * drawing of a pad with callouts on both flanks, and a rail's 11rem taken from
 * its width set those callouts below the smallest label size this system has.
 */

const SECTIONS = [
  {
    id: 'display',
    title: 'Display',
    icon: MonitorCog,
    about:
      'What the display is asked to draw. Every change applies as it is made.',
  },
  {
    id: 'interface',
    title: 'Interface',
    icon: PanelsTopLeft,
    about: 'The menu bar, where the panels go back to, and the hints.',
  },
  {
    id: 'controls',
    title: 'Controls',
    icon: Keyboard,
    about:
      'Every act on the keyboard. A binding is the physical key, so it survives a change of layout.',
  },
  {
    id: 'controller',
    title: 'Controller',
    icon: Gamepad2,
    about: 'Every act on a gamepad, and how its sticks feel.',
  },
  {
    id: 'data',
    title: 'Data',
    icon: Database,
    about:
      'Settings live in this browser. A file is how they reach another one.',
  },
] as const satisfies readonly {
  id: string
  title: string
  icon: LucideIcon
  about: string
}[]

type SectionId = (typeof SECTIONS)[number]['id']

const DEFAULT_SECTION: SectionId = 'display'

export function SettingsPage({
  render,
  onNotice,
}: {
  render: HudRenderState
  onNotice: (message: string) => void
}) {
  const { section } = useParams<{ section?: string }>()
  /*
   * Every link that stays inside the dialog has to carry the background on.
   *
   * A section tab is a route, so clicking one is a navigation — and without
   * the state it clears `location.state`, `ModeRoutes` re-resolves at
   * `/settings/controls`, matches nothing, falls through to the menu and tears
   * down the mode behind the open dialog. The IR menu's own gear link passes
   * the state; these have to as well.
   */
  const { keep, background } = useOverlay()
  // An unknown section falls back rather than 404s: the URL is hand-typed, and
  // `/settings/audio` from a future build should open settings, not nothing.
  const active =
    SECTIONS.find((entry) => entry.id === section) ??
    SECTIONS.find((entry) => entry.id === DEFAULT_SECTION)!

  /*
   * Every page's defaults, read on every render rather than the active one's.
   *
   * Hooks cannot be called conditionally, and the counts are wanted on the
   * tabs anyway: a tab that says how many of its settings differ from their
   * defaults is how somebody finds the one change they cannot remember making.
   */
  const display = useDisplayDefaults()
  const chrome = useInterfaceDefaults()
  const keys = useKeyDefaults()
  const pad = usePadDefaults()
  const defaults: Readonly<Partial<Record<SectionId, PageDefaults>>> = {
    display,
    interface: chrome,
    controls: keys,
    controller: pad,
  }
  const current = defaults[active.id]

  return (
    <OverlayPage
      title="Settings"
      subtitle="The simulation keeps running"
      wide
      fixed
    >
      <nav
        aria-label="Settings sections"
        className="-mx-4 -mt-3 mb-3 flex shrink-0 gap-1 overflow-x-auto border-b border-slate-800 px-3"
      >
        {SECTIONS.map((entry) => {
          const changed = defaults[entry.id]?.changed ?? 0
          const here = entry.id === active.id
          return (
            <Link
              key={entry.id}
              to={settingsSection(entry.id)}
              state={keep}
              replace
              aria-current={here ? 'page' : undefined}
              className={`type-label relative flex min-h-10 shrink-0 items-center gap-1.5 px-2.5 transition-colors after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-sky-400 after:transition-opacity ${FOCUS_RING} ${
                here
                  ? 'text-sky-200 after:opacity-100'
                  : 'text-slate-400 after:opacity-0 hover:text-slate-200'
              }`}
            >
              <entry.icon aria-hidden className="size-3.5" />
              {entry.title}
              {changed > 0 && (
                <span
                  className="type-micro text-sky-300/90 normal-case"
                  title={`${changed} changed from the default`}
                >
                  <span className="sr-only">, changed: </span>
                  {changed}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      <header className="mb-1 flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <p className="type-ui min-w-0 flex-1 text-pretty text-slate-400">
          {active.about}
        </p>
        {current !== undefined && (
          <RestoreDefaults
            key={active.id}
            changed={current.changed}
            onRestore={() => {
              current.restore()
              onNotice(`${active.title.toLowerCase()} restored to defaults`)
            }}
          />
        )}
      </header>

      {/*
       * The section scrolls inside the fixed frame, with the tabs and the
       * header standing still above it. `@container`, because the rows inside
       * decide their arrangement from the width they are given rather than
       * from the window's.
       */}
      <div className="@container -mx-4 min-h-0 flex-1 overflow-y-auto px-4 pb-2">
        {active.id === 'display' && (
          <GraphicsPanel render={render} onNotice={onNotice} />
        )}
        {active.id === 'interface' && (
          <InterfaceSection
            mode={background === null ? null : modeForPath(background.pathname)}
            onNotice={onNotice}
          />
        )}
        {active.id === 'controls' && <ControlsSection />}
        {active.id === 'controller' && <ControllerSection />}
        {active.id === 'data' && <DataSection onNotice={onNotice} />}
      </div>
    </OverlayPage>
  )
}
