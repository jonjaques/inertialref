import { Quaternion as Q, UV, Vec, vec3 } from '@inertialref/spatial'
import { surfacePlacementPose } from '@inertialref/simulation'
import {
  bodyFixedFrameId,
  drawnSurfaceRadius,
  geodeticDirection,
  systemId,
} from '@inertialref/universe'
import {
  lensForFov,
  lookAlong,
  NO_EFFECTS,
  smooth,
} from '@inertialref/rendering'
import {
  marsApproach,
  marsLandingCamera,
  marsLandingDrives,
  marsLandingFov,
  MARS_LANDING_FPS,
  MARS_LANDING_SECONDS,
} from '@inertialref/rendering'
import type { CutsceneScript } from '../cutscene.ts'
import { MARS_PAD } from '../structures.ts'

/** A surveyed basin in the game's Mars relief; angles are radians, time is J2000 seconds. */
export const MARS_PAD_SITE = Object.freeze({
  latitude: MARS_PAD.latitude,
  longitude: MARS_PAD.longitude,
  presentationTime: -1578.8510672495163,
  deckHeight: MARS_PAD.height,
})

export const MARS_LANDING: CutsceneScript = {
  id: 'mars-landing',
  description:
    'Rocinante descends through the thin Martian air and settles on a basin landing pad',
  fps: MARS_LANDING_FPS,
  durationFrames: MARS_LANDING_FPS * MARS_LANDING_SECONDS,
  prepare(world) {
    const system = world.loadSystem(systemId('SOL'))
    const mars = system.planets[3]!
    const stored = world.structures.find(
      (structure) =>
        structure.id === MARS_PAD.id &&
        structure.bodyAddress === MARS_PAD.bodyAddress &&
        structure.assetId === MARS_PAD.assetId,
    )
    const placement = stored ?? MARS_PAD
    const { latitude, longitude } = placement
    const { presentationTime } = MARS_PAD_SITE
    const up = geodeticDirection(latitude, longitude)
    const spin = world.frames.pose(
      bodyFixedFrameId(mars.address),
      presentationTime,
    )
    const { position, orientation } = surfacePlacementPose(
      placement,
      mars,
      spin,
      drawnSurfaceRadius(mars, up),
    )
    const at = (offset: ReturnType<typeof vec3>) =>
      UV.translate(position, Q.rotate(orientation, offset))
    const upright = lookAlong(vec3(0, 1, 0), vec3(0, 0, -1))
    return {
      sample(frame) {
        const seconds = Math.max(0, frame / MARS_LANDING_FPS)
        const { offset, velocity } = marsApproach(seconds)
        const eye = marsLandingCamera(seconds)
        const reveal = smooth((seconds - 13) / 12) * 0.5
        const target = Vec.add(
          Vec.scale(offset, 1 - reveal),
          Vec.scale(vec3(0, 26, 0), reveal),
        )
        // The tail faces the approach while braking; a fixed vertical attitude carries the final hold.
        const attitude =
          Vec.length(velocity) > 1e-6
            ? lookAlong(Vec.scale(velocity, -1), vec3(0, 0, -1))
            : upright
        const { entryHeat, throttle, landingDust } = marsLandingDrives(seconds)
        return {
          frame,
          elapsedSeconds: seconds,
          presentationTime,
          camera: {
            position: at(eye),
            orientation: Q.multiply(
              orientation,
              lookAlong(Vec.sub(target, eye), vec3(0, 1, 0)),
            ),
          },
          lens: {
            ...lensForFov(marsLandingFov(seconds)),
            focus: Vec.length(Vec.sub(target, eye)),
            fStop: 5.6,
            shutter: 1 / 48,
          },
          ship: {
            model: 'rocinante',
            position: at(offset),
            orientation: Q.multiply(orientation, attitude),
            visible: true,
            throttle,
          },
          stage: {
            model: placement.assetId,
            ...(stored === undefined ? {} : { placementId: stored.id }),
            position,
            orientation,
          },
          effects: { ...NO_EFFECTS, exposure: 0.35, entryHeat, landingDust },
          texts: [],
          done: frame >= MARS_LANDING_FPS * MARS_LANDING_SECONDS,
        }
      },
    }
  },
}
