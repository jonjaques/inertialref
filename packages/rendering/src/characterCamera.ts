import {
  type FramePose,
  type Quat,
  type UniverseVector,
  Quaternion as Q,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import {
  type Body,
  type SurfacePlacement,
  bodyFixedDirection,
  drawnSurfaceRadius,
  geodeticDirection,
  surfaceRadius,
} from '@inertialref/universe'
import { surfaceSupportRadius } from '@inertialref/simulation'
import { clampPitch } from './surfaceStance.ts'

/**
 * What the camera remembers between frames, and nothing the world does.
 *
 * Every number here is a presentation filter over a canonical value that
 * moves in steps: the crouch changes the eye height in one tick, a step up is
 * a 0.35 m teleport of the feet, a landing is a velocity reaching zero in one
 * substep, and the chase boom's sweep is a length that can halve when a
 * ridge enters it. A head does none of those instantly, and a camera that
 * did would pop. The memory is dropped on a cut, so a teleport does not ease
 * across the planet.
 */
export interface CharacterCameraMemory {
  /** The eye height the picture is at, easing toward the stance's. */
  readonly eyeHeight: number
  /** A residual offset of the feet along up, absorbing a step or a landing. */
  readonly lift: number
  /** The chase boom the picture is at, easing out and snapping in. */
  readonly boom: number
  /** The canonical radius of the feet last frame, to notice a step. */
  readonly radius: number
  readonly grounded: boolean
}

export interface CharacterCameraInput {
  readonly position: UniverseVector
  readonly orientation: Quat
  readonly body: Body
  readonly spin: FramePose
  readonly structures: readonly SurfacePlacement[]
  readonly eyeHeight: number
  readonly pitch: number
  readonly view: 'first' | 'third'
  readonly grounded: boolean
  /** Radial speed, m/s, for the dip a hard landing puts in the knees. */
  readonly verticalSpeed: number
  /** Seconds since the previous frame; zero holds every filter still. */
  readonly delta: number
  /** Null on a cut: the filters start at their targets. */
  readonly memory: CharacterCameraMemory | null
}

export interface CharacterCameraPose {
  readonly position: UniverseVector
  readonly orientation: Quat
  /** Where the avatar's feet are drawn: the corrected, lifted contact. */
  readonly feet: UniverseVector
  readonly memory: CharacterCameraMemory
}

/*
 * The chase boom, in meters and seconds.
 *
 * Length and shoulder are what put a 1.85 m suit in the lower third of the
 * frame with the ground it is walking on visible around it; the boom eases
 * out over a third of a second after a ridge lets go of it and snaps in the
 * instant one takes it, because a camera inside a rock is worse than a cut.
 * The feet-plane rule keeps a grounded chase eye above the foot plane so it
 * cannot leave a deck's contact disk and descend through its visible rim.
 */
export const CHASE = {
  boom: 3.6,
  shoulder: 0.35,
  clearance: 0.25,
  easeOut: 0.3,
  /** The crouch and the stand, as a time constant. */
  eyeEase: 0.1,
  /** A step or a landing, as a time constant. */
  liftEase: 0.09,
  /** The share of a landing's radial speed the knees absorb, capped. */
  landingDip: 0.025,
  landingDipLimit: 0.16,
} as const

/** The canonical contact and the corresponding visible ground, including decks. */
function groundAt(input: CharacterCameraInput, position: UniverseVector) {
  const direction = bodyFixedDirection(input.spin, position)
  const canonical = surfaceRadius(input.body, direction)
  let support = canonical
  let drawn = drawnSurfaceRadius(input.body, direction)
  for (const placement of input.structures) {
    const radius = surfaceSupportRadius(placement, input.body, direction)
    if (radius === null || radius <= support) continue
    const anchor = geodeticDirection(placement.latitude, placement.longitude)
    support = radius
    drawn =
      radius +
      (drawnSurfaceRadius(input.body, anchor) -
        surfaceRadius(input.body, anchor)) /
        Vec.dot(anchor, direction)
  }
  return { support, drawn }
}

/** Exponential approach: the fraction of the gap closed in `delta` at time constant `tau`. */
const ease = (from: number, to: number, delta: number, tau: number): number =>
  delta <= 0 ? from : to + (from - to) * Math.exp(-delta / tau)

/** One universe pose feeds the camera, terrain selection, and render origin. */
export function characterCameraPose(
  input: CharacterCameraInput,
): CharacterCameraPose {
  const radial = UV.difference(input.position, input.spin.position)
  const radius = Vec.length(radial)
  const up = Vec.scale(radial, 1 / radius)
  const ground = groundAt(input, input.position)
  const altitude = radius - ground.support
  // The detail tail is presentational. Fade it away once airborne above it.
  const correction =
    (ground.drawn - ground.support) *
    Math.max(0, Math.min(1, (5 - altitude) / 3))

  const held = input.memory
  let lift = held === null ? 0 : ease(held.lift, 0, input.delta, CHASE.liftEase)
  if (held !== null) {
    const rise = radius - held.radius
    // A step: the feet moved with the ground while standing on it. Hold the
    // picture where it was and let it catch up, rather than jump with them.
    if (held.grounded && input.grounded && Math.abs(rise) > 0.02) lift -= rise
    // A landing: the knees take some of the speed the ground just stopped.
    if (!held.grounded && input.grounded && input.verticalSpeed < -1)
      lift -= Math.min(
        CHASE.landingDipLimit,
        -input.verticalSpeed * CHASE.landingDip,
      )
  }
  const eyeHeight =
    held === null
      ? input.eyeHeight
      : ease(held.eyeHeight, input.eyeHeight, input.delta, CHASE.eyeEase)

  const feet = UV.translate(input.position, Vec.scale(up, correction + lift))
  const eye = UV.translate(feet, Vec.scale(up, eyeHeight))
  const orientation = Q.multiply(
    input.orientation,
    Q.fromAxisAngle(vec3(1, 0, 0), clampPitch(input.pitch)),
  )
  const remember = (boom: number): CharacterCameraMemory => ({
    eyeHeight,
    lift,
    boom,
    radius,
    grounded: input.grounded,
  })
  if (input.view === 'first')
    return { position: eye, orientation, feet, memory: remember(0) }

  const backward = Q.rotate(orientation, vec3(0, 0, 1))
  const right = Q.rotate(orientation, vec3(1, 0, 0))
  // The pivot sits over the shoulder, so the suit is beside the crosshair
  // rather than under it and what it is walking toward stays in view.
  const pivot = UV.translate(eye, Vec.scale(right, CHASE.shoulder))
  const clear = (distance: number): boolean => {
    const point = UV.translate(pivot, Vec.scale(backward, distance))
    // A boom can leave a deck's contact disk before descending through its
    // visible rim. Keep a grounded player's chase eye above the foot plane.
    if (altitude <= 0.1 && Vec.dot(UV.difference(point, feet), up) < 0.2)
      return false
    return (
      Vec.length(UV.difference(point, input.spin.position)) >=
      groundAt(input, point).drawn + CHASE.clearance
    )
  }
  // Sweep outward from the head so the boom cannot pass through a ridge:
  // a coarse march finds the first obstruction, a bisection puts the boom a
  // centimeter short of it rather than a quarter meter.
  let reach = 0
  let struck: number = CHASE.boom
  let hit = false
  for (let probe = 0.25; ; probe = Math.min(CHASE.boom, probe + 0.25)) {
    if (!clear(probe)) {
      hit = true
      struck = probe
      break
    }
    reach = probe
    if (probe >= CHASE.boom) break
  }
  if (hit) {
    let low = reach
    let high = struck
    for (let i = 0; i < 5; i += 1) {
      const middle = (low + high) / 2
      if (clear(middle)) low = middle
      else high = middle
    }
    reach = low
  }
  const boom =
    held === null || reach <= held.boom
      ? reach
      : ease(held.boom, reach, input.delta, CHASE.easeOut)
  return {
    position: UV.translate(pivot, Vec.scale(backward, boom)),
    orientation,
    feet,
    memory: remember(boom),
  }
}
