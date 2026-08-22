import type { HarnessStatus } from '@inertialref/devtools'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { Connection } from '../net/health.ts'
import { CameraPanel } from './CameraPanel.tsx'
import { ConnectionPip } from './ConnectionPip.tsx'
import type {
  CameraState,
  GraphicsState,
  HudCommands,
  HudRenderState,
} from './controls.ts'
import { DockTransport } from './DockTransport.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { FOCUS_RING, releaseFocus } from './focus.ts'
import { GraphicsPanel } from './GraphicsPanel.tsx'
import { NavPanel } from './NavPanel.tsx'
import { PerfPanel } from './PerfPanel.tsx'
import { type HudTab, TABS } from './tabs.ts'
import { TelemetryPanel } from './TelemetryPanel.tsx'

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
 * The tab strip's own classes, which are mostly subtractions.
 *
 * The registry's `line` variant is a 36 px pill list with a 2 px underline
 * five pixels below each trigger. The dock's type scale bottoms out at 10 px
 * and its rules are hairlines, so what survives is the variant's *mechanism* —
 * `data-state` driving an `::after` — with the sizes and the accent moved onto
 * this system's own. Overriding here rather than editing `components/ui`,
 * which `pnpm dlx shadcn add` rewrites.
 */
const TAB_LIST =
  'h-auto w-full justify-start gap-1 rounded-none border-b border-slate-800 bg-transparent p-0 px-2 pt-1'

const TAB_TRIGGER =
  'min-h-6 flex-none rounded-none border-0 bg-transparent px-2 py-0.5 text-[10px] font-normal tracking-widest uppercase text-slate-400 shadow-none hover:text-slate-300 data-[state=active]:bg-transparent data-[state=active]:text-sky-300 data-[state=active]:shadow-none after:-bottom-px after:h-px after:bg-sky-400 dark:data-[state=active]:bg-transparent'

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
    <aside className="pointer-events-auto absolute top-3 right-3 flex max-h-[calc(100vh-1.5rem)] w-[27rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border border-slate-700/60 bg-slate-950/85 font-mono text-[11px] leading-relaxed text-slate-300 shadow-xl backdrop-blur">
      <button
        type="button"
        aria-expanded={open}
        onClick={(event) => {
          releaseFocus(event)
          onOpenChange(!open)
        }}
        className={`flex items-center gap-2 border-b border-slate-800 px-2 py-1 text-left hover:bg-slate-900/60 ${FOCUS_RING}`}
      >
        <span className="text-slate-400">{open ? '▾' : '▸'}</span>
        <span className="text-sky-300">InertialRef</span>
        <span className="ml-auto truncate text-slate-400" title={summary}>
          {summary}
        </span>
        <ConnectionPip connection={connection} />
        <span className="shrink-0 text-slate-400">H</span>
      </button>

      {open && (
        <>
          <DockTransport world={world} render={render} commands={commands} />

          {/*
           * Radix owns the tablist, the roving focus and the `aria-controls`
           * wiring; what it does not own is which tab is showing, because that
           * outlives the mount — `App` persists it and validates the stored
           * name against `TABS`, since a `dock.tab` from before these five
           * names existed parses cleanly and renders an empty dock.
           *
           * Native scrolling inside each panel rather than `ScrollArea`,
           * deliberately: Radix's viewport wraps its content in a
           * `display: table` box that grows past 100% to fit the widest
           * line, and every readout in here is `truncate` inside a 27 rem
           * column. `index.css` already paints the native gutter in this
           * system's colours for exactly this surface.
           */}
          <Tabs
            value={tab}
            onValueChange={(next) => onTabChange(next as HudTab)}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <TabsList
              variant="line"
              aria-label="Dock panels"
              className={TAB_LIST}
            >
              {TABS.map((name) => (
                <TabsTrigger
                  key={name}
                  value={name}
                  onClick={releaseFocus}
                  className={`${TAB_TRIGGER} ${FOCUS_RING}`}
                >
                  {name}
                </TabsTrigger>
              ))}
            </TabsList>

            {/*
             * One boundary per tab.
             *
             * Radix unmounts the inactive panels, so leaving a failed tab and
             * coming back remounts the boundary with it — which is the reset a
             * person reaches for first, and it has to work without a button.
             * Inside the scroll container rather than around it so the
             * fallback inherits the panel's padding, and the dock's own chrome
             * — header, tabs, the transport controls — is still there to drive
             * the simulation with while one readout is down.
             */}
            {TABS.map((name) => (
              <TabsContent
                key={name}
                value={name}
                className="min-h-0 flex-1 overflow-auto p-2"
              >
                <ErrorBoundary what={`the ${name} panel`}>
                  {name === 'navigate' && (
                    <NavPanel engine={engine} onNotice={onNotice} />
                  )}
                  {name === 'graphics' && <GraphicsPanel graphics={graphics} />}
                  {name === 'camera' && <CameraPanel camera={camera} />}
                  {name === 'telemetry' && (
                    <TelemetryPanel
                      status={status}
                      output={render.output}
                      connection={connection}
                      onCheckConnection={onCheckConnection}
                    />
                  )}
                  {name === 'perf' && (
                    <PerfPanel engine={engine} status={status} />
                  )}
                </ErrorBoundary>
              </TabsContent>
            ))}
          </Tabs>
        </>
      )}
    </aside>
  )
}
