import {
  type ComputeNode,
  LinearFilter,
  type Node,
  type StorageTexture,
  type Texture,
  type TextureNode,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  clamp,
  computeKernel,
  cross,
  dot,
  exp,
  float,
  Fn,
  globalId,
  If,
  ivec2,
  length,
  log,
  max,
  min,
  normalize,
  saturate,
  select,
  sqrt,
  texture,
  textureStore,
  uint,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  MULTI_SCATTER_HEIGHT,
  MULTI_SCATTER_WIDTH,
  textureBytes,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_WIDTH,
} from '@inertialref/rendering'
import { airMediumAt, type AirUniforms } from './air.ts'
import {
  airEye,
  type AirMediumFn,
  directionAir,
  directionLight,
  type FrontSamples,
  SKY_SEGMENT_SAMPLES,
  SURFACE_SEGMENT_SAMPLES,
} from './cloudCompositeAir.ts'
import { altitudeAlong, cloudRay } from './cloudGeometry.ts'
import { type CloudResource, cloudStorageTexture } from './cloudNodes.ts'
import type { CloudBodyUniforms } from './cloudUniforms.ts'
import { warmCompute } from './warmup.ts'

/*
 * The served body's air as the composite reads it: a table by the ray's
 * direction about the eye's vertical, formed once a frame, in place of a
 * march a pixel (`cloudCompositeAir.ts`, "The air by the ray's direction").
 *
 * **Why directions and not the history's texels.** The air's terms are
 * smooth along a ray and steep across the limb: from 400 km a scale height
 * is 3.6 pixels of a 1080-line frame and a history texel is two, so no
 * blend of a pixel's neighboring texels follows it, and a texel on the limb
 * holds pixels of both classes. About the eye's vertical the same terms
 * depend on the up-cosine and the azimuth from the sun alone, and the limb
 * is one coordinate's rows, as many as it needs.
 *
 * **The rows.** The up-cosine in two segments, split where a ray is tangent
 * to the lowest cloud base: under it a ray leaves the shell through the
 * base, over it through the top, and the span's length jumps by half a
 * chord between them, as the trace's own blocked air does. The first
 * segment starts straight down; the second ends at the ray tangent to the
 * highest top from an eye over it and straight up otherwise. From under the
 * lowest base the split is the datum's horizon, under which no ray meets
 * cloud. A pixel takes its segment from where its own ray leaves the shell,
 * never from its cosine against the knot, so a ray a float's step from the
 * tangency reads the side its own span is on.
 *
 * A segment's rows crowd to one end, the tangency a ray grazes, by a
 * constant ratio of the distance from it: there the air a ray crosses grows
 * as the reciprocal of that distance's root, so equal ratios are equal
 * steps of the air mass, 8% a row. Rows spread as the root of the distance
 * step the air mass by a fifth to a half a row over the last 60 km of a
 * ray's depth under the limb, and read 2% off there (measured from 400 km).
 * The first segment crowds to the base's tangent; the second to the top's
 * from an eye over the top, and to its low end, the horizon, from under
 * it.
 *
 * **The columns** are the cosine of the azimuth from the sun's, in which
 * every term is even about the sun's plane and smooth once the aerosol's
 * phase is out of it.
 *
 * **Two classes**, the sky's and a surface's, since each marches its own
 * samples and beam. A pixel whose scene depth cuts the span short is in
 * neither: its air depends on its depth, and it takes the march a pixel
 * (`cloudComposite.ts`). That march reads the air's two tables through
 * copies of them the same texture holds, so the fragment binds this one
 * texture where it bound those two.
 *
 * The texture, RGBA16F, 520 × 336:
 *
 *   rows   0–127  the rest of the light, sky | surface, 256 columns each,
 *                 then T_a(0, t₀) as two strips four columns wide
 *   rows 128–255  the aerosol's sum, sky | surface
 *   rows 256–319  the transmittance table, 512 × 64
 *   rows 320–335  the multiple-scattering table, 32 × 16
 */

/** Columns of a block: the azimuth's cosine from −1 to 1. */
const COLUMNS = 256
/** Rows of a segment of the up-cosine. */
const SEGMENT_ROWS = 64
const ROWS = 2 * SEGMENT_ROWS
/** Columns of a transmittance strip: one value, wide enough that a bilinear read stays inside it. */
const STRIP = 4
const WIDTH = 2 * COLUMNS + 2 * STRIP
const TRANSMITTANCE_ROW = 2 * ROWS
const MULTI_SCATTER_ROW = TRANSMITTANCE_ROW + TRANSMITTANCE_HEIGHT
const HEIGHT = MULTI_SCATTER_ROW + MULTI_SCATTER_HEIGHT
/** Bytes an RGBA16F texel holds. */
const TEXEL_BYTES = 8
const WORKGROUP = 8
const LABEL = 'cloud air table'
/**
 * The crowding. A segment's first `CROWDED_ROWS` rows run from its crowded
 * end over the nearer `CROWDED_SHARE` of it by
 * e = share·(exp(κ·y) − 1)/(exp(κ) − 1), e the distance from that end as a
 * share of the segment and y the row's share of those rows: a constant
 * ratio a row, 0.84, down to e = share·exp(−κ), under which the rows are
 * even and the planet's curve has already closed the air mass. The rest
 * are even over the farther part, because the march they tabulate is not
 * smooth in the direction: a sample crosses the ozone's tent or the top's
 * fade as a ray turns, and rows a fifth of the segment apart read 1.4% off
 * straight down from 400 km.
 */
const CROWDING = 7.5
const CROWDED_ROWS = 44
const CROWDED_SHARE = 0.5
const CROWDED = Math.exp(CROWDING) - 1
const EVEN_ROWS = SEGMENT_ROWS - 1 - CROWDED_ROWS
/**
 * How far inside a segment's ends its end rows stand, in up-cosine: at a
 * tangency itself a float32 cannot say which side a ray's span is on, and
 * thirty steps of the cosine off it can.
 */
const KNOT_MARGIN = 4e-6
/** Farther than any span: the ray no scene depth stops. */
const NO_STOP = 1e30

/**
 * The front segment's samples. A sky ray's that passes the datum by is 24:
 * with the per-pixel form's six the identity on a ray that grazes the limb
 * is 4.6% off the joint march of air and cloud, with 12 it is 1.3% off and
 * with 24, 0.8% (`cloudCompositeError.gpu.test.ts`, the limb's cases). So
 * on the limb the table and the march a pixel differ by design, by up to
 * 8.5% of a pixel from 400 km, and the table is the nearer. A surface's
 * stays the per-pixel form's four, and a sky ray's that meets the datum its
 * six (`FrontSamples`).
 */
export const AIR_TABLE_FRONT: FrontSamples = {
  sky: 4 * SKY_SEGMENT_SAMPLES,
  surface: SURFACE_SEGMENT_SAMPLES,
}

/** The up-cosine of the ray tangent to the sphere `boundary` over the datum, from an eye `over` meters above it. */
function tangentCosine(
  body: CloudBodyUniforms,
  over: Node<'float'>,
  boundary: Node<'float'>,
): Node<'float'> {
  const R = body.datumRadius
  return sqrt(max(over, 0).mul(R.mul(2).add(body.eye).add(boundary)))
    .div(R.add(body.eye))
    .negate()
}

/** The two segments' ends: −1, `low`, `high`. */
function knots(body: CloudBodyUniforms): {
  readonly low: Node<'float'>
  readonly high: Node<'float'>
} {
  const overBase = body.eyeOver.x
  const overTop = body.eyeOverHigh.y
  const low = select(
    overBase.greaterThan(0),
    tangentCosine(body, overBase, body.boundaries.x),
    select(
      body.eye.greaterThan(0),
      tangentCosine(body, body.eye, float(0)),
      float(-1),
    ),
  )
  const high = select(
    overTop.greaterThan(0),
    tangentCosine(body, overTop, body.boundariesHigh.y),
    float(1),
  )
  return { low, high: max(high, low) }
}

/**
 * Whether a segment's rows crowd to its high end: the first segment's
 * always, to the base's tangent, and the second's from an eye over the
 * highest top, to that top's tangent.
 */
function crowdsHigh(
  body: CloudBodyUniforms,
  first: Node<'bool'>,
): Node<'bool'> {
  return first.or(body.eyeOverHigh.y.greaterThan(0))
}

/** The sun's horizontal at the eye and the horizontal across it, body-fixed: the azimuth's axes. */
function azimuthAxes(body: CloudBodyUniforms): {
  readonly toward: Node<'vec3'>
  readonly across: Node<'vec3'>
} {
  const flat = body.sun.sub(body.up.mul(body.sunUp))
  const size = length(flat)
  // Under a sun at the zenith no term turns with the azimuth: any horizontal serves.
  const spare = normalize(
    cross(
      body.up,
      select(body.up.y.abs().lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0)),
    ),
  )
  const toward = select(
    size.greaterThan(1e-4),
    flat.div(max(size, 1e-6)),
    spare,
  )
  return { toward, across: cross(body.up, toward) }
}

/** What a pixel reads of the table: L_a(0, end) and T_a(0, t₀) for its ray and class. */
export interface TableAir {
  readonly toEnd: Node<'vec3'>
  readonly through: Node<'vec3'>
}

/**
 * The table's read for one ray of `body`: `mu` its up-cosine, `end` where
 * its span ends with no scene depth in the way, true meters, and `sky` its
 * class. Three bilinear reads at level 0, and the aerosol's phase.
 */
export function tableAirAt(
  table: TextureNode,
  body: CloudBodyUniforms,
  direction: Node<'vec3'>,
  mu: Node<'float'>,
  end: Node<'float'>,
  sky: Node<'bool'>,
): TableAir {
  const { low, high } = knots(body)
  const middle = body.boundaries.x.add(body.boundariesHigh.y).mul(0.5)
  const leavesLow = altitudeAlong(body, mu, end).lessThan(middle)
  const from = select(leavesLow, float(-1), low)
  const to = select(leavesLow, low, high)
  const share = saturate(
    select(crowdsHigh(body, leavesLow), to.sub(mu), mu.sub(from)).div(
      max(to.sub(from), 1e-12),
    ),
  )
  const row = select(
    share.lessThan(CROWDED_SHARE),
    log(share.mul(CROWDED / CROWDED_SHARE).add(1)).mul(CROWDED_ROWS / CROWDING),
    share
      .sub(CROWDED_SHARE)
      .mul(EVEN_ROWS / (1 - CROWDED_SHARE))
      .add(CROWDED_ROWS),
  ).add(select(leavesLow, float(0.5), float(SEGMENT_ROWS + 0.5)))
  const nu = dot(direction, body.sun)
  const horizontal = sqrt(
    max(
      float(1)
        .sub(mu.mul(mu))
        .mul(float(1).sub(body.sunUp.mul(body.sunUp))),
      0,
    ),
  )
  const azimuth = clamp(
    nu.sub(mu.mul(body.sunUp)).div(max(horizontal, 1e-6)),
    -1,
    1,
  )
  const column = azimuth
    .add(1)
    .mul(0.5 * (COLUMNS - 1))
    .add(select(sky, float(0.5), float(COLUMNS + 0.5)))
  const strip = select(sky, float(0), float(STRIP)).add(2 * COLUMNS + STRIP / 2)
  const read = (x: Node<'float'>, y: Node<'float'>): Node<'vec3'> =>
    table.sample(vec2(x.div(WIDTH), y.div(HEIGHT))).level(float(0)).rgb
  const terms = {
    rest: read(column, row),
    aerosol: read(column, row.add(ROWS)),
  }
  return {
    toEnd: directionLight(body.air, terms, direction, body.sun),
    through: read(strip, row),
  }
}

/**
 * `air` with its two tables read out of the copies the table's texture
 * holds: what the march a pixel takes where the scene's depth cuts its span
 * short, so the fragment binds one texture for both. Only `sample` is asked
 * of a table (`air.ts`, `readTable`), at coordinates `texelCentered` keeps
 * half a texel inside it, so a bilinear read of a copy weighs the four
 * texels the table's own would.
 */
export function airThroughTable(
  air: AirUniforms,
  table: TextureNode,
): AirUniforms {
  const copy = (
    width: number,
    height: number,
    row: number,
  ): AirUniforms['transmittance'] =>
    ({
      sample: (uv: Node<'vec2'>) =>
        table.sample(
          vec2(
            uv.x.mul(width / WIDTH),
            uv.y.mul(height / HEIGHT).add(row / HEIGHT),
          ),
        ),
    }) as unknown as AirUniforms['transmittance']
  return {
    ...air,
    transmittance: copy(
      TRANSMITTANCE_WIDTH,
      TRANSMITTANCE_HEIGHT,
      TRANSMITTANCE_ROW,
    ),
    multiScatter: copy(
      MULTI_SCATTER_WIDTH,
      MULTI_SCATTER_HEIGHT,
      MULTI_SCATTER_ROW,
    ),
  }
}

/** The kernel that forms the table's blocks: one invocation a direction and class. */
function formKernel(
  body: CloudBodyUniforms,
  into: StorageTexture,
  medium: AirMediumFn,
): ComputeNode {
  const main = Fn(() => {
    const texel = globalId.xy as unknown as Node<'uvec2'>
    If(
      texel.x.lessThan(uint(2 * COLUMNS)).and(texel.y.lessThan(uint(ROWS))),
      () => {
        const surface = texel.x.greaterThanEqual(uint(COLUMNS))
        const inBlock = texel.x.mod(uint(COLUMNS))
        const column = float(inBlock)
        const upper = texel.y.greaterThanEqual(uint(SEGMENT_ROWS))
        const { low, high } = knots(body)
        const from = select(upper, low, float(-1))
        const to = select(upper, high, low)
        const local = float(texel.y.mod(uint(SEGMENT_ROWS)))
        const share = select(
          local.lessThan(CROWDED_ROWS),
          exp(local.mul(CROWDING / CROWDED_ROWS))
            .sub(1)
            .mul(CROWDED_SHARE / CROWDED),
          local
            .sub(CROWDED_ROWS)
            .mul((1 - CROWDED_SHARE) / EVEN_ROWS)
            .add(CROWDED_SHARE),
        )
        const reach = share.mul(to.sub(from))
        const middle = from.add(to).mul(0.5)
        const mu = clamp(
          select(crowdsHigh(body, upper.not()), to.sub(reach), from.add(reach)),
          min(from.add(KNOT_MARGIN), middle),
          max(to.sub(KNOT_MARGIN), middle),
        ).toVar()
        // A sky ray that meets the datum ahead keeps the march a pixel's six.
        const passes = body.eye
          .lessThanEqual(0)
          .or(mu.greaterThanEqual(tangentCosine(body, body.eye, float(0))))
        const azimuth = column.mul(2 / (COLUMNS - 1)).sub(1)
        const { toward, across } = azimuthAxes(body)
        const direction = normalize(
          body.up.mul(mu).add(
            toward
              .mul(azimuth)
              .add(across.mul(sqrt(max(float(1).sub(azimuth.mul(azimuth)), 0))))
              .mul(sqrt(max(float(1).sub(mu.mul(mu)), 0))),
          ),
        )
        const ray = cloudRay(direction, body, float(NO_STOP))
        const radius = body.datumRadius
        const rest = vec3(0).toVar()
        const aerosol = vec3(0).toVar()
        const through = vec3(1).toVar()
        If(ray.hit, () => {
          const terms = directionAir(
            body.air,
            airEye(body),
            direction,
            ray.start.div(radius),
            ray.end.div(radius),
            surface.not(),
            passes,
            body.sun,
            body.cleared,
            AIR_TABLE_FRONT,
            medium,
          )
          rest.assign(terms.rest)
          aerosol.assign(terms.aerosol)
          through.assign(terms.through)
        })
        textureStore(into, texel, vec4(rest, 1))
        textureStore(
          into,
          uvec2(texel.x, texel.y.add(uint(ROWS))),
          vec4(aerosol, 1),
        )
        If(inBlock.lessThan(uint(STRIP)), () => {
          textureStore(
            into,
            uvec2(
              select(surface, uint(STRIP), uint(0))
                .add(inBlock)
                .add(uint(2 * COLUMNS)),
              texel.y,
            ),
            vec4(through, 1),
          )
        })
      },
    )
  })
  return computeKernel(main(), [WORKGROUP, WORKGROUP, 1]).setName(LABEL)
}

/** The kernel that copies the air's two tables under the blocks. */
function copyKernel(air: AirUniforms, into: StorageTexture): ComputeNode {
  const main = Fn(() => {
    const texel = globalId.xy as unknown as Node<'uvec2'>
    If(
      texel.x
        .lessThan(uint(TRANSMITTANCE_WIDTH))
        .and(texel.y.lessThan(uint(TRANSMITTANCE_HEIGHT))),
      () => {
        textureStore(
          into,
          uvec2(texel.x, texel.y.add(uint(TRANSMITTANCE_ROW))),
          air.transmittance.load(ivec2(texel)),
        )
      },
    )
    If(
      texel.x
        .lessThan(uint(MULTI_SCATTER_WIDTH))
        .and(texel.y.lessThan(uint(MULTI_SCATTER_HEIGHT))),
      () => {
        textureStore(
          into,
          uvec2(texel.x, texel.y.add(uint(MULTI_SCATTER_ROW))),
          air.multiScatter.load(ivec2(texel)),
        )
      },
    )
  })
  return computeKernel(main(), [WORKGROUP, WORKGROUP, 1]).setName(LABEL)
}

const groups = (width: number, height: number): [number, number, number] => [
  Math.ceil(width / WORKGROUP),
  Math.ceil(height / WORKGROUP),
  1,
]

/**
 * The table and its two kernels. It keeps nothing between frames: every
 * frame that reads it forms it first, from that frame's uniforms, so no
 * frame reads another's air.
 */
export class CloudAirTable implements CloudResource {
  readonly name = 'air'
  readonly pending = false
  /** The node a program reads the table through. */
  readonly node: TextureNode
  readonly #map: StorageTexture
  readonly #form: ComputeNode
  readonly #copy: ComputeNode
  #allocated = false
  #disposed = false

  constructor(body: CloudBodyUniforms, medium: AirMediumFn = airMediumAt) {
    this.#map = cloudStorageTexture(WIDTH, HEIGHT, 'rgba16float', LABEL)
    this.#map.magFilter = LinearFilter
    this.#map.minFilter = LinearFilter
    this.node = texture(this.#map)
    this.#form = formKernel(body, this.#map, medium)
    this.#copy = copyKernel(body.air, this.#map)
  }

  get bytes(): number {
    if (!this.#allocated || this.#disposed) return 0
    return textureBytes(WIDTH, HEIGHT, 1, TEXEL_BYTES)
  }

  textures(): readonly Texture[] {
    return !this.#allocated || this.#disposed ? [] : [this.#map]
  }

  async warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return
    this.#allocated = true
    await warmCompute(renderer, [this.#form, this.#copy])
  }

  /** Forms the table from the uniforms as they stand: called by the frame that reads it, before its draw. */
  form(renderer: WebGPURenderer): void {
    if (this.#disposed) return
    this.#allocated = true
    renderer.compute(this.#form, groups(2 * COLUMNS, ROWS))
    renderer.compute(
      this.#copy,
      groups(TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT),
    )
  }

  /** The frame's order does not form it: the composite does, on the frames it reads it. */
  render(): void {}

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#map.dispose()
    this.#form.dispose()
    this.#copy.dispose()
  }
}
