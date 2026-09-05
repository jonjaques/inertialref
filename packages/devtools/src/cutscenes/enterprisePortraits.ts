import { Quaternion as Q, UV, Vec, vec3 } from '@inertialref/spatial'
import { AU } from '@inertialref/shared'
import { systemFrameId, systemId } from '@inertialref/universe'
import { lensForFov, lookAlong, NO_EFFECTS } from '@inertialref/rendering'
import type { CutsceneScript } from '../cutscene.ts'

/** Three held photographs; the director owns both poses and the entire lens. */
export const ENTERPRISE_PORTRAITS: CutsceneScript = {
  id: 'enterprise-portraits',
  description: 'three portraits of the Enterprise D in the light of Tau Ceti',
  fps: 24,
  durationFrames: 720,
  prepare(world) {
    const system = world.loadSystem(systemId('HIP8102'))
    const star = world.frames.pose(
      systemFrameId(system.id),
      world.clock.renderTime,
    ).position
    const anchor = UV.translate(star, vec3(-AU, -AU * 0.45, AU * 0.4))
    const portraits = [
      {
        eye: vec3(700, 390, -650),
        aim: vec3(0, 0, -30),
        fov: 40,
        focus: 1000,
        aperture: 2.8,
      },
      {
        eye: vec3(205, 30, 300),
        aim: vec3(151, 3, 220),
        fov: 8,
        focus: 94.44,
        aperture: 1.4,
      },
      {
        eye: vec3(-180, 100, -180),
        aim: vec3(-110, 55, -180),
        fov: 12,
        focus: 75.38,
        aperture: 1.4,
      },
    ]
    return {
      sample(frame) {
        const shot =
          portraits[Math.min(2, Math.max(0, Math.floor(frame / 240)))]!
        return {
          frame,
          camera: {
            position: UV.translate(anchor, shot.eye),
            orientation: lookAlong(Vec.sub(shot.aim, shot.eye), vec3(0, 1, 0)),
          },
          lens: {
            ...lensForFov(shot.fov),
            focus: shot.focus,
            fStop: shot.aperture,
            shutter: 1 / 48,
          },
          ship: { position: anchor, orientation: Q.IDENTITY, visible: true },
          effects: { ...NO_EFFECTS, exposure: -0.5, calibratedLight: 1 },
          texts: [],
          done: frame >= 720,
        }
      },
    }
  },
}
