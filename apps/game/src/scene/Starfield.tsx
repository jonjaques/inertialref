import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { Sprite } from 'three/webgpu'
import { LIGHT_YEAR } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import { placeOnStarShell } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createStarfieldMaterial } from '../render/materials.ts'

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

  const generation = useRef(-1)
  const surveyed = useRef(-1)

  useFrame(() => {
    const scene = engine.scene()
    const stars = engine.starField
    if (scene === null) return
    if (
      generation.current === scene.origin.generation &&
      surveyed.current === stars.positions.length
    )
      return

    generation.current = scene.origin.generation
    surveyed.current = stars.positions.length
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
    let written = 0
    let brightest = 0
    const flux: number[] = []
    for (let i = 0; i < stars.positions.length; i += 1) {
      if (written >= MAX_STARS) break
      const position = stars.positions[i] as UniverseVector
      const point = placeOnStarShell(scene.origin, position)
      if (point === null) continue
      array[written * 3] = point.x
      array[written * 3 + 1] = point.y
      array[written * 3 + 2] = point.z
      const colour = stars.colours[i] ?? WHITE
      colours[written * 3] = colour[0]
      colours[written * 3 + 1] = colour[1]
      colours[written * 3 + 2] = colour[2]

      const metres = UV.distance(position, scene.origin.position)
      // The one-light-year floor keeps a star the camera is inside from
      // dividing by nothing. Nothing is that close except the system's own sun,
      // which is drawn as a body rather than a point.
      const light = Math.max(metres, LIGHT_YEAR)
      const value = (stars.luminosities[i] ?? 1) / (light * light)
      flux.push(value)
      if (value > brightest) brightest = value
      written += 1
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
    for (let i = 0; i < written; i += 1) {
      const magnitude =
        brightest === 0 ? 0 : -2.5 * Math.log10((flux[i] as number) / brightest)
      prominence[i] = Math.max(0, Math.min(1, 1 - magnitude / MAGNITUDE_RANGE))
    }

    field.colours.needsUpdate = true
    field.prominence.needsUpdate = true
    field.positions.needsUpdate = true
    sprite.count = written
  })

  return <primitive object={sprite} />
}
