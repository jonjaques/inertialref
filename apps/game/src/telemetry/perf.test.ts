import { describe, expect, it } from 'vitest'
import type { FrameSample } from '../engine/frameMetrics.ts'
import { PERIOD_BOUNDS, PerfWindow, WINDOW_MS } from './perf.ts'

const frame = (periodMs: number): FrameSample => ({
  periodMs,
  engineMs: periodMs / 4,
  ticks: 1,
  achievedTimeScale: 1,
  drawCalls: 300,
  triangles: 1e6,
  queuedJobs: 0,
  heapMb: 512.4,
})

function rig() {
  const sent: Record<string, unknown>[] = []
  return { window: new PerfWindow((properties) => sent.push(properties)), sent }
}

describe('frame time in the field', () => {
  it('closes a window when its frames add up to a minute, and not before', () => {
    const { window, sent } = rig()
    const frames = WINDOW_MS / 16 // a minute at 62.5 Hz
    for (let i = 0; i < frames - 1; i += 1) window.sample(frame(16))
    expect(sent).toHaveLength(0)
    window.sample(frame(16))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      frames,
      period_p50: 16,
      period_p95: 16,
      dropped_frames: 0,
      draw_calls_p95: 300,
      heap_mb: 512,
    })
  })

  it('counts every frame into buckets a population can sum', () => {
    const { window, sent } = rig()
    // 90 smooth frames, 9 stutters, one hitch.
    for (let i = 0; i < 90; i += 1) window.sample(frame(16))
    for (let i = 0; i < 9; i += 1) window.sample(frame(40))
    window.sample(frame(250))
    window.flush()
    const buckets = sent[0]!['period_buckets'] as number[]
    expect(buckets).toHaveLength(PERIOD_BOUNDS.length + 1)
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(100)
    expect(buckets[2]).toBe(90) // ≤ 16.7 ms
    expect(buckets[6]).toBe(9) // ≤ 50 ms
    expect(buckets.at(-1)).toBe(1) // over 100 ms
    expect(sent[0]).toMatchObject({ dropped_frames: 10, period_p95: 40 })
  })

  it('sends nothing for a window that saw no frames, and ignores a zero period', () => {
    const { window, sent } = rig()
    window.sample(frame(0))
    window.flush()
    expect(sent).toHaveLength(0)
  })
})
