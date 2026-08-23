import { useFrame, useThree } from '@react-three/fiber'
import { useRef } from 'react'
import type { PerspectiveCamera, PointLight } from 'three/webgpu'
import { chaseCameraPosition, chaseOffsetFor } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'

/** Drives the real camera from the ship's canonical state, once per frame. */
export function CameraRig({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  const light = useRef<PointLight>(null)

  useFrame(() => {
    const scene = engine.scene()
    if (scene === null) return

    /*
     * Whoever owns the pose this frame owns all of it.
     *
     * A cutscene's camera and the planetarium's are both already the scene's
     * eye (`buildScene` was handed the same pose), so the chase offset must
     * not be applied on top — a director frames shots and an observatory
     * frames bodies, and neither wants a ship 14 m in front of the lens. The
     * flight FOV yields to a script's lens the same way; the observatory uses
     * the flight lens deliberately, because its framing math is solved
     * against whatever the camera panel is set to.
     */
    const cinematic = engine.cinematic
    const override = cinematic ?? engine.observer

    // The camera panel's field of view, applied here rather than pushed at
    // the camera from React: the canvas remounts on an HDR change and R3F
    // builds a fresh camera, so the engine's value is the durable one and
    // this is the only place that writes it. Guarded, because
    // `updateProjectionMatrix` every frame is waste.
    const fov = cinematic === null ? engine.fov : cinematic.fov
    const perspective = camera as PerspectiveCamera
    if (perspective.isPerspectiveCamera && perspective.fov !== fov) {
      perspective.fov = fov
      perspective.updateProjectionMatrix()
    }

    camera.quaternion.set(
      scene.camera.orientation.x,
      scene.camera.orientation.y,
      scene.camera.orientation.z,
      scene.camera.orientation.w,
    )
    // Offset and ground clearance both come from `chaseCameraPosition`. They
    // were three lines of vector arithmetic here, which is exactly where a rule
    // goes to become untestable: nothing in Node could see that pitching up on
    // the pad put the camera under the crust.
    // The offset scales with the modeled hull once one is mounted; the
    // hand-tuned 6 m default covers the debug cone. `engine.hull` rather than
    // anything module-scoped here — see the field's comment in `GameEngine`.
    const eye =
      override === null
        ? chaseCameraPosition(
            scene,
            engine.hull === null
              ? undefined
              : chaseOffsetFor(engine.hull.lengthMetres),
          )
        : override.camera.position
    camera.position.set(eye.x, eye.y, eye.z)
    camera.updateMatrixWorld()

    // Sunlight comes from the nearest star's rendered position, so shadows and
    // terminators line up with where the star actually is.
    const star = scene.stars[0]
    if (star !== undefined && light.current !== null) {
      light.current.position.set(
        star.placement.position.x,
        star.placement.position.y,
        star.placement.position.z,
      )
      light.current.color.setRGB(star.color.r, star.color.g, star.color.b)
    }
  })

  return (
    <>
      {/* decay 0: the star is tens of millions of render-meters away after
          compression, so physical falloff would make it useless as a light. */}
      <pointLight ref={light} intensity={4} distance={0} decay={0} />
      <directionalLight position={[0.4, 1, 0.8]} intensity={0.35} />
    </>
  )
}
