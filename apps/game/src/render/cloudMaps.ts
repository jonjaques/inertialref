import { getLogger } from '@inertialref/shared'
import {
  LinearFilter,
  type Node,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  type Texture,
  type UniformNode,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  float,
  int,
  mrt,
  normalize,
  screenCoordinate,
  tan,
  texture,
  uniform,
  vec4,
  wgslFn,
} from 'three/tsl'
import {
  BLOB_MEAN,
  blobCells,
  blobThreshold,
  CUBE_FACES,
  type CubeFace,
  genusProfileMean,
  MAX_CLOUD_LAYERS,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import type { CloudFrame } from './cloudFrame.ts'
import { cubeAtlasUv } from './cloudGeometry.ts'
import type { CloudBudget, CloudResource } from './cloudNodes.ts'
import { cloudPcg4d } from './cloudNoise.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmSensorPass } from './warmup.ts'

/*
 * The weather cube: a 2D atlas of six tangent-warped face tiles, 3 × 2, each
 * 512² with a one-texel gutter, four RGBA8 targets drawn by one MRT quad,
 * baked from the placeholder's coverage function one face a frame. The bakes
 * read it — the clipmap's levels, the far atlas, the sphere caches — and the
 * fine march does not, which keeps the trace kernel inside the binding limit.
 *
 * Phase 0's packing (§3.9), which the clipmap shares, so a fine step's
 * coverage of all three layers is one texel:
 *
 *   0  coverage of layers 0–2           ice share of the middle layer
 *   1  log in-cloud τ of layers 0–2     rain rate
 *   2  convective share of layers 0–2   deep-convection rate
 *   3  wind east, wind north            wetness, puddles (spare)
 *
 * with log τ as log2(1 + τ)/log2(513), τ to 512 in 2.5% steps, and wind as
 * ±50 m/s about ½. The placeholder fills textures 0–2 from the scenario and
 * texture 3 with its wind; rain, deep convection, wetness and puddles are 0.
 */

const log = getLogger('game.clouds')

/** Interior texels a face tile has. */
export const CLOUD_CUBE_TILE = 512
/** Texels of neighbor a tile carries on each side. */
export const CLOUD_CUBE_GUTTER = 1
export const CLOUD_CUBE_COLUMNS = 3
export const CLOUD_CUBE_ROWS = 2
/** A tile with its gutters: 514 texels. */
const SPAN = CLOUD_CUBE_TILE + 2 * CLOUD_CUBE_GUTTER
export const CLOUD_CUBE_WIDTH = CLOUD_CUBE_COLUMNS * SPAN
export const CLOUD_CUBE_HEIGHT = CLOUD_CUBE_ROWS * SPAN

/** The bake's pass on the timeline: one face tile a frame. */
export const CLOUD_MAPS_LABEL = 'cloud maps'

/** The names the MRT outputs and the target's textures share. */
const CHANNELS = [
  'cloudMaps0',
  'cloudMaps1',
  'cloudMaps2',
  'cloudMaps3',
] as const

/** Four RGBA8 targets: 16 bytes a texel. */
const TEXEL_BYTES = 16

/* ------------------------------------------------------------------------- */
/* The scenario's pattern                                                     */
/* ------------------------------------------------------------------------- */

/*
 * What the coverage function reads beyond the layers' own uniforms: the
 * pattern, its scale, the blob grid, each layer's u32 blob threshold — formed
 * on the CPU, compared as an integer (rule 58) — and its floor, and the
 * channels the other three textures carry. `CloudUniforms` has no slot for
 * them, so they ride beside the bundle, one set per bundle, and every node
 * built on that bundle reads the same set. `writeScenarioPattern` fills it
 * from the frame's scenario, which `CloudMaps.render` does each frame before
 * anything bakes from the coverage; a pass that bakes from it without the
 * maps calls it itself.
 */

const PATTERN = { uniform: 0, bands: 1, blobs: 2 } as const

interface ScenarioPattern {
  readonly kind: UniformNode<'float', number>
  /** Radians: a band's width. */
  readonly scale: UniformNode<'float', number>
  /** Blob cells a face edge. */
  readonly cells: UniformNode<'float', number>
  /** Each layer's blob threshold, a u32. */
  readonly thresholds: UniformNode<'uvec4', Vector4>
  /** Each layer's coverage between blobs. */
  readonly floors: UniformNode<'vec3', Vector3>
  readonly logDepth: UniformNode<'vec3', Vector3>
  readonly convective: UniformNode<'vec3', Vector3>
  /** The middle layer's ice share. */
  readonly ice: UniformNode<'float', number>
  /** Texture 3's encoding of the wind, east and north. */
  readonly wind: UniformNode<'vec2', Vector2>
}

const PATTERNS = new WeakMap<CloudUniforms, ScenarioPattern>()

function patternOf(uniforms: CloudUniforms): ScenarioPattern {
  let pattern = PATTERNS.get(uniforms)
  if (pattern === undefined) {
    pattern = {
      kind: uniform(PATTERN.uniform),
      scale: uniform(0),
      cells: uniform(1),
      thresholds: uniform(new Vector4(), 'uvec4'),
      floors: uniform(new Vector3()),
      logDepth: uniform(new Vector3()),
      convective: uniform(new Vector3()),
      ice: uniform(0),
      wind: uniform(new Vector2(0.5, 0.5)),
    }
    PATTERNS.set(uniforms, pattern)
  }
  return pattern
}

/** The deepest log τ the encoding holds, τ = 512. */
const LOG_DEPTH_SPAN = Math.log2(513)
/** The wind encoding's half range, m/s. */
const WIND_SPAN = 50

/**
 * The placeholder's per-layer channels: log in-cloud τ (the layer's
 * extinction through its depth at the profile's mean), whether it is
 * convective (cumuliform genera), the middle layer's ice share (cirrus), and
 * texture 3's wind. Constants of the scenario: phase 0 has no climatology to
 * vary them over the body.
 */
export function scenarioChannels(scenario: WeatherScenario): {
  readonly logDepth: readonly [number, number, number]
  readonly convective: readonly [number, number, number]
  readonly ice: number
  readonly wind: readonly [number, number]
} {
  const layer = (k: number) => scenario.layers[k]
  const depth = (k: number): number => {
    const spec = layer(k)
    if (spec === undefined) return 0
    const tau =
      spec.sigma * (spec.top - spec.base) * genusProfileMean(spec.genus)
    // The anvil's column is τ 1,185, past what the encoding carries, and it
    // saturates as the 8-bit store would.
    return Math.min(1, Math.log2(1 + tau) / LOG_DEPTH_SPAN)
  }
  const convective = (k: number): number => {
    const genus = layer(k)?.genus
    return genus === 'cumulus' || genus === 'cumulonimbus' ? 1 : 0
  }
  const encode = (speed: number): number =>
    Math.min(1, Math.max(0, 0.5 + speed / (2 * WIND_SPAN)))
  return {
    logDepth: [depth(0), depth(1), depth(2)],
    convective: [convective(0), convective(1), convective(2)],
    ice: layer(1)?.genus === 'cirrus' ? 1 : 0,
    wind: [encode(scenario.wind.east), encode(scenario.wind.north)],
  }
}

function setNumber(target: { value: number }, value: number): void {
  if (target.value !== value) target.value = value
}

function setVector(
  target: Vector2 | Vector3 | Vector4,
  values: readonly number[],
): void {
  const components = target.toArray()
  if (values.some((value, k) => components[k] !== value))
    target.fromArray(values)
}

/** The coverage between blobs: none until every cell holds one (weatherScenario.ts's `blobFloor`). */
const blobFloor = (coverage: number): number =>
  Math.max(0, (Math.min(1, coverage) - BLOB_MEAN) / (1 - BLOB_MEAN))

/** Copy a scenario's pattern into the uniforms the coverage node reads, each compared first. */
export function writeScenarioPattern(
  uniforms: CloudUniforms,
  scenario: WeatherScenario,
): void {
  const pattern = patternOf(uniforms)
  const coverage = (k: number): number =>
    Math.min(1, Math.max(0, scenario.layers[k]?.coverage ?? 0))
  const layers = [0, 1, 2].slice(0, MAX_CLOUD_LAYERS)
  setNumber(pattern.kind, PATTERN[scenario.pattern])
  setNumber(pattern.scale, scenario.patternScale)
  setNumber(pattern.cells, blobCells(scenario.patternScale))
  setVector(pattern.thresholds.value, [
    ...layers.map((k) => blobThreshold(coverage(k))),
    0,
  ])
  setVector(
    pattern.floors.value,
    layers.map((k) => blobFloor(coverage(k))),
  )
  const channels = scenarioChannels(scenario)
  setVector(pattern.logDepth.value, channels.logDepth)
  setVector(pattern.convective.value, channels.convective)
  setNumber(pattern.ice, channels.ice)
  setVector(pattern.wind.value, channels.wind)
}

/* ------------------------------------------------------------------------- */
/* The coverage function, in WGSL                                             */
/* ------------------------------------------------------------------------- */

const uses = (...fns: readonly unknown[]): never[] => fns as never[]
const axis = (v: Vec3): string => `vec3<f32>(${v.x}, ${v.y}, ${v.z})`

/** `cubeFaceOf`'s face rule, written from `CUBE_FACES` so the two cannot drift. */
const faceCases = CUBE_FACES.map(
  ({ normal, a, b }, f) =>
    `face = ${f}u; depth = dot(d, ${axis(normal)}); u = dot(d, ${axis(a)}); v = dot(d, ${axis(b)});`,
)

const blobCode = /*@__PURE__*/ wgslFn(
  `
  fn cloudBlobCoverage(d: vec3<f32>, cells: f32, layer: u32, period: vec2<u32>, threshold: u32, floorValue: f32) -> f32 {
    // weatherScenario.ts \`blobCoverage\`, with cubeSphere.ts \`cubeFaceOf\`:
    // the largest component's face, ties to the earlier axis, zero positive.
    let m = abs(d);
    var face = 0u;
    var depth = 0.0;
    var u = 0.0;
    var v = 0.0;
    if (m.x >= m.y && m.x >= m.z) {
      if (d.x >= 0.0) { ${faceCases[0]} } else { ${faceCases[1]} }
    } else if (m.y >= m.z) {
      if (d.y >= 0.0) { ${faceCases[2]} } else { ${faceCases[3]} }
    } else {
      if (d.z >= 0.0) { ${faceCases[4]} } else { ${faceCases[5]} }
    }
    var a = 0.0;
    var b = 0.0;
    if (depth > 0.0) {
      a = atan(u / depth) / ${Math.PI / 4};
      b = atan(v / depth) / ${Math.PI / 4};
    }
    let x = (a + 1.0) / 2.0 * cells;
    let y = (b + 1.0) / 2.0 * cells;
    let i = clamp(floor(x), 0.0, cells - 1.0);
    let j = clamp(floor(y), 0.0, cells - 1.0);
    // The cell's existence is an integer comparison against a threshold
    // the CPU formed (rule 58).
    let lane = face | (layer << 3u) | (period.y << 5u);
    if (cloudPcg4d(u32(i), u32(j), lane, period.x).x >= threshold) {
      return floorValue;
    }
    let r = length(vec2<f32>(2.0 * (x - i) - 1.0, 2.0 * (y - j) - 1.0));
    return floorValue + (1.0 - floorValue) * (1.0 - smoothstep(0.5, 1.0, r));
  }
`,
  uses(cloudPcg4d),
)

const bandCode = /*@__PURE__*/ wgslFn(`
  fn cloudBandCoverage(d: vec3<f32>, coverage: f32, scale: f32) -> f32 {
    // weatherScenario.ts \`bandCoverage\`: latitude about +Y.
    let size = length(d);
    let latitude = asin(clamp(select(0.0, d.y / size, size > 0.0), -1.0, 1.0));
    let swing = select((1.0 - coverage) / coverage, 1.0, coverage <= 0.5);
    return coverage * (1.0 + swing * cos(${Math.PI} * latitude / scale));
  }
`)

const coverageCode = /*@__PURE__*/ wgslFn(
  `
  fn cloudScenarioCoverage(
    d: vec3<f32>,
    layer: i32,
    kind: f32,
    scale: f32,
    cells: f32,
    coverages: vec3<f32>,
    thresholds: vec4<u32>,
    floors: vec3<f32>,
    period: vec2<u32>,
  ) -> f32 {
    // weatherScenario.ts \`scenarioCoverage\`.
    if (layer < 0 || layer > 2) {
      return 0.0;
    }
    let coverage = clamp(coverages[layer], 0.0, 1.0);
    if (kind > 1.5) {
      return cloudBlobCoverage(d, cells, u32(layer), period, thresholds[layer], floors[layer]);
    }
    if (kind > 0.5 && scale > 0.0) {
      return cloudBandCoverage(d, coverage, scale);
    }
    return coverage;
  }
`,
  uses(blobCode, bandCode),
)

/**
 * The placeholder's coverage of `layer` at a body-fixed direction, for
 * `body`'s frame and the shared scenario uniforms: the cube bake's source,
 * and the second body's far bake's (§3.13). A port of `scenarioCoverage`;
 * the pattern is a function of the direction alone, so `body` names whose
 * frame the direction is in and adds nothing to the value.
 */
export function scenarioCoverageNode(
  uniforms: CloudUniforms,
  _body: CloudBodyUniforms,
  layer: Node<'int'>,
  direction: Node<'vec3'>,
): Node<'float'> {
  const pattern = patternOf(uniforms)
  return coverageCode({
    d: direction,
    layer,
    kind: pattern.kind,
    scale: pattern.scale,
    cells: pattern.cells,
    coverages: uniforms.layers.coverage,
    thresholds: pattern.thresholds,
    floors: pattern.floors,
    period: uniforms.period,
  }) as unknown as Node<'float'>
}

export interface CloudMapNodes {
  /** Texture 0 at a body-fixed direction (gutter-safe bilinear in its face tile, level 0). */
  synoptic(direction: Node<'vec3'>): Node<'vec4'>
  /** Texture k (1, 2, 3) at a direction. */
  channel(direction: Node<'vec3'>, texture: 1 | 2 | 3): Node<'vec4'>
}

/**
 * The four textures' values at a direction straight from the scenario: what
 * the cube bake writes at a texel's direction, and a source for a pass that
 * has no cube to read.
 */
export function analyticMapNodes(
  uniforms: CloudUniforms,
  body: CloudBodyUniforms = uniforms.served,
): CloudMapNodes {
  const pattern = patternOf(uniforms)
  const channels = (direction: Node<'vec3'>): readonly Node<'vec4'>[] => {
    const cover = (k: number) =>
      scenarioCoverageNode(uniforms, body, int(k), direction)
    return [
      vec4(cover(0), cover(1), cover(2), pattern.ice),
      vec4(pattern.logDepth, 0),
      vec4(pattern.convective, 0),
      vec4(pattern.wind, 0, 0),
    ]
  }
  return {
    synoptic: (direction) => channels(direction)[0]!,
    channel: (direction, k) => channels(direction)[k]!,
  }
}

/* ------------------------------------------------------------------------- */
/* The resource                                                               */
/* ------------------------------------------------------------------------- */

const LEVEL0 = /*@__PURE__*/ float(0)

/** The faces in order of nearness to a direction: its own face first, the opposite last. */
export function facesNearest(direction: Vec3): CubeFace[] {
  const along = (f: number): number => {
    const { normal } = CUBE_FACES[f]!
    return (
      direction.x * normal.x + direction.y * normal.y + direction.z * normal.z
    )
  }
  return ([0, 1, 2, 3, 4, 5] as CubeFace[]).sort(
    (a, b) => along(b) - along(a) || a - b,
  )
}

export class CloudMaps implements CloudResource {
  readonly name = 'maps'
  readonly nodes: CloudMapNodes

  readonly #uniforms: CloudUniforms
  /** 1 × 1 until a frame draws: the format is the pipeline's, not the size. */
  readonly #target = new RenderTarget(1, 1, {
    count: CHANNELS.length,
    type: UnsignedByteType,
    depthBuffer: false,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
  })
  readonly #face = {
    normal: uniform(new Vector3(1, 0, 0)),
    a: uniform(new Vector3(0, 1, 0)),
    b: uniform(new Vector3(0, 0, 1)),
    /** The tile's corner in the atlas, texels. */
    corner: uniform(new Vector2()),
  }
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh()
  #allocated: 'none' | 'stand-in' | 'full' = 'none'
  /** Stale faces in the order they bake: nearest the eye first. */
  #queue: CubeFace[] = []
  /** The steady cycle's next face. */
  #next: CubeFace = 0
  #scenario: string | null = null
  #period: readonly [number, number] = [0, 0]
  #warm: Promise<void> | null = null
  #disposed = false

  constructor(uniforms: CloudUniforms) {
    this.#uniforms = uniforms
    this.#target.textures.forEach((map, k) => {
      map.name = CHANNELS[k]!
    })
    const maps = this.#target.textures.map((map) => texture(map))
    // One atlas uv a direction node, shared by the four reads of a bake.
    const uvs = new WeakMap<Node<'vec3'>, Node<'vec2'>>()
    const uvOf = (direction: Node<'vec3'>): Node<'vec2'> => {
      let uv = uvs.get(direction)
      if (uv === undefined) {
        uv = cubeAtlasUv(
          direction,
          CLOUD_CUBE_TILE,
          CLOUD_CUBE_GUTTER,
          CLOUD_CUBE_COLUMNS,
          CLOUD_CUBE_ROWS,
        )
        uvs.set(direction, uv)
      }
      return uv
    }
    const read = (direction: Node<'vec3'>, k: number): Node<'vec4'> =>
      vec4(maps[k]!.sample(uvOf(direction)).level(LEVEL0))
    this.nodes = {
      synoptic: (direction) => read(direction, 0),
      channel: (direction, k) => read(direction, k),
    }
    this.#material.name = 'cloud maps'
    this.#material.fragmentNode = this.#bakeNode()
  }

  /**
   * One face tile's four textures: the fragment's tile texel i has its
   * center at warped −1 + (2(i − gutter) + 1)/tile, as `cubeTexelCoordinate`
   * has it, and a fragment coordinate is already a texel center.
   */
  #bakeNode(): Node {
    const face = this.#face
    const warped = screenCoordinate.xy
      .sub(face.corner)
      .sub(CLOUD_CUBE_GUTTER)
      .mul(2 / CLOUD_CUBE_TILE)
      .sub(1)
    const quarter = Math.PI / 4
    const direction = normalize(
      face.normal
        .add(face.a.mul(tan(warped.x.mul(quarter))))
        .add(face.b.mul(tan(warped.y.mul(quarter)))),
    )
    const source = analyticMapNodes(this.#uniforms)
    const outputs: Record<string, Node<'vec4'>> = {}
    CHANNELS.forEach((name, k) => {
      outputs[name] =
        k === 0
          ? source.synoptic(direction)
          : source.channel(direction, k as 1 | 2 | 3)
    })
    return mrt(outputs)
  }

  get pending(): boolean {
    return !this.#disposed && this.#queue.length > 0
  }

  get bytes(): number {
    if (this.#disposed || this.#allocated === 'none') return 0
    return this.#target.width * this.#target.height * TEXEL_BYTES
  }

  textures(): readonly Texture[] {
    return this.#disposed || this.#allocated === 'none'
      ? []
      : this.#target.textures
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#warm ??= this.#compile(renderer).catch((cause: unknown) => {
      log.warn('the cloud maps did not warm', { cause: String(cause) })
    })
    return this.#warm
  }

  async #compile(renderer: WebGPURenderer): Promise<void> {
    const compiled = warmSensorPass(renderer, this.#quad, [
      { target: this.#target, material: this.#material },
    ])
    if (this.#allocated === 'none') this.#allocated = 'stand-in'
    await compiled
  }

  /**
   * One face tile a frame, every frame: the steady cycle takes six. When the
   * field moves discontinuously — a jump, a scenario or a pattern period
   * that is not the last frame's, or the first frame at full size — every
   * face is stale, and the six bake over the next six frames nearest the eye
   * first. That order is what lets the clipmap rebuild its levels 0–1 the
   * same frame and 2–5 over the next frames from faces already baked: a
   * level reaches at most 1,540 km from the eye, which the eye's own face
   * and the neighbors nearest it hold, and the opposite face, 90° away at
   * least, comes last.
   */
  render(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    budget: CloudBudget,
  ): void {
    if (this.#disposed) return
    writeScenarioPattern(this.#uniforms, frame.scenario)
    const fresh = this.#allocated !== 'full'
    if (fresh) {
      this.#target.setSize(CLOUD_CUBE_WIDTH, CLOUD_CUBE_HEIGHT)
      this.#allocated = 'full'
    }
    const [low, high] = frame.period
    const moved =
      fresh ||
      frame.jump ||
      budget.jump ||
      frame.scenario.id !== this.#scenario ||
      low !== this.#period[0] ||
      high !== this.#period[1]
    this.#scenario = frame.scenario.id
    this.#period = [low, high]
    if (moved) this.#queue = facesNearest(frame.served.eye)
    const face = this.#queue.shift() ?? this.#cycle()
    this.#draw(renderer, face)
  }

  #cycle(): CubeFace {
    const face = this.#next
    this.#next = ((face + 1) % 6) as CubeFace
    return face
  }

  #draw(renderer: WebGPURenderer, f: CubeFace): void {
    const { normal, a, b } = CUBE_FACES[f]!
    const x = (f % CLOUD_CUBE_COLUMNS) * SPAN
    const y = Math.floor(f / CLOUD_CUBE_COLUMNS) * SPAN
    this.#face.normal.value.set(normal.x, normal.y, normal.z)
    this.#face.a.value.set(a.x, a.y, a.z)
    this.#face.b.value.set(b.x, b.y, b.z)
    this.#face.corner.value.set(x, y)
    const target = this.#target
    target.scissor.set(x, y, SPAN, SPAN)
    try {
      runQuadPasses(
        renderer,
        this.#quad,
        { linear: true, autoClear: false, scissor: true },
        (draw) => {
          draw(CLOUD_MAPS_LABEL, target, this.#material)
        },
      )
    } finally {
      target.scissor.set(0, 0, target.width, target.height)
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#target.dispose()
    this.#material.dispose()
  }
}
