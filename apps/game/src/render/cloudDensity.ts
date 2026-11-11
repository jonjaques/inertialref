import type { Node } from 'three/webgpu'
import {
  clamp,
  dot,
  exp2,
  float,
  If,
  int,
  max,
  mix,
  normalize,
  property,
  saturate,
  select,
  smoothstep,
  step,
  vec3,
  vec4,
} from 'three/tsl'
import { DETAIL_NOISE_PERIOD } from '@inertialref/rendering'
import type { CloudClipmapNodes } from './cloudClipmap.ts'
import {
  CLOUD_CUBE_TILE,
  type CloudMapNodes,
  climateNode,
} from './cloudMaps.ts'
import type { CloudMedium, CloudMediumFn, CloudSample } from './cloudNodes.ts'
import {
  type CloudNoiseNodes,
  createMesoscaleRay,
  mesoscaleNode,
} from './cloudNoise.ts'
import { type CloudProfile, profileSlot } from './cloudProfile.ts'
import type {
  CloudBodyUniforms,
  CloudLayerUniforms,
  CloudUniforms,
} from './cloudUniforms.ts'

/*
 * The field's density: `levelSample` of `weatherField.ts`, the CPU field
 * every medium is held to, read through the GPU's textures. A level's cover
 * and convective share come from the climate's maps, its shape from the
 * profile table's row at that share, its cells from the base noise thresholded
 * against the shape and eroded by the detail, and past a footprint that no
 * longer resolves its cells, its level's statistics (phase 1 design §4.3,
 * §5.2). The three media
 * differ only in where the cover and the share come from — the clipmap near,
 * the weather cube for the served body's far bakes, the climate itself for a
 * second body — so the far field is the same field at every distance.
 *
 * **Nothing in the lookup is the observer's** (§5.3). Each level's noise
 * frame turns about the spin axis and drifts along it: a sample's lattice
 * point is `origin_k + M_k·offset`, the origin `latticeOrigin` of the eye in
 * float64 and `M_k` the level's turn as a float32 matrix, which is `M_k·p`
 * plus the drift modulo the noise's period for any eye. The eye enters only
 * as the point the float32 offset is measured from (rule 58).
 *
 * Each level's noise is read displaced over tens of kilometers
 * (`weatherField.ts`'s mesoscale waves). The fine medium carries the
 * waves' sines along the ray from call to call (`createMesoscaleRay`), so a
 * march step pays no sine for it; the far media and the bakes, which call
 * the field once a texel, evaluate it where they read it.
 *
 * A fine step reads the clipmap's one texture (twice in a level's fade
 * band), the profile, and the base and detail noises where it resolves the
 * field or the level's statistics where it does not. The curl that
 * tears the edges is in the base noise already (`weatherNoise.ts`), so it
 * costs a step nothing. Every read names level 0, so the media compile in a
 * fragment's non-uniform control flow as they do in compute.
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
/** µm outside every level, as the analytic media and `cloudFieldAt` have it. */
const NO_RADIUS = 10
/** The least a remap divides by: a level with no cover draws nothing rather than 0/0. */
const TINY = 1e-6

/** The level a sample is in, by altitude, as one-hot weights over the three. */
export interface Layer {
  readonly weights: Node<'vec3'>
  /** 1 inside a level, 0 outside every one. */
  readonly inside: Node<'float'>
  /** −1 outside every level. */
  readonly index: Node<'int'>
  /** The level's index as a float, 0 outside every level: the profile's row block. */
  readonly level: Node<'float'>
  readonly h01: Node<'float'>
  readonly thickness: Node<'float'>
  readonly sigma: Node<'float'>
  readonly cell: Node<'float'>
  readonly erosion: Node<'float'>
  readonly radius: Node<'float'>
}

/**
 * base_k ≤ h < top_k, unrolled over three by `step`: the levels are
 * disjoint, so at most one weight is 1 and a level's every parameter is a
 * dot product rather than a branch. An absent level has no thickness at the
 * union's top and holds nothing.
 */
export function layerAt(
  layers: CloudLayerUniforms,
  altitude: Node<'float'>,
): Layer {
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
    level: of(vec3(0, 1, 2)),
    h01: altitude.sub(base).div(thickness),
    thickness,
    sigma: of(layers.sigma),
    cell: max(of(layers.cell), 1),
    erosion: of(layers.erosion),
    radius: of(layers.radius),
  }
}

/**
 * A sample's droplet radius, µm, for a medium that reads one radius a
 * level: its level's, and the analytic media's outside every level, where a
 * filtered read can still hold cloud.
 */
export const layerRadius = (layer: Layer): Node<'float'> =>
  mix(float(NO_RADIUS), layer.radius, layer.inside)

/**
 * A level's noise frame at a sample: `M_k·offset`, and the level's two
 * origins, each the one-hot weights' sum over the three, so outside every
 * level all three are zero. The weights are exactly 0 or 1, so the sums are
 * the chosen level's to the bit.
 *
 * The turned offset is the level's one product (`levelProduct`): summed as
 * the origins are, it would be three matrix products a read where one
 * counts. Times `inside`, it stays zero outside every level, as the sum
 * does.
 */
function noiseFrame(
  sample: CloudSample,
  layers: CloudLayerUniforms,
  weights: Node<'vec3'>,
): {
  readonly turned: Node<'vec3'>
  readonly noise: Node<'vec3'>
  readonly detail: Node<'vec3'>
} {
  const sum = (of: (k: 0 | 1 | 2) => Node<'vec3'>): Node<'vec3'> =>
    of(0)
      .mul(weights.x)
      .add(of(1).mul(weights.y))
      .add(of(2).mul(weights.z)) as Node<'vec3'>
  const turned = levelProduct(
    weights,
    (k) => layers.turn[k].mul(sample.offset) as Node<'vec3'>,
  )
  return {
    turned: turned
      .mul(weights.x.add(weights.y).add(weights.z))
      .toVar() as Node<'vec3'>,
    noise: sum((k) => layers.noiseOrigin[k]),
    detail: sum((k) => layers.detailOrigin[k]),
  }
}

/**
 * A level's six phases at the eye, the one-hot weights' sum over the three
 * levels, as the origins are.
 */
function levelPhases(
  layers: CloudLayerUniforms,
  weights: Node<'vec3'>,
): readonly [Node<'vec3'>, Node<'vec3'>] {
  const sum = (half: 0 | 1): Node<'vec3'> =>
    layers.mesoscale[0][half]
      .mul(weights.x)
      .add(layers.mesoscale[1][half].mul(weights.y))
      .add(layers.mesoscale[2][half].mul(weights.z)) as Node<'vec3'>
  return [sum(0), sum(1)]
}

/**
 * The level's of three products, `of(k)` formed in the branch of the level
 * the weights name and in no other; outside every level, level 0's. The
 * select is of the product, not of the level's matrix: a selected matrix is
 * a nine-float copy held in a variable, and on this Mac mini that copy
 * costs the trace more than the two products it saves (0.01 to 0.13 ms
 * dearer on the read reckoning's rows, where the selected product is 0.12
 * to 0.28 ms cheaper).
 */
const levelProduct = (
  weights: Node<'vec3'>,
  of: (k: 0 | 1 | 2) => Node<'vec3'>,
): Node<'vec3'> =>
  select(
    weights.y.greaterThan(0.5),
    of(1),
    select(weights.z.greaterThan(0.5), of(2), of(0)),
  ) as Node<'vec3'>

/** The base noise's lattice at a sample displaced by `w`, in its level's base cells: the level's frame, no absolute position. */
const baseCells = (
  frame: ReturnType<typeof noiseFrame>,
  w: Node<'vec3'>,
  cell: Node<'float'>,
): Node<'vec3'> => frame.noise.add(frame.turned).add(w).div(cell)

/** The detail's lattice displaced by `w`, in its own cells: four a base cell, tiling once a base cell. */
const detailLattice = (
  frame: ReturnType<typeof noiseFrame>,
  w: Node<'vec3'>,
  cell: Node<'float'>,
): Node<'vec3'> =>
  frame.detail
    .add(frame.turned)
    .add(w)
    .mul(float(DETAIL_NOISE_PERIOD).div(cell)) as Node<'vec3'>

/**
 * The detail's lattice at a sample, in its own cells, in the noise frame of
 * the level the sample's altitude is in and displaced as that level's noise
 * is (`mesoscaleNode`, six sines): for a bake that adds detail back, never a
 * march step.
 */
export const detailCells = (
  sample: CloudSample,
  body: CloudBodyUniforms,
  cell: Node<'float'>,
): Node<'vec3'> => {
  const { weights } = layerAt(body.layers, sample.altitude)
  const frame = noiseFrame(sample, body.layers, weights)
  const w = mesoscaleNode(frame.turned, levelPhases(body.layers, weights), cell)
  return detailLattice(frame, w, cell)
}

/**
 * The share of the detail's erosion a footprint keeps, §5.6's fade: all of it
 * under a sixteenth of a cell, none past a quarter. The volume reads it at
 * two footprints, its bake's and the sample's, to add back what its bake
 * faded out.
 */
export const detailReach = (
  footprint: Node<'float'>,
  cell: Node<'float'>,
): Node<'float'> =>
  float(1).sub(smoothstep(cell.div(16), cell.div(4), footprint))

/** Where a level's climate and displacement come from, at a sample in the level. */
type ClimateOf = (
  layer: Layer,
  frame: ReturnType<typeof noiseFrame>,
) => {
  readonly cover: Node<'float'>
  readonly convective: Node<'float'>
  /** The level's gain at the column, where the source carries it; otherwise read from the profile's statistics. */
  readonly gain?: Node<'float'>
  /**
   * The mesoscale displacement at the sample, meters, in the level's turned
   * frame: built inside the resolved read, the one that reads the noise.
   */
  displacement(): Node<'vec3'>
  /** Horizontal meters the cover holds still over. */
  readonly column: Node<'float'>
}

/** A level's cover and share out of a body's three, by the one-hot weights. */
const ofLevel = (layer: Layer, values: Node<'vec4'>): Node<'float'> =>
  dot(layer.weights, values.xyz)

/** The displacement evaluated where it is read: six sines, for a bake. */
const exactDisplacement = (
  body: CloudBodyUniforms,
  layer: Layer,
  frame: ReturnType<typeof noiseFrame>,
): Node<'vec3'> =>
  mesoscaleNode(
    frame.turned,
    levelPhases(body.layers, layer.weights),
    layer.cell,
  )

/** The constant dither a sample without one takes: the switch at half a cell. */
const DITHER = 0.5

/**
 * `4^(dither − 1)`, the share of a cell past which a footprint reads its
 * level's statistics (`statisticsFootprint`): a constant for a sample with
 * no dither, and an `exp2` where the sample carries one.
 */
const switchShare = (sample: CloudSample): Node<'float'> =>
  sample.dither === undefined
    ? float(4 ** (DITHER - 1))
    : exp2(clamp(sample.dither, 0, 1).mul(2).sub(2))

/**
 * `levelSample` at a sample, for the level it is in. Up to a footprint of
 * `cell·4^(dither − 1)` the read is the resolved field, at every footprint
 * alike:
 *
 *     d = saturate(remap(n_b·R, 1 − c, 1, 0, 1)),  d = saturate(remap(d, n_d·erosion, 1, 0, 1))
 *     fraction = 1,  σ′ = gain·σ′_level·d
 *
 * with `R` the profile's extinction share at the height and the convective
 * share and the gain the level's statistics' at its column, which makes a
 * cloud's mean extinction inside it the genus's. The detail is never faded
 * out: a cell with its erosion taken away is a thicker cell, and the
 * crossing it darkens is the one the footprint was meant to keep.
 *
 * Past it the read is the level's statistics at the column, measured on the
 * resolved field itself: `fraction` the share of its columns that hold
 * cloud, and `σ′ = depth·R/(Ḡ·thickness)`, so a vertical column sums to the
 * depth whose transmittance is the cloudy columns' mean. It reads no noise,
 * and the displacement does not enter it: the table was measured through
 * it.
 *
 * The two are branches, not a blend of two reads that both run, so a step
 * reads the column, the profile and either the base and detail noises or
 * the statistics. A body whose tables are not all in (`CloudProfile.ready`)
 * draws nothing.
 *
 * The depths are `(B, 1)·σ′·Ḡ·thickness`, two multiplies on the profile's
 * fetch: the level's in-cloud column above the sample, and the whole of it.
 */
function recipe(
  deps: RecipeDeps,
  sample: CloudSample,
  body: CloudBodyUniforms,
  climateOf: ClimateOf,
  shareOf: (sample: CloudSample) => Node<'float'> = switchShare,
): CloudMedium {
  const layer = layerAt(body.layers, sample.altitude)
  const slot = profileSlot(deps.uniforms, body)
  const ready = deps.profile.ready[slot]
  const held = vec3(0, 0, UNBOUNDED_COLUMN).toVar()
  const shaped = vec3(NO_RADIUS, 0, 0).toVar()
  // The column's cover and share, held for a crossing's read of the
  // statistics, which a march takes once a crossing and not a step.
  const columnCover = float(0).toVar()
  const columnShare = float(0).toVar()
  If(layer.inside.greaterThan(0.5), () => {
    const frame = noiseFrame(sample, body.layers, layer.weights)
    const climate = climateOf(layer, frame)
    const cover = saturate(climate.cover).toVar()
    const convective = climate.convective.toVar()
    columnCover.assign(cover)
    columnShare.assign(convective)
    const profile = deps.profile
      .sample(slot, layer.level, layer.h01, convective)
      .toVar()
    const column = layer.sigma.mul(profile.y).mul(layer.thickness)
    shaped.assign(
      vec3(profile.w.mul(layer.radius), profile.z.mul(column), column),
    )
    const threshold = layer.cell.mul(shareOf(sample))
    If(sample.footprint.greaterThan(threshold), () => {
      const stats = deps.profile.statistics(
        slot,
        layer.level,
        cover,
        convective,
      )
      const sigma = select(
        stats.fraction.greaterThan(0).and(profile.y.greaterThan(0)),
        stats.depth
          .mul(profile.x)
          .div(max(profile.y.mul(layer.thickness), TINY)),
        float(0),
      )
      held.assign(vec3(stats.fraction, sigma, climate.column))
    }).Else(() => {
      const w = climate.displacement()
      const base = deps.noise.base(baseCells(frame, w, layer.cell))
      const erosion = deps.noise
        .detail(detailLattice(frame, w, layer.cell))
        .mul(layer.erosion)
      const shapedDensity = saturate(
        base.mul(profile.x).sub(float(1).sub(cover)).div(max(cover, TINY)),
      )
      const eroded = saturate(
        shapedDensity.sub(erosion).div(max(float(1).sub(erosion), TINY)),
      )
      const gain =
        climate.gain ?? deps.profile.gain(slot, layer.level, cover, convective)
      held.assign(vec3(1, gain.mul(layer.sigma).mul(eroded), climate.column))
    })
    // A body whose tables are not in draws nothing: no frame draws from a
    // table that is not its level's.
    held.assign(vec3(held.x.mul(ready), held.y.mul(ready), held.z))
  })
  const statistics = deps.profile.statistics(
    slot,
    layer.level,
    columnCover,
    columnShare,
  )
  return {
    fraction: held.x,
    sigma: held.y,
    layer: layer.index,
    column: held.z,
    radius: shaped.x,
    depth: shaped.yz,
    statistics: {
      fraction: statistics.fraction.mul(layer.inside).mul(ready),
      depth: statistics.depth,
      shape: statistics.shape,
      sight: statistics.sightCells.mul(layer.cell),
      mean: deps.profile.mean(slot, layer.level, columnCover, columnShare),
    },
  }
}

/** The direction from the body's center of an eye-relative point: a coarse lookup's, for the cube's 19.6 km texels and up. */
const directionAt = (
  sample: CloudSample,
  body: CloudBodyUniforms,
): Node<'vec3'> =>
  normalize(body.up.mul(body.datumRadius.add(body.eye)).add(sample.offset))

/** The cube's texel at a face's center, meters: what its cover holds still over. */
const cubeTexel = (body: CloudBodyUniforms): Node<'float'> =>
  body.datumRadius.mul(Math.PI / (2 * CLOUD_CUBE_TILE))

/**
 * The fine march's medium: the clipmap's climate (§4.3), and the mesoscale
 * displacement carried along the ray from call to call
 * (`createMesoscaleRay`), so a step pays no sine for it.
 */
export function fieldMedium(deps: FieldMediumDeps): CloudMediumFn {
  return fieldMedia(deps).field
}

/**
 * The fine march's medium, and the same field read at a light tap: a point
 * within a kilometer of the step the march last read, along the sun.
 *
 * A tap takes its step's column, the cover, the convective share, the gain
 * and the texel they hold over, and the displacement beside the ray's chain
 * (`MesoscaleRay.near`), and reads the profile and the noises at its own
 * point. The column is the clipmap's, whose finest texel is wider than a
 * tap's reach, and its pick is a quarter of a read; the displacement's
 * chain is another third, and a tap that advanced it would leave the next
 * step to start it over.
 */
export function fieldMedia(deps: FieldMediumDeps): {
  readonly field: CloudMediumFn
  readonly tap: CloudMediumFn
} {
  const ray = createMesoscaleRay()
  const share = ditherShare()
  /** The last step's column: cover, convective share, gain and its texel's meters. */
  const stepped = property('vec4')
  return {
    field: (sample, body) =>
      recipe(
        deps,
        sample,
        body,
        (layer, frame) => {
          const column = deps.clipmap.column(sample, body, layer.index)
          stepped.assign(
            vec4(column.cover, column.convective, column.gain, column.meters),
          )
          return {
            cover: stepped.x,
            convective: stepped.y,
            gain: stepped.z,
            displacement: () =>
              ray(
                frame.turned,
                levelPhases(body.layers, layer.weights),
                layer.cell,
                layer.level,
              ),
            column: stepped.w,
          }
        },
        share,
      ),
    tap: (sample, body) =>
      recipe(
        deps,
        sample,
        body,
        (layer, frame) => ({
          cover: stepped.x,
          convective: stepped.y,
          gain: stepped.z,
          displacement: () =>
            ray.near(
              frame.turned,
              levelPhases(body.layers, layer.weights),
              layer.cell,
              layer.level,
            ),
          column: stepped.w,
        }),
        share,
      ),
  }
}

/**
 * `switchShare` for a march: a ray carries one dither, so its `exp2` is
 * taken when the dither changes, once a ray, and held between the calls in
 * invocation-wide variables, as the displacement's chain is
 * (`createMesoscaleRay`).
 */
function ditherShare(): (sample: CloudSample) => Node<'float'> {
  const key = property('float')
  const held = property('float')
  return (sample) => {
    if (sample.dither === undefined) return switchShare(sample)
    const dither = clamp(sample.dither, 0, 1)
    // A dither plus one, so the variables' zero start is no dither's key.
    const next = dither.add(1)
    If(key.notEqual(next), () => {
      held.assign(exp2(dither.mul(2).sub(2)))
      key.assign(next)
    })
    return held
  }
}

/**
 * The same recipe with its climate read from the weather cube: the whole
 * body, for the served body's far bakes, which reach the limb (1,830 km of
 * gnomonic plane on far-shore from 400 km, 2,290 km on Earth), past the
 * clipmap's ±1,024 km.
 */
export function synopticMedium(deps: SynopticMediumDeps): CloudMediumFn {
  return (sample, body) => {
    const direction = directionAt(sample, body)
    return recipe(deps, sample, body, (layer, frame) => ({
      cover: ofLevel(layer, deps.maps.cover(direction)),
      convective: ofLevel(layer, deps.maps.kind(direction)),
      displacement: () => exactDisplacement(body, layer, frame),
      column: cubeTexel(body),
    }))
  }
}

/**
 * The same recipe with its climate evaluated where it is read
 * (`climateNode`): the second body, which has no cube.
 */
export function analyticMedium(deps: {
  readonly uniforms: CloudUniforms
  readonly noise: CloudNoiseNodes
  readonly profile: CloudProfile
}): CloudMediumFn {
  return (sample, body) => {
    const climate = climateNode(body, deps.noise, directionAt(sample, body))
    return recipe(deps, sample, body, (layer, frame) => ({
      cover: ofLevel(layer, climate.cover),
      convective: ofLevel(layer, climate.kind),
      displacement: () => exactDisplacement(body, layer, frame),
      column: cubeTexel(body),
    }))
  }
}

/**
 * The three media of a field, over one recipe: the fine march's from the
 * clipmap, the served body's far bakes' from the cube, and a second body's
 * from the climate itself.
 *
 * A factory names what its module reads of the field, and the field hands
 * every factory more than that, so a module whose constructor needs another
 * part asks for it here and the field's construction does not change.
 */
export function createCloudMedia(deps: {
  readonly uniforms: CloudUniforms
  readonly noise: { readonly nodes: CloudNoiseNodes }
  readonly profile: CloudProfile
  readonly maps: { readonly nodes: CloudMapNodes }
  readonly clipmap: { readonly nodes: CloudClipmapNodes }
}): {
  readonly field: CloudMediumFn
  /** The field at a light tap beside the fine march's last step (`fieldMedia`). */
  readonly tap: CloudMediumFn
  readonly synoptic: CloudMediumFn
  readonly analytic: CloudMediumFn
} {
  const recipe = {
    uniforms: deps.uniforms,
    noise: deps.noise.nodes,
    profile: deps.profile,
  }
  return {
    ...fieldMedia({ ...recipe, clipmap: deps.clipmap.nodes }),
    synoptic: synopticMedium({ ...recipe, maps: deps.maps.nodes }),
    analytic: analyticMedium(recipe),
  }
}
