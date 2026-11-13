import { deriveSeed, Rng, type Seed } from '@inertialref/procedural'
import {
  mediumAt,
  PHASE_CONE_NODE,
  PHASE_NODE,
  phaseConeReach,
  phaseDensity,
  phaseNodeAt,
  phaseRow,
  phaseSample,
  type SkyByDirection,
  skyByDirection,
  TRACE_BRICK,
  type TraceMedium,
  type TracePhase,
} from '@inertialref/rendering'

/*
 * The float64 path tracer: the radiance leaving a heterogeneous cloud, by
 * every order of scattering, on the true medium. The unscaled extinction
 * and the whole Mie phase, peak included (phase 1 design §5.11): the scaled
 * medium is the march's approximation, and a reference that shared it would
 * not test it.
 *
 * **A backward analog walk.** A path starts at the eye. Free flights are
 * drawn by delta tracking against each brick's greatest extinction, the
 * phase by the inverse of its own cumulative share, and the albedo is one,
 * so a walk carries no weight: its throughput is one until it ends on the
 * sky or meets the ground. Under a uniform sky with no sun every path then
 * returns the sky's radiance exactly, which is the furnace, and is why the
 * phase is sampled from the same piecewise form it is evaluated by.
 *
 * **The sun is found by two estimators that share no path.** Drawing a
 * point of the disk at every scattering and adding its light through the
 * phase is exact and useless alone: the droplets' forward peak is hundreds
 * of sr⁻¹ inside a degree or two, a walk's direction falls in it about once
 * in a thousand scatterings, and those rare terms carry most of the answer.
 * Weighing the drawn point against a walk that finds the disk by itself
 * (`estimator: 'disk'`) does not help, because the disk is narrower than
 * the peak.
 *
 * So the paths are split by how they reach the sun (`estimator: 'cone'`).
 * Take the cone of 9.4° about the sun. A light path's last directions before
 * the sun, read from the eye, are a run of some length inside that cone:
 *
 * - **A run of none** is a vertex whose incoming direction is outside the
 *   cone. The drawn point of the disk serves it, through a phase that is
 *   bounded there.
 * - **A run of one or more** is a chain: from a vertex reached from outside
 *   the cone, a direction inside it, a flight, and a scattering toward the
 *   sun, and on from there while the directions stay inside. A chain's
 *   direction is one of two candidates, drawn by the phase about the ray
 *   and by the phase laid about the sun itself, weighed by the balance of
 *   the two densities and chosen by what each is worth to the next term. So
 *   `p(u·v)·p(v·s)` is divided by a density that is large wherever either
 *   factor is, and a chain's terms stay the size of its first. A chain ends
 *   when it leaves the cloud or by roulette, and carries its weight no
 *   further, so no weight is ever multiplied along the hundreds of
 *   scatterings of the walk itself.
 *
 * Every path from the sun to the eye has one run length and so belongs to
 * exactly one of the two, and the walk between them is analog.
 *
 * Measured on this Mac mini (Mac18,5, Apple M6): a pixel through the core
 * of the analytic cumulus, lit from the side, has a variance a sample of
 * 3.76 under `'disk'` (10⁶ samples) and 0.019 under `'cone'` (2 × 10⁵), two
 * hundred times less, for about three times the time a path; both give
 * 0.047, and sixteen batches of the second agree with its own error. A
 * conservative slab of depth 8 has its reflected flux to 14% from 30,000
 * paths under `'disk'` and to 1.1% under `'cone'`. The cone's angle is not
 * critical: from 6° to 16° the variance moves inside its own noise.
 *
 * **One band a path.** The bands share an extinction and differ in phase. A
 * path that carried three would weigh each by a ratio of phases at every
 * scattering, and the product over the hundreds of scatterings of a path
 * through a cumulus's core has no usable variance. A sample of a pixel is
 * three paths, a stream each.
 *
 * Positions are in the medium's cell coordinates and distances in meters:
 * `TraceMedium` says what a cell coordinate is.
 */

type Triple = readonly [number, number, number]

export interface TraceSun {
  /** Unit, toward the sun, in the grid's east, up and north. */
  readonly direction: Triple
  /** A band's irradiance on a face turned to the sun. */
  readonly irradiance: Triple
  /** The disk's angular radius, radians. Zero is a point sun. */
  readonly angularRadius: number
}

/**
 * The sky a cloud stands under, in one of two forms.
 *
 * - **Linear in direction** (`LinearSky`): three moments a band, as the
 *   march's table gives them (§5.6). A direction `ω` sees
 *   `mean·max(0, 1 + ¾·(up·ω_y + sunward·ω·ŝ_h))`, the sky linear in
 *   direction that has exactly those moments, and the one the march's own
 *   sky term is the thin-cloud limit under.
 * - **By direction** (`SkyByDirection`): the air's own radiance at a
 *   quadrature's directions, read between them in the sun's frame. A
 *   reference lit by the linear sky shares the march's form, so it could
 *   not see that form's error: under the air's own sky the linear sky's
 *   sides stand 2% to 234% bright (ruling 007).
 *
 * A path that leaves the medium takes the sky at its direction, upward or
 * downward. Over a ground, a downward path meets the ground first, so the
 * sky's lower half is read only where there is none.
 */
export type TraceSky = LinearSky | SkyByDirection

/** The sky linear in direction: the mean radiance over the sphere and the two irradiance differences, per band. */
export interface LinearSky {
  readonly mean: Triple
  readonly up: Triple
  readonly sunward: Triple
}

/** A Lambertian ground under the grid, level, lit by the sun through the cloud and by the sky. */
export interface TraceGround {
  /** Its height, meters from the grid's low corner; at or under the medium. */
  readonly height: number
  readonly albedo: number
}

export interface TraceScene {
  readonly medium: TraceMedium
  readonly phase: TracePhase
  /**
   * The sun, or none. The sky's `sunward` term is laid on the sun's bearing,
   * so a scene with no sun takes a sky with none of it; the sky alone under
   * a case's sun is that sun at an irradiance of zero.
   */
  readonly sun: TraceSun | null
  readonly sky: TraceSky
  readonly ground: TraceGround | null
  /**
   * The scatterings a path may make before it is dropped: 1 keeps first
   * order alone, 0 the light that crosses unscattered. A closed form of one
   * order is what a test holds the tracer to; a reference traces every
   * order, at `Infinity`.
   */
  readonly orders: number
  /**
   * The first scattering whose sunlight is counted: 1 where it is left out,
   * which is every order, and 2 for the orders past the first alone. The
   * walk and the sky's light are the same either way. It is how the
   * renderer's scaled medium is put together from two media: first order on
   * the whole phase, and the scaled phase's orders past it (§5.1).
   */
  readonly first?: number
  /** How the sun is found: the file's header says what each is. A reference is `'cone'`. */
  readonly estimator: 'cone' | 'disk'
}

/** A sky that is dark, and one that is `radiance` in every direction. */
export const uniformSky = (radiance: number): LinearSky => ({
  mean: [radiance, radiance, radiance],
  up: [0, 0, 0],
  sunward: [0, 0, 0],
})

/**
 * Scatterings a path is followed through. A path through the densest
 * cumulus makes thousands; one that reaches this is counted in `truncated`
 * and its light so far is kept, so a reference with any truncated path says
 * so.
 */
const MAX_SCATTERINGS = 1_000_000
/** Below this a shadow ray's transmittance is dropped as zero. */
const DARK = 1e-12
/** A cell coordinate's nudge along the ray, so a point on a brick's face is in the brick ahead. */
const NUDGE = 1e-7

export interface Tracer {
  /**
   * One path's radiance in a band: from `origin`, meters from the grid's
   * low corner, along a unit `direction`.
   */
  radiance(origin: Triple, direction: Triple, band: number, rng: Rng): number
  /** One ratio-tracked estimate of the transmittance from a point along a unit direction. */
  transmittance(origin: Triple, direction: Triple, rng: Rng): number
  /** The blend of rows' density at a radius, sr⁻¹, at the cosine `cosine`. */
  density(radius: number, band: number, cosine: number): number
  /** Paths, their walks' scatterings, their chains' scatterings, and the paths that reached the cap, since the tracer was made. */
  readonly counts: {
    paths: number
    scatterings: number
    chained: number
    truncated: number
  }
}

/** A tracer of one scene. It keeps a ray's state between calls and is not reentrant. */
export function createTracer(scene: TraceScene): Tracer {
  const { medium, phase, sun, sky, ground } = scene
  const { majorant } = medium
  const cellX = medium.cell[0]
  const cellY = medium.cell[1]
  const cellZ = medium.cell[2]
  const bricksX = medium.bricks[0]
  const bricksY = medium.bricks[1]
  const bricksZ = medium.bricks[2]
  const highX = TRACE_BRICK * bricksX
  const highY = TRACE_BRICK * bricksY
  const highZ = TRACE_BRICK * bricksZ
  const counts = { paths: 0, scatterings: 0, chained: 0, truncated: 0 }
  const at = new Float64Array(2)
  const drawn = new Float64Array(3)

  // No sun is no bearing. A sky that leans toward one would be drawn with
  // that term at nothing and no word of it: 41% dark in a rim toward the
  // sun and three times too bright in one seen from behind. A sky by
  // direction is named by its bearing from the sun throughout.
  const linear = 'mean' in sky ? sky : null
  if (
    sun === null &&
    (linear === null || linear.sunward.some((value) => value !== 0))
  )
    throw new Error(
      linear === null
        ? 'pathTrace: a sky by direction needs a sun for its bearing; give the sun an irradiance of zero'
        : 'pathTrace: a sky with a sunward term needs a sun for its bearing; give the sun an irradiance of zero',
    )

  // The sun's disk: its solid angle is 2π·(1 − cos α), and a point of it is
  // drawn uniformly in that.
  const sunX = sun?.direction[0] ?? 0
  const sunY = sun?.direction[1] ?? 1
  const sunZ = sun?.direction[2] ?? 0
  const diskReach = sun === null ? 0 : 2 * Math.sin(sun.angularRadius / 2) ** 2
  const diskDensity = diskReach > 0 ? 1 / (2 * Math.PI * diskReach) : 0
  const flat = Math.hypot(sunX, sunZ)
  const sunwardX = flat > 0 ? sunX / flat : 0
  const sunwardZ = flat > 0 ? sunZ / flat : 0

  // The ray a walk or a shadow is on: a point in cells, a unit direction,
  // and the direction in cells a meter.
  let qx = 0
  let qy = 0
  let qz = 0
  let ux = 0
  let uy = 0
  let uz = 1
  let ex = 0
  let ey = 0
  let ez = 0
  // The direction the last draw gave.
  let wx = 0
  let wy = 0
  let wz = 0

  const aim = (x: number, y: number, z: number): void => {
    ux = x
    uy = y
    uz = z
    ex = x / cellX
    ey = y / cellY
    ez = z / cellZ
  }

  /** Whether the ray's point, nudged ahead, is in the domain. */
  const inside = (): boolean => {
    const x = qx + Math.sign(ex) * NUDGE
    const y = qy + Math.sign(ey) * NUDGE
    const z = qz + Math.sign(ez) * NUDGE
    return x >= 0 && x < highX && y >= 0 && y < highY && z >= 0 && z < highZ
  }

  /** Moves a ray that starts outside the domain to where it enters; false where it never does. */
  const enter = (): boolean => {
    if (inside()) return true
    let near = 0
    let far = Infinity
    const slab = (q: number, e: number, high: number): boolean => {
      if (e === 0) return q >= 0 && q < high
      const t0 = -q / e
      const t1 = (high - q) / e
      near = Math.max(near, Math.min(t0, t1))
      far = Math.min(far, Math.max(t0, t1))
      return true
    }
    if (!slab(qx, ex, highX) || !slab(qy, ey, highY) || !slab(qz, ez, highZ))
      return false
    if (!(far > near)) return false
    qx += ex * near
    qy += ey * near
    qz += ez * near
    return inside()
  }

  /** The brick the ray's point is in, by its three indices, and the meters to its far face. */
  let brick = 0
  const reach = (): number => {
    const bx = Math.floor((qx + Math.sign(ex) * NUDGE) / TRACE_BRICK)
    const by = Math.floor((qy + Math.sign(ey) * NUDGE) / TRACE_BRICK)
    const bz = Math.floor((qz + Math.sign(ez) * NUDGE) / TRACE_BRICK)
    brick = (by * bricksZ + bz) * bricksX + bx
    let t = Infinity
    if (ex !== 0)
      t = Math.min(t, ((bx + (ex > 0 ? 1 : 0)) * TRACE_BRICK - qx) / ex)
    if (ey !== 0)
      t = Math.min(t, ((by + (ey > 0 ? 1 : 0)) * TRACE_BRICK - qy) / ey)
    if (ez !== 0)
      t = Math.min(t, ((bz + (ez > 0 ? 1 : 0)) * TRACE_BRICK - qz) / ez)
    return Math.max(0, t)
  }

  /**
   * Delta tracking: moves the ray to its next scattering and leaves the
   * medium there in `at`; false where the ray leaves the domain first. A
   * flight drawn past a brick's face is drawn again in the next brick,
   * which the exponential's lack of memory allows.
   */
  const walk = (rng: Rng): boolean => {
    while (inside()) {
      const t = reach()
      const bound = majorant[brick]!
      if (bound > 0) {
        let s = 0
        for (;;) {
          s -= Math.log(1 - rng.next()) / bound
          if (s >= t) break
          mediumAt(medium, qx + ex * s, qy + ey * s, qz + ez * s, at)
          if (rng.next() * bound < at[0]!) {
            qx += ex * s
            qy += ey * s
            qz += ez * s
            return true
          }
        }
      }
      qx += ex * t
      qy += ey * t
      qz += ez * t
    }
    return false
  }

  /**
   * Ratio tracking along the ray from its point: the product of
   * `1 − σ/σ̄` over the collisions a flight against the bound would have
   * had, whose mean is the transmittance and which is never a zero or a one
   * alone.
   */
  const shadow = (rng: Rng): number => {
    if (!enter()) return 1
    let transmittance = 1
    while (inside()) {
      const t = reach()
      const bound = majorant[brick]!
      if (bound > 0) {
        let s = 0
        for (;;) {
          s -= Math.log(1 - rng.next()) / bound
          if (s >= t) break
          mediumAt(medium, qx + ex * s, qy + ey * s, qz + ez * s, at)
          transmittance *= 1 - at[0]! / bound
          if (transmittance < DARK) return 0
        }
      }
      qx += ex * t
      qy += ey * t
      qz += ez * t
    }
    return transmittance
  }

  /** The sun's transmittance to the walk's point along the last drawn direction, with the walk's ray put back. */
  const sunlit = (rng: Rng): number => {
    const px = qx
    const py = qy
    const pz = qz
    const dx = ux
    const dy = uy
    const dz = uz
    aim(wx, wy, wz)
    const transmittance = shadow(rng)
    qx = px
    qy = py
    qz = pz
    aim(dx, dy, dz)
    return transmittance
  }

  /**
   * A unit direction at `m = 1 − cos θ`, `s = 1 + cos θ` from the axis
   * `(ax, ay, az)` and at `azimuth` about it, into `w`. The frame is Duff et
   * al.'s (2017), which has no pole a direction can fall on.
   */
  const turn = (
    ax: number,
    ay: number,
    az: number,
    m: number,
    s: number,
    azimuth: number,
  ): void => {
    const sign = az >= 0 ? 1 : -1
    const a = -1 / (sign + az)
    const b = ax * ay * a
    const sine = Math.sqrt(Math.max(0, m * s))
    const cosine = 1 - m
    const c = sine * Math.cos(azimuth)
    const d = sine * Math.sin(azimuth)
    const x = (1 + sign * ax * ax * a) * c + b * d + ax * cosine
    const y = sign * b * c + (sign + ay * ay * a) * d + ay * cosine
    const z = -sign * ax * c - ay * d + az * cosine
    const length = Math.hypot(x, y, z)
    wx = x / length
    wy = y / length
    wz = z / length
  }

  /** A point of the sun's disk into `w`: the sun's own direction for a point sun. */
  const drawSun = (rng: Rng): void => {
    if (diskReach > 0) {
      const m = rng.next() * diskReach
      turn(sunX, sunY, sunZ, m, 2 - m, 2 * Math.PI * rng.next())
    } else {
      wx = sunX
      wy = sunY
      wz = sunZ
    }
  }

  /** The blend of two rows' density between the ray's direction and `w`. */
  const scattered = (row: number, share: number, band: number): number => {
    const m = ((ux - wx) ** 2 + (uy - wy) ** 2 + (uz - wz) ** 2) / 2
    const s = ((ux + wx) ** 2 + (uy + wy) ** 2 + (uz + wz) ** 2) / 2
    const low = phaseDensity(phase, phaseNodeAt(phase, row, band), m, s)
    if (share === 0) return low
    const high = phaseDensity(phase, phaseNodeAt(phase, row + 1, band), m, s)
    return low + (high - low) * share
  }

  // The sun's frame for the sky: its height is the direction's own `y`,
  // and its bearing is read from the sun's azimuth, which a sky by
  // direction mirrors across.
  const skyRadiance =
    linear === null
      ? (band: number): number =>
          skyByDirection(
            sky as SkyByDirection,
            uy,
            ux * sunwardX + uz * sunwardZ,
            uz * sunwardX - ux * sunwardZ,
            band,
          )
      : (band: number): number =>
          linear.mean[band]! *
          Math.max(
            0,
            1 +
              0.75 *
                (linear.up[band]! * uy +
                  linear.sunward[band]! * (ux * sunwardX + uz * sunwardZ)),
          )

  /** `1 − cos` of the angle between a direction and the sun's center. */
  const fromSun = (x: number, y: number, z: number): number =>
    ((x - sunX) ** 2 + (y - sunY) ** 2 + (z - sunZ) ** 2) / 2
  const coneReach = phaseConeReach(phase)
  const cone = scene.estimator === 'cone'
  const first = scene.first ?? 1

  /**
   * The weight of the drawn point of the disk against a direction the vertex
   * would have drawn itself at `density`: the balance heuristic under
   * `'disk'`, and one under `'cone'`, where no walk scores the disk.
   */
  const diskWeight = (density: number): number =>
    !cone && diskDensity > 0 ? diskDensity / (diskDensity + density) : 1

  /** A direction drawn from the blend of rows about the ray's own, into `w`; its density. */
  const scatter = (rng: Rng, row: number, share: number, band: number) => {
    const upper = rng.next() < share
    const node = phaseNodeAt(phase, upper ? row + 1 : row, band)
    phaseSample(phase, node, rng.next(), drawn)
    const own = drawn[2]!
    const other =
      share === 0 || share === 1
        ? own
        : phaseDensity(
            phase,
            phaseNodeAt(phase, upper ? row : row + 1, band),
            drawn[0]!,
            drawn[1]!,
          )
    turn(ux, uy, uz, drawn[0]!, drawn[1]!, 2 * Math.PI * rng.next())
    return upper ? other + (own - other) * share : own + (other - own) * share
  }

  /** The sun's light scattered at the ray's point into its direction, through a drawn point of the disk. */
  const lit = (rng: Rng, row: number, share: number, band: number): number => {
    drawSun(rng)
    const density = scattered(row, share, band)
    if (!(density > 0) || (ground !== null && !(wy > 0))) return 0
    return density * diskWeight(density) * sunlit(rng)
  }

  /** A direction in the cone, drawn from a row's phase laid about the sun, into `w`. */
  const drawCone = (rng: Rng, node: number): void => {
    const share = phase.nodes[node + PHASE_CONE_NODE * PHASE_NODE + 1]!
    phaseSample(phase, node, rng.next() * share, drawn)
    turn(sunX, sunY, sunZ, drawn[0]!, drawn[1]!, 2 * Math.PI * rng.next())
  }
  /** The density `drawCone` gives the direction in `w`. */
  const coneDensity = (node: number): number => {
    const m = fromSun(wx, wy, wz)
    return (
      phaseDensity(phase, node, m, 2 - m) /
      phase.nodes[node + PHASE_CONE_NODE * PHASE_NODE + 1]!
    )
  }

  const FROM_VERTEX = 0
  const FROM_EYE = 1
  const FROM_GROUND = 2
  /** The row the ground's chains draw their cone by: any row is a valid density, and this is the table's middle. */
  const groundNode = (band: number): number =>
    phaseNodeAt(phase, phase.rows >> 1, band)

  /**
   * A chain from the ray's point: the sun's light that reaches it along a
   * run of directions inside the cone, per unit of irradiance, with the
   * walk's ray put back. From a vertex the first direction is drawn about
   * the vertex's own ray; from the eye it is the ray; from the ground it is
   * drawn about the sun alone and weighed by the ground's cosine lobe.
   */
  const chain = (
    rng: Rng,
    band: number,
    from: number,
    row0: number,
    share0: number,
    order0: number,
  ): number => {
    const px = qx
    const py = qy
    const pz = qz
    const dx = ux
    const dy = uy
    const dz = uz
    let weight = 1
    // The size of the chain's next term, which the roulette holds it to.
    let level = -1
    let row = row0
    let share = share0
    let order = order0
    let total = 0
    for (let step = 0; ; step += 1) {
      let reward = -1
      if (step > 0 || from === FROM_VERTEX) {
        // Two candidates, one drawn by the phase about the ray and one by
        // the phase about the sun, each weighed by the balance of the two
        // densities; then one of them, chosen by what it is worth to the
        // next term, with the pair's worth carried in the weight.
        const node = phaseNodeAt(phase, row, band)
        const own = scatter(rng, row, share, band)
        const ax = wx
        const ay = wy
        const az = wz
        const about = fromSun(ax, ay, az) < coneReach ? coneDensity(node) : 0
        const first = about > 0 ? (own / (own + about)) * about : 0
        drawCone(rng, node)
        const density = scattered(row, share, band)
        const lobe = coneDensity(node)
        const second = (density / (density + lobe)) * lobe
        const worth = first + second
        if (!(worth > 0)) break
        let chosen = lobe
        if (rng.next() * worth < first) {
          wx = ax
          wy = ay
          wz = az
          chosen = about
        }
        weight *= worth / chosen
        reward = weight * chosen
        aim(wx, wy, wz)
      } else if (from === FROM_GROUND) {
        const node = groundNode(band)
        drawCone(rng, node)
        if (!(wy > 0)) break
        reward = (ground!.albedo * wy) / Math.PI
        weight = reward / coneDensity(node)
        aim(wx, wy, wz)
      }
      // A chain whose terms have shrunk goes on with the chance they shrank
      // by, at the size they were: its length is finite and no term of it
      // is smaller than its first.
      if (reward >= 0) {
        if (level < 0 || reward >= level) level = reward
        else if (rng.next() * level >= reward) break
        else weight *= level / reward
      }
      if (!enter() || !walk(rng)) break
      order += 1
      if (order > scene.orders) break
      counts.chained += 1
      ;[row, share] = phaseRow(phase, at[1]!)
      if (order >= first) total += weight * lit(rng, row, share, band)
    }
    qx = px
    qy = py
    qz = pz
    aim(dx, dy, dz)
    return total
  }

  const radiance = (
    origin: Triple,
    direction: Triple,
    band: number,
    rng: Rng,
  ): number => {
    counts.paths += 1
    qx = origin[0] / cellX + 0.5
    qy = origin[1] / cellY + 0.5
    qz = origin[2] / cellZ + 0.5
    aim(direction[0], direction[1], direction[2])
    const irradiance = sun === null ? 0 : sun.irradiance[band]!
    const chains = cone && irradiance > 0
    let light = 0
    let throughput = 1
    // The density the last vertex drew the ray's direction with. Under zero
    // the ray is the eye's own, which does not look at the disk: the sun
    // seen through a cloud is the scene's, a source narrower than the
    // diffraction's blur (§5.1).
    let drew = -1
    let scatterings = 0
    // An eye that looks into the cone starts a run of its own.
    if (chains && fromSun(ux, uy, uz) < coneReach)
      light += irradiance * chain(rng, band, FROM_EYE, 0, 0, 0)
    let within = enter()
    for (;;) {
      if (!(within && walk(rng))) {
        if (ground !== null && uy < 0) {
          // The ground, under the medium: a Lambertian bounce.
          const height = (qy - 0.5) * cellY
          const t = (ground.height - height) / uy
          qx += ex * t
          qy += ey * t
          qz += ez * t
          // A bounce is a scattering to the count of orders, and no more.
          if (irradiance > 0 && scatterings + 1 >= first) {
            drawSun(rng)
            if (wy > 0) {
              const density = wy / Math.PI
              light +=
                throughput *
                ground.albedo *
                density *
                irradiance *
                diskWeight(density) *
                sunlit(rng)
            }
            if (chains)
              light +=
                throughput *
                irradiance *
                chain(rng, band, FROM_GROUND, 0, 0, scatterings)
          }
          throughput *= ground.albedo
          if (!(throughput > 0)) break
          const lift = rng.next()
          const flatness = Math.sqrt(1 - lift)
          const azimuth = 2 * Math.PI * rng.next()
          const up = Math.sqrt(lift)
          aim(flatness * Math.cos(azimuth), up, flatness * Math.sin(azimuth))
          drew = up / Math.PI
          within = enter()
          continue
        }
        light += throughput * skyRadiance(band)
        if (
          !cone &&
          drew >= 0 &&
          diskDensity > 0 &&
          irradiance > 0 &&
          scatterings >= first
        ) {
          if (fromSun(ux, uy, uz) < diskReach)
            light +=
              (throughput * irradiance * diskDensity * drew) /
              (drew + diskDensity)
        }
        break
      }
      // A scattering, with the medium there in `at`.
      if (scatterings >= scene.orders) break
      if (scatterings >= MAX_SCATTERINGS) {
        counts.truncated += 1
        break
      }
      scatterings += 1
      const [row, share] = phaseRow(phase, at[1]!)
      // Under `'cone'` a vertex reached along the cone is a chain's to light.
      if (irradiance > 0 && !(chains && fromSun(ux, uy, uz) < coneReach)) {
        if (scatterings >= first)
          light += throughput * irradiance * lit(rng, row, share, band)
        if (chains)
          light +=
            throughput *
            irradiance *
            chain(rng, band, FROM_VERTEX, row, share, scatterings)
      }
      drew = scatter(rng, row, share, band)
      aim(wx, wy, wz)
      within = true
    }
    counts.scatterings += scatterings
    return light
  }

  return {
    radiance,
    counts,
    transmittance(origin, direction, rng) {
      qx = origin[0] / cellX + 0.5
      qy = origin[1] / cellY + 0.5
      qz = origin[2] / cellZ + 0.5
      aim(direction[0], direction[1], direction[2])
      return shadow(rng)
    },
    density(radius, band, cosine) {
      const [row, share] = phaseRow(phase, radius)
      const low = phaseNodeAt(phase, row, band)
      const high = phaseNodeAt(phase, row + 1, band)
      const a = phaseDensity(phase, low, 1 - cosine, 1 + cosine)
      const b = phaseDensity(phase, high, 1 - cosine, 1 + cosine)
      return a + (b - a) * share
    },
  }
}

/**
 * A slab row of the oracle's as a ray: the sun's direction, and the eye's
 * line for light leaving at `viewMu`, `azimuth` degrees from the sun's
 * bearing (`addingDoubling.ts`, `scatteringCosine`).
 */
export function slabRay(
  sunMu: number,
  viewMu: number,
  azimuth: number,
  side: 'reflected' | 'transmitted',
): { readonly sun: Triple; readonly view: Triple } {
  const flat = Math.sqrt(1 - viewMu * viewMu)
  const bearing = (azimuth * Math.PI) / 180
  return {
    sun: [Math.sqrt(1 - sunMu * sunMu), sunMu, 0],
    view: [
      flat * Math.cos(bearing),
      side === 'reflected' ? -viewMu : viewMu,
      -flat * Math.sin(bearing),
    ],
  }
}

/* ------------------------------------------------------------------------- */
/* A pixel's estimate                                                         */
/* ------------------------------------------------------------------------- */

/** What a run of samples leaves of a pixel and a band: enough to join two runs and to give an error. */
export interface PixelSum {
  readonly sum: number
  readonly squares: number
  readonly samples: number
}

/**
 * Samples `from` to `to` of a ray in a band. Sample `i` draws from its own
 * stream, `deriveSeed(seed, band:i)`, so a pixel's estimate does not depend
 * on how its samples are split over runs or processes, or on what was
 * traced before it.
 */
export function tracePixel(
  tracer: Tracer,
  origin: Triple,
  direction: Triple,
  band: number,
  seed: Seed,
  from: number,
  to: number,
): PixelSum {
  let sum = 0
  let squares = 0
  for (let i = from; i < to; i += 1) {
    const value = tracer.radiance(
      origin,
      direction,
      band,
      Rng.fromSeed(deriveSeed(seed, `${band}:${i}`)),
    )
    sum += value
    squares += value * value
  }
  return { sum, squares, samples: to - from }
}

/** Two runs of one pixel and band as one. */
export const joinSums = (a: PixelSum, b: PixelSum): PixelSum => ({
  sum: a.sum + b.sum,
  squares: a.squares + b.squares,
  samples: a.samples + b.samples,
})

/** A pixel's mean and the standard error of that mean. One sample has no error to give. */
export function estimateOf(sum: PixelSum): {
  readonly mean: number
  readonly error: number
} {
  const n = sum.samples
  const mean = n > 0 ? sum.sum / n : 0
  const variance =
    n > 1 ? Math.max(0, sum.squares / n - mean * mean) * (n / (n - 1)) : 0
  return { mean, error: Math.sqrt(variance / Math.max(n, 1)) }
}
