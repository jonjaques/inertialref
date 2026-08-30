import { useState } from 'react'
import type { HarnessStatus } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import {
  setTimingLevel,
  TIMING_LEVELS,
  timingLevel,
} from '../engine/browserTiming.ts'
import {
  DRAW_CALL_BUDGET,
  DROPPED_FRAME_MS,
  ENGINE_BUDGET_MS,
  FRAME_BUDGET_MS,
} from '../engine/perfBudgets.ts'
import { measureGpuFrameMs } from '../render/measure.ts'
import { TIMING_LEVEL, write } from '../state/preferences.ts'
import { GpuMeasureButton } from './GpuMeasureButton.tsx'
import { OptionGroup } from './OptionGroup.tsx'
import { describeGl, format, fps, gpuLabel } from './perfFormat.ts'
import { Row } from './Row.tsx'
import { Section } from './Section.tsx'
import { SeriesPlot } from './SeriesPlot.tsx'
import { SeriesStatsRow } from './SeriesStatsRow.tsx'

/*
 * The performance overlay.
 *
 * Modeled on Dear ImGui's debug windows, and for its reasons rather than its
 * looks: every number carries its own history, the history is a plot rather than
 * a single value, and the plot is small enough that six of them fit above the
 * fold. A frame counter that says "60 fps" tells you nothing about the frame
 * that took 90 ms four seconds ago, and that frame is the entire question.
 *
 * It reads at the dock's 8 Hz while the samples arrive at frame rate, so a spike
 * lasting one frame is still in the window when a human looks — that asymmetry
 * is why the ring buffer exists instead of a smoothed scalar.
 *
 * The budgets are in `engine/perfBudgets.ts` rather than here, and the move is
 * not tidying. They were module constants in this file, which meant the only
 * thing that could act on them was the plot — so "over budget" existed in
 * exactly one place and was available to nothing else. A trace entry wants the
 * same definition, `hud/` sits above `engine/`, and the sink must not import a
 * panel. One definition now colours the plot *and* colours the trace entry.
 */

export function PerfPanel({
  engine,
  status,
}: {
  engine: GameEngine
  status: HarnessStatus | null
}) {
  /*
   * React Compiler is on, and it is exactly wrong about this component.
   *
   * It memoises derived values against their inputs, and every input here is a
   * `GameEngine` that never changes identity — so `metrics.period.summarise()`
   * is a pure call on a stable object as far as the compiler can see, and gets
   * computed once. It is not pure: it reads a ring buffer that the frame loop
   * has been writing to ever since. The panel rendered its first frame and then
   * showed those numbers for the rest of the session, reporting `starting…` for
   * a renderer that had been live for minutes.
   *
   * `use no memo` is the documented opt-out and this is what it is for. It is
   * not a license to hand-write `useMemo` here — see CLAUDE.md — it is a
   * statement that this subtree's whole job is to read mutable state on every
   * render, at the 8 Hz the dock re-renders at.
   */
  'use no memo'

  const metrics = engine.metrics
  const world = status?.world ?? null
  const workers = status?.workers ?? null
  const [gpuBusy, setGpuBusy] = useState(false)

  const period = metrics.period.summarise()
  const heap = metrics.heapMb.summarise()

  const measureGpu = (): void => {
    const gl = engine.gl
    const view = engine.view
    if (gl === null || view === null || gpuBusy) return
    setGpuBusy(true)
    void measureGpuFrameMs(gl.renderer, view.scene, view.camera)
      .then((ms) => {
        metrics.gpuMs = ms
      })
      .finally(() => setGpuBusy(false))
  }

  return (
    <div>
      <Section
        id="perf.frame"
        title="Frame"
        trailing={`${fps(period.mean)} fps`}
      >
        <SeriesPlot
          series={metrics.period}
          unit="ms"
          budget={FRAME_BUDGET_MS}
          warnAbove={DROPPED_FRAME_MS}
        />
        <SeriesStatsRow stats={period} unit="ms" />
        {/* p95 rather than max, and stated as a frame rate too, because "17.4 ms
            p95" and "57 fps at the 95th percentile" land differently and only
            one of them is the number the budget is written in. */}
        <Row
          label="P95"
          value={`${period.p95.toFixed(2)} ms · ${fps(period.p95)} fps`}
        />
        <Row
          label="Worst"
          value={`${period.max.toFixed(2)} ms · ${fps(period.max)} fps`}
        />
      </Section>

      <Section
        id="perf.engine"
        title="Engine"
        trailing={`${metrics.engineMs.summarise().mean.toFixed(2)} ms`}
      >
        {/* Simulation, snapshot, scene build and terrain reconciliation — but
            not the draw, which happens after this returns. Conflating the two is
            how a renderer problem gets diagnosed as a simulation one. */}
        <SeriesPlot
          series={metrics.engineMs}
          unit="ms"
          budget={ENGINE_BUDGET_MS}
        />
        <SeriesStatsRow stats={metrics.engineMs.summarise()} unit="ms" />
        <Row label="GPU" value={gpuLabel(engine, metrics.gpuMs, gpuBusy)} />
        <div className="mt-1">
          <GpuMeasureButton
            engine={engine}
            busy={gpuBusy}
            onMeasure={measureGpu}
          />
        </div>
      </Section>

      <Section
        id="perf.sim"
        title="Simulation"
        trailing={world === null ? '—' : `${world.tick} ticks`}
      >
        <SeriesPlot series={metrics.ticks} unit="" />
        {/*
         * Requested against delivered, side by side, which is the whole reason
         * this row exists: the dock offers seven time-warp detents and the
         * clock has a ceiling, and for a long time nothing said so. Anything
         * short of the request is being dropped.
         */}
        <Row
          label="Time Warp"
          value={
            world === null
              ? '—'
              : `${world.timeScale}× requested · ${format(world.achievedTimeScale)}× delivered`
          }
        />
        {world !== null && world.achievedTimeScale < world.timeScale * 0.99 && (
          <div className="text-amber-400/90">
            capped — the clock cannot run {world.timeScale}× at this frame rate
          </div>
        )}
        <Row
          label="Ticks/frame"
          value={format(metrics.ticks.summarise().mean)}
        />
        <Row
          label="Dropped"
          value={world === null ? '—' : String(world.droppedTicks)}
        />
      </Section>

      <Section
        id="perf.render"
        title="Render"
        trailing={`${format(metrics.drawCalls.summarise().last)} calls`}
      >
        <SeriesPlot
          series={metrics.drawCalls}
          unit=""
          budget={DRAW_CALL_BUDGET}
        />
        <SeriesStatsRow stats={metrics.drawCalls.summarise()} unit="" />
        <Row
          label="Triangles"
          value={format(metrics.triangles.summarise().last)}
        />
        <Row
          label="Pipeline"
          value={engine.gl === null ? 'starting…' : describeGl(engine)}
        />
      </Section>

      <Section
        id="perf.workers"
        title="Workers"
        trailing={workers === null ? '—' : `${workers.workers} threads`}
      >
        <SeriesPlot series={metrics.queuedJobs} unit="" />
        {workers !== null && (
          <>
            <Row
              label="Queued / Active"
              value={`${workers.queued} / ${workers.active}`}
            />
            <Row
              label="Queue Wait"
              value={`${workers.averageQueueMs.toFixed(1)} ms avg · ${workers.longestQueueMs.toFixed(1)} ms worst`}
            />
            <Row
              label="Run"
              value={`${workers.averageRunMs.toFixed(1)} ms avg`}
            />
            <Row
              label="Completed / Failed"
              value={`${workers.completed} / ${workers.failed}`}
            />
          </>
        )}
      </Section>

      <Section
        id="perf.memory"
        title="Memory"
        trailing={heap.count === 0 ? 'n/a' : `${heap.last.toFixed(0)} MB`}
      >
        {heap.count === 0 ? (
          // Not a failure worth hiding: `performance.memory` is Chromium-only and
          // non-standard, and a blank plot with no explanation reads as a bug.
          <div className="text-slate-400">
            performance.memory is Chromium-only
          </div>
        ) : (
          <>
            {/* The budget is 900 MB peak; the plot would be a flat line at the
                bottom against it, so this one is scaled to its own data. */}
            <SeriesPlot series={metrics.heapMb} unit="MB" />
            <SeriesStatsRow stats={heap} unit="MB" />
          </>
        )}
      </Section>

      <Section id="perf.timing" title="Timing" trailing={timingLevel()}>
        {/*
         * The fourth door onto one switch — the URL, the preference and
         * `ir.timing()` are the other three — and it is here because somebody
         * watching a p95 climb is already looking at this panel.
         *
         * `OptionGroup`, not `SwitchRow`: the setting has three values, and the
         * registry rule is that a countable set gets a radio group rather than
         * a control that cycles. Off is the default and has to be — there is no
         * capability query for the `console.timeStamp` track arguments, so a
         * level that turned itself on would make browsers that cannot draw
         * these entries pay for them anyway.
         *
         * The displayed value is the *live* level rather than the stored
         * preference, because `ir.timing('full')` from a script is not a
         * gesture anybody made and must not be written to disk — but it is what
         * the session is doing, and a row that disagreed with it would be
         * describing something else. The panel re-renders at the dock's 8 Hz,
         * so a change made elsewhere shows up within 125 ms.
         */}
        <div className="rounded border border-slate-800/80 bg-slate-900/40 p-1.5">
          <OptionGroup
            label="Timing detail"
            className="w-full [&>*]:flex-1"
            value={timingLevel()}
            values={TIMING_LEVELS}
            onChange={(next) => {
              setTimingLevel(next)
              write(TIMING_LEVEL, next)
            }}
          />
          <p className="type-ui mt-1.5 text-pretty text-slate-400">
            {timingLevel() === 'off'
              ? 'nothing is emitted; record a profile with trace'
              : timingLevel() === 'trace'
                ? 'custom tracks in a DevTools recording, nothing retained'
                : 'User Timing as well — readable back through ir.timing.drain()'}
          </p>
        </div>
      </Section>
    </div>
  )
}
