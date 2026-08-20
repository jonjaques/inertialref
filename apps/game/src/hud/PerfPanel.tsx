import { useMemo, useState } from 'react'
import type { Series, SeriesStats } from '@inertialref/devtools'
import type { HarnessStatus } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import { canMeasureGpu, measureGpuFrameMs } from '../render/measure.ts'
import { Row, Section } from './widgets.tsx'

/*
 * The performance overlay.
 *
 * Modelled on Dear ImGui's debug windows, and for its reasons rather than its
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
 * The budget and the measurement are not the same quantity, and colouring the
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
   * not a licence to hand-write `useMemo` here — see CLAUDE.md — it is a
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
        title="frame"
        trailing={`${fps(period.mean)} fps`}
      >
        <Plot
          series={metrics.period}
          unit="ms"
          budget={FRAME_BUDGET_MS}
          warnAbove={DROPPED_FRAME_MS}
        />
        <Stats stats={period} unit="ms" />
        {/* p95 rather than max, and stated as a frame rate too, because "17.4 ms
            p95" and "57 fps at the 95th percentile" land differently and only
            one of them is the number the budget is written in. */}
        <Row
          label="p95"
          value={`${period.p95.toFixed(2)} ms · ${fps(period.p95)} fps`}
        />
        <Row
          label="worst"
          value={`${period.max.toFixed(2)} ms · ${fps(period.max)} fps`}
        />
      </Section>

      <Section
        id="perf.engine"
        title="engine"
        trailing={`${metrics.engineMs.summarise().mean.toFixed(2)} ms`}
      >
        {/* Simulation, snapshot, scene build and terrain reconciliation — but
            not the draw, which happens after this returns. Conflating the two is
            how a renderer problem gets diagnosed as a simulation one. */}
        <Plot series={metrics.engineMs} unit="ms" budget={ENGINE_BUDGET_MS} />
        <Stats stats={metrics.engineMs.summarise()} unit="ms" />
        <Row label="gpu" value={gpuLabel(engine, metrics.gpuMs, gpuBusy)} />
        <div className="mt-1">
          <MeasureButton
            engine={engine}
            busy={gpuBusy}
            onMeasure={measureGpu}
          />
        </div>
      </Section>

      <Section
        id="perf.sim"
        title="simulation"
        trailing={world === null ? '—' : `${world.tick} ticks`}
      >
        <Plot series={metrics.ticks} unit="" />
        {/*
         * Requested against delivered, side by side, which is the whole reason
         * this row exists: the dock offers seven time-warp detents and the
         * clock has a ceiling, and for a long time nothing said so. Anything
         * short of the request is being dropped.
         */}
        <Row
          label="time warp"
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
          label="ticks/frame"
          value={format(metrics.ticks.summarise().mean)}
        />
        <Row
          label="dropped"
          value={world === null ? '—' : String(world.droppedTicks)}
        />
      </Section>

      <Section
        id="perf.render"
        title="render"
        trailing={`${format(metrics.drawCalls.summarise().last)} calls`}
      >
        <Plot series={metrics.drawCalls} unit="" budget={DRAW_CALL_BUDGET} />
        <Stats stats={metrics.drawCalls.summarise()} unit="" />
        <Row
          label="triangles"
          value={format(metrics.triangles.summarise().last)}
        />
        <Row
          label="pipeline"
          value={engine.gl === null ? 'starting…' : describeGl(engine)}
        />
      </Section>

      <Section
        id="perf.workers"
        title="workers"
        trailing={workers === null ? '—' : `${workers.workers} threads`}
      >
        <Plot series={metrics.queuedJobs} unit="" />
        {workers !== null && (
          <>
            <Row
              label="queued / active"
              value={`${workers.queued} / ${workers.active}`}
            />
            <Row
              label="queue wait"
              value={`${workers.averageQueueMs.toFixed(1)} ms avg · ${workers.longestQueueMs.toFixed(1)} ms worst`}
            />
            <Row
              label="run"
              value={`${workers.averageRunMs.toFixed(1)} ms avg`}
            />
            <Row
              label="completed / failed"
              value={`${workers.completed} / ${workers.failed}`}
            />
          </>
        )}
      </Section>

      <Section
        id="perf.memory"
        title="memory"
        trailing={heap.count === 0 ? 'n/a' : `${heap.last.toFixed(0)} MB`}
      >
        {heap.count === 0 ? (
          // Not a failure worth hiding: `performance.memory` is Chromium-only and
          // non-standard, and a blank plot with no explanation reads as a bug.
          <div className="text-slate-500">
            performance.memory is Chromium-only
          </div>
        ) : (
          <>
            {/* The budget is 900 MB peak; the plot would be a flat line at the
                bottom against it, so this one is scaled to its own data. */}
            <Plot series={metrics.heapMb} unit="MB" />
            <Stats stats={heap} unit="MB" />
          </>
        )}
      </Section>
    </div>
  )
}

function MeasureButton({
  engine,
  busy,
  onMeasure,
}: {
  engine: GameEngine
  busy: boolean
  onMeasure: () => void
}) {
  // Reads `engine.gl`, which arrives after the first render. See `PerfPanel`.
  'use no memo'

  const gl = engine.gl
  const ready =
    gl !== null && engine.view !== null && canMeasureGpu(gl.renderer)
  return (
    <button
      type="button"
      disabled={!ready || busy}
      title="Submit 40 frames and time them across a drained queue — the only measurement three's own timestamp does not exaggerate"
      onClick={(event) => {
        event.currentTarget.blur()
        onMeasure()
      }}
      className="rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-[10px] text-slate-300 transition-colors hover:border-sky-500/60 hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-35"
    >
      {busy ? 'measuring…' : 'measure gpu'}
    </button>
  )
}

/**
 * An ImGui-style history plot.
 *
 * A filled area rather than a line, because at 240 samples across 200 pixels the
 * line is mostly aliasing and the fill still reads as a shape. The budget, where
 * there is one, is a dashed rule — so "over budget" is something you see rather
 * than something you compute.
 *
 * The vertical scale is the window's own maximum, never a fixed one. A plot
 * pinned to the budget looks identical whether the frame time is 2 ms or 6 ms,
 * which is exactly the range where the interesting changes happen.
 */
function Plot({
  series,
  unit,
  budget,
  warnAbove,
}: {
  series: Series
  unit: string
  /** Drawn as a dashed rule. Where the design says this number should sit. */
  budget?: number
  /** Colours the plot when p95 exceeds it. Defaults to `budget`; see `DROPPED_FRAME_MS`. */
  warnAbove?: number
}) {
  // The series reference is stable and its contents are not, which is the same
  // trap `PerfPanel` describes. The `useMemo` below is the other kind — a stable
  // object, not a memoised computation — and stays.
  'use no memo'

  // Allocated once per mount and written into every read. The panel re-renders
  // eight times a second and the buffer is 240 doubles; making a new one each
  // time is the kind of garbage a performance overlay should be embarrassed by.
  const buffer = useMemo(() => new Float64Array(series.capacity), [series])
  const written = series.drain(buffer)
  const stats = series.summarise()

  const width = 100
  const height = 26
  if (written === 0) return <div className="h-[26px]" />

  // Headroom above the peak so the tallest sample is not flush with the border,
  // and never a zero-height range — a flat series would divide by zero.
  const ceiling = Math.max(
    stats.max * 1.15,
    budget === undefined ? 0 : budget * 1.1,
    1e-9,
  )
  const step = written > 1 ? width / (written - 1) : width
  let path = `M 0 ${height}`
  for (let i = 0; i < written; i += 1) {
    const value = buffer[i] ?? 0
    path += ` L ${(i * step).toFixed(2)} ${(height - (value / ceiling) * height).toFixed(2)}`
  }
  path += ` L ${width} ${height} Z`

  const threshold = warnAbove ?? budget
  const over = threshold !== undefined && stats.p95 > threshold
  const stroke = over ? '#fbbf24' : '#38bdf8'

  return (
    <div className="relative my-0.5">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block h-[26px] w-full rounded-sm bg-slate-900/70"
        role="img"
        aria-label={`${stats.last.toFixed(2)} ${unit}, ${written} samples`}
      >
        <path
          d={path}
          fill={stroke}
          fillOpacity={0.22}
          stroke={stroke}
          strokeWidth={0.6}
          vectorEffect="non-scaling-stroke"
        />
        {budget !== undefined && budget < ceiling && (
          <line
            x1={0}
            x2={width}
            y1={height - (budget / ceiling) * height}
            y2={height - (budget / ceiling) * height}
            stroke="#f87171"
            strokeWidth={0.5}
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {/* ImGui writes the current value over the plot rather than beside it; it
          costs no height and the eye is already there. */}
      <span className="pointer-events-none absolute right-1 top-0 text-[10px] tabular-nums text-slate-400">
        {format(stats.last)}
        {unit}
      </span>
    </div>
  )
}

function Stats({ stats, unit }: { stats: SeriesStats; unit: string }) {
  const suffix = unit === '' ? '' : ` ${unit}`
  return (
    <Row
      label="min · mean · max"
      value={`${format(stats.min)} · ${format(stats.mean)} · ${format(stats.max)}${suffix}`}
    />
  )
}

function describeGl(engine: GameEngine): string {
  const description = engine.gl?.description
  if (description === undefined) return 'starting…'
  return description.mode === 'extended'
    ? `${description.backend} · extended ${description.headroom}×`
    : `${description.backend} · sRGB`
}

function gpuLabel(
  engine: GameEngine,
  gpuMs: number | null,
  busy: boolean,
): string {
  if (busy) return 'measuring…'
  if (engine.gl !== null && !canMeasureGpu(engine.gl.renderer))
    return 'webgpu only'
  if (gpuMs === null) return 'not measured'
  return Number.isFinite(gpuMs) ? `${gpuMs.toFixed(2)} ms/frame` : 'unavailable'
}

/** Three significant figures without exponent noise, for numbers spanning 0.01 to 100,000. */
function format(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1000) return value.toFixed(0)
  if (Math.abs(value) >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function fps(periodMs: number): string {
  return periodMs > 0 ? (1000 / periodMs).toFixed(0) : '—'
}
