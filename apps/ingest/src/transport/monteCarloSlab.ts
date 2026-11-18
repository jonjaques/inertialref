import { Rng, deriveSeedInt, type Seed } from '@inertialref/procedural'
import { capMoments, phaseOf } from './legendre.ts'
import { SOLAR_ANGULAR_RADIUS } from './moments.ts'

/*
 * The Monte Carlo slab: the radiance leaving a plane slab of the true medium,
 * by paths walked backward from the detector's direction with a connection
 * to the sun at every collision. It is the adding-doubling oracle's
 * independent check. Nothing in it is truncated or scaled: a collision
 * scatters by the whole Mie phase function, forward peak included.
 *
 * **A walk samples the phase function, and a second walk samples the sun.**
 * A walk's connection to the sun scores p(sun → walk) at each collision, and
 * a droplet's p is 10³ sr⁻¹ inside a cone a degree wide and 10⁻² at the
 * side. A walk aims into that cone once in ten thousand steps and half the
 * light comes through it, so the plain estimator's variance is near 10³ a
 * collision and its sample error understates the truth until the rare steps
 * are drawn. So every collision takes its next step two ways: once from the
 * phase function, and, while it is headed more than two degrees from every
 * sun, once from a lobe about one of the suns, the phase function's own
 * forward ten degrees. Each carries the balance weight
 * p/(p + lobe) of that step, so a step into the cone arrives with a small
 * weight whichever way it was drawn, and the two together count every path
 * once (Veach and Guibas, "Optimally combining sampling techniques for Monte
 * Carlo rendering", SIGGRAPH 1995). One mixture serves every sun at once.
 *
 * A walk whose weight is small and which is headed outside every lobe ends
 * by roulette. Inside a lobe a small weight is the point, and it walks on.
 *
 * **The medium's phase function is a histogram** in solid angle, 16,384 bins
 * a hemisphere of scattering angle, 0.005° wide at both ends, each holding
 * the series' own share. A walk samples it exactly, so a walk's weight is
 * its balance weights alone. The connection to the sun reads the series
 * convolved with the sun's disk, between the same nodes.
 *
 * **A path is a stream.** Path i draws from `Rng.fromSeed(deriveSeedInt(seed, i))`
 * and nothing else, and a row is sixteen batches of consecutive paths summed
 * in order, so a row split over processes by batch is the row.
 */

/** A phase function as the walk samples it and the sun's connection reads it. */
export interface PhaseTable {
  /** Bins a hemisphere of scattering angle. */
  readonly half: number
  /** A bin's width in sin(θ/2) from the forward axis, or in cos(θ/2) from the backward one. */
  readonly step: number
  /** sr⁻¹ at the nodes: `half + 1` from the forward axis, then `half + 1` from the backward one. */
  readonly value: Float64Array
  /** sr⁻¹: each bin's share over its solid angle, forward bins then backward. */
  readonly density: Float64Array
  /** The bins' running share, ending at one. */
  readonly cumulative: Float64Array
  /** Forward bins in the sun's lobe, and the share they hold. */
  readonly lobeBins: number
  readonly lobeShare: number
  /** Forward bins in a sun's core, inside which a walk takes no lobe step. */
  readonly coreBins: number
}

export interface PhaseTableOptions {
  readonly half?: number
  /** Radians: the disk the sun's connection is convolved with. */
  readonly sun?: number
  /** Degrees: the lobe's half-angle, and the core's. */
  readonly lobe?: number
  readonly core?: number
}

export function phaseTable(
  moments: Float64Array,
  options: PhaseTableOptions = {},
): PhaseTable {
  const half = options.half ?? 16384
  const step = Math.SQRT1_2 / half
  const cap = capMoments(options.sun ?? SOLAR_ANGULAR_RADIUS, moments.length)
  const convolved = moments.map((value, l) => value * cap[l]!)
  const value = new Float64Array(2 * (half + 1))
  const exact = new Float64Array(2 * (half + 1))
  for (let j = 0; j <= half; j += 1) {
    const cosine = 1 - 2 * (j * step) ** 2
    value[j] = phaseOf(convolved, cosine)
    value[half + 1 + j] = phaseOf(convolved, -cosine)
    exact[j] = phaseOf(moments, cosine)
    exact[half + 1 + j] = phaseOf(moments, -cosine)
  }
  // A bin's share with p linear in w between its nodes: dΩ = 8π·w·dw.
  const density = new Float64Array(2 * half)
  const cumulative = new Float64Array(2 * half)
  let total = 0
  for (let side = 0; side < 2; side += 1)
    for (let j = 0; j < half; j += 1) {
      const w0 = j * step
      const w1 = w0 + step
      const p0 = exact[side * (half + 1) + j]!
      const p1 = exact[side * (half + 1) + j + 1]!
      const slope = (p1 - p0) / step
      const level = p0 - slope * w0
      const share =
        8 *
        Math.PI *
        ((level * (w1 * w1 - w0 * w0)) / 2 + (slope * (w1 ** 3 - w0 ** 3)) / 3)
      if (!(share >= 0))
        throw new Error('monteCarloSlab: a phase function under zero')
      density[side * half + j] = share
      total += share
    }
  let running = 0
  for (let k = 0; k < 2 * half; k += 1) {
    const j = k % half
    running += density[k]! / total
    cumulative[k] = running
    density[k] = density[k]! / total / (4 * Math.PI * step * step * (2 * j + 1))
  }
  cumulative[2 * half - 1] = 1
  const lobe = ((options.lobe ?? 10) * Math.PI) / 180
  const lobeBins = Math.max(1, Math.round(Math.sin(lobe / 2) / step))
  return {
    half,
    step,
    value,
    density,
    cumulative,
    lobeBins,
    lobeShare: cumulative[lobeBins - 1]!,
    coreBins: Math.max(
      1,
      Math.round(Math.sin(((options.core ?? 2) * Math.PI) / 360) / step),
    ),
  }
}

/** One detector direction of one slab, under every sun at once. */
export interface SlabTrace {
  /** Optical depth, unscaled. */
  readonly depth: number
  /** The suns' cosines. */
  readonly suns: readonly number[]
  readonly viewMu: number
  /** Degrees between the view ray's bearing and the suns'. */
  readonly azimuth: number
  readonly side: 'reflected' | 'transmitted'
  readonly seed: Seed
}

/** Sums over consecutive paths: enough to add batches and to form an error. */
export interface TraceBatch {
  readonly paths: number
  /** Per sun: Σ of a path's radiance, and of its square. */
  readonly sum: Float64Array
  readonly squares: Float64Array
}

/** A weight under this, outside every lobe, goes to roulette. */
const ROULETTE_UNDER = 0.1
/** What a walk that survives roulette weighs. */
const ROULETTE_TO = 0.5
/** Walks one path may hold waiting: a lobe step a collision, most of them a few collisions long. */
const STACK = 1 << 14
/** A waiting walk: its depth, its direction, its weight, and whether a lobe holds it. */
const SLOT = 6

/** Paths `from` up to `to` of a trace. */
export function traceBatch(
  table: PhaseTable,
  trace: SlabTrace,
  from: number,
  to: number,
): TraceBatch {
  const { half, step, value, density, cumulative, lobeBins, lobeShare } = table
  const count = trace.suns.length
  const sunX = trace.suns.map((mu) => Math.sqrt(Math.max(0, 1 - mu * mu)))
  const sunZ = trace.suns
  const sum = new Float64Array(count)
  const squares = new Float64Array(count)
  const score = new Float64Array(count)
  const stack = new Float64Array(SLOT * STACK)
  const azimuth = (trace.azimuth * Math.PI) / 180
  const sine = Math.sqrt(Math.max(0, 1 - trace.viewMu * trace.viewMu))
  // z is depth from the lit face. Light to the detector travels along
  // (viewX, viewY, viewZ): out of the lit face, or out of the far one.
  const viewX = sine * Math.cos(azimuth)
  const viewY = sine * Math.sin(azimuth)
  const viewZ = trace.side === 'reflected' ? -trace.viewMu : trace.viewMu
  const startZ = trace.side === 'reflected' ? 0 : trace.depth
  const lobeEdge = lobeBins * step
  const coreEdge = table.coreBins * step

  // The direction drawn by the last `sample`.
  let ux = 0
  let uy = 0
  let uz = 0
  /** A direction at a bin's angle from an axis, among the first `last` bins, which hold `share`. */
  const sample = (
    rng: Rng,
    ax: number,
    ay: number,
    az: number,
    last: number,
    share: number,
  ): void => {
    const target = rng.next() * share
    let low = 0
    let high = last - 1
    while (low < high) {
      const middle = (low + high) >> 1
      if (cumulative[middle]! > target) high = middle
      else low = middle + 1
    }
    const j = low % half
    // Uniform in solid angle across the bin: uniform in w².
    const w2 = step * step * (j * j + rng.next() * (2 * j + 1))
    const cosine = low < half ? 1 - 2 * w2 : 2 * w2 - 1
    const sin = 2 * Math.sqrt(w2 * (1 - w2))
    const phi = 2 * Math.PI * rng.next()
    // Duff et al.'s branchless basis about the axis (JCGT 6(1), 2017).
    const sign = az >= 0 ? 1 : -1
    const a = -1 / (sign + az)
    const b = ax * ay * a
    const c = sin * Math.cos(phi)
    const s = sin * Math.sin(phi)
    ux = cosine * ax + c * (1 + sign * ax * ax * a) + s * b
    uy = cosine * ay + c * sign * b + s * (sign + ay * ay * a)
    uz = cosine * az - c * sign * ax - s * ay
    const norm = 1 / Math.sqrt(ux * ux + uy * uy + uz * uz)
    ux *= norm
    uy *= norm
    uz *= norm
  }
  /**
   * sin²(θ/2) between two directions, from the nearer axis: `behind` says
   * the axis is the backward one. Formed from the difference of the two
   * directions, because 1 − cos θ keeps eight digits at a milliradian and
   * the forward peak is all there.
   */
  let behind = false
  const halfAngle = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ): number => {
    behind = ax * bx + ay * by + az * bz < 0
    return behind
      ? ((ax + bx) ** 2 + (ay + by) ** 2 + (az + bz) ** 2) / 4
      : ((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2) / 4
  }
  /** The histogram's density at the angle `halfAngle` last measured. */
  const densityAt = (w2: number): number => {
    const j = Math.min(half - 1, Math.floor(Math.sqrt(w2) / step))
    return density[behind ? half + j : j]!
  }
  /** The convolved series at that angle, linear between its nodes. */
  const valueAt = (w2: number): number => {
    const x = Math.min(half, Math.sqrt(w2) / step)
    const j = Math.min(half - 1, Math.floor(x))
    const at = (behind ? half + 1 : 0) + j
    return value[at]! + (value[at + 1]! - value[at]!) * (x - j)
  }
  /**
   * The lobes' density at the last direction drawn. `inside` says whether
   * any lobe holds it, and `cored` whether any sun's core does.
   */
  let inside = false
  let cored = false
  const lobesAt = (): number => {
    let total = 0
    inside = false
    cored = false
    for (let k = 0; k < count; k += 1) {
      const w2 = halfAngle(ux, uy, uz, sunX[k]!, 0, sunZ[k]!)
      if (!behind && w2 < lobeEdge * lobeEdge) {
        total += densityAt(w2)
        inside = true
        cored ||= w2 < coreEdge * coreEdge
      }
    }
    return total / (count * lobeShare)
  }

  // Whether the detector's own direction is inside a lobe.
  ux = viewX
  uy = viewY
  uz = viewZ
  lobesAt()
  const startsCored = cored

  for (let index = from; index < to; index += 1) {
    const rng = Rng.fromSeed(deriveSeedInt(trace.seed, index))
    score.fill(0)
    let held = 1
    stack[0] = startZ
    stack[1] = viewX
    stack[2] = viewY
    stack[3] = viewZ
    stack[4] = 1
    stack[5] = startsCored ? 1 : 0
    while (held > 0) {
      held -= 1
      let z = stack[SLOT * held]!
      let dx = stack[SLOT * held + 1]!
      let dy = stack[SLOT * held + 2]!
      let dz = stack[SLOT * held + 3]!
      let weight = stack[SLOT * held + 4]!
      let within = stack[SLOT * held + 5]! === 1
      for (;;) {
        // Back along the light's direction to where it was last scattered.
        z -= dz * -Math.log(1 - rng.next())
        if (z < 0 || z > trace.depth) break
        for (let k = 0; k < count; k += 1)
          score[k] =
            score[k]! +
            weight *
              valueAt(halfAngle(dx, dy, dz, sunX[k]!, 0, sunZ[k]!)) *
              Math.exp(-z / sunZ[k]!)
        // The step is taken both ways only from outside the suns' cores. A
        // walk already headed along a sun reaches its cone by the phase
        // function half the time, and a lobe step from every collision of
        // every lobe step is a tree that grows without end.
        if (!within) {
          const k = Math.min(count - 1, Math.floor(rng.next() * count))
          sample(rng, sunX[k]!, 0, sunZ[k]!, lobeBins, lobeShare)
          const toward = densityAt(halfAngle(ux, uy, uz, dx, dy, dz))
          if (held >= STACK)
            throw new Error(
              'monteCarloSlab: a path holds more walks than its stack',
            )
          stack[SLOT * held] = z
          stack[SLOT * held + 1] = ux
          stack[SLOT * held + 2] = uy
          stack[SLOT * held + 3] = uz
          stack[SLOT * held + 4] = (weight * toward) / (toward + lobesAt())
          stack[SLOT * held + 5] = cored ? 1 : 0
          held += 1
        }
        sample(rng, dx, dy, dz, 2 * half, 1)
        const along = densityAt(halfAngle(ux, uy, uz, dx, dy, dz))
        const lobes = lobesAt()
        if (!within) weight *= along / (along + lobes)
        within = cored
        dx = ux
        dy = uy
        dz = uz
        if (!inside && weight < ROULETTE_UNDER) {
          if (rng.next() * ROULETTE_TO >= weight) break
          weight = ROULETTE_TO
        }
      }
    }
    for (let k = 0; k < count; k += 1) {
      sum[k] = sum[k]! + score[k]!
      squares[k] = squares[k]! + score[k]! * score[k]!
    }
  }
  return { paths: to - from, sum, squares }
}

/** A row's batches. */
export const BATCHES = 16

/**
 * χ² at fifteen degrees of freedom and one chance in a thousand: batch means
 * more scattered than this about their mean, for the error the paths
 * themselves report, are a row whose error cannot be believed.
 */
export const BATCH_CHI_LIMIT = 37.7

/** One direction's radiance under each sun, with what says whether to believe it. */
export interface TraceRow {
  readonly paths: number
  /** sr⁻¹ per unit of the sun's irradiance, a sun. */
  readonly mean: readonly number[]
  /** The mean's standard error, from the paths' own variance. */
  readonly error: readonly number[]
  /** χ² of the batch means about the mean, under that variance. */
  readonly chi: readonly number[]
}

/** The row sixteen batches make, summed in the order given. */
export function combineBatches(batches: readonly TraceBatch[]): TraceRow {
  const count = batches[0]!.sum.length
  const paths = batches.reduce((total, batch) => total + batch.paths, 0)
  const mean: number[] = []
  const error: number[] = []
  const chi: number[] = []
  for (let k = 0; k < count; k += 1) {
    let sum = 0
    let squares = 0
    for (const batch of batches) {
      sum += batch.sum[k]!
      squares += batch.squares[k]!
    }
    const average = sum / paths
    const variance = Math.max(0, squares / paths - average * average)
    let scatter = 0
    for (const batch of batches)
      scatter +=
        (batch.sum[k]! / batch.paths - average) ** 2 / (variance / batch.paths)
    mean.push(average)
    error.push(Math.sqrt(variance / paths))
    chi.push(scatter)
  }
  return { paths, mean, error, chi }
}

/** Batch `batch` of a row of `paths`: its own consecutive share. */
export function batchRange(
  paths: number,
  batch: number,
): readonly [from: number, to: number] {
  return [
    Math.floor((paths * batch) / BATCHES),
    Math.floor((paths * (batch + 1)) / BATCHES),
  ]
}

/**
 * The row, or a refusal: a row whose batch means are not consistent with
 * its own standard error has an error that cannot be believed, and a
 * heavy-tailed score reports too small an error until its rare paths are
 * drawn.
 */
export function acceptRow(row: TraceRow): TraceRow {
  const worst = Math.max(...row.chi)
  if (!(worst <= BATCH_CHI_LIMIT))
    throw new Error(
      `monteCarloSlab: refused, batch means scatter at χ² ${worst.toFixed(1)} over ${BATCH_CHI_LIMIT} for the paths' own error`,
    )
  return row
}

/** A whole row, every batch in this process. */
export function traceRow(
  table: PhaseTable,
  trace: SlabTrace,
  paths: number,
): TraceRow {
  return acceptRow(
    combineBatches(
      Array.from({ length: BATCHES }, (_, batch) =>
        traceBatch(table, trace, ...batchRange(paths, batch)),
      ),
    ),
  )
}
