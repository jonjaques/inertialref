import { invariant } from '@inertialref/shared'
import {
  type FrameState,
  type Quat,
  Quaternion as Q,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import {
  type Body,
  type BodyFixedDirection,
  geodeticDirection,
  directionToGeodetic,
  surfaceRadius,
} from '@inertialref/universe'
import type { Entity } from './entity.ts'

/** Player intent, sampled by fixed ticks. Yaw is an absolute heading in radians. */
export interface CharacterInput {
  readonly forward: number
  readonly right: number
  readonly sprint: boolean
  readonly crouch: boolean
  readonly jump: boolean
  readonly ascend: boolean
  readonly descend: boolean
  readonly yaw: number
}

export interface CharacterState {
  readonly canFly: boolean
  readonly flying: boolean
  readonly grounded: boolean
  readonly crouched: boolean
  /** The last consumed jump edge, retained through saves. */
  readonly jumpHeld: boolean
  /** Applied yaw; orientation transports this heading continuously over poles. */
  readonly heading: number
  /**
   * Ticks since the feet last had support; zero while grounded. A jump
   * closes the coyote window by setting it past `coyoteTicks` at once, so
   * the window is for the player who walked off an edge, not a second jump.
   */
  readonly airTicks: number
  /** Ticks a jump pressed in the air stays armed for the landing; zero when none. */
  readonly jumpBuffer: number
  readonly input: CharacterInput
}

/*
 * The tuning, in one place, with what each number is for.
 *
 * The speeds are a suited walker's: the walk is a brisk pace the third-person
 * gait is authored at, the sprint twice it, and the animation clips carry
 * those two nominal speeds so a foot plants where the ground is. Acceleration
 * is what makes a key press a push rather than a switch — a third of a
 * second to full walk, faster to stop — and the small air value is the whole
 * of air control: a jump keeps the momentum it left the ground with and the
 * player can lean it a little, not turn it around.
 */
export const CHARACTER = {
  walkSpeed: 2.8,
  sprintSpeed: 5.6,
  crouchSpeed: 1.5,
  flySpeed: 9,
  groundAcceleration: 30,
  groundDeceleration: 42,
  airAcceleration: 2,
  flyAcceleration: 40,
  jumpSpeed: 5,
  /** Ticks after walking off an edge in which a jump still counts. */
  coyoteTicks: 6,
  /** Ticks a jump pressed just before landing waits for the ground. */
  jumpBufferTicks: 8,
  height: 1.85,
  crouchHeight: 1.3,
  eyeHeight: 1.68,
  crouchEyeHeight: 1.15,
  stepHeight: 0.35,
  maxSlope: (50 * Math.PI) / 180,
  terminalSpeed: 55,
} as const

/** Ticks airborne are counted up to this and no further; a fall does not overflow the hash. */
const AIR_TICKS_LIMIT = 1_000_000

export const NEUTRAL_CHARACTER_INPUT: CharacterInput = {
  forward: 0,
  right: 0,
  sprint: false,
  crouch: false,
  jump: false,
  ascend: false,
  descend: false,
  yaw: 0,
}

export function createCharacter(canFly = false, heading = 0): CharacterState {
  return {
    canFly,
    flying: false,
    grounded: false,
    crouched: false,
    jumpHeld: false,
    heading,
    airTicks: 0,
    jumpBuffer: 0,
    input: { ...NEUTRAL_CHARACTER_INPUT, yaw: heading },
  }
}

export function characterInput(
  previous: CharacterInput,
  input: Partial<CharacterInput>,
): CharacterInput {
  const next = { ...previous, ...input }
  invariant(
    Number.isFinite(next.forward) &&
      Number.isFinite(next.right) &&
      Number.isFinite(next.yaw),
    'Character axes and yaw must be finite',
  )
  return {
    ...next,
    forward: Math.max(-1, Math.min(1, next.forward)),
    right: Math.max(-1, Math.min(1, next.right)),
  }
}

export interface CharacterGround {
  contactRadius(
    body: Body,
    direction: BodyFixedDirection,
    terrain: number,
  ): number
}

/** Brand a body-frame local direction through the coordinate boundary. */
function directionAt(position: Vec3): BodyFixedDirection {
  const { latitude, longitude } = directionToGeodetic(position)
  return geodeticDirection(latitude, longitude)
}

export interface CharacterResult {
  readonly state: FrameState
  readonly character: CharacterState
  readonly altitude: number
}

/** Move `v` toward `target` by at most `step`, arriving exactly when it can. */
function approach(v: Vec3, target: Vec3, step: number): Vec3 {
  const delta = Vec.sub(target, v)
  const length = Vec.length(delta)
  return length <= step ? target : Vec.add(v, Vec.scale(delta, step / length))
}

/** How far a probe steps to read the ground's slope around a blocked move. */
const PROBE = 0.15

/**
 * The rotation carrying one unit vector onto another, for the tiny angles a
 * substep turns the local vertical through. `Q.fromUnitVectors` answers the
 * identity under 0.08 degrees, which on Mars is every step of a 4.7 km walk:
 * an orientation transported that way stays put while the ground turns under
 * it, its forward axis leaves the tangent plane, and the motor pushing along
 * that axis climbs. The cross-and-sum form is exact down to float precision.
 */
function transport(from: Vec3, to: Vec3): Quat {
  const d = Vec.dot(from, to)
  if (d < -0.999_999) return Q.fromUnitVectors(from, to)
  const cross = Vec.cross(from, to)
  return Q.normalize({ x: cross.x, y: cross.y, z: cross.z, w: 1 + d })
}

/**
 * A body-fixed kinematic controller, not an orbit integrator. Its motor drives
 * the momentum it keeps in the entity's velocity toward what the keys ask for,
 * on the ground quickly and in the air hardly at all; gravity owns the radial
 * motion of anything airborne; the frame carries planetary transport. The
 * orientation is parallel-transported so a pole is not a turn.
 *
 * Contact is a height under a body-fixed ray, so an obstacle is a rise a step
 * cannot take and a slope one steeper than the limit. A move into either is
 * not simply refused: the ground's gradient around the blocked point is the
 * wall's normal, the component of momentum into it is dropped, and the rest
 * slides along. That is what lets a walker follow a wall or contour a hill
 * instead of sticking to it, and it costs four extra ground samples only on
 * the substeps that are blocked.
 */
export function stepCharacter(
  world: CharacterGround,
  body: Body,
  entity: Entity,
  dt: number,
): CharacterResult {
  const held = entity.character
  invariant(held !== null, 'Character stepping requires a character')
  const input = held.input
  let position = entity.state.position
  let up = Vec.normalize(position)
  let orientation = Q.normalize(
    Q.multiply(
      Q.fromAxisAngle(up, held.heading - input.yaw),
      entity.state.orientation,
    ),
  )
  let grounded = held.grounded
  let flying = held.flying && held.canFly
  let airTicks = held.airTicks
  let jumpBuffer = held.jumpBuffer
  const crouched = input.crouch && !flying
  // Momentum: what the last tick left in the velocity, split about local up.
  let vertical = Vec.dot(entity.state.velocity, up)
  let planar = Vec.sub(entity.state.velocity, Vec.scale(up, vertical))
  if (grounded && !flying) vertical = 0

  const jumpEdge = input.jump && !held.jumpHeld && !flying
  const launch = (): void => {
    vertical = CHARACTER.jumpSpeed
    grounded = false
    airTicks = CHARACTER.coyoteTicks + 1
    jumpBuffer = 0
  }
  if (jumpEdge) {
    if (grounded || airTicks <= CHARACTER.coyoteTicks) launch()
    else jumpBuffer = CHARACTER.jumpBufferTicks
  }

  const speed = flying
    ? CHARACTER.flySpeed * (input.sprint ? 2 : 1)
    : crouched
      ? CHARACTER.crouchSpeed
      : input.sprint
        ? CHARACTER.sprintSpeed
        : CHARACTER.walkSpeed
  const magnitude = Math.max(1, Math.hypot(input.forward, input.right))
  const forward = input.forward / magnitude
  const right = input.right / magnitude
  const asking = forward !== 0 || right !== 0
  // Terminal speed bounds each collision sweep; no frame can skip a mountain.
  const pace = Math.max(Vec.length(planar), speed) + Math.abs(vertical) + 1
  const parts = Math.min(16, Math.max(1, Math.ceil((pace * dt) / 0.2)))
  const step = dt / parts
  let altitude = 0
  const supportAt = (p: Vec3): number => {
    const direction = directionAt(p)
    return world.contactRadius(body, direction, surfaceRadius(body, direction))
  }

  for (let i = 0; i < parts; i += 1) {
    up = Vec.normalize(position)
    // Momentum rides the surface: the tangent plane turned under it during
    // the last substep, and the radial part it left behind is not a climb.
    planar = Vec.sub(planar, Vec.scale(up, Vec.dot(planar, up)))
    const basis = Q.basis(orientation)
    const wanted = Vec.scale(
      Vec.add(Vec.scale(basis.forward, forward), Vec.scale(basis.right, right)),
      speed,
    )
    const radius = Vec.length(position)
    const support = supportAt(position)
    if (radius <= support + 1e-6 && vertical <= 0 && !flying) {
      grounded = true
      vertical = 0
    }

    // The motor. On the ground it reaches the asked speed in a few tenths
    // of a second and stops faster; in the air it only leans the momentum
    // the jump kept; in flight it is the same push in three axes.
    if (flying) {
      const lift =
        ((input.ascend ? 1 : 0) - (input.descend || input.crouch ? 1 : 0)) *
        speed
      const motion = approach(
        Vec.add(planar, Vec.scale(up, vertical)),
        Vec.add(wanted, Vec.scale(up, lift)),
        CHARACTER.flyAcceleration * step,
      )
      vertical = Vec.dot(motion, up)
      planar = Vec.sub(motion, Vec.scale(up, vertical))
    } else if (grounded) {
      planar = approach(
        planar,
        wanted,
        (asking ? CHARACTER.groundAcceleration : CHARACTER.groundDeceleration) *
          step,
      )
    } else {
      if (asking)
        planar = approach(planar, wanted, CHARACTER.airAcceleration * step)
      vertical = Math.max(
        -CHARACTER.terminalSpeed,
        vertical - (body.mu / (radius * radius)) * step,
      )
    }

    let nextRadius = radius + vertical * step
    // The sweep: try the move; if the ground ahead is a wall, slide along it.
    // What blocks is either the rise at the candidate itself or a slope met
    // half a meter ahead, and the answer says which, because the wall's
    // normal has to be read where the wall is.
    const blocked = (
      candidate: Vec3,
      nextSupport: number,
      motion: Vec3,
    ): Vec3 | null => {
      if (grounded) {
        if (nextSupport - support > CHARACTER.stepHeight) return candidate
        const length = Vec.length(motion)
        if (length === 0) return null
        const ahead = Vec.add(position, Vec.scale(motion, 0.5 / length))
        return supportAt(ahead) - support >
          Math.max(CHARACTER.stepHeight, Math.tan(CHARACTER.maxSlope) * 0.5)
          ? ahead
          : null
      }
      // An airborne motor hitting a hillside stops at the hillside; lifting
      // the feet to its summit would turn collision into an upward teleport.
      return nextSupport > nextRadius + 1e-6 && nextSupport > support + 1e-6
        ? candidate
        : null
    }
    let candidate = Vec.add(position, Vec.scale(planar, step))
    let nextSupport = supportAt(candidate)
    const obstacle =
      Vec.lengthSquared(planar) > 0
        ? blocked(candidate, nextSupport, planar)
        : null
    if (obstacle !== null) {
      // The wall's normal is the ground's gradient around the obstacle,
      // read in the tangent plane. Drop the momentum into it and try again.
      const gradient = Vec.add(
        Vec.scale(
          basis.right,
          (supportAt(Vec.add(obstacle, Vec.scale(basis.right, PROBE))) -
            supportAt(Vec.sub(obstacle, Vec.scale(basis.right, PROBE)))) /
            (2 * PROBE),
        ),
        Vec.scale(
          basis.forward,
          (supportAt(Vec.add(obstacle, Vec.scale(basis.forward, PROBE))) -
            supportAt(Vec.sub(obstacle, Vec.scale(basis.forward, PROBE)))) /
            (2 * PROBE),
        ),
      )
      const slope = Vec.length(gradient)
      let slid = false
      if (slope > 1e-9) {
        const into = Vec.dot(planar, gradient) / slope
        if (into > 0) {
          const slide = Vec.sub(planar, Vec.scale(gradient, into / slope))
          const retry = Vec.add(position, Vec.scale(slide, step))
          const retrySupport = supportAt(retry)
          if (blocked(retry, retrySupport, slide) === null) {
            planar = slide
            candidate = retry
            nextSupport = retrySupport
            slid = true
          }
        }
      }
      if (!slid) {
        planar = Vec.ZERO
        candidate = position
        nextSupport = support
      }
    }
    const nextUp = Vec.normalize(candidate)
    // Small descending steps remain attached; a ledge starts a gravity fall.
    if (grounded && nextRadius - nextSupport <= CHARACTER.stepHeight)
      nextRadius = nextSupport
    else if (grounded) grounded = false
    if (nextRadius <= nextSupport) {
      nextRadius = nextSupport
      if (vertical < 0) vertical = 0
      const landing = !grounded && !flying
      grounded = !flying
      // Creative flight meets the ground rather than driving through it.
      if (flying && (input.descend || input.crouch)) {
        flying = false
        grounded = true
      }
      if (landing && jumpBuffer > 0) launch()
    } else if (flying) grounded = false
    if (grounded) {
      airTicks = 0
      jumpBuffer = 0
    }
    const next = Vec.scale(nextUp, nextRadius)
    orientation = Q.normalize(Q.multiply(transport(up, nextUp), orientation))
    position = next
    altitude = Math.max(0, nextRadius - nextSupport)
  }
  if (!grounded) {
    airTicks = Math.min(AIR_TICKS_LIMIT, airTicks + 1)
    if (jumpBuffer > 0) jumpBuffer -= 1
  }
  up = Vec.normalize(position)
  const velocity = Vec.add(
    Vec.sub(planar, Vec.scale(up, Vec.dot(planar, up))),
    Vec.scale(up, grounded && !flying ? 0 : vertical),
  )
  return {
    state: {
      ...entity.state,
      position,
      orientation,
      velocity,
      angularVelocity: Vec.ZERO,
    },
    character: {
      ...held,
      flying,
      grounded,
      crouched,
      jumpHeld: input.jump,
      heading: input.yaw,
      airTicks,
      jumpBuffer,
    },
    altitude,
  }
}
