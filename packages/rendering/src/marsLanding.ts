import { Vec, vec3, type Vec3 } from '@inertialref/spatial'
import { smooth } from './cinematic.ts'

export const MARS_LANDING_FPS = 24
export const MARS_LANDING_SECONDS = 46
export const MARS_TOUCHDOWN_SECONDS = 41
export const ROCI_HALF_LENGTH = 23

interface LandingKnot {
  readonly seconds: number
  readonly offset: Vec3
  readonly velocity: Vec3
}

/** Pad-local meters, +Y above the deck and -Z toward the northern approach. */
const APPROACH: readonly LandingKnot[] = [
  {
    seconds: 0,
    offset: vec3(-1300, 5000, -11000),
    velocity: vec3(90, -600, 1200),
  },
  {
    seconds: 8,
    offset: vec3(-450, 1500, -3300),
    velocity: vec3(110, -240, 620),
  },
  { seconds: 14, offset: vec3(-70, 320, -450), velocity: vec3(35, -90, 180) },
  { seconds: 20, offset: vec3(0, 140, 0), velocity: vec3(0, -16, 0) },
  { seconds: 29, offset: vec3(0, 48, 0), velocity: vec3(0, -5, 0) },
  { seconds: 37, offset: vec3(0, 24.2, 0), velocity: vec3(0, -0.7, 0) },
  {
    seconds: MARS_TOUCHDOWN_SECONDS,
    offset: vec3(0, ROCI_HALF_LENGTH, 0),
    velocity: vec3(0, 0, 0),
  },
]

/** Hermite velocity is authored in m/s, so the last segment meets the deck at rest. */
export function marsApproach(seconds: number): {
  offset: Vec3
  velocity: Vec3
} {
  const first = APPROACH[0]!
  const last = APPROACH[APPROACH.length - 1]!
  if (seconds <= first.seconds)
    return { offset: first.offset, velocity: first.velocity }
  if (seconds >= last.seconds)
    return { offset: last.offset, velocity: last.velocity }
  const index = APPROACH.findIndex((knot) => knot.seconds > seconds)
  const a = APPROACH[index - 1]!
  const b = APPROACH[index]!
  const dt = b.seconds - a.seconds
  const u = (seconds - a.seconds) / dt
  const u2 = u * u
  const u3 = u2 * u
  const combine = (p: number, q: number, v: number, w: number): Vec3 =>
    Vec.add(
      Vec.add(Vec.scale(a.offset, p), Vec.scale(b.offset, q)),
      Vec.add(Vec.scale(a.velocity, v), Vec.scale(b.velocity, w)),
    )
  return {
    offset: combine(
      2 * u3 - 3 * u2 + 1,
      -2 * u3 + 3 * u2,
      (u3 - 2 * u2 + u) * dt,
      (u3 - u2) * dt,
    ),
    velocity: combine(
      (6 * u2 - 6 * u) / dt,
      (-6 * u2 + 6 * u) / dt,
      3 * u2 - 4 * u + 1,
      3 * u2 - 2 * u,
    ),
  }
}

export function marsLandingCamera(seconds: number): Vec3 {
  const reveal = smooth((seconds - 11) / 11)
  const settle = smooth((seconds - 25) / 16)
  return Vec.add(
    Vec.add(vec3(-95, 5, 160), Vec.scale(vec3(-65, 43, 110), reveal)),
    Vec.scale(vec3(55, -33, -120), settle),
  )
}

export function marsLandingFov(seconds: number): number {
  const beats = [
    [0, 0.3],
    [8, 0.9],
    [14, 11],
    [22, 46],
    [41, 34],
  ] as const
  for (let i = 1; i < beats.length; i += 1) {
    const [end, b] = beats[i]!
    if (seconds > end) continue
    const [start, a] = beats[i - 1]!
    return a + (b - a) * smooth((seconds - start) / (end - start))
  }
  return 34
}

/** The drive is out three quarters of a second after the deck takes the weight. */
export const MARS_CUTOFF_SECONDS = 0.75

export function marsLandingDrives(seconds: number) {
  const { offset } = marsApproach(seconds)
  const ignition = smooth((seconds - 8) / 2)
  // The drive carries the ship until the deck does. The last metre of the
  // approach is a hover, and a burn that fades through it leaves nothing
  // holding the hull up at contact; the cut begins at touchdown.
  const cutoff =
    1 - smooth((seconds - MARS_TOUCHDOWN_SECONDS) / MARS_CUTOFF_SECONDS)
  return {
    entryHeat:
      (0.55 + 0.45 * smooth(seconds / 3)) * (1 - smooth((seconds - 9) / 8)),
    throttle: ignition * (1 - 0.82 * smooth((seconds - 12) / 26)) * cutoff,
    // Dust is what the plume raises, so it settles once the plume is out.
    landingDust:
      0.7 *
      smooth((130 - offset.y) / 100) *
      (1 - smooth((seconds - MARS_TOUCHDOWN_SECONDS) / 4)),
  }
}
