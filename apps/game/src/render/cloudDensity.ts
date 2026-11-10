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
  vec3,
} from 'three/tsl'
import { DETAIL_NOISE_PERIOD } from '@inertialref/rendering'
import type { CloudClipmapNodes } from './cloudClipmap.ts'
import { CLOUD_CUBE_TILE, type CloudMapNodes, climateNode } from './cloudMaps.ts'
import type { CloudMedium, CloudMediumFn, CloudSample } from './cloudNodes.ts'
import { type CloudNoiseNodes, mesoscaleNode } from './cloudNoise.ts'
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
 * against the shape and eroded by the detail, faded by footprint to a
 * fraction and a mean extinction (phase 1 design §4.3, §5.2). The three media
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
 * A step reads the cover and the kind (each twice in a clipmap level's fade
 * band), the profile, the base noise and the detail noise. The curl that
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
 * level all three are zero and no read is wasted on a select of indices.
 * The weights are exactly 0 or 1, so the sums are the chosen level's to the
 * bit.
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
  const sum = (
    of: (k: 0 | 1 | 2) => Node<'vec3'>,
  ): Node<'vec3'> =>
    of(0)
      .mul(weights.x)
      .add(of(1).mul(weights.y))
      .add(of(2).mul(weights.z)) as Node<'vec3'>
  return {
    turned: sum((k) => layers.turn[k].mul(sample.offset) as Node<'vec3'>),
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
  /** The mesoscale displacement at the sample, meters, in the level's turned frame. */
  readonly displacement: Node<'vec3'>
  /** Horizontal meters the cover holds still over. */
  readonly column: Node<'float'>
}

/** A level's cover and share out of a body's three, by the one-hot weights. */
const ofLevel = (
  layer: Layer,
  values: Node<'vec4'>,
): Node<'float'> => dot(layer.weights, values.xyz)

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

/**
 * `levelSample` at a sample, for the level it is in:
 *
 *     d     = saturate(remap(n_b·R, 1 − c, 1, 0, 1)),  d = saturate(remap(d, n_d, 1, 0, 1))
 *     f     = smoothstep(cell/4, cell, footprint)       the unresolved share of a cell
 *     fraction = mix(1, c, f),   fraction·σ′ = σ′_level·mix(d, c·Ḡ, f)
 *
 * with `R` the profile's extinction share at the height and the convective
 * share, `Ḡ` its mean over the level, and
 * `n_d = detail·erosion·(1 − smoothstep(cell/16, cell/4, footprint))`.
 *
 * The two pictures of a cell — resolved, all of it at σ′·d, and unresolved,
 * a share c at σ′·Ḡ — are blended by their mean extinction, fraction × σ′,
 * which is what a step's transmittance follows. Blending σ′ and the
 * fraction each on its own puts (1 − f)·f·σ′·Ḡ of cloud in a cell with no
 * cover, where the first picture holds no σ′ and the second no share: at the
 * far bake's 400 m footprint on 1 km cells that phantom made the atlas
 * 96–97% cloudy at every texel the cube held clear, and Earth opaque from
 * orbit. Both ends of the blend are unchanged.
 *
 * The depths are `(B, 1)·σ′·Ḡ·thickness`, two multiplies on the profile's
 * fetch: the level's in-cloud column above the sample, and the whole of it.
 */
function recipe(
  deps: RecipeDeps,
  sample: CloudSample,
  body: CloudBodyUniforms,
  climateOf: ClimateOf,
): CloudMedium {
  const layer = layerAt(body.layers, sample.altitude)
  const slot = profileSlot(deps.uniforms, body)
  const inLayer = (): readonly [Node<'vec3'>, Node<'vec3'>] => {
    const frame = noiseFrame(sample, body.layers, layer.weights)
    const climate = climateOf(layer, frame)
    const cover = saturate(climate.cover)
    const convective = climate.convective
    const w = climate.displacement
    const profile = deps.profile.sample(slot, layer.level, layer.h01, convective)
    const base = deps.noise.base(baseCells(frame, w, layer.cell))
    const cell = layer.cell
    const footprint = sample.footprint
    const reach = detailReach(footprint, cell)
    const erosion = select(
      reach.greaterThan(0),
      deps.noise
        .detail(detailLattice(frame, w, cell))
        .mul(layer.erosion)
        .mul(reach),
      float(0),
    )
    const shaped = saturate(
      base.mul(profile.x).sub(float(1).sub(cover)).div(max(cover, TINY)),
    )
    const eroded = saturate(
      shaped.sub(erosion).div(max(float(1).sub(erosion), TINY)),
    )
    const unresolved = smoothstep(cell.div(4), cell, footprint)
    const fraction = mix(float(1), cover, unresolved)
    const extinction = layer.sigma.mul(
      mix(eroded, cover.mul(profile.y), unresolved),
    )
    const column = layer.sigma.mul(profile.y).mul(layer.thickness)
    return [
      vec3(fraction, extinction.div(max(fraction, TINY)), climate.column),
      vec3(profile.w.mul(layer.radius), profile.z.mul(column), column),
    ]
  }
  const inside = layer.inside.greaterThan(0.5)
  const [held, shaped] = inLayer()
  const first = select(inside, held, vec3(0, 0, UNBOUNDED_COLUMN))
  const second = select(inside, shaped, vec3(NO_RADIUS, 0, 0))
  return {
    fraction: first.x,
    sigma: first.y,
    layer: layer.index,
    column: first.z,
    radius: second.x,
    depth: second.yz,
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
 * The fine march's medium: the clipmap's climate and displacement (§4.3).
 * The displacement is the column's at the level's middle height plus its
 * rate times the sample's height from there, so a step pays no sine.
 */
export function fieldMedium(deps: FieldMediumDeps): CloudMediumFn {
  return (sample, body) =>
    recipe(deps, sample, body, (layer) => {
      const column = deps.clipmap.column(sample, body, layer.index)
      const middle = dot(
        layer.weights,
        body.layers.base.add(body.layers.top).mul(0.5),
      )
      return {
        cover: column.cover,
        convective: column.convective,
        displacement: column.displacement.add(
          column.rise.mul(sample.altitude.sub(middle)),
        ),
        column: deps.clipmap.columnMeters(sample, body),
      }
    })
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
      displacement: exactDisplacement(body, layer, frame),
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
      displacement: exactDisplacement(body, layer, frame),
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
  readonly synoptic: CloudMediumFn
  readonly analytic: CloudMediumFn
} {
  const recipe = {
    uniforms: deps.uniforms,
    noise: deps.noise.nodes,
    profile: deps.profile,
  }
  return {
    field: fieldMedium({ ...recipe, clipmap: deps.clipmap.nodes }),
    synoptic: synopticMedium({ ...recipe, maps: deps.maps.nodes }),
    analytic: analyticMedium(recipe),
  }
}
