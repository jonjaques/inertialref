import { Vector3, type Node } from 'three/webgpu'
import { Fn, If, Loop, float, uint, uniform, vec3 } from 'three/tsl'
import { invariant, PARSEC } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import {
  STAR_EXTINCTION_SAMPLES,
  STAR_EXTINCTION_NEAR_SAMPLES,
  STAR_EXTINCTION_NEAR_PARSECS,
  STAR_EXTINCTION_MID_SAMPLES,
  STAR_EXTINCTION_MID_PARSECS,
  STAR_EXTINCTION_PLANE_SCALE_PARSECS,
  STAR_EXTINCTION_PLANE_SLOPE,
  type GalaxyField,
  type StarExtinctionOptions,
} from '@inertialref/universe'
import { createGalaxyKernel, galaxyWarpElevation } from './galaxyKernel.ts'

/** The galaxy field accepts galactocentric parsecs in its GPU boundary. */
export function starExtinctionOrigin(position: UniverseVector): Vector3 {
  const p = UV.approxMeters(position)
  return new Vector3(p.x / PARSEC, p.y / PARSEC, p.z / PARSEC)
}

const asinh = (x: Node<'float'>): Node<'float'> =>
  x.abs().add(x.mul(x).add(1).sqrt()).log().mul(x.sign())
const sinh = (x: Node<'float'>): Node<'float'> =>
  x.exp().sub(x.negate().exp()).mul(0.5)

/**
 * Bake this column once per selected star and observer region. Even a bounded
 * integral repeated at every sprite vertex would spend millions of field
 * samples on observer positions whose extinction has not changed.
 */
export function createStarExtinction(
  field: GalaxyField,
  options: StarExtinctionOptions = {},
  kernel = createGalaxyKernel(field),
) {
  const requested = options.samples
  invariant(
    requested === undefined ||
      (Number.isInteger(requested) && requested >= 16 && requested <= 4096),
    'Star extinction needs 16 through 4096 samples',
  )
  const dust = uniform(field.dustScale)
  const along = Fn(([origin, displacement]: [Node<'vec3'>, Node<'vec3'>]) => {
    const distance = displacement.length().toVar()
    const depth = vec3(0).toVar()
    If(distance.greaterThan(0).and(dust.greaterThan(0)), () => {
      const direction = displacement.div(distance).toVar()
      const count =
        requested === undefined
          ? distance
              .lessThanEqual(STAR_EXTINCTION_NEAR_PARSECS)
              .select(
                uint(STAR_EXTINCTION_NEAR_SAMPLES),
                distance
                  .lessThanEqual(STAR_EXTINCTION_MID_PARSECS)
                  .select(
                    uint(STAR_EXTINCTION_MID_SAMPLES),
                    uint(STAR_EXTINCTION_SAMPLES),
                  ),
              )
          : uint(requested)
      const tilted = direction.y
        .abs()
        .greaterThan(STAR_EXTINCTION_PLANE_SLOPE)
        .toVar()
      const focus = float(0).toVar()
      If(tilted, () => {
        focus.assign(origin.y.negate().div(direction.y))
        for (let iteration = 0; iteration < 2; iteration++) {
          const crossing = origin.add(direction.mul(focus)).toVar()
          focus.assign(
            galaxyWarpElevation(crossing).sub(origin.y).div(direction.y),
          )
        }
      })
      const scale = float(STAR_EXTINCTION_PLANE_SCALE_PARSECS)
        .div(direction.y.abs().max(STAR_EXTINCTION_PLANE_SLOPE))
        .toVar()
      const lo = asinh(focus.negate().div(scale)).toVar()
      const span = asinh(distance.sub(focus).div(scale)).sub(lo).toVar()
      const previous = float(0).toVar()
      Loop(
        { start: uint(0), end: count, type: 'uint', condition: '<' },
        ({ i }) => {
          const u = float(i.add(1)).div(float(count))
          const next = tilted
            .select(
              focus
                .add(scale.mul(sinh(lo.add(span.mul(u)))))
                .clamp(0, distance),
              distance.mul(u.mul(u)),
            )
            .toVar()
          If(i.add(1).equal(count), () => {
            next.assign(distance)
          })
          const midpoint = origin.add(
            direction.mul(previous.add(next).mul(0.5)),
          )
          depth.addAssign(kernel.extinction(midpoint).mul(next.sub(previous)))
          previous.assign(next)
        },
      )
    })
    return depth
  })
  return {
    setField(next: GalaxyField) {
      kernel.setField(next)
      dust.value = next.dustScale
    },
    /** Preserve a short relative displacement instead of subtracting two distant float32 positions. */
    opticalDepth: (
      originParsecs: Node<'vec3'>,
      displacementParsecs: Node<'vec3'>,
    ): Node<'vec3'> => along(originParsecs, displacementParsecs),
    along: (
      originParsecs: Node<'vec3'>,
      displacementParsecs: Node<'vec3'>,
    ): Node<'vec3'> => along(originParsecs, displacementParsecs).negate().exp(),
    transmittance: (
      originParsecs: Node<'vec3'>,
      starParsecs: Node<'vec3'>,
    ): Node<'vec3'> =>
      along(originParsecs, starParsecs.sub(originParsecs)).negate().exp(),
  }
}
