import type { HarnessStatus } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { OutputPreference, RendererDescription } from '../render/output.ts'
import { NavPanel } from './NavPanel.tsx'
import { PerfPanel } from './PerfPanel.tsx'
import { TelemetryPanel } from './TelemetryPanel.tsx'
import { Action } from './widgets.tsx'

/*
 * The dev dock.
 *
 * One panel on the right holding everything an author needs while the game is
 * running: where you can go, what the simulation thinks is true, and the
 * handful of controls that have no business being keyboard-only in an alpha.
 * They share the space because they are read in alternation — you travel
 * somewhere and then look at what the frame graph did about it — and because
 * two floating overlays would cover twice as much of the thing being debugged.
 *
 * Nothing here is the shipping HUD. `docs/design/ux.md` specifies a cockpit
 * where every element has a physical place on the canopy and there is no
 * teleport at all; this is the scaffolding that lets that be built.
 */

export type HudTab = 'navigate' | 'telemetry' | 'perf'

/**
 * The renderer, as far as the dock is concerned: what was asked for, what came
 * back, and how to ask for something else.
 *
 * One prop rather than three because they are read together — the whole point of
 * showing the resolved mode next to the preference is that they routinely
 * disagree, and a browser that cannot produce extended range is supposed to say
 * so rather than silently ignore the setting.
 */
export interface HudRenderState {
  readonly preference: OutputPreference
  readonly output: RendererDescription | null
  readonly onCyclePreference: () => void
}

export interface HudCommands {
  readonly togglePause: () => void
  readonly warp: (direction: number) => void
  readonly toggleAssist: () => void
  readonly killRotation: () => void
  readonly save: () => void
  readonly load: () => void
}

export function HudDock({
  engine,
  status,
  render,
  open,
  onOpenChange,
  tab,
  onTabChange,
  commands,
  onNotice,
}: {
  engine: GameEngine
  status: HarnessStatus | null
  render: HudRenderState
  open: boolean
  onOpenChange: (open: boolean) => void
  tab: HudTab
  onTabChange: (tab: HudTab) => void
  commands: HudCommands
  onNotice: (message: string) => void
}) {
  const world = status?.world ?? null

  return (
    <aside className="pointer-events-auto absolute right-3 top-3 flex max-h-[calc(100vh-1.5rem)] w-[27rem] flex-col overflow-hidden rounded-lg border border-slate-700/60 bg-slate-950/85 font-mono text-[11px] leading-relaxed text-slate-300 shadow-xl backdrop-blur">
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.blur()
          onOpenChange(!open)
        }}
        className="flex items-center gap-2 border-b border-slate-800 px-2 py-1 text-left hover:bg-slate-900/60"
      >
        <span className="text-slate-500">{open ? '▾' : '▸'}</span>
        <span className="text-sky-300">InertialRef</span>
        {/* Collapsed, the header is the whole overlay, so it carries the two
            numbers you cannot fly without. */}
        <span className="ml-auto truncate text-slate-500">
          {world === null
            ? 'starting…'
            : `t ${world.tick} · ${world.timeScale}×${world.paused ? ' · paused' : ''} · ${status?.player?.localSpeedText ?? '—'}`}
        </span>
        <span className="shrink-0 text-slate-600">Tab</span>
      </button>

      {open && (
        <>
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
            <span className="w-12 text-center tabular-nums text-slate-400">
              {world?.timeScale ?? 1}×
            </span>
            <Action
              label="+"
              title="Faster ( ] )"
              onClick={() => commands.warp(1)}
            />
            <span className="mx-1 h-3 w-px bg-slate-800" />
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
            <span className="mx-1 h-3 w-px bg-slate-800" />
            <Action label="save" title="F5" onClick={commands.save} />
            <Action label="load" title="F9" onClick={commands.load} />
            <span className="mx-1 h-3 w-px bg-slate-800" />
            {/* Three states, one button. `docs/design/art.md` requires the
                override; what it does not require is three radio buttons in an
                overlay that is already dense. The resolved answer — which is
                often not the one asked for — is a row in the telemetry tab. */}
            <Action
              label={`hdr ${render.preference}`}
              title="Extended-range output: auto detects, and is wrong for somebody on every browser"
              tone={render.output?.mode === 'extended' ? 'primary' : 'normal'}
              onClick={render.onCyclePreference}
            />
          </div>

          <div className="flex gap-1 border-b border-slate-800 px-2 pt-1">
            <Tab
              label="navigate"
              active={tab === 'navigate'}
              onClick={() => onTabChange('navigate')}
            />
            <Tab
              label="telemetry"
              active={tab === 'telemetry'}
              onClick={() => onTabChange('telemetry')}
            />
            <Tab
              label="perf"
              active={tab === 'perf'}
              onClick={() => onTabChange('perf')}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {tab === 'navigate' && (
              <NavPanel engine={engine} onNotice={onNotice} />
            )}
            {tab === 'telemetry' && (
              <TelemetryPanel status={status} output={render.output} />
            )}
            {tab === 'perf' && <PerfPanel engine={engine} status={status} />}
          </div>
        </>
      )}
    </aside>
  )
}

function Tab({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.currentTarget.blur()
        onClick()
      }}
      className={`-mb-px border-b px-2 py-0.5 text-[10px] uppercase tracking-widest ${
        active
          ? 'border-sky-400 text-sky-300'
          : 'border-transparent text-slate-500 hover:text-slate-300'
      }`}
    >
      {label}
    </button>
  )
}
