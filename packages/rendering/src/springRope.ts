import { Vec, type Vec3, vec3 } from '@inertialref/spatial'

/** A gravity-driven launch in body radii. The first point belongs to the pointer. */
export function launchArc(from: Vec3, up: Vec3): readonly Vec3[] {
  const radius = Vec.length(from)
  if (!(radius > 1)) return [from, Vec.normalize(from)]
  const radial = Vec.scale(from, 1 / radius)
  const tangent = Vec.sub(up, Vec.scale(radial, Vec.dot(up, radial)))
  const loft =
    Vec.length(tangent) > 1e-9
      ? Vec.normalize(tangent)
      : Vec.normalize(
          Vec.cross(
            radial,
            Math.abs(radial.x) < 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0),
          ),
        )
  // Angular momentum stays below a grazing orbit's, even far from the body.
  // The launch therefore reaches the surface instead of becoming a satellite.
  const mu = 4
  let velocity = Vec.add(
    Vec.scale(radial, -0.45 * Math.sqrt(mu / radius)),
    Vec.scale(loft, (0.65 * Math.sqrt(mu)) / radius),
  )
  let position = from
  const points: Vec3[] = [from]
  const gravity = (at: Vec3): Vec3 =>
    Vec.scale(at, -mu / Math.pow(Vec.length(at), 3))
  for (let index = 0; index < 4096; index += 1) {
    // A local orbital timescale keeps the integration bounded across zoom levels.
    const dt = Math.sqrt(Math.pow(Vec.length(position), 3) / mu) / 64
    const acceleration = gravity(position)
    const next = Vec.add(
      position,
      Vec.add(Vec.scale(velocity, dt), Vec.scale(acceleration, (dt * dt) / 2)),
    )
    if (Vec.length(next) <= 1) {
      const delta = Vec.sub(next, position)
      const a = Vec.dot(delta, delta)
      const b = Vec.dot(position, delta)
      const t =
        (-b -
          Math.sqrt(
            Math.max(0, b * b - a * (Vec.dot(position, position) - 1)),
          )) /
        a
      points.push(Vec.normalize(Vec.add(position, Vec.scale(delta, t))))
      return points
    }
    velocity = Vec.add(
      velocity,
      Vec.scale(Vec.add(acceleration, gravity(next)), dt / 2),
    )
    position = next
    points.push(position)
  }
  return []
}

const COUNT = 33
const STEP = 1 / 120

/** Arc-length sampling prevents a dense touchdown cluster from making a stiff rope. */
function resample(path: readonly Vec3[]): Vec3[] {
  const distances = [0]
  for (let index = 1; index < path.length; index += 1)
    distances.push(
      distances[index - 1]! + Vec.distance(path[index - 1]!, path[index]!),
    )
  const length = distances.at(-1) ?? 0
  let segment = 1
  return Array.from({ length: COUNT }, (_, index) => {
    const distance = (length * index) / (COUNT - 1)
    while (segment < path.length - 1 && distances[segment]! < distance)
      segment += 1
    const a = path[segment - 1] ?? Vec.ZERO
    const b = path[segment] ?? a
    const span = (distances[segment] ?? 0) - (distances[segment - 1] ?? 0)
    return Vec.add(
      a,
      Vec.scale(
        Vec.sub(b, a),
        span > 0 ? (distance - distances[segment - 1]!) / span : 0,
      ),
    )
  })
}

/** A damped spring chain around a gravity arc, with two kinematic endpoints. */
export class SpringRope {
  #points: Vec3[] = []
  #velocity: Vec3[] = []
  #remainder = 0

  get points(): readonly Vec3[] {
    return this.#points
  }

  reset(): void {
    this.#points = []
    this.#velocity = []
    this.#remainder = 0
  }

  step(
    path: readonly Vec3[],
    delta: number,
    immediate = false,
  ): readonly Vec3[] {
    const rest = resample(path)
    if (this.#points.length === 0 || immediate) {
      this.#points = rest
      this.#velocity = rest.map(() => Vec.ZERO)
      this.#remainder = 0
    }
    // Pins do not ease. Only the rope between the hand and touchdown has inertia.
    this.#points[0] = path[0] ?? Vec.ZERO
    this.#points[COUNT - 1] = path.at(-1) ?? Vec.ZERO
    this.#remainder += Math.min(1 / 15, Math.max(0, delta))
    while (this.#remainder + 1e-12 >= STEP) {
      this.#remainder = Math.max(0, this.#remainder - STEP)
      const acceleration = rest.map((point, index) =>
        Vec.sub(
          Vec.scale(Vec.sub(point, this.#points[index]!), 225),
          Vec.scale(this.#velocity[index]!, 24),
        ),
      )
      for (let index = 0; index < COUNT - 1; index += 1) {
        const link = Vec.sub(this.#points[index + 1]!, this.#points[index]!)
        const length = Vec.length(link)
        if (length < 1e-12) continue
        const extension = length - Vec.distance(rest[index]!, rest[index + 1]!)
        const force = Vec.scale(link, (100 * extension) / length)
        acceleration[index] = Vec.add(acceleration[index]!, force)
        acceleration[index + 1] = Vec.sub(acceleration[index + 1]!, force)
      }
      for (let index = 1; index < COUNT - 1; index += 1) {
        this.#velocity[index] = Vec.add(
          this.#velocity[index]!,
          Vec.scale(acceleration[index]!, STEP),
        )
        this.#points[index] = Vec.add(
          this.#points[index]!,
          Vec.scale(this.#velocity[index]!, STEP),
        )
      }
    }
    return this.#points
  }
}
