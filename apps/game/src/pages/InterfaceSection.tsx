import { Action } from '../hud/Action.tsx'
import { OptionGroup } from '../hud/OptionGroup.tsx'
import { Section } from '../hud/Section.tsx'
import { SettingRow } from '../hud/SettingRow.tsx'
import { DOCK_PLACEMENTS, PLACEMENT_LABEL } from '../dock/placement.ts'
import {
  DOCK_PLACEMENT,
  PLANETARIUM_HINTED,
  resetPreference,
  usePersistentState,
} from '../state/preferences.ts'
import type { AppMode } from './paths.ts'
import { resetWorkspace, WORKSPACE_MODES } from './settingsDefaults.ts'

/** What each workspace is called on the button that resets it. */
const MODE_NAMES: Readonly<Record<Exclude<AppMode, 'menu'>, string>> = {
  planetarium: 'Planetarium',
  flight: 'Flight',
  cinema: 'Cinema',
  docs: 'Documentation',
}

/**
 * The chrome around the scene: where the menu bar sits, and where the panels
 * go back to, with the one hint that says how to look.
 *
 * Every row is a preference the build already keeps. The menu bar's
 * placement is chosen here and only here: it was a glyph on the bar itself —
 * a permanent control on the one piece of chrome that is always on screen,
 * for a choice somebody makes once — and the layouts were reachable only
 * through "reset everything", which also took the bindings and the lens.
 *
 * `mode` is the mode behind the dialog, read from the overlay's background
 * rather than from the path: this page opens over the menu as readily as over
 * the planetarium, and from the menu there is no "this mode" to name.
 */
export function InterfaceSection({
  mode,
  onNotice,
}: {
  mode: AppMode | null
  onNotice: (message: string) => void
}) {
  const [placement, setPlacement] = usePersistentState(DOCK_PLACEMENT)
  const [hinted] = usePersistentState(PLANETARIUM_HINTED)
  const here = mode === null || mode === 'menu' ? null : mode

  return (
    <div className="@container flex flex-col gap-2">
      <Section id="settings.interface.menu" title="Menu bar">
        <SettingRow
          label="Position"
          changed={placement !== DOCK_PLACEMENT.initial}
          detail="Floating over the scene, or attached as a band along an edge of the display."
        >
          <OptionGroup
            label="Menu bar position"
            value={placement}
            values={DOCK_PLACEMENTS}
            labels={PLACEMENT_LABEL}
            onChange={setPlacement}
          />
        </SettingRow>
      </Section>

      {/*
       * Where the panels go back to, and the one hint that introduces them:
       * both are about the workspace a mode opens with, so one heading.
       */}
      <Section id="settings.interface.panels" title="Panels">
        <SettingRow
          label="Layout"
          detail="Every panel back in the pane it starts in — nothing floating, nothing collapsed, both panes open."
        >
          {here !== null && (
            <Action
              label={`Reset ${MODE_NAMES[here].toLowerCase()}`}
              title={`Put the ${MODE_NAMES[here].toLowerCase()} panels back where they start`}
              onClick={() => {
                resetWorkspace(here)
                onNotice(`${MODE_NAMES[here].toLowerCase()} panels reset`)
              }}
            />
          )}
          <Action
            label="Reset every mode"
            title="Put every mode's panels back where they start"
            onClick={() => {
              for (const one of WORKSPACE_MODES) resetWorkspace(one)
              onNotice('every layout reset')
            }}
          />
        </SettingRow>
        <SettingRow
          label="Planetarium gestures"
          detail="The line over the scene that says how to orbit, zoom and focus. It leaves on the first gesture."
        >
          <Action
            label="Show again"
            disabled={!hinted}
            title={
              hinted
                ? 'Bring the gesture hint back in the planetarium'
                : 'The hint is still showing; it leaves on the first gesture'
            }
            onClick={() => resetPreference(PLANETARIUM_HINTED)}
          />
        </SettingRow>
      </Section>
    </div>
  )
}
