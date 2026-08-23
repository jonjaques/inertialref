import { useState } from 'react'
import type { HarnessStatus } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import { measureGpuFrameMs } from '../render/measure.ts'
import { GpuMeasureButton } from './GpuMeasureButton.tsx'
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
 * Budgets come from `docs/design/technical.md` § Performance budgets, and are
 * drawn on the plots rather than written next to them, because the useful
 * question is never "what is the budget" but "how close is this to it".
 */

/** The frame budget, ms. 60 fps at 1920×1080 is the target machine's job. */
const FRAME_BUDGET_MS = 16.6

/**
 * Where a frame period stops being jitter and starts being a dropped frame.
 *
 * The budget and the measurement are not the same quantity, and coloring the
 * plot on the budget alone gets this wrong in the most misleading direction.
 * The budget is 16.6 ms of *work*; what the plot samples is the interval between
 * animation frames, and on a vsynced display that interval is pinned at 16.67 ms
 * by the display whether the frame took 2 ms or 16. Measured here at a
 * comfortable 60 fps, the period's p95 is 17.8 ms — over budget, permanently,
 * while nothing at all is wrong.
 *
 * A frame that is genuinely late misses a vsync interval and lands near 33 ms.
 * 25 ms is between the two and cannot be reached by jitter.
 */
const DROPPED_FRAME_MS = 25

/** `docs/design/technical.md`: simulation ticks 0.5 ms, snapshot + scene build 1.5 ms. */
const ENGINE_BUDGET_MS = 2.0

/** The draw-call budget from the same table. */
const DRAW_CALL_BUDGET = 1_200

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
    </div>
  )
}
