import type { Meters, Radians } from '@inertialref/shared'
import { Vec, type Vec3 } from '@inertialref/spatial'
import { FOV_MAX, FOV_MIN } from './lens.ts'
import { angularRadius } from './lod.ts'
import {
  clampPitch,
  horizonPitch,
  localTriad,
  stanceToward,
} from './surfaceStance.ts'

/*
 * A rise: standing on a moon with its parent over the horizon.
 *
 * The one composition in this build that is about *two* bodies, and the reason
 * it needs its own solver. Everything in `compositions.ts` is relative to the
 * body under the camera — a phase, a tilt and a standoff — and none of that can
 * express "Earth, three degrees above the lunar limb", because the subject of
 * the picture is not the thing being stood on.
 *
 * The name had been attached to a composition that was `{phase: 132, tilt: 8,
 * fill: 0.32}`: a small low crescent of the subject itself, which is a picture
 * but is not this one. The photograph is taken from 110 km over Luna looking
 * along the ground with Earth a few degrees above the limb, and what makes it
 * legible is the horizon in the lower third — so the horizon is solved for, not
 * hoped for.
 *
 * **Tidal locking is what makes it a stable picture.** Luna, the Galileans,
 * Titan and Phobos all hold their parent fixed in the sky; what cycles is the
 * parent's phase, not its position. A moon that spins solves against the
 * parent's direction at the instant the picture is taken, which is what the
 * caller passes in — so pressing the card again re-solves it and the picture is
 * right at that instant rather than at some remembered one.
 *
 * Pure, in the same bargain `observer.ts` and `surfaceStance.ts` make: given a
 * radius, a displacement to the parent and a height, it returns a stance in the
 * axes it was handed. Resolving which body is whose parent, and at what instant,
 * is `devtools/observatory.ts`.
 */

/**
 * How far above the horizon the parent sits by default, radians.
 *
 * Three degrees. Apollo 8's frame has Earth a little under two disks above the
 * limb, and Earth is 1.9° across from Luna — so a few degrees is the picture.
 * Lower and the parent is cut by the terrain the phase-2 geology will put
 * there; higher and the horizon leaves the frame, at which point it is a
 * photograph of a planet with nothing to say where it was taken from.
 */
export const RISE_CLEARANCE: Radians = (3 * Math.PI) / 180

/**
 * How much of the frame's height the parent fills.
 *
 * A sixth. The subject has to read as a disk with a face on it while the
 * horizon still carries a third of the frame, and those two claims together
 * leave very little room: at a quarter the parent crowds the horizon out, at a
 * tenth it is a bright dot.
 */
export const RISE_FILL = 1 / 6

/**
 * Where the horizon sits in the frame, as a fraction of its height from the
 * bottom.
 *
 * A third, which is the rule every landscape photograph is composed to and the
 * one the Apollo frame happens to obey. Stated as a constant because the pitch
 * below is *derived* from it: the frame's center sits a sixth of the field
 * above the horizon, which is the difference between a half and a third.
 */
export const HORIZON_THIRD = 1 / 3

/**
 * The field of view that gives a parent of `parentRadius` at `distance` a
 * `fill` fraction of the frame's height.
 *
 * Solved rather than fixed, because one focal length is not the picture for
 * both ends of what this has to cover: Earth is 1.9° across from Luna and Mars
 * is 42° across from Phobos, a factor of twenty-two. A single lens that framed
 * one of them would put the other off the edges or in a corner as a speck.
 *
 * Clamped to the slider's own range, and the clamp is doing real work at the
 * long end: Earthrise at the photograph's framing wants 11.4°, and the range
 * stops at 20° because the terrain predicate saturates there
 * (`docs/adr/0017-the-lens.md`). The picture below 20° is a phase of its own; until then Earth is
 * smaller in this frame than in the photograph, which is a stated limit rather
 * than a silent one.
 */
export function riseFov(
  parentRadius: Meters,
  distance: Meters,
  fill: number = RISE_FILL,
): number {
  const angle = 2 * angularRadius(parentRadius, distance)
  const wanted = (angle * 180) / Math.PI / Math.max(1e-3, fill)
  if (!Number.isFinite(wanted)) return FOV_MIN
  return Math.max(FOV_MIN, Math.min(FOV_MAX, wanted))
}

/** Where the eye stands for a rise, in the axes `toParent` was given in. */
export interface RiseStance {
  readonly up: Vec3
  readonly height: Meters
  readonly heading: Radians
  readonly pitch: Radians
}

/**
 * The stance that puts a parent `clearance` above the horizon.
 *
 * `toParent` is the **displacement** from this body's center to the parent's,
 * not a direction, and the distinction is the whole of the arithmetic. Treating
 * it as a direction from the eye is the version everybody writes first, and it
 * is wrong by up to `asin((R + h)/d)` — 0.28° for Earth from Luna, which sounds
 * survivable until you notice the clearance being solved for is 3°. It is 9% of
 * the answer, and on a closer pair it is all of it: Phobos sits 6,000 km from
 * Mars' center and is 11 km across, so the eye's own offset moves the parent's
 * elevation by 0.1°.
 *
 * The solve, in one line: the eye sits at angular distance θ from the
 * sub-parent point, and
 *
 *     sin α = (d·cos θ − r) / √(d² + r² − 2·d·r·cos θ)
 *
 * is the parent's elevation above the *local horizontal* from there, with
 * r = radius + height. The horizon is `acos(r_ground/r)` below that horizontal,
 * so the clearance asked for fixes α, and the quadratic in cos θ closes:
 *
 *     cos θ = (r·cos²α ± |sin α|·√(d² − r²·cos²α)) / d
 *
 * Both roots satisfy the squared equation and only one satisfies the original —
 * the sign of `d·cos θ − r` has to match the sign of `sin α`, and taking the
 * wrong one puts the eye on the far side of the body with the parent under its
 * feet.
 *
 * **Which great circle is a free choice, and it is made eastward.** The plane
 * through the sub-parent point is unconstrained by the picture: the sky is
 * empty except for the parent, so every choice makes the same frame and a
 * different place underfoot. East keeps the stance on the sub-parent point's
 * own parallel — the leading or trailing limb, which is where the Apollo
 * orbits were — where poleward would walk over the pole for any clearance
 * asked below about 20°.
 */
export function riseStance(
  radius: Meters,
  toParent: Vec3,
  height: Meters,
  clearance: Radians = RISE_CLEARANCE,
  fovDeg: number = FOV_MIN,
): RiseStance {
  const eyeRadius = radius + Math.max(0, height)
  const distance = Vec.length(toParent)
  const triad = localTriad(toParent)
  const subParent = triad.up

  // The horizon's dip below the local horizontal, as a positive angle.
  const dip = -horizonPitch(radius, Math.max(0, height))

  /*
   * A parent nearer than the eye's own radius has no rise: the geometry below
   * has no real root and the picture it describes is the eye inside the parent.
   * Standing at the sub-parent point is the honest degenerate answer — the
   * parent is overhead, which is what "nearer than the ground under you" means.
   */
  if (!(distance > eyeRadius)) {
    return {
      up: subParent,
      height: Math.max(0, height),
      heading: 0,
      pitch: clampPitch(Math.PI / 2),
    }
  }

  const wanted = Math.max(0, Math.min(Math.PI / 2 + dip, clearance))
  const alpha = wanted - dip
  const s = Math.sin(alpha)
  const k = Math.cos(alpha) ** 2
  const root = Math.sqrt(
    Math.max(0, distance * distance - eyeRadius * eyeRadius * k),
  )
  const candidates = [
    (eyeRadius * k + Math.abs(s) * root) / distance,
    (eyeRadius * k - Math.abs(s) * root) / distance,
  ]
  // The root whose `d·cos θ − r` agrees in sign with `sin α`. A zero elevation
  // makes both roots the same number, so either answer is the same answer.
  const cosTheta = Math.max(
    -1,
    Math.min(
      1,
      candidates.find(
        (c) => Math.sign(distance * c - eyeRadius) === Math.sign(s) || s === 0,
      ) ?? 1,
    ),
  )
  const theta = Math.acos(cosTheta)

  const up = Vec.normalize(
    Vec.add(
      Vec.scale(subParent, Math.cos(theta)),
      Vec.scale(triad.east, Math.sin(theta)),
    ),
  )
  const toward = Vec.normalize(Vec.sub(toParent, Vec.scale(up, eyeRadius)))
  const half = (fovDeg * Math.PI) / 180 / 2
  /*
   * The horizon on the lower-third line, through the projection rather than
   * across it.
   *
   * A frame fraction is a distance on the sensor, and the angle it subtends is
   * `atan(tan(fov/2) · f)` — not `fov · f`. The two agree to 0.03° at the 20°
   * floor Earthrise lands on, which is why the linear form reads as right; they
   * do not agree at the wide end, and `riseFov` clamps to `FOV_MAX` for a close
   * pair like Phobos over Mars. There the exact tilt is 25.45° and the linear
   * one 18.33°, which puts the horizon at 0.384 of the frame height instead of
   * a third — a composition named for a line it misses.
   */
  const aboveHorizon = Math.atan(Math.tan(half) * (1 - 2 * HORIZON_THIRD))
  return {
    up,
    height: Math.max(0, height),
    ...stanceToward(up, toward),
    pitch: clampPitch(-dip + aboveHorizon),
  }
}

/**
 * The parent's elevation above the apparent horizon from a rise stance.
 *
 * The inverse claim, so the property test can state it as one: solve a stance
 * for a clearance and this returns that clearance. It is also what a panel
 * reads to say whether the picture it is about to take has the parent in it.
 */
export function riseClearance(
  radius: Meters,
  toParent: Vec3,
  stance: RiseStance,
): Radians {
  const eyeRadius = radius + Math.max(0, stance.height)
  const eye = Vec.scale(stance.up, eyeRadius)
  const toward = Vec.sub(toParent, eye)
  const length = Vec.length(toward)
  if (length === 0) return 0
  const above = Math.asin(
    Math.max(-1, Math.min(1, Vec.dot(toward, stance.up) / length)),
  )
  return above - horizonPitch(radius, Math.max(0, stance.height))
}
