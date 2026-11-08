import type { Node } from 'three/webgpu'
import {
  dot,
  float,
  int,
  max,
  mix,
  normalize,
  saturate,
  select,
  smoothstep,
  step,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { DETAIL_NOISE_PERIOD } from '@inertialref/rendering'
import { CLOUD_SWEEP_EXTRAS } from './cloudLevers.ts'
import type { CloudClipmapNodes } from './cloudClipmap.ts'
import {
  CLOUD_CUBE_TILE,
  type CloudMapNodes,
  scenarioCoverageNode,
} from './cloudMaps.ts'
import type { CloudMedium, CloudMediumFn, CloudSample } from './cloudNodes.ts'
import type { CloudNoiseNodes } from './cloudNoise.ts'
import type { CloudProfile } from './cloudProfile.ts'
import type {
  CloudBodyUniforms,
  CloudLayerUniforms,
  CloudUniforms,
} from './cloudUniforms.ts'

/*
 * The placeholder's density (§5.6): coverage × the genus's profile × eroded
 * noise, with the unresolved share of a cell carried as a fraction rather
 * than a mean density. The three media differ only in where the coverage
 * comes from — the clipmap near, the weather cube for the served body's far
 * bakes, the analytic function for a second body — so the far field is the
 * same field at every distance.
 *
 * A step reads the coverage (twice in a clipmap level's fade band), the
 * profile, the base noise and the detail noise, and nothing outside every
 * layer: the reads sit in one branch on the layer, so a ray's steps between
 * two decks cost the arithmetic and no fetch. The curl that tears the edges
 * is in the base noise already (`weatherNoise.ts`), so it costs a step
 * nothing. Every read names level 0, so the media compile in a fragment's
 * non-uniform control flow as they do in compute.
 */

export interface FieldMediumDeps {
  readonly uniforms: CloudUniforms
  readonly clipmap: CloudClipmapNodes
  readonly noise: CloudNoiseNodes
  readonly profile: CloudProfile
}

export interface SynopticMediumDeps {
  readonly uniforms: CloudUniforms
  readonly maps: CloudMapNodes
  readonly noise: CloudNoiseNodes
  readonly profile: CloudProfile
}

interface RecipeDeps {
  readonly uniforms: CloudUniforms
  readonly noise: CloudNoiseNodes
  readonly profile: CloudProfile
}

/** A slab with no horizontal edge, as `slabMedium` has outside its slabs. */
const UNBOUNDED_COLUMN = 1e9
/** µm outside every layer, as the analytic media have it. */
const NO_RADIUS = 10
/** The least a remap divides by: a layer with no cover draws nothing rather than 0/0. */
const TINY = 1e-6

/** The layer a sample is in, by altitude, as one-hot weights over the three. */
interface Layer {
  readonly weights: Node<'vec3'>
  /** 1 inside a layer, 0 outside every one. */
  readonly inside: Node<'float'>
  /** −1 outside every layer. */
  readonly index: Node<'int'>
  readonly h01: Node<'float'>
  readonly sigma: Node<'float'>
  readonly cell: Node<'float'>
  readonly erosion: Node<'float'>
  readonly radius: Node<'float'>
  readonly genus: Node<'float'>
}

/**
 * base_k ≤ h < top_k, unrolled over three by `step`: the layers are
 * disjoint, so at most one weight is 1 and a layer's every parameter is a
 * dot product rather than a branch. An absent layer has no thickness at the
 * union's top and holds nothing.
 */
function layerAt(layers: CloudLayerUniforms, altitude: Node<'float'>): Layer {
  const h = vec3(altitude)
  const weights = step(layers.base, h).mul(
    vec3(1).sub(step(layers.top, h)),
  ) as Node<'vec3'>
  const of = (v: Node<'vec3'>): Node<'float'> => dot(weights, v)
  const base = of(layers.base)
  const thickness = max(of(layers.top).sub(base), 1)
  return {
    weights,
    inside: weights.x.add(weights.y).add(weights.z),
    index: int(of(vec3(1, 2, 3)).sub(1)),
    h01: altitude.sub(base).div(thickness),
    sigma: of(layers.sigma),
    cell: max(of(layers.cell), 1),
    erosion: of(layers.erosion),
    radius: of(layers.radius),
    genus: of(layers.genus),
  }
}

/** The base noise's lattice at a sample, in the layer's base cells (§5.4): no absolute position. */
const baseCells = (
  sample: CloudSample,
  body: CloudBodyUniforms,
  layer: Layer,
): Node<'vec3'> =>
  body.noiseOrigin.add(body.drift).add(sample.offset).div(layer.cell)

/** The detail's lattice, in its own cells: four a base cell, tiling once a base cell. */
const detailCells = (
  sample: CloudSample,
  body: CloudBodyUniforms,
  layer: Layer,
): Node<'vec3'> =>
  body.detailOrigin
    .add(body.drift)
    .add(sample.offset)
    .mul(float(DETAIL_NOISE_PERIOD).div(layer.cell))

/** Where a layer's coverage comes from, read inside the layer's branch. */
type CoverageOf = (layer: Layer) => {
  /** Layer k's coverage. */
  readonly cover: Node<'float'>
  /** Horizontal meters the coverage holds still over. */
  readonly column: Node<'float'>
}

/**
 * §5.6 at a sample, for the layer it is in:
 *
 *     d     = saturate(remap(n_b·p, 1 − c, 1, 0, 1)),  d = saturate(remap(d, n_d, 1, 0, 1))
 *     f     = smoothstep(cell/4, cell, footprint)       the unresolved share of a cell
 *     fraction = mix(1, c, f),   σ = mix(σ_k·d, σ_k·p̄, f)
 *
 * with n_d = detail · erosion · (1 − smoothstep(cell/16, cell/4, footprint))
 * and its read skipped where that fade is 0.
 */
function recipe(
  deps: RecipeDeps,
  sample: CloudSample,
  body: CloudBodyUniforms,
  coverageOf: CoverageOf,
): CloudMedium {
  const layer = layerAt(deps.uniforms.layers, sample.altitude)
  const inLayer = (): Node<'vec3'> => {
    const { cover, column } = coverageOf(layer)
    const shape = deps.profile.sample(layer.genus, layer.h01)
    const base = deps.noise.base(baseCells(sample, body, layer))
    const cell = layer.cell
    const footprint = sample.footprint
    const reach = float(1).sub(smoothstep(cell.div(16), cell.div(4), footprint))
    const erosion = select(
      reach.greaterThan(0),
      deps.noise
        .detail(detailCells(sample, body, layer))
        .mul(layer.erosion)
        .mul(reach),
      float(0),
    )
    const shaped = saturate(
      base.mul(shape.x).sub(float(1).sub(cover)).div(max(cover, TINY)),
    )
    const eroded = saturate(
      shaped.sub(erosion).div(max(float(1).sub(erosion), TINY)),
    )
    const unresolved = smoothstep(cell.div(4), cell, footprint)
    return vec3(
      mix(float(1), cover, unresolved),
      layer.sigma.mul(mix(eroded, shape.y, unresolved)),
      column,
    )
  }
  const values = select(
    layer.inside.greaterThan(0.5),
    inLayer(),
    vec3(0, 0, UNBOUNDED_COLUMN),
  )
  return {
    fraction: values.x,
    sigma: values.y,
    layer: layer.index,
    column: values.z,
    radius: mix(float(NO_RADIUS), layer.radius, layer.inside),
  }
}

/** The direction from the body's center of an eye-relative point: a coarse lookup's, for the cube's 19.6 km texels and up. */
const directionAt = (
  sample: CloudSample,
  body: CloudBodyUniforms,
): Node<'vec3'> =>
  normalize(body.up.mul(body.datumRadius.add(body.eye)).add(sample.offset))

/** The cube's texel at a face's center, meters: what its coverage holds still over. */
const cubeTexel = (body: CloudBodyUniforms): Node<'float'> =>
  body.datumRadius.mul(Math.PI / (2 * CLOUD_CUBE_TILE))

/** The fine march's medium: the clipmap's coverage × profile × eroded noise (§5.6). */
export function fieldMedium(deps: FieldMediumDeps): CloudMediumFn {
  return (sample, body) =>
    recipe(deps, sample, body, (layer) => ({
      cover: dot(layer.weights, deps.clipmap.coverage(sample, body)),
      column: deps.clipmap.columnMeters(sample, body),
    }))
}

/**
 * The same recipe with its coverage read from the weather cube: the whole
 * body, for the served body's far bakes, which reach the limb (1,830 km of
 * gnomonic plane on far-shore from 400 km, 2,290 km on Earth), past the
 * clipmap's ±1,024 km.
 */
export function synopticMedium(deps: SynopticMediumDeps): CloudMediumFn {
  return (sample, body) =>
    recipe(deps, sample, body, (layer) => ({
      cover: dot(
        layer.weights,
        deps.maps.synoptic(directionAt(sample, body)).xyz,
      ),
      column: cubeTexel(body),
    }))
}

/**
 * The same recipe with its coverage from `scenarioCoverageNode`: the second
 * body, which has no cube.
 */
export function analyticMedium(deps: {
  readonly uniforms: CloudUniforms
  readonly noise: CloudNoiseNodes
  readonly profile: CloudProfile
}): CloudMediumFn {
  return (sample, body) =>
    recipe(deps, sample, body, (layer) => ({
      cover: scenarioCoverageNode(
        deps.uniforms,
        body,
        layer.index,
        directionAt(sample, body),
      ),
      column: cubeTexel(body),
    }))
}

/* ------------------------------------------------------------------------- */
/* The sweep                                                                  */
/* ------------------------------------------------------------------------- */

/** The most base fetches a sweep step makes (`CloudLevers.sweepReads`). */
export const SWEEP_READS_MAX = 6

/**
 * Each fetch's offset from the last, in base texels (1/16 of a cell): odd
 * and far apart, so no two of a step's fetches share a texel or a cache
 * line, and each still lands at a texel center wherever the first does.
 */
export const SWEEP_STRIDE = [37, 61, 17] as const

/** The RGBA8 variant's four channels folded into one, so a narrower read cannot serve the fetch. */
const FOLD = /*@__PURE__*/ vec4(0.4, 0.3, 0.2, 0.1)

/**
 * The sweep's medium (§8.4): `sweepReads` base-noise fetches at decorrelated
 * offsets, summed so none can be dropped, plus one read of `sweepExtra`'s
 * type. Constant work by construction: the fetches happen at every step,
 * inside a layer or not, each behind a branch on a uniform, so every ray
 * takes the same ones and nothing diverges; the density they make is
 * masked by the layer only after they are summed.
 */
export function sweepMedium(deps: FieldMediumDeps): CloudMediumFn {
  const trace = deps.uniforms.trace
  return (sample, body) => {
    const layer = layerAt(deps.uniforms.layers, sample.altitude)
    const cells = baseCells(sample, body, layer)
    const reads = trace.sweepReads
    let sum: Node<'float'> = float(0)
    for (let r = 0; r < SWEEP_READS_MAX; r += 1) {
      const at = cells.add(
        vec3(...SWEEP_STRIDE)
          .mul(r)
          .div(16),
      )
      sum = sum.add(
        select(
          reads.greaterThan(r),
          dot(deps.noise.baseWide(at), FOLD),
          float(0),
        ),
      )
    }
    const kind = trace.sweepExtra
    const is = (name: (typeof CLOUD_SWEEP_EXTRAS)[number]): Node<'bool'> =>
      kind.equal(float(CLOUD_SWEEP_EXTRAS.indexOf(name)))
    const extraRead = select(
      is('clipmap'),
      deps.clipmap.level(sample, body, 0).x,
      select(
        is('profile'),
        deps.profile.profile(layer.genus, layer.h01),
        select(
          is('detail'),
          deps.noise.detail(detailCells(sample, body, layer)),
          select(
            is('curl'),
            deps.noise.curl(vec2(cells.x, cells.z).div(8)).x,
            select(
              is('level'),
              deps.clipmap.level(sample, body, 1).x,
              float(0),
            ),
          ),
        ),
      ),
    )
    const density = saturate(sum.add(extraRead).div(reads.add(1)))
    return {
      fraction: layer.inside,
      sigma: layer.sigma.mul(density).mul(layer.inside),
      layer: layer.index,
      column: float(UNBOUNDED_COLUMN),
      radius: mix(float(NO_RADIUS), layer.radius, layer.inside),
    }
  }
}
