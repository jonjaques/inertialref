import type { GameEngine } from '../engine/GameEngine.ts'
import { canMeasureGpu } from '../render/measure.ts'

/*
 * How the performance overlay writes a number.
 *
 * Its own module because the panel and its plot both need it, and a `.tsx`
 * that exports plain functions alongside components is a file Fast Refresh
 * gives up on — the same rule `tabs.ts` and `controls.ts` are here for.
 */

/**
 * Three significant figures without exponent noise, for numbers spanning 0.01
 * to 100,000. Every readout on the panel crosses at least two of those decades.
 */
export function format(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1000) return value.toFixed(0)
  if (Math.abs(value) >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

export function fps(periodMs: number): string {
  return periodMs > 0 ? (1000 / periodMs).toFixed(0) : '—'
}

export function describeGl(engine: GameEngine): string {
  const description = engine.gl?.description
  if (description === undefined) return 'starting…'
  return description.mode === 'extended'
    ? `${description.backend} · extended ${description.headroom}×`
    : `${description.backend} · sRGB`
}

export function gpuLabel(
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
