import { getLogger } from '@inertialref/shared'
import {
  LinearFilter,
  type Node,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  float,
  mrt,
  normalize,
  saturate,
  screenCoordinate,
  select,
  tan,
  texture,
  uniform,
  vec4,
  wgslFn,
} from 'three/tsl'
import {
  CUBE_FACES,
  type CubeFace,
  SYNOPTIC_CELL,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import type { CloudFrame } from './cloudFrame.ts'
import { cubeAtlasUv } from './cloudGeometry.ts'
import type { CloudBudget, CloudResource } from './cloudNodes.ts'
import { type CloudNoiseNodes, cloudPcg4d, noiseOf } from './cloudNoise.ts'
import { profileOf } from './cloudProfile.ts'
import {
  CLOUD_CLIMATE_KINDS,
  type CloudBodyUniforms,
  type CloudUniforms,
} from './cloudUniforms.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmSensorPass } from './warmup.ts'

/*
 * The weather cube: a 2D atlas of six tangent-warped face tiles, 3 × 2, each
 * 512² with a one-texel gutter, two RGBA8 targets drawn by one MRT quad,
 * baked from the body's climate (`climateNode`, a port of
 * `BodyClimate.sample`) a face at a time. Two bakes read it — the clipmap's
 * levels and the served body's far atlas — and the fine march does not,
 * which keeps the trace kernel inside the binding limit.
 *
 * What a medium reads, a texel of each (phase 1 design §4.3):
 *
 *   cover  the cover of levels 0–2      the middle level's ice share
 *   kind   their convective shares      the deep-convection rate
 *
 * **A face is redrawn at the pace its field moves,** never faster than one
 * a frame: before the fastest thing it holds moves a tenth of a texel
 * (`texel/(10·u)`, §4.7). What moves is each level's turn, which carries the
 * zonal law's synoptic field with the low level, the sun where a terminator
 * ends a regime's cover, and the convergence zone, which follows the
 * sub-solar latitude. A field with none of these moving bakes nothing.
 *
 * **A face is fresh by generation.** Every discontinuity of the field — a
 * jump, a new weather, a new body, the pattern's period, a level's
 * statistics landing (`CloudProfile.generation`) — starts a new generation, and a face is fresh when it was baked in the present one. The
 * clipmap reads each face's generation and is fresh only from fresh faces
 * (`CloudCubeFreshness`).
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

/** The bake's pass on the timeline: one face tile. */
export const CLOUD_MAPS_LABEL = 'cloud maps'

/** The names the MRT outputs and the target's textures share: cover, then kind. */
const CHANNELS = ['cloudCover', 'cloudKind'] as const

/** Two RGBA8 targets: 8 bytes a texel. */
const TEXEL_BYTES = 8

/* ------------------------------------------------------------------------- */
/* The climate, in WGSL                                                       */
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

const regimeCode = /*@__PURE__*/ wgslFn(
  `
  fn cloudRegimeCover(
    d: vec3<f32>,
    pattern: vec4<f32>,
    covers: vec3<f32>,
    thresholds: vec3<u32>,
    floors: vec3<f32>,
    period: vec2<u32>,
    sun: vec3<f32>,
    terminator: vec2<f32>,
  ) -> vec3<f32> {
    // weatherScenario.ts \`scenarioCoverage\` for the three levels, a
    // regime's \`BodyClimate.sample\`. With no terminator its sines are
    // (2, 3), which no sine reaches, and the share is 1.
    let size = length(d);
    let up = select(0.0, dot(d, sun) / size, size > 0.0);
    let share = 1.0 - smoothstep(terminator.x, terminator.y, up);
    var cover = vec3<f32>(0.0);
    for (var k = 0; k < 3; k = k + 1) {
      let coverage = clamp(covers[k], 0.0, 1.0);
      var value = coverage;
      if (pattern.x > 1.5) {
        value = cloudBlobCoverage(d, pattern.z, u32(k), period, thresholds[k], floors[k]);
      } else if (pattern.x > 0.5 && pattern.y > 0.0) {
        value = cloudBandCoverage(d, coverage, pattern.y);
      }
      cover[k] = share * value;
    }
    return cover;
  }
`,
  uses(blobCode, bandCode),
)

const zoneCode = /*@__PURE__*/ wgslFn(`
  fn cloudZonalZones(d: vec3<f32>, law: mat4x4<f32>) -> vec3<f32> {
    // weatherClimate.ts \`zonalClimate\`'s three Gaussians in latitude: the
    // convergence zone, the two dry belts and the two storm tracks. The law
    // is its sixteen numbers row-major, so column c holds amplitude c of the
    // three levels and, in w, shared angle c: [φ_I, φ_H, φ_S, w].
    let size = length(d);
    let latitude = asin(clamp(select(0.0, d.y / size, size > 0.0), -1.0, 1.0));
    let w = law[3].w;
    let s = -0.5 / (w * w);
    let toward = latitude - law[0].w;
    let a = latitude - law[1].w;
    let b = latitude + law[1].w;
    let c = latitude - law[2].w;
    let e = latitude + law[2].w;
    return vec3<f32>(
      exp(s * toward * toward),
      exp(s * a * a) + exp(s * b * b),
      exp(s * c * c) + exp(s * e * e),
    );
  }
`)

const coverCode = /*@__PURE__*/ wgslFn(`
  fn cloudZonalCover(law: mat4x4<f32>, zones: vec3<f32>, factor: f32) -> vec3<f32> {
    // base + itcz·zone − dry·belts + storm·tracks, times the synoptic factor.
    let cover = law[0].xyz + law[1].xyz * zones.x - law[2].xyz * zones.y + law[3].xyz * zones.z;
    return clamp(cover * factor, vec3<f32>(0.0), vec3<f32>(1.0));
  }
`)

/** A body's climate at a direction: each level's cover and the ice share, and each level's convective share and the deep rate. */
export interface CloudClimateNodes {
  readonly cover: Node<'vec4'>
  readonly kind: Node<'vec4'>
}

/**
 * `BodyClimate.sample` of a body's climate at a body-fixed direction, under
 * the body's sun, at the frame's instant: the cube bake's source, and a
 * second body's, which has no cube. The kind is a uniform, so both kinds
 * compile into one program and the uniforms choose.
 *
 * Under the zonal law the synoptic factor reads the base noise at the
 * direction turned with the low level, `M₀·d`, over its 1,000 km cell: a
 * lattice that coarse may be read from an absolute direction (rule 58 binds
 * fine ones), and `M₀` is the frame's own `turnBack` of the low level's
 * angle, which is the angle `BodyClimate.sample` turns by.
 */
export function climateNode(
  body: CloudBodyUniforms,
  noise: CloudNoiseNodes,
  direction: Node<'vec3'>,
): CloudClimateNodes {
  const { climate, layers } = body
  const regime = regimeCode({
    d: direction,
    pattern: climate.pattern,
    covers: climate.cover,
    thresholds: climate.blobThreshold,
    floors: climate.blobFloor,
    period: climate.period,
    sun: body.sun,
    terminator: climate.terminator,
  }) as unknown as Node<'vec3'>
  const n = noise.base(
    layers.turn[0]
      .mul(direction)
      .mul(body.datumRadius.div(SYNOPTIC_CELL)) as Node<'vec3'>,
  )
  const factor = n.sub(0.5).mul(0.5).add(1)
  const zones = zoneCode({
    d: direction,
    law: climate.law,
  }) as unknown as Node<'vec3'>
  const zonal = coverCode({
    law: climate.law,
    zones,
    factor,
  }) as unknown as Node<'vec3'>
  const zonalKind = climate.kind.equal(CLOUD_CLIMATE_KINDS.zonal)
  const cover = select(zonalKind, zonal, regime)
  const convective = select(
    zonalKind,
    saturate(climate.convective.mul(zones.x)),
    climate.convective,
  )
  return {
    cover: vec4(cover, climate.ice),
    kind: vec4(convective, climate.deep),
  }
}

export interface CloudMapNodes {
  /** Each level's cover and the middle level's ice share at a body-fixed direction (gutter-safe bilinear in its face tile, level 0). */
  cover(direction: Node<'vec3'>): Node<'vec4'>
  /** Each level's convective share and the deep-convection rate at a direction. */
  kind(direction: Node<'vec3'>): Node<'vec4'>
  /** How fresh each face is, where the nodes read a cube; none for the analytic climate, which is always the frame's. */
  readonly freshness?: CloudCubeFreshness
}

/**
 * The climate straight from the body's uniforms: what the cube bake writes
 * at a texel's direction, and a source for a pass that has no cube to read.
 */
export function analyticMapNodes(
  body: CloudBodyUniforms,
  noise: CloudNoiseNodes,
): CloudMapNodes {
  return {
    cover: (direction) => climateNode(body, noise, direction).cover,
    kind: (direction) => climateNode(body, noise, direction).kind,
  }
}

/* ------------------------------------------------------------------------- */
/* Freshness and pace                                                         */
/* ------------------------------------------------------------------------- */

/** What a reader of the cube asks of a face: the generation it was baked in, and how many times it has been. */
export interface CloudCubeFreshness {
  /** The field's present generation: a face baked in an older one holds another field. */
  readonly generation: number
  faceGeneration(face: CubeFace): number
  /** Bakes of the face so far: a reader that read it at another count reads a redrawn face. */
  faceVersion(face: CubeFace): number
}

/** A cube texel at a face's center, meters: 19.6 km on Earth. */
export const cubeTexelMeters = (radius: number): number =>
  (radius * Math.PI) / (2 * CLOUD_CUBE_TILE)

/** What a face was baked under: enough to say how far its field has moved since. */
interface Baked {
  readonly time: number
  readonly sun: Vec3
  /** The convergence zone's latitude, radians: the zonal law's one term that follows the sun. */
  readonly zone: number
}

/**
 * Meters the field a face holds has moved since it was baked, at its
 * fastest: each level's turn at the equator, the terminator's sweep where a
 * regime ends at one, and the convergence zone's walk with the season. The
 * face is due when this passes a tenth of its texel.
 */
export function cubeDrift(frame: CloudFrame, baked: Baked): number {
  const { served } = frame
  const radius = served.datumRadius
  let speed = 0
  for (const level of served.levels)
    speed = Math.max(speed, Math.abs(level.turnRate) * radius)
  const turned = Math.abs(frame.time - baked.time) * speed
  const { climate, sun } = served
  // A terminator's sines are (2, 3) where a regime has none.
  const terminator =
    climate.kind === 'regime' && climate.terminator[0] <= 1
      ? Math.acos(
          Math.min(
            1,
            sun.x * baked.sun.x + sun.y * baked.sun.y + sun.z * baked.sun.z,
          ),
        ) * radius
      : 0
  const zone =
    climate.kind === 'zonal'
      ? Math.abs((climate.law[12] ?? 0) - baked.zone) * radius
      : 0
  return Math.max(turned, terminator, zone)
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

const FACES: readonly CubeFace[] = [0, 1, 2, 3, 4, 5]

export class CloudMaps implements CloudResource, CloudCubeFreshness {
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
  #generation = 0
  /** The generation each face was baked in; −1 before its first bake. */
  readonly #faceGeneration: number[] = [-1, -1, -1, -1, -1, -1]
  readonly #faceVersion: number[] = [0, 0, 0, 0, 0, 0]
  /** The render each face went stale on, or null while it holds this generation. */
  readonly #staleSince: (number | null)[] = [null, null, null, null, null, null]
  readonly #baked: (Baked | null)[] = [null, null, null, null, null, null]
  #renders = 0
  #weather: string | null = null
  #address: string | null = null
  #period: readonly [number, number] = [0, 0]
  /** The profile's generation the faces were baked under. */
  #tables = -1
  #warm: Promise<void> | null = null
  #disposed = false

  constructor(uniforms: CloudUniforms, noise: CloudNoiseNodes) {
    this.#uniforms = uniforms
    this.#target.textures.forEach((map, k) => {
      map.name = CHANNELS[k]!
    })
    const [cover, kind] = this.#target.textures.map((map) => texture(map)) as [
      ReturnType<typeof texture>,
      ReturnType<typeof texture>,
    ]
    // One atlas uv a direction node, shared by the reads of a bake.
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
    this.nodes = {
      cover: (direction) => vec4(cover.sample(uvOf(direction)).level(LEVEL0)),
      kind: (direction) => vec4(kind.sample(uvOf(direction)).level(LEVEL0)),
      freshness: this,
    }
    this.#material.name = 'cloud maps'
    this.#material.fragmentNode = this.#bakeNode(noise)
  }

  /**
   * One face tile's two textures: the fragment's tile texel i has its
   * center at warped −1 + (2(i − gutter) + 1)/tile, as `cubeTexelCoordinate`
   * has it, and a fragment coordinate is already a texel center.
   */
  #bakeNode(noise: CloudNoiseNodes): Node {
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
    const climate = climateNode(this.#uniforms.served, noise, direction)
    return mrt({ [CHANNELS[0]]: climate.cover, [CHANNELS[1]]: climate.kind })
  }

  get generation(): number {
    return this.#generation
  }

  faceGeneration(face: CubeFace): number {
    return this.#faceGeneration[face]!
  }

  faceVersion(face: CubeFace): number {
    return this.#faceVersion[face]!
  }

  get pending(): boolean {
    return !this.#disposed && this.#staleSince.some((since) => since !== null)
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
   * The frame's numbers on what this bundle's field reads beyond the uniform
   * bundle, before any pass of the frame: the profile table's rows of each
   * body's levels. The field's construction hands the maps the bundle, and
   * this is the one call each frame makes before anything bakes.
   */
  write(frame: CloudFrame): void {
    profileOf(this.#uniforms)?.write(frame)
  }

  /**
   * At most one face a frame. A discontinuity of the field — a jump, a new
   * weather or body, the pattern's period, the first frame at full size —
   * starts a generation, and every face bakes again, one a frame, the
   * longest stale first and the nearest the eye among those, so the
   * clipmap's levels 0–1 read fresh faces from the first frame: a level
   * reaches at most 1,540 km from the eye, which the eye's own face and the
   * neighbors nearest it hold. A scrub jumps every frame; an order begun
   * again at each jump would bake the eye's own face forever, so through a
   * run of jumps the eye's own face waits its turn with the rest.
   *
   * Otherwise the face whose field has moved furthest past a tenth of its
   * texel bakes (`cubeDrift`), and none if no face's has.
   */
  render(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    budget: CloudBudget,
  ): void {
    if (this.#disposed) return
    const now = this.#renders
    this.#renders += 1
    this.write(frame)
    const fresh = this.#allocated !== 'full'
    if (fresh) {
      this.#target.setSize(CLOUD_CUBE_WIDTH, CLOUD_CUBE_HEIGHT)
      this.#allocated = 'full'
    }
    const { served } = frame
    const [low, high] = served.climate.period
    // A level's statistics landing is a new field: what was baked before it
    // read a gain the field no longer has.
    const tables = profileOf(this.#uniforms)?.generation ?? 0
    const moved =
      tables !== this.#tables ||
      fresh ||
      frame.jump ||
      budget.jump ||
      served.weatherKey !== this.#weather ||
      served.address !== this.#address ||
      low !== this.#period[0] ||
      high !== this.#period[1]
    this.#tables = tables
    this.#weather = served.weatherKey
    this.#address = served.address
    this.#period = [low, high]
    const stale = this.#staleSince
    if (moved) {
      this.#generation += 1
      for (const f of FACES) stale[f] ??= now
    }
    const face = this.#owed(served.eye) ?? this.#due(frame)
    if (face === null) return
    stale[face] = null
    this.#faceGeneration[face] = this.#generation
    this.#faceVersion[face]! += 1
    this.#baked[face] = {
      time: frame.time,
      sun: served.sun,
      zone: served.climate.kind === 'zonal' ? (served.climate.law[12] ?? 0) : 0,
    }
    this.#draw(renderer, face)
  }

  /** The stale face to bake: the longest stale, the nearest the eye among those. */
  #owed(eye: Vec3): CubeFace | null {
    const stale = this.#staleSince
    if (stale.every((since) => since === null)) return null
    let chosen: CubeFace | null = null
    for (const face of facesNearest(eye)) {
      const since = stale[face]
      if (since === null || since === undefined) continue
      if (chosen === null || since < stale[chosen]!) chosen = face
    }
    return chosen
  }

  /** The face whose field has moved furthest past a tenth of its texel, if any has. */
  #due(frame: CloudFrame): CubeFace | null {
    const limit = cubeTexelMeters(frame.served.datumRadius) / 10
    let chosen: CubeFace | null = null
    let furthest = limit
    for (const face of FACES) {
      const baked = this.#baked[face]
      if (baked === null || baked === undefined) return face
      const moved = cubeDrift(frame, baked)
      if (moved >= furthest) {
        chosen = face
        furthest = moved
      }
    }
    return chosen
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

/**
 * The weather cube a field's far media and its clipmap read, baked from the
 * climate with the field's own noise.
 *
 * A factory names what its module reads of the field, and the field hands
 * every factory more than that, so a module whose constructor needs another
 * part asks for it here and the field's construction does not change. The
 * field hands the maps the uniform bundle alone, so the noise built for that
 * bundle is found by it (`noiseOf`) where it is not handed over.
 */
export function createCloudMaps(deps: {
  readonly uniforms: CloudUniforms
  readonly noise?: { readonly nodes: CloudNoiseNodes }
}): CloudMaps {
  const noise = deps.noise?.nodes ?? noiseOf(deps.uniforms)
  if (noise === null)
    throw new Error(
      'cloud maps: no noise was built for this uniform bundle, and the climate reads it',
    )
  return new CloudMaps(deps.uniforms, noise)
}
