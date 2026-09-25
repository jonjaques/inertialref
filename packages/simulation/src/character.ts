import { invariant } from '@inertialref/shared'
import {
  type FrameState,
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
  readonly input: CharacterInput
}

export const CHARACTER = {
  walkSpeed: 4.3,
  sprintSpeed: 7,
  crouchSpeed: 1.8,
  flySpeed: 9,
  jumpSpeed: 5,
  height: 1.85,
  crouchHeight: 1.2,
  eyeHeight: 1.68,
  crouchEyeHeight: 1.04,
  stepHeight: 0.35,
  maxSlope: (50 * Math.PI) / 180,
  terminalSpeed: 55,
} as const

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

/**
 * A body-fixed kinematic controller, not an orbit integrator. Its motor controls
 * tangent speed while local gravity controls jumps; the frame carries planetary
 * transport. The orientation is parallel-transported so a pole is not a turn.
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
      Q.fromAxisAngle(up, input.yaw - held.heading),
      entity.state.orientation,
    ),
  )
  let grounded = held.grounded
  let flying = held.flying && held.canFly
  const crouched = input.crouch && !flying
  let vertical = Vec.dot(entity.state.velocity, up)
  if (input.jump && !held.jumpHeld && grounded && !flying) {
    vertical = CHARACTER.jumpSpeed
    grounded = false
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
  const horizontalSpeed = Math.hypot(forward, right) * speed
  // Terminal speed bounds each collision sweep; no frame can skip a mountain.
  const parts = Math.min(
    16,
    Math.max(
      1,
      Math.ceil(((horizontalSpeed + Math.abs(vertical) + 1) * dt) / 0.2),
    ),
  )
  const step = dt / parts
  let velocity = Vec.ZERO
  let altitude = 0
  const supportAt = (p: Vec3): number => {
    const direction = directionAt(p)
    return world.contactRadius(body, direction, surfaceRadius(body, direction))
  }

  for (let i = 0; i < parts; i += 1) {
    up = Vec.normalize(position)
    const basis = Q.basis(orientation)
    let tangent = Vec.scale(
      Vec.add(Vec.scale(basis.forward, forward), Vec.scale(basis.right, right)),
      speed,
    )
    const radius = Vec.length(position)
    const support = supportAt(position)
    if (radius <= support + 1e-6 && vertical <= 0 && !flying) {
      grounded = true
      vertical = 0
    }
    if (flying) {
      vertical =
        ((input.ascend ? 1 : 0) - (input.descend || input.crouch ? 1 : 0)) *
        speed
    } else if (!grounded) {
      vertical = Math.max(
        -CHARACTER.terminalSpeed,
        vertical - (body.mu / (radius * radius)) * step,
      )
    }
    let candidate = Vec.add(position, Vec.scale(tangent, step))
    let nextSupport = supportAt(candidate)
    if (grounded && horizontalSpeed > 0) {
      const ahead = Vec.add(position, Vec.scale(Vec.normalize(tangent), 0.5))
      const steep =
        supportAt(ahead) - support >
        Math.max(CHARACTER.stepHeight, Math.tan(CHARACTER.maxSlope) * 0.5)
      if (nextSupport - support > CHARACTER.stepHeight || steep) {
        tangent = Vec.ZERO
        candidate = position
        nextSupport = support
      }
    }
    const nextUp = Vec.normalize(candidate)
    let nextRadius = radius + vertical * step
    // Small descending steps remain attached; a ledge starts a gravity fall.
    if (grounded && nextRadius - nextSupport <= CHARACTER.stepHeight)
      nextRadius = nextSupport
    else if (grounded) grounded = false
    if (nextRadius <= nextSupport) {
      nextRadius = nextSupport
      if (vertical < 0) vertical = 0
      grounded = !flying
      // Creative flight meets the ground rather than driving through it.
      if (flying && (input.descend || input.crouch)) {
        flying = false
        grounded = true
      }
    } else if (flying) grounded = false
    const next = Vec.scale(nextUp, nextRadius)
    velocity = Vec.scale(Vec.sub(next, position), 1 / step)
    orientation = Q.normalize(
      Q.multiply(Q.fromUnitVectors(up, nextUp), orientation),
    )
    position = next
    altitude = Math.max(0, nextRadius - nextSupport)
  }
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
    },
    altitude,
  }
}
