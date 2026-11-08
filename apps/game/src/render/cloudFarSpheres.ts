import type { Node, TextureNode } from 'three/webgpu'
import {
  dot,
  exp,
  float,
  Fn,
  If,
  max,
  min,
  normalize,
  oneMinus,
  select,
  sqrt,
  texture,
  vec4,
} from 'three/tsl'
import { airMediumAt } from './air.ts'
import type { CloudFarDeps, CloudFarField } from './cloudFar.ts'
import {
  type AirMediumFn,
  bakeFootprint,
  centerOf,
  cloudBeam,
  columnStatistics,
  faceDirection,
  FarBake,
  farLayer,
  farLayerAt,
  FarMarch,
  type FarOptions,
  farRead,
  farTexel,
  slantCosine,
  subColumnAround,
  subColumnOf,
} from './cloudFarAtlas.ts'
import { shellCrossing } from './cloudGeometry.ts'
import type { CloudFarFn } from './cloudNodes.ts'
import type { CloudBodyUniforms } from './cloudUniforms.ts'

/*
 * The sphere caches: per layer, a 6 × 258² face atlas at the layer's
 * mid-height holding (fraction, column τ, cached sun transmittance, spare),
 * RGBA16F in the atlas's own layout, met at most twice a ray (§3.13, §5.13).
 * Each crossing is one column, crossed at the slant the ray meets the sphere
 * with, so there is no column mixing along a grazing chord: that loss is what
 * the far comparison's grazing ray at sunset scores.
 *
 * The cache holds the cloud's own transmittance toward the sun, the layers
 * above and half of its own column, which the atlas reads a column a layer
 * for at every step. The air's beam is not cached: `cleared` is a per-frame
 * uniform, Enhanced and Photographic switch it, and a cached beam would light
 * a block 45 frames stale.
 *
 * Each crossing stands for the layer's whole slant path, centered on it and
 * clipped to the march's span, so a fine march that hands over halfway
 * through a layer leaves the far field the half it did not march, and an eye
 * inside a layer looking up still sees the cloud over it.
 */

type F = Node<'float'>
type V4 = Node<'vec4'>

/**
 * How far a ray from height `from` over the datum, at cosine `mu` to the
 * vertical there, runs to the sphere at `to`, above it: |r₀d̂ + s·ŝ| = r₁ with
 * r₀² − r₁² = (h₀ − h₁)(2R + h₀ + h₁), from heights. The constant is negative,
 * so the roots straddle zero and the one ahead is the larger. Center-relative,
 * because the bake has no eye in it: a second body's bake from its moon would
 * form an eye-relative constant out of terms of 10¹⁷ m².
 */
function sunReach(body: CloudBodyUniforms, from: F, to: F, mu: F): F {
  const radius = body.datumRadius
  const b = radius.add(from).mul(mu)
  const c = from.sub(to).mul(radius.mul(2).add(from).add(to))
  const sigma = select(b.greaterThanEqual(0), float(1), float(-1))
  const q = b.add(sigma.mul(sqrt(max(b.mul(b).sub(c), 0)))).negate()
  const other = c.div(select(q.notEqual(0), q, float(1)))
  return max(q, other)
}

/** (fraction, column τ, the cloud's transmittance to the sun from mid-height, 0). */
function spheresBake(deps: CloudFarDeps): V4 {
  return Fn(() => {
    const body = deps.uniforms[deps.body]
    const radius = body.datumRadius
    const texel = farTexel()
    const { base, top } = farLayerAt(body, texel.layer)
    const bottom = base.toVar()
    const ceiling = top.toVar()
    const footprint = bakeFootprint(deps.uniforms).toVar()
    const column = columnStatistics(
      deps.field,
      body,
      bottom,
      ceiling,
      footprint,
      subColumnOf(texel.face, texel.a, texel.b),
      'farSphere',
    )
    const tau = column.tau.toVar()
    const middle = bottom.add(ceiling).mul(0.5).toVar()
    const center = faceDirection(texel.face, texel.a, texel.b).toVar()
    const muSun = dot(center, body.sun).toVar()
    const sun = exp(
      tau
        .negate()
        .div(
          slantCosine(muSun, ceiling.sub(bottom), radius.add(middle)).mul(2),
        ),
    ).toVar()
    // The layers above, each read as one column where the sun ray from this
    // column's mid-height meets its own: the statistics the atlas would read
    // there, evaluated here once a cycle instead of at every step.
    for (const j of [1, 2]) {
      const above = farLayer(body, j)
      If(
        texel.layer.lessThan(j - 0.5).and(above.top.greaterThan(above.base)),
        () => {
          const height = above.base.add(above.top).mul(0.5)
          const reach = sunReach(body, middle, height, muSun)
          const direction = normalize(
            center.mul(radius.add(middle)).add(body.sun.mul(reach)),
          ).toVar()
          const crossed = columnStatistics(
            deps.field,
            body,
            above.base,
            above.top,
            footprint,
            subColumnAround(direction),
            `farSun${j}`,
          )
          const slant = slantCosine(
            dot(direction, body.sun),
            above.top.sub(above.base),
            radius.add(height),
          )
          sun.mulAssign(
            oneMinus(crossed.fraction).add(
              crossed.fraction.mul(exp(crossed.tau.negate().div(slant))),
            ),
          )
        },
      )
    }
    return vec4(column.fraction, tau, sun, 0)
  })() as V4
}

/** The spheres' march: each layer's mid-height crossings in t order, each one column. */
function spheresMarch(
  deps: CloudFarDeps,
  atlas: TextureNode,
  air: AirMediumFn,
): CloudFarFn {
  return (given, from, body, sky) => {
    const march = new FarMarch(given, from, body, sky, air)
    const ray = march.ray
    const end = given.end.toVar()
    const center = centerOf(body).toVar()
    const eyeRadius = body.datumRadius.add(body.eye)
    const spheres = [0, 1, 2].map((k) => {
      const layer = farLayer(body, k)
      const middle = layer.base.add(layer.top).mul(0.5).toVar()
      return {
        middle,
        radius: body.datumRadius.add(middle).toVar(),
        thickness: layer.top.sub(layer.base).toVar(),
        crossing: shellCrossing(
          body,
          ray.mu,
          layer.eyeOverBase.add(layer.eyeOverTop).mul(0.5),
          middle,
        ),
      }
    })
    // Down through the spheres from the top, then back up from the bottom,
    // as the atlas's shells: the order a ray meets them in.
    const order = [
      [2, 'near'],
      [1, 'near'],
      [0, 'near'],
      [0, 'far'],
      [1, 'far'],
      [2, 'far'],
    ] as const
    for (const [k, side] of order) {
      const { middle, radius, thickness, crossing } = spheres[k]!
      const t = (side === 'near' ? crossing.near : crossing.far).toVar()
      // The ray's cosine to the vertical where it crosses: (r_e·μ + t)/r there.
      const mu = eyeRadius.mul(ray.mu).add(t).div(radius)
      const run = thickness.div(slantCosine(mu, thickness, radius))
      const start = max(t.sub(run.mul(0.5)), march.cursor).toVar()
      const stop = min(t.add(run.mul(0.5)), end).toVar()
      If(
        thickness.greaterThan(0).and(crossing.hit).and(stop.greaterThan(start)),
        () => {
          march.gap(start)
          const read = farRead(
            atlas,
            normalize(center.add(ray.direction.mul(t))),
            k,
          ).toVar()
          const length = stop.sub(start).toVar()
          const sunMu = eyeRadius.mul(body.sunUp).add(t.mul(ray.nu)).div(radius)
          march.step(
            {
              from: start,
              to: stop,
              start,
              length,
              tau: read.y.div(max(thickness, 1e-3)).mul(length),
              fraction: read.x,
              source: cloudBeam(body, middle, sunMu).mul(read.z),
            },
            k,
          )
        },
      )
    }
    march.gap(end)
    return march.result(deps.uniforms, deps.phase)
  }
}

export class CloudFarSpheres extends FarBake implements CloudFarField {
  readonly far: CloudFarFn

  constructor(deps: CloudFarDeps, options: FarOptions = {}) {
    super(deps, 'spheres', 'rgba16f', spheresBake(deps))
    this.far = spheresMarch(
      deps,
      texture(this.texture),
      options.air ?? airMediumAt,
    )
  }
}
