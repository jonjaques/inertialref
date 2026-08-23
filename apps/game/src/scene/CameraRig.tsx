import { useFrame, useThree } from '@react-three/fiber'
import { useRef } from 'react'
import type {
  DirectionalLight,
  PerspectiveCamera,
  PointLight,
} from 'three/webgpu'
import { Vector3 } from 'three/webgpu'
import { chaseCameraPosition, chaseOffsetFor } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'

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

/**
 * Fill strength in flight, as irradiance against the star's 4.
 *
 * Unchanged in value from the constant-direction light this replaced: what was
 * wrong with that one was where it pointed, not how bright it was, and a
 * simulator whose selling point is a real sky does not get a second sun. Aimed,
 * the same 0.35 is worth more than it was — it now lands on the face turned
 * toward the lens instead of on whatever the render axes happened to favor.
 */
const FILL_INTENSITY = 0.35

/**
 * Fill strength while a cutscene owns the camera, against the star's 4.
 *
 * A shot can put the camera on the side of the hull the star does not reach,
 * and a title sequence cannot answer that with "space is high-contrast" — the
 * subject of the piece has to read. `AGENTS.md` says light is staging; this is
 * the staged half of the same rig, sized so a face with no key at all comes out
 * near a face with one (4.2 × 0.68 ≈ 2.9 against the key's 4 × 0.9 ≈ 3.6).
 *
 * It is not a general brightening and cannot become one: `FILL_OFF_AXIS` zeroes
 * it wherever the key is already doing the work, so raising it only ever
 * rescues a face that would otherwise be a silhouette.
 *
 * 1.6 rather than the 4.2 this was first metered at, and the difference is
 * where it was metered. 4.2 was fitted on the fly-through wipes, where the hull
 * is a small shape on an empty starfield and the fill is the only thing
 * lighting the face turned toward the lens. It is far too much once that hull
 * *is* the frame: through `tng-intro`'s skim the camera rides the saucer's own
 * surface, `FILL_OFF_AXIS` leaves a tenth of the fill on a face the key already
 * reaches, and a tenth of 4.2 spread over the whole picture measured **22.3**
 * of mean-luminance error against the reference across f2100–2360. At 1.6 the
 * same band measures **8.0**. The cost is four or five frames at each wipe
 * entry where the hull drops back under the reference tracker's floor, on a
 * criterion that is missed by nine frames either way; the skim's is not.
 *
 * The response is steeply non-linear through the tone curve's shoulder, which
 * is why this was found by capture rather than by arithmetic — 2.6 measured
 * 21.0 on the same band, almost all of the error still there, while costing
 * *more* wipe frames than 4.2. In flight the same light
 * stays at `FILL_INTENSITY` because the only other thing these lights reach is
 * streamed terrain, and a second sun on a planet's night side is a worse lie
 * than a dark hull. Planets, atmospheres and rings are not at risk either way:
 * they shade from their own `sunDirection` uniform and never see these lights.
 */
const STAGE_FILL_INTENSITY = 1.6

/** Drives the real camera from the ship's canonical state, once per frame. */
export function CameraRig({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  const light = useRef<PointLight>(null)
  const fill = useRef<DirectionalLight>(null)

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
      fill.current.intensity =
        cinematic === null ? FILL_INTENSITY : STAGE_FILL_INTENSITY
    }
  })

  return (
    <>
      {/* decay 0: the star is tens of millions of render-meters away after
          compression, so physical falloff would make it useless as a light. */}
      <pointLight ref={light} intensity={4} distance={0} decay={0} />
      {/* Aimed every frame above; the initial direction only has to be
          non-degenerate, because `DirectionalLight` normalizes nothing and a
          zero vector renders as a light pointing everywhere and nowhere. */}
      <directionalLight
        ref={fill}
        position={[0, 0, 1]}
        intensity={FILL_INTENSITY}
      />
    </>
  )
}
