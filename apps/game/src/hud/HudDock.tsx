import type { HarnessStatus } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { Connection } from '../net/health.ts'
import type { OutputPreference, RendererDescription } from '../render/output.ts'
import { CameraPanel, type CameraState } from './CameraPanel.tsx'
import { CONNECTION_LABEL, connectionTone } from './connection.ts'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { FOCUS_RING, releaseFocus } from './focus.ts'
import { GraphicsPanel, type GraphicsState } from './GraphicsPanel.tsx'
import { NavPanel } from './NavPanel.tsx'
import { PerfPanel } from './PerfPanel.tsx'
import { type HudTab, TABS } from './tabs.ts'
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
  graphics,
  camera,
  connection,
  onCheckConnection,
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
  graphics: GraphicsState
  camera: CameraState
  connection: Connection
  onCheckConnection: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
  tab: HudTab
  onTabChange: (tab: HudTab) => void
  commands: HudCommands
  onNotice: (message: string) => void
}) {
  const world = status?.world ?? null
  // Collapsed, the header is the whole overlay, so this is the readout. It is
  // computed once because it is also the title that recovers it when the window
  // is too narrow to show it whole.
  const summary =
    world === null
      ? 'starting…'
      : `t ${world.tick} · ${world.timeScale}×${world.paused ? ' · paused' : ''} · ${status?.player?.localSpeedText ?? '—'}`

  /*
   * `max-w` below is an overflow guard, not a breakpoint: the fixed 27rem
   * column is the design — this is a desktop surface and adding breakpoints
   * would be a new decision, not a completion of an existing one — but a window
   * narrower than the dock should crop it rather than push half of it
   * off-screen where no scrollbar can reach it.
   */
  return (
    <aside className="pointer-events-auto absolute right-3 top-3 flex max-h-[calc(100vh-1.5rem)] w-[27rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border border-slate-700/60 bg-slate-950/85 font-mono text-[11px] leading-relaxed text-slate-300 shadow-xl backdrop-blur">
      <button
        type="button"
        aria-expanded={open}
        onClick={(event) => {
          releaseFocus(event)
          onOpenChange(!open)
        }}
        className={`flex items-center gap-2 border-b border-slate-800 px-2 py-1 text-left hover:bg-slate-900/60 ${FOCUS_RING}`}
      >
        <span className="text-slate-500">{open ? '▾' : '▸'}</span>
        <span className="text-sky-300">InertialRef</span>
        <span className="ml-auto truncate text-slate-500" title={summary}>
          {summary}
        </span>
        <ConnectionPip connection={connection} />
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

          <div
            role="tablist"
            aria-label="Dock panels"
            className="flex gap-1 border-b border-slate-800 px-2 pt-1"
          >
            {TABS.map((name) => (
              <Tab
                key={name}
                label={name}
                active={tab === name}
                onClick={() => onTabChange(name)}
              />
            ))}
          </div>

          {/*
           * One boundary per tab, keyed on the tab.
           *
           * Keyed because remounting is the reset: leaving a failed tab and
           * coming back is the recovery a person reaches for first, and it has
           * to work without a button. Inside the scroll container rather than
           * around it so the fallback inherits the panel's padding and the
           * dock's own chrome — header, tabs, the transport controls — is
           * still there to drive the simulation with while one readout is down.
           */}
          <div
            role="tabpanel"
            id={`hud-panel-${tab}`}
            aria-labelledby={`hud-tab-${tab}`}
            className="min-h-0 flex-1 overflow-auto p-2"
          >
            <ErrorBoundary key={tab} what={`the ${tab} panel`}>
              {tab === 'navigate' && (
                <NavPanel engine={engine} onNotice={onNotice} />
              )}
              {tab === 'graphics' && <GraphicsPanel graphics={graphics} />}
              {tab === 'camera' && <CameraPanel camera={camera} />}
              {tab === 'telemetry' && (
                <TelemetryPanel
                  status={status}
                  output={render.output}
                  connection={connection}
                  onCheckConnection={onCheckConnection}
                />
              )}
              {tab === 'perf' && <PerfPanel engine={engine} status={status} />}
            </ErrorBoundary>
          </div>
        </>
      )}
    </aside>
  )
}

/**
 * The dot in the header — the entire network readout when the dock is
 * collapsed, which is why it carries its explanation in a title rather than a
 * label. Local, like `Tab` below: it is chrome for this one header.
 */
function ConnectionPip({ connection }: { connection: Connection }) {
  const { state, detail } = connection
  return (
    <span
      role="img"
      // The glyph carries the whole readout when the dock is collapsed, and a
      // screen reader announcing "black circle" carries none of it.
      aria-label={`server ${CONNECTION_LABEL[state]}`}
      className={`shrink-0 ${connectionTone(state)}`}
      title={`${CONNECTION_LABEL[state]}${detail === null ? '' : ` — ${detail}`}`}
    >
      ●
    </span>
  )
}

function Tab({
  label,
  active,
  onClick,
}: {
  label: HudTab
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`hud-tab-${label}`}
      aria-selected={active}
      aria-controls={`hud-panel-${label}`}
      onClick={(event) => {
        releaseFocus(event)
        onClick()
      }}
      className={`-mb-px border-b px-2 py-0.5 text-[10px] uppercase tracking-widest ${FOCUS_RING} ${
        active
          ? 'border-sky-400 text-sky-300'
          : 'border-transparent text-slate-500 hover:text-slate-300'
      }`}
    >
      {label}
    </button>
  )
}
