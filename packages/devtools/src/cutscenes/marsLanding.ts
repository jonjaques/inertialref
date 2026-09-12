import { Quaternion as Q, UV, Vec, vec3 } from '@inertialref/spatial'
import { surfacePlacementPose } from '@inertialref/simulation'
import {
  bodyFixedFrameId,
  drawnSurfaceRadius,
  geodeticDirection,
  MARS_PAD,
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

/**
 * The instant the scene is composed for, in J2000 seconds: the Sun 3° above
 * the horizon and west of `MARS_PAD`, so the descent is shot into a sunset.
 * It is solved for that one site, which is why the scene stages the seeded
 * pad rather than whatever record carries its id.
 */
export const MARS_PAD_SITE = Object.freeze({
  presentationTime: 1133.5211610867814,
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
    // The pose and the instant are one composition: ten degrees of longitude
    // moves the horizon under a Sun the instant no longer lifts, and ninety
    // degrees of heading puts it four frame-widths off screen. So the scene
    // stages `MARS_PAD` itself, and the stored record lends only its id, and
    // only while it still coincides — a pad the player has moved is drawn
    // where they put it by the structure pass, and the stage stand-in here.
    const stored = world.structures.find(
      (structure) =>
        structure.id === MARS_PAD.id &&
        structure.bodyAddress === MARS_PAD.bodyAddress &&
        structure.assetId === MARS_PAD.assetId &&
        structure.latitude === MARS_PAD.latitude &&
        structure.longitude === MARS_PAD.longitude &&
        structure.height === MARS_PAD.height &&
        structure.heading === MARS_PAD.heading,
    )
    const placement = MARS_PAD
    const { presentationTime } = MARS_PAD_SITE
    const up = geodeticDirection(placement.latitude, placement.longitude)
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
        const reveal = smooth((seconds - 11) / 9) * 0.55
        const target = Vec.lerp(offset, vec3(0, 26, 0), reveal)
        // The tail faces the approach while braking; a fixed vertical attitude carries the final hold.
        const braking =
          Vec.length(velocity) > 1e-6
            ? lookAlong(Vec.scale(velocity, -1), vec3(0, 0, -1))
            : upright
        const broadside = Q.multiply(
          braking,
          Q.fromAxisAngle(
            vec3(0, 1, 0),
            0.95 * (1 - smooth((seconds - 6) / 9)),
          ),
        )
        const attitude = Q.slerp(
          broadside,
          upright,
          smooth((seconds - 10) / 10),
        )
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
          effects: {
            ...NO_EFFECTS,
            exposure: -0.2,
            calibratedLight: 1,
            entryHeat,
            landingDust,
            skyHaze: 1,
            // The flight stance's coating response, so the Sun over the pad
            // is the lens the player already knows from orbit. The anamorphic
            // streak's core is 0.66 px tall at 1600×900 and aliases into a
            // full-width hairline at the Sun's height, so it stays off here.
            lensArtifacts: 1,
            anamorphicFlare: 0,
          },
          texts: [],
          done: frame >= MARS_LANDING_FPS * MARS_LANDING_SECONDS,
        }
      },
    }
  },
}
