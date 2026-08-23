import type { WorldInspection } from '@inertialref/devtools'
import { Action } from './Action.tsx'
import type { HudCommands } from './controls.ts'
import { Section } from './Section.tsx'

/*
 * The verbs that have no business being keyboard-only in an alpha: the clock,
 * the ship's attitude helpers, and the save slot.
 *
 * A panel now, rather than a strip wedged under the dock's header. It was there
 * because the dock was one object with tabs and this was the band that stayed
 * on screen whichever tab was showing — a real constraint, and one that stopped
 * existing the moment every readout became a panel that can be open beside
 * another. As its own panel it can sit under the flight strip while the
 * catalogue is on the other side, which is the arrangement it was always
 * fighting the tab strip to get.
 *
 * Every control here duplicates a key binding and says which one in its title.
 * That is a rule rather than a courtesy: `PRODUCT.md` requires everything
 * doable by clicking to be reproducible without a browser, so a button with no
 * keyboard or harness equivalent is a capability the headless runner cannot
 * reach.
 */

export function ControlsPanel({
  world,
  commands,
}: {
  world: WorldInspection | null
  commands: HudCommands
}) {
  return (
    <div className="flex flex-col gap-2">
      <Section id="controls.clock" title="Clock">
        <div className="flex items-center gap-1">
          <Action
            label={world?.paused === true ? 'Run' : 'Pause'}
            tone={world?.paused === true ? 'primary' : 'normal'}
            title="Space"
            onClick={commands.togglePause}
          />
          <Action
            label="−"
            title="Slower ( [ )"
            onClick={() => commands.warp(-1)}
          />
          {/*
           * The one figure on this panel, so it carries the mono. Fixed width
           * and tabular, because it is read while it is being changed: a `100×`
           * that is two characters wider than `10×` moves the button under the
           * pointer that is repeating on it.
           */}
          <span className="type-readout w-12 shrink-0 text-center text-slate-200">
            {world?.timeScale ?? 1}×
          </span>
          <Action
            label="+"
            title="Faster ( ] )"
            onClick={() => commands.warp(1)}
          />
        </div>
      </Section>

      <Section id="controls.attitude" title="Attitude">
        <div className="flex flex-wrap items-center gap-1">
          <Action
            label="Flight Assist"
            title="Flight assist (Z)"
            onClick={commands.toggleAssist}
          />
          <Action
            label="Stop Spin"
            title="Kill rotation (X)"
            onClick={commands.killRotation}
          />
        </div>
      </Section>

      <Section id="controls.session" title="Session">
        <div className="flex flex-wrap items-center gap-1">
          <Action label="Save" title="F5" onClick={commands.save} />
          <Action label="Load" title="F9" onClick={commands.load} />
        </div>
      </Section>
    </div>
  )
}
