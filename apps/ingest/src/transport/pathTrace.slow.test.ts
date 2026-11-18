import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  mieDroplets,
  SLAB_REFERENCE,
  traceMedium,
  tracePhase,
} from '@inertialref/rendering'
import {
  createTracer,
  estimateOf,
  slabRay,
  tracePixel,
  uniformSky,
} from './pathTrace.ts'

/*
 * Two figures package R1 measured of the renderer's scaled medium against
 * the true one, taken again by this tracer, which shares no code with
 * either of R1's solvers and reads the phase from the half-float table
 * where they read the Mie series. Each is tens of seconds of one core,
 * which is why it is here and not in the gate.
 *
 * Measured on the Mac mini (Mac18,5, Apple M6), 5 s and 22 s: the scaling's
 * worst row 0.1795 ± 0.0025 against the oracle's 0.1837 on the true medium
 * and 0.2001 on the scaled one; the glory's ring over its trough 1.068 ±
 * 0.007 against R1's 1.061 ± 0.002 traced, 1.060 by the oracle and 1.139
 * scaled.
 */

const PHASE = tracePhase(mieDroplets())
const SEED = rootSeed('pathTrace.slow.test')
type Triple = readonly [number, number, number]

/** A slab of optical depth `depth` at one radius, 400 km wide. */
function slab(depth: number, radius: number) {
  const count = 4 * 8 * 4
  return traceMedium(
    [4, 8, 4],
    [100_000, 125, 100_000],
    new Float32Array(count).fill(depth / 1000),
    new Float32Array(count).fill(radius),
  )
}

/** A slab's radiance in a band along a view, by every order. */
function radiance(
  depth: number,
  radius: number,
  sun: Triple,
  view: Triple,
  band: number,
  angularRadius: number,
  paths: number,
) {
  const tracer = createTracer({
    medium: slab(depth, radius),
    phase: PHASE,
    sun: { direction: sun, irradiance: [1, 1, 1], angularRadius },
    sky: uniformSky(0),
    ground: null,
    orders: Infinity,
    estimator: 'cone',
  })
  const eye: Triple = [
    120_000 - view[0] * 5000,
    500 - view[1] * 5000,
    120_000 - view[2] * 5000,
  ]
  return estimateOf(tracePixel(tracer, eye, view, band, SEED, 0, paths))
}

describe('the scaled medium against the true one', () => {
  it('is 8.93% off where R1 found it worst, and the tracer stands with the true one', () => {
    // 6 µm at 680 nm, τ 5, the sun at 60°, light leaving 6.4° from its
    // direction: inside this tracer's cone, so the light is an eye's chain.
    const row = SLAB_REFERENCE.rows.find(
      (held) =>
        held.radius === 6 &&
        held.depth === 5 &&
        held.sunMu === 0.5 &&
        held.viewMu === 0.4 &&
        held.azimuth === 0 &&
        held.side === 'transmitted',
    )!
    expect(row.angle).toBeCloseTo(6.4, 1)
    expect(row.scaled[0] / row.truth[0] - 1).toBeCloseTo(
      SLAB_REFERENCE.scalingError,
      3,
    )
    const { sun, view } = slabRay(0.5, 0.4, 0, 'transmitted')
    const disk = ((959.63 / 3600) * Math.PI) / 180
    const { mean, error } = radiance(5, 6, sun, view, 0, disk, 100_000)
    expect(Math.abs(mean - row.truth[0])).toBeLessThan(
      3 * error + 0.005 * row.truth[0],
    )
    // And not with the scaled medium, by more than chance allows.
    expect(row.scaled[0] - mean).toBeGreaterThan(4 * error)
  }, 120_000)

  it('doubles the glory’s contrast, and the tracer draws the true one', () => {
    // A deck of 10 µm from straight above under a sun straight above, a
    // point sun as R1's is: the red ring over the trough inside it.
    const { glory } = SLAB_REFERENCE
    const at = (degrees: number) => {
      const { sun, view } = slabRay(
        1,
        Math.cos((degrees * Math.PI) / 180),
        0,
        'reflected',
      )
      return radiance(
        glory.depth,
        glory.radius,
        sun,
        view,
        glory.band,
        0,
        120_000,
      )
    }
    const trough = at(glory.trough)
    const ring = at(glory.ring)
    const ratio = ring.mean / trough.mean
    const error =
      ratio * Math.hypot(trough.error / trough.mean, ring.error / ring.mean)
    expect(Math.abs(ratio - glory.oracle)).toBeLessThan(3 * error)
    expect(Math.abs(ratio - glory.traced)).toBeLessThan(
      3 * Math.hypot(error, glory.error),
    )
    expect(glory.scaled - ratio).toBeGreaterThan(5 * error)
  }, 240_000)
})
