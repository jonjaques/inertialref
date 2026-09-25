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

export interface CharacterCameraInput {
  readonly position: UniverseVector
  readonly orientation: Quat
  readonly body: Body
  readonly spin: FramePose
  readonly structures: readonly SurfacePlacement[]
  readonly eyeHeight: number
  readonly pitch: number
  readonly view: 'first' | 'third'
}

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

/** One universe pose feeds the camera, terrain selection, and render origin. */
export function characterCameraPose(input: CharacterCameraInput) {
  const radial = UV.difference(input.position, input.spin.position)
  const up = Vec.normalize(radial)
  const ground = groundAt(input, input.position)
  const altitude = Vec.length(radial) - ground.support
  // The detail tail is presentational. Fade it away once airborne above it.
  const correction =
    (ground.drawn - ground.support) *
    Math.max(0, Math.min(1, (5 - altitude) / 3))
  const feet = UV.translate(input.position, Vec.scale(up, correction))
  const eye = UV.translate(feet, Vec.scale(up, input.eyeHeight))
  const orientation = Q.multiply(
    input.orientation,
    Q.fromAxisAngle(vec3(1, 0, 0), clampPitch(input.pitch)),
  )
  if (input.view === 'first') return { position: eye, orientation, feet }

  const backward = Q.rotate(orientation, vec3(0, 0, 1))
  // Sweep outward from the head so the boom cannot pass through a ridge.
  let distance = 0
  for (let probe = 0.25; probe <= 4.5; probe += 0.25) {
    const point = UV.translate(eye, Vec.scale(backward, probe))
    if (
      // A boom can leave a deck's contact disk before descending through its
      // visible rim. Keep a grounded player's chase eye above the foot plane.
      (altitude <= 0.1 && Vec.dot(UV.difference(point, feet), up) < 0.2) ||
      Vec.length(UV.difference(point, input.spin.position)) <
        groundAt(input, point).drawn + 0.2
    )
      break
    distance = probe
  }
  return {
    position: UV.translate(eye, Vec.scale(backward, distance)),
    orientation,
    feet,
  }
}
