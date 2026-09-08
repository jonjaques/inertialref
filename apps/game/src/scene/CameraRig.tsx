import { useThree } from '@react-three/fiber'
import { useRef } from 'react'
import type {
  AmbientLight,
  DirectionalLight,
  PerspectiveCamera,
  PointLight,
} from 'three/webgpu'
import { Vector3 } from 'three/webgpu'
import {
  chaseCameraPosition,
  nearFieldLighting,
  chaseOffsetFor,
  verticalFovDegrees,
} from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/** Reused per frame; a light direction is not worth an allocation at 144 Hz. */
const VIEW = /*@__PURE__*/ new Vector3()
const FILL = /*@__PURE__*/ new Vector3()

/**
 * How much of the key is subtracted out of the fill's direction.
 *
 * This is the whole design, and it is not a taste setting. The fill points back
 * down the lens *minus* `FILL_OFF_AXIS` of the direction to the star, so on any
 * surface its `N·L` is `N·toCamera − k·(N·toKey)`, clamped at zero. Near k = 1
 * that expression is negative wherever the key already reaches the face the
 * camera is looking at, and positive only where it does not: the fill switches
 * itself off on lit surfaces and covers exactly the ones the key cannot.
 *
 * Measured over `tng-intro` at k = 0.85 — the whole cruise (f700–1080), the
 * credit descent (f1770–2300) and the first wipe entry contribute **0.000**,
 * because their visible face already carries `key·face` between 0.77 and 0.99.
 * The fly-through wipes at f1290/f1440/f1540/f1560 carry `key·face` of −0.771 —
 * the camera is looking at the far side of the hull — and there the fill lands
 * at 0.68–0.77. Nothing that is already right can be brightened by it.
 *
 * That property is why k is high rather than the textbook 0.3–0.5, and it is
 * load-bearing beyond this scene: the hull's authored attitude is still being
 * refit against the reference's tracked landmarks, so which face any given beat
 * shows the camera moves from week to week. A fill that can only ever add light
 * where the key is absent stays correct across those refits instead of having
 * to be retuned after each one. At k = 0.4 it does not: the same sweep put
 * 0.31 of fill on the descent at f2085, on a face already lit at 0.877.
 *
 * Keep it strictly below 1. At exactly 1 the two vectors cancel when the star
 * sits behind the lens — `toCamera − toStar` is the zero vector — and
 * normalizing that is a NaN direction, which is a light that renders nothing
 * anywhere. At 0.85 the shortest the sum can get is 0.15 of a unit, which
 * normalizes fine.
 */
const FILL_OFF_AXIS = 0.85

/** Drives the real camera from the ship's canonical state, once per frame. */
export function CameraRig({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  const light = useRef<PointLight>(null)
  const ambient = useRef<AmbientLight>(null)
  const fill = useRef<DirectionalLight>(null)

  useTimedFrame('cameraRig', () => {
    const scene = engine.scene()
    /*
     * Whoever owns the pose this frame owns all of it.
     *
     * A cutscene's camera and the planetarium's are both already the scene's
     * eye (`buildScene` was handed the same pose), so the chase offset must
     * not be applied on top — a director frames shots and an observatory
     * frames bodies, and neither wants a ship 14 m in front of the lens. The
     * flight lens yields to a script's the same way — `engine.lens` resolves
     * that order once — and the observatory uses the flight lens deliberately,
     * because its framing math is solved against whatever the camera panel is
     * set to.
     */
    const cinematic = engine.cinematic

    // A missing scene must still release authored lighting when staging ends.
    const lighting = nearFieldLighting(
      engine.cameraPolicy,
      (cinematic?.effects.calibratedLight ?? 0) > 0,
    )
    if (ambient.current !== null) ambient.current.intensity = lighting.ambient
    if (fill.current !== null) fill.current.intensity = lighting.fill
    if (scene === null) return

    const override = cinematic ?? engine.observer

    /*
     * The lens, applied here rather than pushed at the camera from React: the
     * canvas remounts on an HDR change and R3F builds a fresh camera, so the
     * engine's value is the durable one and this is the only place that writes
     * it. Guarded, because `updateProjectionMatrix` every frame is waste.
     *
     * `camera.fov`, and never `filmGauge`/`setFocalLength`. Three's gauge is
     * the sensor's *long* side and `getFilmHeight()` divides it by the aspect
     * ratio, so a focal length pushed through that route yields an angle that
     * changes on a resize — which would move the terrain selection, the
     * observatory's standoff and every composed shot with it. `fov` is the
     * vertical field and aspect-independent, which is what the lens states.
     *
     * The aspect ratio too, from the store's own size, because R3F cannot be
     * relied on to have set it on the camera it ends up with. R3F 9.7 builds
     * its camera as `new PerspectiveCamera(75, 0, …)` — aspect zero — and
     * corrects it only from a store subscription that fires on a size or
     * pixel-ratio *change*. Its async `configure()` reads a state snapshot
     * taken before it awaits the `gl` factory, which here is a renderer build
     * of one to six seconds, and `<Canvas>` calls `configure()` again on every
     * re-render while it waits: a boot status line, the measured size, the
     * output description. Each queued call then finds no camera in its stale
     * snapshot and builds one; the last one built lands after the size is
     * already in the store, its `setSize` is a no-op, and the subscription
     * never fires for it. A zero aspect is a NaN projection: every draw is
     * submitted and rasterizes to nothing — 790k triangles a frame, opaque
     * black under a healthy HUD — and a remount cures it only because a
     * resolved renderer memo leaves fewer calls queued. Measured headless on
     * the dev build: three boots of three black, `camera.aspect === 0` with
     * the store at 1600×900. One compare a frame is the whole cost.
     */
    const perspective = camera as PerspectiveCamera
    const fov = verticalFovDegrees(engine.lens)
    const aspect =
      size.height > 0 ? size.width / size.height : perspective.aspect
    if (
      perspective.isPerspectiveCamera &&
      (perspective.fov !== fov || perspective.aspect !== aspect)
    ) {
      perspective.fov = fov
      perspective.aspect = aspect
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
    if (light.current !== null)
      light.current.intensity =
        4 * (engine.visibilityProcessing ? 1 : (star?.sunlight ?? 0))
    if (star !== undefined && light.current !== null) {
      light.current.position.set(
        star.placement.position.x,
        star.placement.position.y,
        star.placement.position.z,
      )
      light.current.color.setRGB(star.color.r, star.color.g, star.color.b)
    }

    /*
     * Aim the fill. It is a *direction*, so only `position − target` matters
     * and the default target at the origin is what makes a bare unit vector
     * the whole answer; the light's own place in render space is meaningless.
     *
     * This used to be the constant `[0.4, 1, 0.8]` while the comment in
     * `SceneView` called it camera-mounted, and the gap between those two is
     * the bug. A fixed direction fills whatever it happens to point at, so
     * whether the near field was readable came down to which way a shot faced
     * and where the render axes happened to lie — a coincidence, re-rolled
     * every time a camera moved. When it came up wrong the visible face was lit
     * by `ambientLight` 0.16 and nothing else, which through the ACES toe is
     * 1/255: a silhouette with its window rows showing. Measured on `tng-intro`
     * f1800 while the credit descent still had that geometry, the star lit the
     * hull's dorsal at 0.661, the camera sat on the ventral side at −0.609, and
     * the old fill's dot with that ventral face was −0.619 — clamped away. Two
     * hundred and five frames had a hero starship in them that the reference
     * diff could not find at all.
     */
    if (fill.current !== null) {
      // `getWorldDirection` is the way the camera is looking; the light has to
      // come back down it, from behind the lens.
      FILL.copy(camera.getWorldDirection(VIEW)).negate()
      if (star !== undefined) {
        VIEW.set(
          star.placement.position.x,
          star.placement.position.y,
          star.placement.position.z,
        )
          .sub(camera.position)
          .normalize()
        FILL.addScaledVector(VIEW, -FILL_OFF_AXIS)
      }
      fill.current.position.copy(FILL.normalize())
    }
  })

  return (
    <>
      <ambientLight ref={ambient} intensity={0} />
      {/* decay 0: the star is tens of millions of render-meters away after
          compression, so physical falloff would make it useless as a light. */}
      <pointLight ref={light} intensity={0} distance={0} decay={0} />
      {/* Aimed every frame above; the initial direction only has to be
          non-degenerate, because `DirectionalLight` normalizes nothing and a
          zero vector renders as a light pointing everywhere and nowhere. */}
      <directionalLight ref={fill} position={[0, 0, 1]} intensity={0} />
    </>
  )
}
