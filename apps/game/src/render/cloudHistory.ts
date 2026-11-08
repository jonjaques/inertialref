import {
  type ComputeNode,
  type Node,
  StorageBufferAttribute,
  type StorageTexture,
  type Texture,
  type TextureNode,
  type UniformNode,
  Vector2,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  abs,
  atomicAdd,
  clamp,
  computeKernel,
  dot,
  float,
  floor,
  Fn,
  fract,
  globalId,
  If,
  int,
  ivec2,
  length,
  max,
  min,
  mix,
  select,
  sqrt,
  storage,
  texture,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { invariant } from '@inertialref/shared'
import { type Extent, textureBytes } from '@inertialref/rendering'
import type { CloudFrame } from './cloudFrame.ts'
import { traceScreen, viewDirection } from './cloudGeometry.ts'
import {
  type CloudBudget,
  type CloudResource,
  cloudStorageTexture,
  finiteOr,
} from './cloudNodes.ts'
import type { CloudTraceTextures } from './cloudTrace.ts'
import type { CloudUniforms } from './cloudUniforms.ts'
import { warmCompute } from './warmup.ts'

/*
 * The history: the trace's quarter-resolution samples accumulated at half
 * resolution (§5.14). Trace texel (i, j) samples history pixel
 * (2i + φx, 2j + φy), φ stepping through (0,0), (1,1), (1,0), (0,1) one a
 * frame, so each pixel takes a fresh sample every fourth frame; every pixel
 * is also reprojected from the last frame's history in body-fixed axes, by
 * the eye's motion and the cloud's drift on the wind, and clipped to the
 * current neighborhood's variance. The body's turn needs no term of its own:
 * the axes turn with it, and the eye's motion through them is the turn.
 *
 * Two parities, each three RGBA16F storage textures. A frame reads one and
 * writes the other, because the reprojected read lands anywhere in the image
 * and a kernel sampling the texture it stores into reads texels its own
 * workgroups have already overwritten. Four kernels, each named
 * `cloud history`: a converging kernel for each direction and an immediate
 * kernel into each parity, each binding texture objects of its own, so no
 * program holds two nodes over one texture (rule 57).
 *
 * The history remembers the light — L_c, T_c and B — and none of the
 * depths. A depth averaged over frames trails a moving eye by the average's
 * window, 28 frames at the floor's weight, and the next frame's depth test
 * holds that trailing figure against where the reprojected point really is:
 * an eye closing on a cloud by 1% of its distance a frame puts the average
 * 28% behind, past the test's 20%, and every pixel of the cloud rejects. So
 * d_reproj, d_end, d_front and the deviation are this frame's — the trace's
 * own texel on a pixel of this frame's phase, the bilinear current
 * elsewhere.
 */

/** (L_c.rgb, T_c), (B.rgb, d_reproj km), (d_end km, d_front km, deviation km, age frames). */
export interface CloudHistoryTextures {
  /** (L_c.rgb, T_c). */
  readonly light: StorageTexture
  /** (B.rgb, d_reproj km). */
  readonly air: StorageTexture
  /** (d_end km, d_front km, deviation km, age frames). */
  readonly depth: StorageTexture
  readonly extent: Extent
}

/** The interleave in Bayer order: a converging frame n samples phase n mod 4. */
const PHASES = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
] as const
/** Frames until every pixel's own phase has come round once. */
const CYCLE = PHASES.length
const WORKGROUP = 8

/*
 * Age is the frames of history a texel's estimate stands for, capped. A
 * converging frame adds one to every texel it keeps. A fresh full-budget
 * sample that starts an estimate stands for one cycle; a guess — the
 * bilinear current a rejected pixel takes, or the immediate regime's sample
 * at a quarter of the step budget — stands for none. So ⌊age/4⌋ at a pixel's
 * own phase counts the full-budget samples its estimate already holds,
 * whatever phase the restart fell on, and α = max(1/(n + 1), 1/8) is the
 * running mean's weight up to the eighth sample and the floor's after it:
 * 32 frames after a reset every pixel the clip has not held holds the plain
 * mean of its eight samples. Weighting by frames, 1/(age + 1), would weight a
 * pixel by where its phase fell after the reset rather than by what it holds,
 * and leave the reset frame's quarter-budget sample a 29% share in a quarter
 * of the pixels 32 frames on.
 */
const ALPHA_FLOOR = 1 / 8
/** Past 28 frames α is the floor's; a half float counts integers exactly only to 2048. */
const AGE_CAP = 255
/** The clip's half-width, in deviations of the current neighborhood. */
const CLIP_WIDTH = 1.25
/** The eye's travel over the cloud's distance past which a volume reprojects as a different view. */
const PARALLAX_LIMIT = 0.1
/** The share of the cloud's distance the stored depth may miss the reprojected point by. */
const DEPTH_LIMIT = 0.2
/** Meters: the least distance either share is taken of, so a cloud at the eye does not reject on its own rounding. */
const DEPTH_FLOOR = 10
/** A ray this frame's scene stops short of this share of the stored cloud's distance is occluded. */
const OCCLUSION_SHARE = 0.9
/** A luminance this small has no chroma left to scale. */
const DARK = 1e-6
/** Bytes an RGBA16F texel holds. */
const TEXEL_BYTES = 8
const KM = 1000

/** Rec. 709's, as the meter's: the clip's luminance is the scene's, not the output gamut's. */
const LUMINANCE = /*@__PURE__*/ vec3(0.2126, 0.7152, 0.0722)
const LEVEL0 = /*@__PURE__*/ float(0)
/** What a texel holds where nothing finite can be: clear sky, no air blocked, nothing aged. */
const NO_LIGHT = /*@__PURE__*/ vec4(0, 0, 0, 1)
const NO_AIR = /*@__PURE__*/ vec4(0, 0, 0, 0)
const NO_DEPTH = /*@__PURE__*/ vec4(0, 0, 0, 0)

interface Parity {
  readonly light: StorageTexture
  readonly air: StorageTexture
  readonly depth: StorageTexture
}

/** The trace's two textures the history reads, one node each, swapped to the trace's objects every frame. */
interface TraceNodes {
  readonly light: TextureNode
  readonly aux: TextureNode
}

/** A trace texel, or a blend of them: (L_c, T_c), (B, d_reproj), (d_end, d_front, deviation, knots). */
interface TraceRecord {
  readonly light: Node<'vec4'>
  readonly air: Node<'vec4'>
  readonly depth: Node<'vec4'>
}

interface Controls {
  readonly phase: UniformNode<'vec2', Vector2>
  /** 0 after a CPU reset or a reallocation: every pixel takes the current. */
  readonly valid: UniformNode<'float', number>
  /** 1 on a frame whose rejections the report counts. */
  readonly counting: UniformNode<'float', number>
  readonly rejected: Node
}

const groups = (extent: Extent): [number, number, number] => [
  Math.ceil(extent.width / WORKGROUP),
  Math.ceil(extent.height / WORKGROUP),
  1,
]

/** Trace texel (x, y): its light, and the two halves of its aux pair. */
function traceRecord(
  trace: TraceNodes,
  x: Node<'int'>,
  y: Node<'int'>,
): TraceRecord {
  const left = x.mul(2)
  return {
    light: trace.light.load(ivec2(x, y)).toVar(),
    air: trace.aux.load(ivec2(left, y)).toVar(),
    depth: trace.aux.load(ivec2(left.add(1), y)).toVar(),
  }
}

/**
 * Whether every component is finite: `finiteOr`'s exponent test, read
 * through a marker it replaces. A component sum is non-finite exactly when a
 * component is, short of an overflow no half-float input can reach.
 */
function allFinite(...values: readonly Node<'vec4'>[]): Node<'bool'> {
  const sum = (v: Node<'vec4'>): Node<'float'> => v.x.add(v.y).add(v.z).add(v.w)
  const [a, b = vec4(0), c = vec4(0)] = values
  return finiteOr(
    vec4(sum(a!), sum(b), sum(c), 0),
    vec4(0, 0, 0, -1),
  ).w.greaterThanEqual(0)
}

/** Bilinear weights of a coordinate on the block's texels 0, 1 and 2. */
const tent = (c: Node<'float'>): readonly Node<'float'>[] =>
  [0, 1, 2].map((k) => max(float(1).sub(abs(c.sub(k))), 0))

/** A block's texels weighted by one position's separable weights. */
function blend(
  grid: readonly (readonly Node<'vec4'>[])[],
  wx: readonly Node<'float'>[],
  wy: readonly Node<'float'>[],
): Node<'vec4'> {
  let sum: Node<'vec4'> = vec4(0)
  grid.forEach((row, b) =>
    row.forEach((value, a) => {
      sum = sum.add(value.mul(wx[a]!.mul(wy[b]!)))
    }),
  )
  return sum
}

/*
 * The clip's window reads the block with a texel past the trace's edge
 * extrapolated linearly from the two inside it; the current reads it clamped.
 * Clamped, an edge pixel on a frame that does not sample it has its inward
 * neighbors for a window, a pixel of the image's gradient off the value its
 * own samples accumulated, and the clip pulls it inward every such frame:
 * 3.5% at the edge of a ramp of 1.25% a pixel. Extrapolated, the window
 * follows the gradient, while the current, which the history writes when it
 * rejects, never overshoots. The window's center is a pixel inside the image,
 * so at most one texel a side is past it.
 */
function extrapolated(
  grid: readonly (readonly Node<'float'>[])[],
  base: Node<'vec2'>,
  last: Node<'vec2'>,
): readonly (readonly Node<'float'>[])[] {
  const past =
    (low: Node<'bool'>, high: Node<'bool'>) =>
    (line: readonly Node<'float'>[]): Node<'float'>[] => [
      select(low, line[1]!.mul(2).sub(line[2]!), line[0]!),
      line[1]!,
      select(high, line[1]!.mul(2).sub(line[0]!), line[2]!),
    ]
  const across = past(base.x.lessThan(0), base.x.add(2).greaterThan(last.x))
  const down = past(base.y.lessThan(0), base.y.add(2).greaterThan(last.y))
  const rows = grid.map(across)
  const columns = [0, 1, 2].map((a) => down(rows.map((row) => row[a]!)))
  return [0, 1, 2].map((b) => columns.map((column) => column[b]!))
}

/** The mean and deviation of a scalar over the nine positions' bilinear values. */
function moments(
  grid: readonly (readonly Node<'float'>[])[],
  wx: readonly (readonly Node<'float'>[])[],
  wy: readonly (readonly Node<'float'>[])[],
): { readonly mean: Node<'float'>; readonly deviation: Node<'float'> } {
  // Separable: each position's row sums first, then down the rows.
  const rows = wx.map((weights) =>
    grid.map((row) =>
      row
        .reduce<Node<'float'>>((s, v, a) => s.add(v.mul(weights[a]!)), float(0))
        .toVar(),
    ),
  )
  let sum: Node<'float'> = float(0)
  let squares: Node<'float'> = float(0)
  for (const across of rows)
    for (const weights of wy) {
      const value = across
        .reduce<Node<'float'>>((s, v, b) => s.add(v.mul(weights[b]!)), float(0))
        .toVar()
      sum = sum.add(value)
      squares = squares.add(value.mul(value))
    }
  const mean = sum.div(9).toVar()
  return {
    mean,
    deviation: sqrt(max(squares.div(9).sub(mean.mul(mean)), 0)),
  }
}

/**
 * A history pixel's light and air: reproject, reject, clip and blend. The
 * pixel's current is the bilinear blend of the trace texels whose sample
 * points surround its center — the trace's own texel exactly on a pixel of
 * this frame's phase, which is that pixel's fresh sample.
 */
function convergingKernel(
  uniforms: CloudUniforms,
  trace: TraceNodes,
  from: Parity,
  into: Parity,
  controls: Controls,
): ComputeNode {
  const previous = {
    light: texture(from.light),
    air: texture(from.air),
    depth: texture(from.depth),
  }
  const { camera } = uniforms
  const { size, history, wind, frameSeconds } = uniforms.trace
  const body = Fn(() => {
    const pixel = globalId.xy as unknown as Node<'uvec2'>
    If(
      float(pixel.x)
        .lessThan(history.x)
        .and(float(pixel.y).lessThan(history.y)),
      () => {
        /*
         * A history coordinate among the trace's sample points is
         * u = (p − φ)/2 in trace texels: whole on this frame's phase, half-way
         * off it. The clip's 3 × 3 window is centered one pixel inside the
         * image's edge, and the 3 × 3 block of texels from ⌊u − ½⌋ of that
         * center holds every texel its nine bilinear values and the pixel's
         * own reach, clamped at the trace's edges. Centered on an edge pixel
         * the phase does not sample, all nine values would be one clamped
         * texel: a deviation of 0, and a clip that overwrites the history with
         * its neighbor's raw sample one frame in four.
         */
        const at = vec2(pixel).toVar()
        const center = clamp(at, vec2(1), max(history.sub(2), vec2(1)))
        const u = center.sub(controls.phase).mul(0.5)
        const base = floor(u.sub(0.5)).toVar()
        const offset = u.sub(base).toVar()
        const self = at.sub(controls.phase).mul(0.5).sub(base).toVar()
        const own = fract(self.x)
          .lessThan(0.25)
          .and(fract(self.y).lessThan(0.25))
        const last = size.sub(1)
        const grid = [0, 1, 2].map((b) =>
          [0, 1, 2].map((a) => {
            const texel = clamp(base.add(vec2(a, b)), vec2(0), last)
            return traceRecord(trace, int(texel.x), int(texel.y))
          }),
        )
        const wx = [-0.5, 0, 0.5].map((s) => tent(offset.x.add(s)))
        const wy = [-0.5, 0, 0.5].map((s) => tent(offset.y.add(s)))
        const ownX = tent(self.x)
        const ownY = tent(self.y)
        const field = (key: keyof TraceRecord) =>
          grid.map((row) => row.map((record) => record[key]))
        const current: TraceRecord = {
          light: blend(field('light'), ownX, ownY).toVar(),
          air: blend(field('air'), ownX, ownY).toVar(),
          depth: blend(field('depth'), ownX, ownY).toVar(),
        }

        // X = d̂·d_reproj now; X_prev = X + translation − wind·Δt, projected
        // onto the previous basis and plane (galaxyTemporal.ts's form).
        const ray = viewDirection(camera, traceScreen(pixel, vec2(0), history))
        const distance = current.air.w.mul(KM).toVar()
        const before = ray
          .mul(distance)
          .add(camera.translation)
          .sub(wind.mul(frameSeconds))
          .toVar()
        const ahead = dot(before, camera.previousForward).toVar()
        const facing = max(ahead, 1e-6)
        const seen = vec2(
          dot(before, camera.previousRight).div(
            facing.mul(camera.previousPlane.x),
          ),
          dot(before, camera.previousUp).div(
            facing.mul(camera.previousPlane.y),
          ),
        ).toVar()
        const then = vec2(
          seen.x.mul(0.5).add(0.5),
          float(0.5).sub(seen.y.mul(0.5)),
        )
        const kept: TraceRecord = {
          light: previous.light.sample(then).level(LEVEL0).toVar(),
          air: previous.air.sample(then).level(LEVEL0).toVar(),
          depth: previous.depth.sample(then).level(LEVEL0).toVar(),
        }

        /*
         * Every test is written as what keeps the history, so a NaN, which
         * compares false, rejects. The history's own d_reproj is in the
         * previous eye's terms and |X_prev| is too.
         */
        const floorDistance = max(distance, DEPTH_FLOOR)
        const accept = controls.valid
          .greaterThan(0.5)
          .and(ahead.greaterThan(0))
          .and(abs(seen.x).lessThanEqual(1))
          .and(abs(seen.y).lessThanEqual(1))
          .and(allFinite(kept.light, kept.air, kept.depth))
          .and(
            length(camera.translation)
              .div(floorDistance)
              .lessThanEqual(PARALLAX_LIMIT),
          )
          .and(
            abs(kept.air.w.mul(KM).sub(length(before))).lessThanEqual(
              floorDistance.mul(DEPTH_LIMIT),
            ),
          )
          .and(
            current.depth.x.greaterThanEqual(kept.air.w.mul(OCCLUSION_SHARE)),
          )
          .toVar()

        /*
         * The clip: luminance of L_c + B and T_c, each held within 1.25
         * deviations of the nine neighbors' bilinear current. The luminance
         * is held by scaling both RGBs, which keeps the history's chroma; a
         * history too dark to scale, or one the scale would turn negative,
         * takes the current's RGB instead.
         */
        const luminance = moments(
          extrapolated(
            grid.map((row) =>
              row.map((record) =>
                dot(record.light.rgb.add(record.air.rgb), LUMINANCE).toVar(),
              ),
            ),
            base,
            last,
          ),
          wx,
          wy,
        )
        const transmittance = moments(
          extrapolated(
            grid.map((row) => row.map((record) => record.light.a)),
            base,
            last,
          ),
          wx,
          wy,
        )
        const brightness = dot(
          kept.light.rgb.add(kept.air.rgb),
          LUMINANCE,
        ).toVar()
        const spread = luminance.deviation.mul(CLIP_WIDTH)
        const held = clamp(
          brightness,
          luminance.mean.sub(spread),
          luminance.mean.add(spread),
        ).toVar()
        const moved = held.notEqual(brightness)
        const lit = abs(brightness).greaterThan(DARK)
        const scale = held.div(select(lit, brightness, float(1))).toVar()
        const replace = moved.and(lit.and(scale.greaterThanEqual(0)).not())
        const factor = select(moved, scale, float(1))
        const opacitySpread = transmittance.deviation.mul(CLIP_WIDTH)
        const clippedLight = vec4(
          select(replace, current.light.rgb, kept.light.rgb.mul(factor)),
          clamp(
            kept.light.a,
            transmittance.mean.sub(opacitySpread),
            transmittance.mean.add(opacitySpread),
          ),
        )
        const clippedAir = select(
          replace,
          current.air.rgb,
          kept.air.rgb.mul(factor),
        )

        const age = kept.depth.w
        const alpha = max(
          float(1).div(floor(age.div(CYCLE)).add(1)),
          ALPHA_FLOOR,
        )
        const light = select(
          accept,
          select(own, mix(clippedLight, current.light, alpha), clippedLight),
          current.light,
        ).toVar()
        const air = select(
          accept,
          select(own, mix(clippedAir, current.air.rgb, alpha), clippedAir),
          current.air.rgb,
        ).toVar()
        const aged = select(
          accept,
          min(age.add(1), AGE_CAP),
          select(own, float(CYCLE), float(0)),
        )

        // The guard on write: anything still not finite takes the current,
        // and a current that is not either takes clear sky.
        const trusted = allFinite(light, vec4(air, 0))
        textureStore(
          into.light,
          pixel,
          finiteOr(select(trusted, light, current.light), NO_LIGHT),
        )
        textureStore(
          into.air,
          pixel,
          finiteOr(
            vec4(select(trusted, air, current.air.rgb), current.air.w),
            NO_AIR,
          ),
        )
        textureStore(
          into.depth,
          pixel,
          finiteOr(
            vec4(current.depth.xyz, select(trusted, aged, float(0))),
            NO_DEPTH,
          ),
        )
        If(controls.counting.greaterThan(0.5).and(accept.not()), () => {
          atomicAdd(controls.rejected, uint(1))
        })
      },
    )
  })
  return computeKernel(body(), [WORKGROUP, WORKGROUP, 1]).setName(
    'cloud history',
  )
}

/** Phase k's pixels from the trace, at age 0: one invocation a trace texel. */
function immediateKernel(
  uniforms: CloudUniforms,
  trace: TraceNodes,
  into: Parity,
  phase: Node<'vec2'>,
): ComputeNode {
  const { size } = uniforms.trace
  const body = Fn(() => {
    const texel = globalId.xy as unknown as Node<'uvec2'>
    If(
      float(texel.x).lessThan(size.x).and(float(texel.y).lessThan(size.y)),
      () => {
        const record = traceRecord(trace, int(texel.x), int(texel.y))
        const pixel = texel.mul(uint(2)).add(uvec2(phase))
        textureStore(into.light, pixel, finiteOr(record.light, NO_LIGHT))
        textureStore(into.air, pixel, finiteOr(record.air, NO_AIR))
        textureStore(
          into.depth,
          pixel,
          finiteOr(vec4(record.depth.xyz, 0), NO_DEPTH),
        )
      },
    )
  })
  return computeKernel(body(), [WORKGROUP, WORKGROUP, 1]).setName(
    'cloud history',
  )
}

function parity(label: string): Parity {
  return {
    light: cloudStorageTexture(
      1,
      1,
      'rgba16float',
      `cloud history light ${label}`,
    ),
    air: cloudStorageTexture(1, 1, 'rgba16float', `cloud history air ${label}`),
    depth: cloudStorageTexture(
      1,
      1,
      'rgba16float',
      `cloud history depth ${label}`,
    ),
  }
}

const mapsOf = (held: Parity): StorageTexture[] => [
  held.light,
  held.air,
  held.depth,
]

export class CloudHistory implements CloudResource {
  readonly name = 'history'
  /**
   * Never: a frame does its whole share. How far the history has converged
   * is `report.sinceReset`, which the settle predicate reads.
   */
  readonly pending = false
  readonly #trace: () => CloudTraceTextures
  readonly #parities: readonly [Parity, Parity] = [parity('A'), parity('B')]
  /*
   * The trace's two textures are read through nodes the history owns,
   * swapped to whatever `trace()` holds before every dispatch, so a trace
   * that replaces its textures at a resize is followed. Until the first swap
   * they sit over placeholders of the trace's kind and filter, one each: two
   * nodes over one texture compile to one binding (rule 57), and a
   * nearest-filtered stand-in compiles a program without the sampler the
   * trace's linear textures bind (rule 56).
   */
  readonly #placeholders = [
    cloudStorageTexture(1, 1, 'rgba16float', 'cloud history trace light'),
    cloudStorageTexture(1, 1, 'rgba16float', 'cloud history trace aux'),
  ] as const
  readonly #traceNodes: TraceNodes = {
    light: texture(this.#placeholders[0]),
    aux: texture(this.#placeholders[1]),
  }
  readonly #phase = uniform(new Vector2())
  readonly #valid = uniform(1)
  readonly #counting = uniform(0)
  readonly #counter = new StorageBufferAttribute(new Uint32Array(1), 1)
  /** [k]: reads parity k, writes the other. */
  readonly #converge: readonly [ComputeNode, ComputeNode]
  /** [k]: writes parity k. */
  readonly #immediate: readonly [ComputeNode, ComputeNode]
  #newest: 0 | 1 = 0
  #extent: Extent = { width: 1, height: 1 }
  #allocated = false
  #disposed = false
  #resetPending = false
  #resets = 0
  #sinceReset = 0
  #phaseIndex = 0
  #stats = false
  #reading = false
  #rejected: number | null = null

  constructor(uniforms: CloudUniforms, trace: () => CloudTraceTextures) {
    this.#trace = trace
    const controls: Controls = {
      phase: this.#phase,
      valid: this.#valid,
      counting: this.#counting,
      rejected: storage(this.#counter, 'uint', 1).toAtomic().element(0),
    }
    const [a, b] = this.#parities
    this.#converge = [
      convergingKernel(uniforms, this.#traceNodes, a, b, controls),
      convergingKernel(uniforms, this.#traceNodes, b, a, controls),
    ]
    this.#immediate = [
      immediateKernel(uniforms, this.#traceNodes, a, this.#phase),
      immediateKernel(uniforms, this.#traceNodes, b, this.#phase),
    ]
  }

  /**
   * The newest history: what the composite and the next frame read.
   * `outputs` and not `textures`, which every resource answers with what it
   * holds for the census. It names the other parity after every frame, so
   * a reader takes it again each frame.
   */
  get outputs(): CloudHistoryTextures {
    const held = this.#parities[this.#newest]
    return { ...held, extent: this.#extent }
  }

  /** Both parities at the frame's history extent; nothing until a frame has sized them. */
  get bytes(): number {
    if (!this.#allocated || this.#disposed) return 0
    const { width, height } = this.#extent
    return 6 * textureBytes(width, height, 1, TEXEL_BYTES)
  }

  get report(): {
    readonly resets: number
    readonly sinceReset: number
    readonly phase: number
    /** The share of the history's pixels the last counted frame rejected, under `levers.stats`. */
    readonly rejected: number | null
  } {
    return {
      resets: this.#resets,
      sinceReset: this.#sinceReset,
      phase: this.#phaseIndex,
      rejected: this.#rejected,
    }
  }

  textures(): readonly Texture[] {
    if (!this.#allocated || this.#disposed) return []
    return this.#parities.flatMap(mapsOf)
  }

  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#bindTrace()
    return warmCompute(renderer, [...this.#converge, ...this.#immediate])
  }

  /** The converging regime: reproject, reject, clip and blend into the other parity. */
  render(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    _budget: CloudBudget,
  ): void {
    if (this.#disposed) return
    const resized = this.#allocate(renderer, frame.extents.history)
    this.#bindTrace()
    this.#setPhase(frame.frameIndex % CYCLE)
    // A frame the system should have drawn immediately keeps nothing either.
    const restart =
      resized || this.#resetPending || frame.regime === 'immediate'
    this.#resetPending = false
    if (restart) this.#restarted()
    else this.#sinceReset += 1
    if (this.#valid.value !== (restart ? 0 : 1))
      this.#valid.value = restart ? 0 : 1
    this.#stats = frame.levers.stats
    if (!this.#stats) this.#rejected = null
    const counting = this.#stats && !this.#reading
    if (this.#counting.value !== (counting ? 1 : 0))
      this.#counting.value = counting ? 1 : 0
    if (counting) {
      this.#counter.array[0] = 0
      this.#counter.needsUpdate = true
    }
    renderer.compute(this.#converge[this.#newest], groups(this.#extent))
    this.#newest = this.#newest === 0 ? 1 : 0
    if (counting)
      this.#readRejected(renderer, this.#extent.width * this.#extent.height)
  }

  /**
   * The immediate regime: write phase k's pixels of the newest parity from
   * the trace, age 0, and nothing else. After k = 3 every pixel is this
   * frame's. k = 0 turns to the other parity, so the one the last frame
   * wrote is never half overwritten.
   */
  renderImmediate(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    k: number,
  ): void {
    invariant(
      Number.isInteger(k) && k >= 0 && k < CYCLE,
      'the immediate regime has four phases',
    )
    if (this.#disposed) return
    this.#allocate(renderer, frame.extents.history)
    this.#bindTrace()
    if (k === 0) {
      this.#newest = this.#newest === 0 ? 1 : 0
      this.#resetPending = false
      this.#restarted()
    }
    this.#setPhase(k)
    renderer.compute(this.#immediate[this.#newest], groups(frame.extents.trace))
  }

  /** The next converging frame keeps nothing: every pixel takes the current. */
  reset(): void {
    this.#resetPending = true
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const held of this.#parities)
      for (const map of mapsOf(held)) map.dispose()
    for (const placeholder of this.#placeholders) placeholder.dispose()
    for (const kernel of [...this.#converge, ...this.#immediate])
      kernel.dispose()
    this.#counter.dispose()
  }

  #restarted(): void {
    this.#resets += 1
    this.#sinceReset = 0
  }

  /**
   * Size both parities to the frame's history extent; true when they had to
   * be reallocated. Both are made on the device here rather than at their
   * first binding: an immediate frame binds only the parity it writes, and a
   * census taken after it would find three of the six textures it declares.
   */
  #allocate(renderer: WebGPURenderer, extent: Extent): boolean {
    if (
      this.#allocated &&
      extent.width === this.#extent.width &&
      extent.height === this.#extent.height
    )
      return false
    for (const held of this.#parities)
      for (const map of mapsOf(held)) {
        // `@types/three` declares a depth that r185's 2D storage texture ignores.
        map.setSize(extent.width, extent.height, 1)
        renderer.initTexture(map)
      }
    this.#extent = { width: extent.width, height: extent.height }
    this.#allocated = true
    return true
  }

  #bindTrace(): void {
    const { light, aux } = this.#trace()
    if (this.#traceNodes.light.value !== light)
      this.#traceNodes.light.value = light
    if (this.#traceNodes.aux.value !== aux) this.#traceNodes.aux.value = aux
  }

  #setPhase(index: number): void {
    const [x, y] = PHASES[index]!
    if (this.#phase.value.x !== x || this.#phase.value.y !== y)
      this.#phase.value.set(x, y)
    this.#phaseIndex = index
  }

  /** The counted frame's rejections, read back without waiting for them. */
  #readRejected(renderer: WebGPURenderer, pixels: number): void {
    this.#reading = true
    void renderer
      .getArrayBufferAsync(this.#counter)
      .then((buffer) => {
        if (!this.#disposed && this.#stats)
          this.#rejected = new Uint32Array(buffer)[0]! / pixels
      })
      .catch(() => {
        // A device being replaced has no counter; the next frame counts again.
      })
      .finally(() => {
        this.#reading = false
      })
  }
}
