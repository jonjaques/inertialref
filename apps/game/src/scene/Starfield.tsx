import { useMemo, useRef } from 'react'
import { Sprite } from 'three/webgpu'
import { LIGHT_YEAR, type Meters } from '@inertialref/shared'
import type { FrameId, Quat } from '@inertialref/spatial'
import { UV, type UniverseVector } from '@inertialref/spatial'
import { placeOnStarShell } from '@inertialref/rendering'
import type { GameEngine, StarField } from '../engine/GameEngine.ts'
import { createStarfieldMaterial } from '../render/materials.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/** How many stars the instanced sprite buffer has room for. */
const MAX_STARS = 20_000

/** Fallback color for a star whose survey predates the color column. */
const WHITE: readonly [number, number, number] = [1, 1, 1]

/**
 * Magnitudes below the brightest star at which a star reaches the floor.
 *
 * Measured, not chosen: a 40 ly sweep from Alpha Centauri spans 20.7 magnitudes
 * with a median at 13.2. At 17 the median star lands around a fifth of the ramp
 * and the top percentile is clearly separated, which is what makes the sky read
 * as a sky rather than as noise. Larger flattens it; smaller loses everything
 * below the median into the floor.
 */
const MAGNITUDE_RANGE = 17

/**
 * How far the origin may travel, as a fraction of the nearest star's distance,
 * before the shell is rewritten.
 *
 * The buffer holds *directions*, and a direction is invariant under
 * translation — moving `d` swings the nearest star through at most `d/r`
 * radians and everything behind it through less. So the rebase counter, which
 * ticks every 4,096 m, is the wrong question: it fired every ninth frame in
 * Earth orbit and made a component that "does nothing unless the survey
 * changes" the largest Render span on the home page, 0.48 ms mean and 1.7 ms
 * max for twenty thousand stars that had not moved a pixel.
 *
 * 1e-5 radians is a quarter of a pixel across a 900-line viewport at a ~2°
 * field, which is past the zoom slider's narrow end — and the star it binds on
 * is never a distant one. It is the system's own sun, which the survey
 * includes and which sits ~1 AU away, so the budget in orbit is ~1,500 km:
 * about a minute of travel at 27.6 km/s instead of nine frames. The tolerance
 * is recomputed at every rewrite, so approaching the sun tightens it faster
 * than the approach can spend it.
 */
const SHELL_PARALLAX_TOLERANCE = 1e-5

/** What the shell in the buffer was drawn for, and what would invalidate it. */
interface WrittenShell {
  /** Identity, not length: a re-survey builds a whole new `StarField`. */
  readonly field: StarField
  readonly from: UniverseVector
  readonly orientation: Quat
  readonly anchorFrame: FrameId
  /** `SHELL_PARALLAX_TOLERANCE` times the nearest star's distance. */
  readonly budget: Meters
}

/**
 * Distant stars, as one instanced sprite draw.
 *
 * A `Points` cloud until the WebGPU migration, and it could not stay one: WebGPU
 * has no point size, so every star would have been a single pixel on the backend
 * this renderer is for while still looking right on the WebGL fallback. The
 * geometry is the sprite's own unit quad; `count` and the instanced position
 * buffer are what move. See `createStarfieldMaterial`.
 */
export function Starfield({ engine }: { engine: GameEngine }) {
  const field = useMemo(() => createStarfieldMaterial(MAX_STARS), [])
  const sprite = useMemo(() => {
    const object = new Sprite(field.material)
    object.count = 0
    // The bounding sphere describes the unit quad at the origin, not the shell
    // the instances are scattered over, so culling it would remove the entire
    // sky the moment the camera looked away from the origin.
    object.frustumCulled = false
    // Behind everything. The shell is far outside the depth range and the stars
    // are additive, so what protects the planets from being drawn over is order.
    object.renderOrder = -2
    return object
  }, [field])

  const written = useRef<WrittenShell | null>(null)

  useTimedFrame('starfield', () => {
    const scene = engine.scene()
    const stars = engine.starField
    if (scene === null) return
    const origin = scene.origin
    const held = written.current
    /*
     * Orientation and anchor exactly, position within the parallax budget.
     *
     * Rotation is the input that genuinely invalidates a direction — it turns
     * every one of them at once — and a reanchor changes the axes the shell is
     * expressed in, so both are compared for equality rather than tolerance.
     * The quaternion is a fresh object most frames, so its components are what
     * is compared.
     */
    if (
      held !== null &&
      held.field === stars &&
      held.anchorFrame === origin.anchorFrame &&
      held.orientation.x === origin.orientation.x &&
      held.orientation.y === origin.orientation.y &&
      held.orientation.z === origin.orientation.z &&
      held.orientation.w === origin.orientation.w &&
      UV.distance(origin.position, held.from) < held.budget
    )
      return

    const array = field.positions.array as Float32Array
    const colours = field.colours.array as Float32Array
    const prominence = field.prominence.array as Float32Array

    // Stars sit far outside the depth range, so they are drawn on a fixed
    // sphere around the camera: direction is what matters, distance is not
    // representable and not observable. The projection itself belongs to
    // `rendering`, which owns render space — doing it here meant a hand-written
    // copy of the sector arithmetic that also forgot the origin's orientation.
    //
    // Distance is not observable *in the geometry*, which is why how bright each
    // star looks has to be computed here, before it is discarded.
    let count = 0
    let brightest = 0
    let nearest = Number.POSITIVE_INFINITY
    const flux: number[] = []
    for (let i = 0; i < stars.positions.length; i += 1) {
      if (count >= MAX_STARS) break
      const position = stars.positions[i] as UniverseVector
      const point = placeOnStarShell(origin, position)
      if (point === null) continue
      array[count * 3] = point.x
      array[count * 3 + 1] = point.y
      array[count * 3 + 2] = point.z
      const colour = stars.colours[i] ?? WHITE
      colours[count * 3] = colour[0]
      colours[count * 3 + 1] = colour[1]
      colours[count * 3 + 2] = colour[2]

      const metres = UV.distance(position, origin.position)
      // The raw distance, before the flux floor below rounds it up: this is
      // the one that sets how far the origin may drift before this star's
      // *direction* is wrong, and the nearest star is always the sun.
      if (metres < nearest) nearest = metres
      // The one-light-year floor keeps a star the camera is inside from
      // dividing by nothing. Nothing is that close except the system's own sun,
      // which is drawn as a body rather than a point.
      const light = Math.max(metres, LIGHT_YEAR)
      const value = (stars.luminosities[i] ?? 1) / (light * light)
      flux.push(value)
      if (value > brightest) brightest = value
      count += 1
    }

    /*
     * Flux to a magnitude, then a magnitude to a ramp.
     *
     * Magnitudes because the range is otherwise unusable: within a 40 ly sweep
     * the apparent flux spans 20 magnitudes — a factor of 10^8 — so a linear
     * normalization leaves the median star at 10^-5 of the brightest and the sky
     * comes out black. That was the first attempt and it is what a photometer
     * would see; a magnitude scale is the logarithmic one astronomy uses for
     * exactly this reason, and it is also roughly how the eye responds.
     *
     * Relative to the brightest star currently in view rather than an absolute
     * zero point, because that is what adaptation does. An absolute scale would
     * darken the whole sky on the way out of the neighborhood, when what really
     * happens is that your eyes adjust.
     */
    for (let i = 0; i < count; i += 1) {
      const magnitude =
        brightest === 0 ? 0 : -2.5 * Math.log10((flux[i] as number) / brightest)
      prominence[i] = Math.max(0, Math.min(1, 1 - magnitude / MAGNITUDE_RANGE))
    }

    field.colours.needsUpdate = true
    field.prominence.needsUpdate = true
    field.positions.needsUpdate = true
    sprite.count = count
    written.current = {
      field: stars,
      from: origin.position,
      orientation: origin.orientation,
      anchorFrame: origin.anchorFrame,
      // Infinite when nothing was placed, which is right: an empty sky has no
      // direction that can go stale, and the survey landing replaces `field`.
      budget: (nearest * SHELL_PARALLAX_TOLERANCE) as Meters,
    }
  })

  return <primitive object={sprite} />
}
