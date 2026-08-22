import type { WorldInspection } from '@inertialref/devtools'
import { Separator } from '@/components/ui/separator'
import { Action } from './Action.tsx'
import type { HudCommands, HudRenderState } from './controls.ts'

/*
 * The controls that have no business being keyboard-only in an alpha: the
 * clock, flight assist, the save slot and the extended-range override.
 *
 * A row of its own rather than a band inside `HudDock`, because it is the one
 * part of the dock that is *not* a tab — it stays on screen whichever readout
 * is showing, and everything on it has a key binding it is duplicating.
 */

export function DockTransport({
  world,
  render,
  commands,
}: {
  world: WorldInspection | null
  render: HudRenderState
  commands: HudCommands
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-slate-800 px-2 py-1">
      <Action
        label={world?.paused === true ? '▶ run' : '❚❚ pause'}
        title="Space"
        onClick={commands.togglePause}
      />
      <Action
        label="−"
        title="Slower ( [ )"
        onClick={() => commands.warp(-1)}
      />
      <span className="w-12 text-center text-slate-400 tabular-nums">
        {world?.timeScale ?? 1}×
      </span>
      <Action label="+" title="Faster ( ] )" onClick={() => commands.warp(1)} />
      <Separator orientation="vertical" className="mx-1 !h-3 bg-slate-800" />
      <Action
        label="assist"
        title="Flight assist (Z)"
        onClick={commands.toggleAssist}
      />
      <Action
        label="stop spin"
        title="Kill rotation (X)"
        onClick={commands.killRotation}
      />
      <Separator orientation="vertical" className="mx-1 !h-3 bg-slate-800" />
      <Action label="save" title="F5" onClick={commands.save} />
      <Action label="load" title="F9" onClick={commands.load} />
      <Separator orientation="vertical" className="mx-1 !h-3 bg-slate-800" />
      {/* Three states, one button. `docs/design/art.md` requires the
          override; what it does not require is three radio buttons in an
          overlay that is already dense — unlike the anti-aliasing level, this
          one is a *preference* whose resolved answer is often not the one
          asked for, and that answer is a row in the telemetry tab. */}
      <Action
        label={`hdr ${render.preference}`}
        title="Extended-range output: auto detects, and is wrong for somebody on every browser"
        tone={render.output?.mode === 'extended' ? 'primary' : 'normal'}
        onClick={render.onCyclePreference}
      />
    </div>
  )
}
