import { Vec, type Vec3, vec3 } from '@inertialref/spatial'
import {
  type AdvanceBeat,
  type LinePath,
  linePosition,
  lineVelocity,
  type ScreenBeat,
  screenDirection,
} from '@inertialref/rendering'

/*
 * Fitting a `LinePath` to measured beats.
 *
 * A beat is what a tracked box reports — a screen mark, a range recovered from
 * an apparent size, a frame — and a `LinePath` is a straight line in camera
 * axes plus a throttle. Against a locked camera a straight ship is a straight
 * image line, so the two meet cleanly: the direction is whatever line projects
 * closest to the marks, and the throttle is wherever along that line each
 * beat's range puts the hull.
 *
 * A solver, so it lives here and never on the sample path: `rendering` only
 * evaluates the result. A script calls it offline, or a test calls it to hold a
 * landed rail to the beats it came from.
 */

/** A measured beat, and how much the direction fit should listen to it. */
export interface FitBeat extends ScreenBeat {
  /**
   * Relative weight in the direction fit. Absent means 1; 0 drops the beat
   * entirely — from the fit and from the throttle — because a beat whose range
   * is not a measurement has nowhere honest to put a knot.
   */
  readonly weight?: number
}

export interface LinePathFitOptions {
  /** The lens the marks were measured through, degrees. */
  readonly fov: number
  readonly aspect: number
  /**
   * The frame of a beat the line passes through exactly, at its mark and its
   * range. Absent, the line is free: its four degrees of freedom are all
   * fitted, which is what a dense track wants and a hand-read beat list does
   * not — at 36 km every line through an entry mark looks the same, and only
   * the near beats can see the impact parameter.
   */
  readonly pin?: number
  /**
   * How far back down the line the anchor sits from the pin, meters. Every
   * advance is then positive, so the log spline has a coordinate for every
   * knot; it needs to exceed the distance from the pin to the earliest beat.
   */
  readonly reach: number
  /**
   * The direction of flight, when something other than the beats fixes it — a
   * departure's lens spike, say. Absent, it is fitted.
   */
  readonly direction?: Vec3
  /**
   * Frames left out of the direction fit and kept as throttle knots: a beat
   * whose range is good and whose mark is a known disagreement, such as a
   * channel splice.
   */
  readonly exclude?: readonly number[]
}

export interface LinePathFit {
  readonly path: LinePath
  /** Screen distance from each beat's mark to the path at its frame. */
  readonly residuals: readonly { frame: number; error: number }[]
  /** Weighted rms of `residuals` over the beats the direction was fitted to. */
  readonly rms: number
  /** Knots the solver added so the throttle cannot reverse. */
  readonly fillers: readonly number[]
}

/**
 * Fit a straight line and its throttle to measured beats.
 *
 * **The residual is a fraction of the frame, not a distance in meters.** A
 * line least-squared through the beats as camera-space points answers the
 * wrong question: an approach spans decades of range, so the far beats carry
 * nearly all the leverage and nearly none of the picture. Each candidate line
 * is scored instead by projecting, for every beat, the point on it at that
 * beat's range back to the screen and measuring the distance to the mark — the
 * same distance `cutscene.test.ts` holds a landed rail to.
 *
 * **The throttle is the range, solved.** The advance at which a point on the
 * line sits a given distance from the lens is a quadratic in the advance. Of
 * its two roots the one kept is the one that projects nearer the mark, since
 * one is on the near side of closest approach and one on the far; a range the
 * line never comes within takes the closest approach.
 *
 * **The throttle never reverses**, which is `cutscene.test.ts`'s audit. Two
 * things break it. A noisy range list is not monotone, so the knots are pooled
 * to the nearest non-decreasing sequence first. And the log-distance spline
 * overshoots between knots that are far apart in log — a six-fold closing
 * beside a one-and-a-half-fold one backs the hull up — so wherever a
 * quarter-frame sample reverses, a knot is added that grades the slope across
 * the junction responsible, until none does.
 */
export function fitLinePath(
  beats: readonly FitBeat[],
  options: LinePathFitOptions,
): LinePathFit {
  const { fov, aspect, reach } = options
  const kept = beats
    .filter((beat) => (beat.weight ?? 1) > 0)
    .slice()
    .sort((a, b) => a.frame - b.frame)
  if (kept.length < 2)
    throw new Error('fitLinePath needs at least two weighted beats')
  const excluded = new Set(options.exclude ?? [])
  const fitted = kept.filter((beat) => !excluded.has(beat.frame))
  const points = kept.map((beat) =>
    Vec.scale(screenDirection(beat.x, beat.y, fov, aspect), beat.range),
  )

  const pinIndex =
    options.pin === undefined
      ? centralIndex(kept)
      : kept.findIndex((beat) => beat.frame === options.pin)
  if (pinIndex < 0) throw new Error(`fitLinePath: no beat at f${options.pin}`)
  const pinPoint = points[pinIndex] as Vec3
  const free = options.pin === undefined

  const start =
    options.direction ?? principalDirection(kept, points, fitted.length)
  const lineFor = (params: readonly number[]): Line => {
    const direction =
      options.direction ??
      tilted(start, params[0] as number, params[1] as number)
    const { u, v } = basis(direction)
    const through = free
      ? Vec.add(
          pinPoint,
          Vec.add(
            Vec.scale(u, params[2] as number),
            Vec.scale(v, params[3] as number),
          ),
        )
      : pinPoint
    return { anchor: Vec.sub(through, Vec.scale(direction, reach)), direction }
  }
  const cost = (params: readonly number[]): number => {
    const line = lineFor(params)
    let sum = 0
    for (const beat of fitted) {
      const t = advanceFor(line, beat, fov, aspect)
      sum +=
        (beat.weight ?? 1) *
        screenError(pointAt(line, t), beat, fov, aspect) ** 2
    }
    return sum
  }

  const dims = (options.direction === undefined ? 2 : 0) + (free ? 2 : 0)
  const scale = Vec.length(pinPoint)
  const steps = [0.05, 0.05, 0.02 * scale, 0.02 * scale].slice(
    options.direction === undefined ? 0 : 2,
  )
  const best = dims === 0 ? [] : minimize(cost, dims, steps)
  const line = lineFor(options.direction === undefined ? best : [0, 0, ...best])

  // The throttle: one knot per kept beat, each the root of its own range.
  const knots: Knot[] = kept.map((beat, index) => ({
    frame: beat.frame,
    t:
      index === pinIndex && !free ? reach : advanceFor(line, beat, fov, aspect),
    weight: index === pinIndex && !free ? 1e9 : (beat.weight ?? 1),
  }))
  if (knots.some((knot) => !(knot.t > 0)))
    throw new Error(
      'fitLinePath: a beat lies behind the anchor. Raise `reach` past it.',
    )
  const pooled = pool(knots)
  const { advance, fillers } = unreversed(line, pooled)
  const path: LinePath = { ...line, advance }

  const residuals = kept.map((beat) => ({
    frame: beat.frame,
    error: screenError(linePosition(path, beat.frame), beat, fov, aspect),
  }))
  let sum = 0
  let weight = 0
  for (const [index, beat] of kept.entries()) {
    if (excluded.has(beat.frame)) continue
    const w = beat.weight ?? 1
    sum += w * (residuals[index] as { error: number }).error ** 2
    weight += w
  }
  return { path, residuals, rms: Math.sqrt(sum / weight), fillers }
}

/* ------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* ------------------------------------------------------------------------- */

interface Line {
  readonly anchor: Vec3
  readonly direction: Vec3
}

interface Knot {
  readonly frame: number
  readonly t: number
  readonly weight: number
}

const pointAt = (line: Line, t: number): Vec3 =>
  Vec.add(line.anchor, Vec.scale(line.direction, t))

/** Where a camera-space point lands on the frame; null behind the lens. */
function project(
  point: Vec3,
  fov: number,
  aspect: number,
): { x: number; y: number } | null {
  const depth = -point.z
  if (depth <= 1e-9) return null
  const tanHalf = Math.tan((fov * Math.PI) / 360)
  return {
    x: 0.5 + point.x / depth / (2 * tanHalf * aspect),
    y: 0.5 - point.y / depth / (2 * tanHalf),
  }
}

/**
 * Screen distance from a point to a beat's mark, in the units the marks are in.
 * A point behind the lens is as wrong as a point can usefully be, and still a
 * finite number for the minimizer to walk away from.
 */
function screenError(
  point: Vec3,
  beat: ScreenBeat,
  fov: number,
  aspect: number,
): number {
  const at = project(point, fov, aspect)
  return at === null ? 10 : Math.hypot(at.x - beat.x, at.y - beat.y)
}

/**
 * The advance at which the line is `beat.range` from the lens, on the side of
 * closest approach that projects nearer the mark. `|anchor + t·d|² = r²` is
 * `t² + 2bt + c = 0` for unit `d`.
 */
function advanceFor(
  line: Line,
  beat: ScreenBeat,
  fov: number,
  aspect: number,
): number {
  const b = Vec.dot(line.anchor, line.direction)
  const c = Vec.dot(line.anchor, line.anchor) - beat.range * beat.range
  const disc = b * b - c
  if (disc <= 0) return -b
  const root = Math.sqrt(disc)
  const near = -b - root
  const far = -b + root
  return screenError(pointAt(line, near), beat, fov, aspect) <=
    screenError(pointAt(line, far), beat, fov, aspect)
    ? near
    : far
}

/** Two unit vectors perpendicular to `d` and to each other. */
function basis(d: Vec3): { u: Vec3; v: Vec3 } {
  const helper = Math.abs(d.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)
  const u = Vec.normalize(Vec.cross(helper, d))
  return { u, v: Vec.cross(d, u) }
}

const tilted = (d: Vec3, a: number, b: number): Vec3 => {
  const { u, v } = basis(d)
  return Vec.normalize(Vec.add(d, Vec.add(Vec.scale(u, a), Vec.scale(v, b))))
}

/**
 * A starting direction: the principal axis of the beats as points, signed so
 * that later beats are further along it. Biased toward the far beats for the
 * reason the fit is not done in meters, and only ever a place to start.
 */
function principalDirection(
  beats: readonly FitBeat[],
  points: readonly Vec3[],
  count: number,
): Vec3 {
  if (count < 2)
    throw new Error('fitLinePath needs two fitted beats to find a direction')
  let total = 0
  let mean = vec3(0, 0, 0)
  for (const [index, point] of points.entries()) {
    const w = (beats[index] as FitBeat).weight ?? 1
    mean = Vec.add(mean, Vec.scale(point, w))
    total += w
  }
  mean = Vec.scale(mean, 1 / total)
  // Power iteration on the weighted scatter matrix, seeded with the chord.
  let axis = Vec.normalize(
    Vec.sub(points[points.length - 1] as Vec3, points[0] as Vec3),
  )
  for (let iteration = 0; iteration < 64; iteration += 1) {
    let next = vec3(0, 0, 0)
    for (const [index, point] of points.entries()) {
      const w = (beats[index] as FitBeat).weight ?? 1
      const offset = Vec.sub(point, mean)
      next = Vec.add(next, Vec.scale(offset, w * Vec.dot(offset, axis)))
    }
    if (Vec.length(next) < 1e-12) break
    axis = Vec.normalize(next)
  }
  // Signed by the correlation of advance with frame, both centered.
  let frames = 0
  for (const beat of beats) frames += (beat.weight ?? 1) * beat.frame
  frames /= total
  let trend = 0
  for (const [index, point] of points.entries()) {
    const beat = beats[index] as FitBeat
    trend +=
      (beat.weight ?? 1) *
      (beat.frame - frames) *
      Vec.dot(Vec.sub(point, mean), axis)
  }
  return trend >= 0 ? axis : Vec.scale(axis, -1)
}

/** The heaviest beat nearest the weighted middle of the pass. */
function centralIndex(beats: readonly FitBeat[]): number {
  let total = 0
  let frame = 0
  for (const beat of beats) {
    total += beat.weight ?? 1
    frame += (beat.weight ?? 1) * beat.frame
  }
  frame /= total
  let best = 0
  for (const [index, beat] of beats.entries())
    if (
      Math.abs(beat.frame - frame) <
      Math.abs((beats[best] as FitBeat).frame - frame)
    )
      best = index
  return best
}

/* ------------------------------------------------------------------------- */
/* Minimizer                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Nelder–Mead, restarted from its own best point until a restart stops
 * improving. Deterministic: the simplex is built from fixed steps, so the same
 * beats give the same line on every machine. Two to four parameters, smooth
 * cost; nothing here needs a gradient.
 */
function minimize(
  cost: (params: readonly number[]) => number,
  dims: number,
  steps: readonly number[],
): number[] {
  let best = new Array<number>(dims).fill(0)
  let bestCost = cost(best)
  let shrink = 1
  for (let restart = 0; restart < 12; restart += 1) {
    const result = nelderMead(
      cost,
      best,
      steps.map((step) => step * shrink),
    )
    const improved = result.cost < bestCost * (1 - 1e-12) - 1e-30
    if (result.cost <= bestCost) {
      best = result.point
      bestCost = result.cost
    }
    if (!improved && restart > 1) break
    shrink *= 0.3
  }
  return best
}

function nelderMead(
  cost: (params: readonly number[]) => number,
  start: readonly number[],
  steps: readonly number[],
): { point: number[]; cost: number } {
  const n = start.length
  let simplex = [start.slice()]
  for (let i = 0; i < n; i += 1) {
    const vertex = start.slice()
    vertex[i] = (vertex[i] as number) + (steps[i] as number)
    simplex.push(vertex)
  }
  let costs = simplex.map(cost)
  const combine = (a: readonly number[], b: readonly number[], k: number) =>
    a.map((value, i) => value + k * ((b[i] as number) - value))
  for (let iteration = 0; iteration < 4000; iteration += 1) {
    const order = costs.map((_, i) => i).sort((a, b) => costs[a]! - costs[b]!)
    simplex = order.map((i) => simplex[i] as number[])
    costs = order.map((i) => costs[i] as number)
    const lowest = costs[0] as number
    const highest = costs[n] as number
    if (highest - lowest <= 1e-16 * (Math.abs(lowest) + 1e-30)) break
    const centroid = new Array<number>(n).fill(0)
    for (let i = 0; i < n; i += 1)
      for (let j = 0; j < n; j += 1)
        centroid[j] = (centroid[j] as number) + (simplex[i]![j] as number) / n
    const worst = simplex[n] as number[]
    const reflected = combine(centroid, worst, -1)
    const reflectedCost = cost(reflected)
    if (reflectedCost < lowest) {
      const expanded = combine(centroid, worst, -2)
      const expandedCost = cost(expanded)
      if (expandedCost < reflectedCost) {
        simplex[n] = expanded
        costs[n] = expandedCost
      } else {
        simplex[n] = reflected
        costs[n] = reflectedCost
      }
    } else if (reflectedCost < (costs[n - 1] as number)) {
      simplex[n] = reflected
      costs[n] = reflectedCost
    } else {
      const contracted = combine(centroid, worst, 0.5)
      const contractedCost = cost(contracted)
      if (contractedCost < highest) {
        simplex[n] = contracted
        costs[n] = contractedCost
      } else {
        const anchor = simplex[0] as number[]
        simplex = simplex.map((vertex, i) =>
          i === 0 ? vertex : combine(anchor, vertex, 0.5),
        )
        costs = simplex.map((vertex, i) =>
          i === 0 ? (costs[0] as number) : cost(vertex),
        )
      }
    }
  }
  let index = 0
  for (let i = 1; i <= n; i += 1)
    if ((costs[i] as number) < (costs[index] as number)) index = i
  return { point: simplex[index] as number[], cost: costs[index] as number }
}

/* ------------------------------------------------------------------------- */
/* Throttle                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The nearest non-decreasing advance, by weighted pool-adjacent-violators in
 * log distance, with every pooled run collapsed to one knot at its weighted
 * mean frame. Collapsed rather than repeated: two equal knots are a stop, and a
 * Catmull-Rom carries its neighbors' slope into a stop and overshoots it.
 */
function pool(knots: readonly Knot[]): AdvanceBeat[] {
  const blocks: { frame: number; log: number; weight: number }[] = []
  for (const knot of knots) {
    blocks.push({
      frame: knot.frame,
      log: Math.log(knot.t),
      weight: knot.weight,
    })
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!
      const before = blocks[blocks.length - 2]!
      if (before.log < last.log) break
      const weight = before.weight + last.weight
      blocks.splice(blocks.length - 2, 2, {
        frame:
          (before.frame * before.weight + last.frame * last.weight) / weight,
        log: (before.log * before.weight + last.log * last.weight) / weight,
        weight,
      })
    }
  }
  return blocks.map((block) => ({ frame: block.frame, t: Math.exp(block.log) }))
}

/**
 * Split segments until no quarter-frame sample of the throttle reverses.
 *
 * A Catmull-Rom tangent is a weighted mean of the two slopes beside its knot,
 * and a Hermite segment cannot reverse while both its tangents are within
 * three times its own slope. So a reversal is a junction where two neighboring
 * slopes, in log distance per frame, differ by a large ratio — a six-fold
 * closing beside a one-and-a-half-fold one, or a pooled run that is nearly
 * flat beside one that is not. The fix grades the junction: of the two
 * junctions of the reversing segment the one with the larger ratio is taken,
 * and its steeper side is split at its midpoint frame so that the piece beside
 * the junction runs at the geometric mean of the two slopes. Each split takes
 * the ratio at that junction to its square root and leaves the steeper side's
 * remainder within about twice that of its new neighbor, so the ratios fall
 * toward one and the loop ends.
 */
function unreversed(
  line: Line,
  start: readonly AdvanceBeat[],
): { advance: AdvanceBeat[]; fillers: number[] } {
  const frames = start.map((knot) => knot.frame)
  const logs = start.map((knot) => Math.log(knot.t))
  const fillers: number[] = []
  const slope = (i: number): number =>
    ((logs[i + 1] as number) - (logs[i] as number)) /
    ((frames[i + 1] as number) - (frames[i] as number))
  for (let split = 0; split < 256; split += 1) {
    const path: LinePath = {
      ...line,
      advance: frames.map((frame, i) => ({
        frame,
        t: Math.exp(logs[i] as number),
      })),
    }
    const first = frames[0] as number
    const last = frames[frames.length - 1] as number
    let reversal: number | null = null
    for (let f = first; f <= last; f += 0.25)
      if (Vec.dot(lineVelocity(path, f), line.direction) < 0) {
        reversal = f
        break
      }
    if (reversal === null) return { advance: path.advance.slice(), fillers }
    let segment = 0
    while (
      segment + 2 < frames.length &&
      reversal >= (frames[segment + 1] as number)
    )
      segment += 1
    // The junction with the larger slope ratio, and which side is steeper.
    let junction: { left: number; ratio: number } | null = null
    for (const left of [segment - 1, segment]) {
      if (left < 0 || left + 2 >= frames.length) continue
      const a = Math.max(slope(left), 1e-300)
      const b = Math.max(slope(left + 1), 1e-300)
      const ratio = Math.max(a / b, b / a)
      if (junction === null || ratio > junction.ratio)
        junction = { left, ratio }
    }
    if (junction === null)
      throw new Error(`fitLinePath: the throttle reverses at f${reversal}`)
    const leftSteeper = slope(junction.left) > slope(junction.left + 1)
    const steep = leftSteeper ? junction.left : junction.left + 1
    const flat = leftSteeper ? junction.left + 1 : junction.left
    const a = frames[steep] as number
    const b = frames[steep + 1] as number
    if (b - a < 1 / 1024)
      throw new Error(
        `fitLinePath: the throttle reverses at f${reversal} and the segment ` +
          'beside it is already a thousandth of a frame wide',
      )
    const frame =
      b - a >= 2 && Number.isInteger(a) && Number.isInteger(b)
        ? Math.floor((a + b) / 2)
        : (a + b) / 2
    const graded = Math.sqrt(
      Math.max(slope(flat), slope(steep) * 1e-12) * slope(steep),
    )
    // Measured from the shared knot: the steep segment's start if it lies to
    // the right of the junction, its end if to the left.
    const log = leftSteeper
      ? (logs[steep + 1] as number) - graded * (b - frame)
      : (logs[steep] as number) + graded * (frame - a)
    frames.splice(steep + 1, 0, frame)
    logs.splice(steep + 1, 0, log)
    fillers.push(frame)
  }
  throw new Error('fitLinePath: the throttle still reverses after 256 splits')
}
