import {
  ClampToEdgeWrapping,
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  type Node,
  RGBAFormat,
  type Texture,
  type TextureNode,
  type UniformNode,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  abs,
  acos,
  clamp,
  cos,
  dot,
  float,
  int,
  log,
  max,
  min,
  mix,
  pow,
  select,
  sqrt,
  texture3D,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'
import {
  type CloudGenus,
  GENUS_TABLE,
  SLAB_DIFFUSION_REACH,
  SLAB_SUN_HOLD,
  SLAB_VIEW_SOURCE,
} from '@inertialref/rendering'
import type { CloudClimateFrame, CloudFrame } from './cloudFrame.ts'
import {
  type CloudResource,
  type CloudSourceLevel,
  type CloudSourceNodes,
  type CloudSourceSlab,
  cloudSourceStandIn,
  type CloudSourceView,
} from './cloudNodes.ts'

/*
 * The light a cloud scatters after first order, as a source a march
 * integrates: `SLAB_VIEW_SOURCE` as a 3D texture, and its read (design
 * §5.5). `packages/rendering/src/slabSourceRead.ts` is the same read on the
 * CPU, the one the table's header figures were taken through, and
 * `cloudSource.gpu.test.ts` holds this node to it.
 *
 * **The node takes a slab and a view and owns everything between them and
 * the texel.** A caller forms the slab a sample stands in (`resolvedSlab`,
 * `statisticalSlab` in `cloudMix.ts`) and the view's cosine and bearing in
 * the sample's own frame. Inside: the transport scale at the sample's
 * radius for its level's class, the depths' logarithm, the hold of the
 * sun's coordinate inside its slab, the two reads and their blend in the
 * view's polar angle, the extension past the last depth node, and the
 * factor of the sun by level. Three callers read the table (the march, the
 * far march, the composite's second body), and a convention left outside
 * the node is a convention one of them misses.
 *
 * **A level's numbers are formed once a crossing** (`level`), and a caller
 * hands them back at each read. Read from their uniforms at every step
 * instead, the level's class and its two factors cost the frame 0.15 to
 * 0.2 ms at 1080p on the Mac mini's GPU, more than the view's four
 * transcendentals: a component of a uniform chosen by a level is not a
 * value that GPU's compiler lifts out of a loop.
 *
 * **The transport depth is `(1 − χ′₁)·τ′`, by the scaled phase's own first
 * moment,** which the table records at each radius, read linearly in ln r:
 * `transport` for droplets and `iceTransport` for ice. The formula's
 * `1 − g′`, which a level's uniforms hold at its reference radius, is over
 * it by 0.046/r to 0.055/r, because the diffraction the scaling takes out
 * has wings.
 *
 * **The factor of the sun by level** multiplies the sun's orders past the
 * first, never first order and never the sky:
 *
 *     c = 1 + v·(l·(1 + a·√(1 − μ₀²)/μ₀) − 1)
 *
 * with `μ₀` the slab's own sun cosine and `v` the cumuliform share of the
 * slab's column. A plane slab's source cannot describe a cloud with sides:
 * a cumulus's lit wall takes the sun at the cosine to the wall and the slab
 * reads it at the cosine to the vertical, low under a low sun and high
 * under a high one. `l` and `a` are a fit of that mean error for a genus's
 * own clouds (`CLOUD_SUN_FACTORS`), one pair a level, for its cumuliform
 * genus. It mends the mean and only the mean: a cloud's thin rim is read
 * brighter than a path tracer has it wherever the factor brightens the
 * cloud, which is declared. At `v = 0` it is exactly one, so a stratiform
 * level and the slab gate take none.
 *
 * **The texels arrive by `import()`,** 1.28 MB of base64 that no chunk on a
 * page's static path may carry: until they land the node reads a 1 × 1 × 1
 * stand-in of the table's format, filter and wrap, which holds no source,
 * and the resource is pending.
 */

const TABLE = SLAB_VIEW_SOURCE
/** Slabs: a view cosine in each hemisphere. */
const SLABS = 2 * TABLE.cosines.length
/** Slices: a sun cosine in each slab. */
const SLICES = SLABS * TABLE.suns
const TEXEL_BYTES = 8
/** What the table holds on the device: 20 × 20 × 300 RGBA16F, one level. */
export const CLOUD_SOURCE_BYTES =
  TABLE.nodes * TABLE.nodes * SLICES * TEXEL_BYTES

/**
 * The factor of the sun's two numbers by cumuliform genus, `l` and `a` of
 * `c = l·(1 + a·cot e)`: fitted to path traces of eight of the field's own
 * cumulus clouds under nine suns from 7° to 70°, against a CPU march of the
 * plane slab's source through `slabSourceRead.ts` (the depth rule's second
 * critic, its second job: on six clouds it was not fitted to, the root mean
 * square of the logarithm of the march over the trace falls from 0.67 to
 * 0.47, and the sum's error by sun from −55% … +33% to −1% … +7%). A genus
 * not yet fitted takes 1 and 0, which is no factor.
 */
export const CLOUD_SUN_FACTORS: Readonly<
  Partial<Record<CloudGenus, { readonly l: number; readonly a: number }>>
> = { cumulus: { l: 0.71, a: 0.25 } }
const NO_FACTOR = { l: 1, a: 0 } as const

/** A level's class and its factor of the sun, as the node reads them. */
export interface CloudSourceLevels {
  /** 1 where the level scatters as ice, by component. */
  readonly ice: UniformNode<'vec3', Vector3>
  /** `l`, by component: 1 where the level's cumuliform genus has no pair. */
  readonly factor: UniformNode<'vec3', Vector3>
  /** `a`, by component: 0 where it has none. */
  readonly slope: UniformNode<'vec3', Vector3>
}

function createLevels(): CloudSourceLevels {
  return {
    ice: uniform(new Vector3(0, 0, 0)),
    factor: uniform(new Vector3(1, 1, 1)),
    slope: uniform(new Vector3(0, 0, 0)),
  }
}

function writeLevels(
  levels: CloudSourceLevels,
  genera: CloudClimateFrame['genera'],
): void {
  const of = (read: (cumuliform: CloudGenus) => number) =>
    genera.map(([, cumuliform]) => read(cumuliform)) as [number, number, number]
  const set = (target: Vector3, [x, y, z]: [number, number, number]): void => {
    if (target.x !== x || target.y !== y || target.z !== z) target.set(x, y, z)
  }
  // A level's two genera scatter as one class (`levelGenera` refuses a
  // level that blends two).
  set(
    levels.ice.value,
    of((genus) => (GENUS_TABLE[genus].class === 'ice' ? 1 : 0)),
  )
  set(
    levels.factor.value,
    of((genus) => (CLOUD_SUN_FACTORS[genus] ?? NO_FACTOR).l),
  )
  set(
    levels.slope.value,
    of((genus) => (CLOUD_SUN_FACTORS[genus] ?? NO_FACTOR).a),
  )
}

/** A level's component of a per-level vector. */
const ofLevel = (v: Node<'vec3'>, level: Node<'int'>): Node<'float'> =>
  select(level.equal(int(0)), v.x, select(level.equal(int(1)), v.y, v.z))

/** A table of scales against radius, as a chain of ramps in ln r. */
interface ScaleRamps {
  /** ln of the first and last radius, and the first scale. */
  readonly from: number
  readonly to: number
  readonly first: number
  /** A node's ln r, and the change of slope there. */
  readonly ramps: readonly (readonly [at: number, turn: number])[]
}

/**
 * A table of scales against radius, read linearly in ln r and held at its
 * ends, as a sum of ramps: `s₀ + Σ cₖ·max(ln r − ln rₖ, 0)`, each `cₖ` the
 * change of slope at a node. A max, a multiply and an add a node, and no
 * branch for a batch's rays to disagree about.
 */
function scaleRamps(table: {
  readonly radii: readonly number[]
  readonly scales: readonly number[]
}): ScaleRamps {
  const at = table.radii.map(Math.log)
  const last = at.length - 1
  const ramps: [number, number][] = []
  let before = 0
  for (let k = 0; k < last; k += 1) {
    const slope =
      (table.scales[k + 1]! - table.scales[k]!) / (at[k + 1]! - at[k]!)
    ramps.push([at[k]!, slope - before])
    before = slope
  }
  return { from: at[0]!, to: at[last]!, first: table.scales[0]!, ramps }
}

const DROPLETS = scaleRamps(TABLE.transport)
/**
 * Ice's scale runs from 0.4863 to 0.4973 over its 23 rows, and a level
 * reads it through `CLOUD_ICE_ROWS` of them: within 0.02% of the read
 * between every pair, for ten ramps a step fewer. Its source is declared
 * at 22% root mean square against the oracle on the ice phase itself.
 */
export const CLOUD_ICE_ROWS = [0, 1, 2, 3, 4, 6, 8, 12, 16, 22] as const
const ICE = scaleRamps({
  radii: CLOUD_ICE_ROWS.map((row) => TABLE.iceTransport.radii[row]),
  scales: CLOUD_ICE_ROWS.map((row) => TABLE.iceTransport.scales[row]),
})

/** A chain of ramps at ln r. */
function rampsAt(table: ScaleRamps, logRadius: Node<'float'>): Node<'float'> {
  const t = clamp(logRadius, table.from, table.to)
  return table.ramps.reduce<Node<'float'>>(
    (scale, [at, turn]) => scale.add(max(t.sub(at), 0).mul(turn)),
    float(table.first),
  )
}

/** What a view's read needs, as the node keeps it behind `CloudSourceView`. */
interface ViewRead {
  /** The first of the two slabs the view lies between, as a float. */
  readonly slab: Node<'float'>
  /** The second slab's share, in the polar angle. */
  readonly share: Node<'float'>
  /** (1, cos ψ, cos 2ψ, cos 3ψ) at the stretched bearing. */
  readonly weights: Node<'vec4'>
}

const VIEW_ANGLES = TABLE.cosines.map(Math.acos)
const DEPTH_LOG = 1 / Math.log1p(TABLE.depthMax / TABLE.depthScale)
/** The least a bearing's angle is taken as, of π: `pow` at zero is the adapter's to define. */
const NO_ANGLE = 1e-7

/** The node set over one body's levels and the one table. */
function sourceNodes(
  table: TextureNode,
  levels: CloudSourceLevels,
): CloudSourceNodes {
  return {
    view(mu, bearing) {
      const steep = abs(mu)
      // The pair of cosines the view lies between: the last node at or
      // under it, of all but the first and the last.
      let low: Node<'float'> = float(0)
      let near: Node<'float'> = float(VIEW_ANGLES[0]!)
      let far: Node<'float'> = float(VIEW_ANGLES[1]!)
      for (let j = 1; j < TABLE.cosines.length - 1; j += 1) {
        const past = steep.greaterThanEqual(TABLE.cosines[j]!)
        low = select(past, float(j), low)
        near = select(past, float(VIEW_ANGLES[j]!), near)
        far = select(past, float(VIEW_ANGLES[j + 1]!), far)
      }
      // Blended in the polar angle, where a source's first harmonic is a
      // line at the pole and at the horizon both; a view outside the first
      // or the last cosine reads that slab alone.
      const share = clamp(
        near.sub(acos(min(steep, 1))).div(near.sub(far)),
        0,
        1,
      )
      const hemisphere = select(
        mu.greaterThanEqual(0),
        float(0),
        float(TABLE.cosines.length),
      )
      // ψ = π·(φ/π)^stretch: the harmonics are spent near the sun's own
      // bearing, where a source's lobe is.
      const turn = max(acos(clamp(bearing, -1, 1)).div(Math.PI), NO_ANGLE)
      const c = cos(pow(turn, float(TABLE.stretch)).mul(Math.PI)).toVar()
      const read: ViewRead = {
        slab: hemisphere.add(low).toVar(),
        share: share.toVar(),
        weights: vec4(
          1,
          c,
          c.mul(c).mul(2).sub(1),
          c.mul(c.mul(c).mul(4).sub(3)),
        ).toVar(),
      }
      return read as unknown as CloudSourceView
    },

    // (ice, l, l·a): whether the level scatters as ice, and its factor of
    // the sun as `1 + v·(l − 1 + l·a·√(1 − μ₀²)/μ₀)`.
    level(index) {
      const factor = ofLevel(levels.factor, index)
      return vec3(
        ofLevel(levels.ice, index),
        factor,
        factor.mul(ofLevel(levels.slope, index)),
      )
    },

    source(slab: CloudSourceSlab, radius, level, view) {
      const read = view as unknown as ViewRead
      const sunMu = clamp(slab.sunMu, TABLE.sunMuMin, 1).toVar()
      const logRadius = log(max(radius, 1e-6)).toVar()
      const scale = select(
        level.x.greaterThan(0.5),
        rampsAt(ICE, logRadius),
        rampsAt(DROPLETS, logRadius),
      )
      // Transport depths: from the lit face, and to the far one.
      const depth = max(slab.depth, 0).mul(scale).toVar()
      const last = TABLE.nodes - 1
      const across = min(
        log(depth.div(TABLE.depthScale).add(1)).mul(DEPTH_LOG),
        1,
      )
        .mul(last)
        .add(0.5)
        .div(TABLE.nodes)
      // Held a 128th of a slice inside the slab's first and last: formed
      // in float32 the coordinate lands up to 1.5e-5 of a texel into the
      // next slab, whose source is 42 times this one's at the median.
      const sun = clamp(
        sunMu.sub(TABLE.sunMuMin).mul((TABLE.suns - 1) / (1 - TABLE.sunMuMin)),
        SLAB_SUN_HOLD,
        TABLE.suns - 1 - SLAB_SUN_HOLD,
      ).add(0.5)
      const at = (slabIndex: Node<'float'>): Node<'float'> =>
        dot(
          table
            .sample(
              vec3(across, slabIndex.mul(TABLE.suns).add(sun).div(SLICES)),
            )
            .level(float(0)),
          read.weights,
        )
      const blended = mix(at(read.slab), at(read.slab.add(1)), read.share)
      /*
       * Past the last depth node from the lit face the read is the node's,
       * and diffusion's law carries it on: the source falls linearly to
       * the far face, `(t_b + q)/(t_d + t_b + 2q)`. Held instead,
       * transmitted light reads +62% at an unscaled depth of 200 and +217%
       * at 400. The two branches are `diffusionExtension`'s: a far face
       * inside the table, and one past it as well.
       */
      const reach = SLAB_DIFFUSION_REACH
      const end = TABLE.depthMax
      const top = max(depth.x, end)
      const bottom = max(depth.y, end)
      const near = min(depth.y, end)
      const extension = float(end)
        .add(near)
        .add(reach)
        .div(top.add(near).add(reach))
        .mul(bottom.add(reach / 2).div(end + reach / 2))
        .mul(top.add(end + reach).div(top.add(bottom).add(reach)))
      const extended = blended.mul(
        select(depth.x.greaterThan(end), extension, float(1)),
      )
      const { convective } = slab
      if (convective === undefined) return extended
      const lean = sqrt(max(float(1).sub(sunMu.mul(sunMu)), 0)).div(sunMu)
      return extended.mul(
        level.y.sub(1).add(level.z.mul(lean)).mul(convective).add(1),
      )
    },
  }
}

/** Little-endian half floats from base64, as the texel module holds them. */
function halvesFromBase64(text: string, count: number): Uint16Array {
  const bytes = atob(text)
  if (bytes.length !== count * 2)
    throw new Error(
      `cloudSource: the table holds ${bytes.length} bytes where ${count} half floats are ${count * 2}`,
    )
  const halves = new Uint16Array(count)
  for (let i = 0; i < count; i += 1)
    halves[i] = bytes.charCodeAt(2 * i) | (bytes.charCodeAt(2 * i + 1) << 8)
  return halves
}

/**
 * The source as the field holds it: the served body's node set, a second
 * body's, the levels each reads, and the table they share.
 */
export class CloudSource implements CloudResource, CloudSourceNodes {
  readonly name = 'source'
  /** The served body's levels, and a second clouded body's. */
  readonly levels: CloudSourceLevels = createLevels()
  readonly secondLevels: CloudSourceLevels = createLevels()
  /** The same table read with a second body's levels. */
  readonly second: CloudSourceNodes
  readonly #standIn: Texture
  readonly #node: TextureNode
  readonly #served: CloudSourceNodes
  #map: Data3DTexture | null = null
  #loading: Promise<void> | null = null
  #allocated = false
  #disposed = false

  constructor() {
    this.#standIn = cloudSourceStandIn()
    this.#node = texture3D(this.#standIn)
    this.#served = sourceNodes(this.#node, this.levels)
    this.second = sourceNodes(this.#node, this.secondLevels)
  }

  view(mu: Node<'float'>, bearing: Node<'float'>): CloudSourceView {
    return this.#served.view(mu, bearing)
  }

  level(index: Node<'int'>): CloudSourceLevel {
    return this.#served.level(index)
  }

  source(
    slab: CloudSourceSlab,
    radius: Node<'float'>,
    level: CloudSourceLevel,
    view: CloudSourceView,
  ): Node<'float'> {
    return this.#served.source(slab, radius, level, view)
  }

  /**
   * A table's half floats, laid out [slab][sun][bottom][top][channel], in
   * place of whatever the node reads: the committed table's when they
   * arrive, or a test's own.
   */
  land(halves: Uint16Array): void {
    if (this.#disposed) return
    if (halves.length !== TABLE.texelCount)
      throw new Error(
        `cloudSource: ${halves.length} half floats where the table's layout holds ${TABLE.texelCount}`,
      )
    const map = new Data3DTexture(halves, TABLE.nodes, TABLE.nodes, SLICES)
    map.format = RGBAFormat
    map.type = HalfFloatType
    // Linear by name: a `Data3DTexture` magnifies by nearest unless told.
    map.magFilter = LinearFilter
    map.minFilter = LinearFilter
    map.wrapS = ClampToEdgeWrapping
    map.wrapT = ClampToEdgeWrapping
    map.wrapR = ClampToEdgeWrapping
    map.generateMipmaps = false
    map.name = 'cloud source'
    map.needsUpdate = true
    this.#map?.dispose()
    this.#map = map
    this.#node.value = map
  }

  /** The committed table, fetched once: settles when its texels have landed. */
  load(): Promise<void> {
    this.#loading ??= import('@inertialref/rendering/slabSourceTexels').then(
      ({ SLAB_VIEW_SOURCE_TEXELS: committed }) => {
        // A test's table landed first stays.
        if (this.#map === null)
          this.land(halvesFromBase64(committed.texels, committed.count))
      },
    )
    return this.#loading
  }

  /** The frame's levels: each body's classes and factors, from its two genera a level. */
  write(frame: CloudFrame): void {
    writeLevels(this.levels, frame.served.climate.genera)
    if (frame.second !== null)
      writeLevels(this.secondLevels, frame.second.climate.genera)
  }

  /** The table's texture once it has landed, and its stand-in until then. */
  get texture(): Texture {
    return this.#map ?? this.#standIn
  }

  get pending(): boolean {
    return !this.#disposed && this.#map === null
  }

  get bytes(): number {
    return this.#disposed || !this.#allocated || this.#map === null
      ? 0
      : CLOUD_SOURCE_BYTES
  }

  textures(): readonly Texture[] {
    return this.#disposed || !this.#allocated || this.#map === null
      ? []
      : [this.#map]
  }

  /**
   * Fetches the table and puts it on the device ahead of the first ray
   * that reads it; it draws nothing, so there is no pipeline of its own to
   * build. A renderer with no backend has no device to put it on.
   */
  async warm(renderer: WebGPURenderer): Promise<void> {
    await this.load()
    if (this.#disposed || this.#map === null) return
    if (renderer?.backend === undefined) return
    renderer.initTexture(this.#map)
    this.#allocated = true
  }

  /** The table is uploaded when it lands and draws nothing a frame. */
  render(): void {}

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#map?.dispose()
    this.#standIn.dispose()
  }
}

export function createCloudSource(): CloudSource {
  return new CloudSource()
}
