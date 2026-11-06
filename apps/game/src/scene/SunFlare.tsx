import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import type { PerspectiveCamera, Scene } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createLensFlare } from '../render/flare.ts'
import { type FlareOccluder, sunVisibility } from '../render/flareMath.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/**
 * The key light's lens flare, driven from the same scene description as the
 * bodies: `stars[0]` is the star that lights the scene, and the occluders are
 * every drawn body — which is what lets the flare fade *smoothly* behind a
 * limb instead of popping when a depth sample flips. See `render/flare.ts`.
 */
export function SunFlare({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  // No dispose-on-unmount effect, deliberately, and `Starfield` is the
  // precedent: StrictMode remounts run cleanup against the *memoized*
  // instance and then mount it again, so a dispose here empties the group
  // for good — seven quads with nothing left inside them. R3F removes the
  // primitive from the scene on unmount; the handful of GPU objects live as
  // long as the renderer, like the starfield's do.
  const flare = useMemo(createLensFlare, [])

  useEffect(() => {
    warmAtMount({
      label: 'compiling the solar lens',
      units: 1,
      run: async (done) => {
        await warmCompile(warmRenderer(gl, engine.sceneLayout(gl)), {
          object: flare.group,
          camera,
          scene: scene as Scene,
        })
        done()
      },
    })
  }, [engine, flare, gl, camera, scene])

  useTimedFrame('sunFlare', () => {
    const scene = engine.scene()
    const star = scene?.stars[0]
    // The external instrument has no relative-brightness solar glare. Its
    // unresolved stars feed the sensor PSF with their physical flux instead.
    if (
      !engine.lensFlare ||
      engine.galaxyInstrument ||
      scene == null ||
      star === undefined
    ) {
      flare.group.visible = false
      return
    }
    /*
     * The drawn sphere is sunk under the datum by the body's relief, and
     * from a summit its horizon lies degrees under the ground's: a sun 3°
     * under Mars's horizon from 1.5 km over its highest ground drew its glare
     * through the ridges that hid it. Where a body's ground is streaming, the
     * ground under the eye is the occluder.
     */
    const ground = engine.groundUnderEye()
    const occluders: FlareOccluder[] = scene.bodies.map((body) => ({
      position: body.placement.position,
      radius:
        ground !== null && body.address === ground.body
          ? Math.max(
              body.placement.scale,
              ground.ground * body.placement.compression,
            )
          : body.placement.scale,
    }))
    // The flare is a lens's response to an unresolved point of glare. Once
    // the disk is genuinely resolved — the star-orbit arrival subtends ~15°
    // — the camera is exposed for the surface and the artifact stack fades,
    // or the flare's core repaints the stopped-down photosphere back to a
    // clipped white circle. Same ramp as the disk's own exposure.
    const filling = Math.min(
      1,
      Math.max(0, (star.placement.angularRadius - 0.015) / 0.085),
    )
    flare.update(
      camera as PerspectiveCamera,
      star.placement.position,
      star.color,
      star.brightness * (1 - filling * 0.85),
      star.placement.angularRadius,
      sunVisibility(
        scene.camera.position,
        star.placement.position,
        occluders,
        star.placement.angularRadius,
      ),
      // Scripts choose their coating response. The clean default keeps the
      // reference-matched title shots free of ghost chains crossing the type.
      engine.owner?.arm === 'cutscene'
        ? (engine.owner.cinematic.effects.lensArtifacts ?? 0.05)
        : engine.flareArtifacts,
      // The corona is staging, and only a script stages. Zero everywhere else,
      // which is what keeps a crescent preset in the planetarium from turning
      // into an eclipse nobody asked for.
      engine.cinematic?.effects.corona ?? 0,
      // The lens the flare is a response to, from the one producer of it. A
      // script's lens outranks the flight one and `engine.lens` has already
      // resolved that; reading `camera.fov` here would be a second opinion.
      engine.lens,
      // The same decision the bodies and the key light make: Natural, or a
      // script that opted into calibrated staging — the intro's eclipse beats
      // are staged around this glow whatever response the player chose.
      engine.visibilityProcessing,
      engine.cinematic?.effects.anamorphicFlare ?? 0,
      1 - 0.94 * (engine.cinematic?.effects.skyHaze ?? 0),
      // The same bodies the visibility test sees, so a ghost can fade where
      // it lands on a disk.
      occluders,
    )
  })

  return <primitive object={flare.group} />
}
