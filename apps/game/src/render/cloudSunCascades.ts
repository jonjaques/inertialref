import {
  HalfFloatType,
  type Node,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  type Texture,
  type TextureNode,
  type UniformNode,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  abs,
  dot,
  float,
  floor,
  Fn,
  If,
  int,
  ivec2,
  length,
  Loop,
  max,
  min,
  mix,
  packHalf2x16,
  screenCoordinate,
  select,
  texture,
  uniform,
  unpackHalf2x16,
  vec2,
  vec4,
} from 'three/tsl'
import {
  type DirtyRect,
  type SunCascade,
  textureBytes,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import type { CloudFrame } from './cloudFrame.ts'
import { altitudeAt, shellCrossingFrom, sunMuAt } from './cloudGeometry.ts'
import type {
  CloudBudget,
  CloudMediumFn,
  CloudResource,
  CloudSunDepthNodes,
} from './cloudNodes.ts'
import type { CloudUniforms } from './cloudUniforms.ts'
import { wrapped } from './cloudVolume.ts'
import { runQuadPasses } from './quadPass.ts'
import { warmSensorPass } from './warmup.ts'

/*
 * The sun's optical depth as three sun-space Beer shadow maps (UE5's form,
 * Hillaire 2020): per texel, the front depth along the sun from the
 * cascade's near plane, the mean extinction over the cloudy chord and the
 * largest optical depth, read as T(z) = exp(−min(G·max(z − front, 0), B)).
 *
 * **The front depth is two half floats.** From one near plane across a
 * cascade the depth to the layer varies by about extent·cot(elevation): at
 * 37.5° up to 269 km at the outer cascade's far edge, where one half float
 * steps by 250 m, ±8 optical depths of cumulus on exactly the front samples
 * that carry a cloud's light. So R holds the depth rounded to a half float
 * and A what that rounding left, under a quarter kilometer, which a half
 * float holds to 6 cm. A bilinear blend is linear, so the blended pair
 * still sums to the blended depth — blended in float32 by the read itself,
 * because the sampler returns a half float (`#bilinear`). R is rounded in
 * the shader through `pack2x16float`, so the store has nothing left to
 * round: a store that truncated (the GPU suite's Metal device truncates
 * R16F) would otherwise part R from the depth A was taken against.
 *
 * **What a texel holds is fixed by the frame it was drawn in.** A cascade is
 * read with the orientation, near plane and window it was last drawn with,
 * never the frame's newest: while it waits its turn to be rebuilt after the
 * sun turns, it is read as it stands, frozen, so no cascade ever mixes two
 * orientations. Scrolled, the exposed strips are drawn the frame they
 * appear; the near plane holds still in body-fixed space (`SunCascade.plane`)
 * and every held texel keeps its meaning. The finest cascade whose window
 * holds a point a texel in from its edge answers for it; past all three the
 * sun is unshadowed beyond the taps.
 *
 * **Under the shared cap** (`CloudBudget.sunTexelSteps`, one grid rebuild):
 * the strips, then one stale cascade rebuilt whole, the longest stale first
 * and the inner of those stale together, then one 64-row slice of the time
 * refresh, round-robin over the 24; what does not fit waits a frame and
 * holds `pending`.
 */

/** Meters; texels of 25, 100 and 400 m. */
export const SUN_CASCADE_EXTENTS = [12_800, 51_200, 204_800] as const
export const SUN_CASCADE_SIZE = 512
/** 64 rows a slice. */
export const SUN_CASCADE_SLICES = 8
/** The per-frame cap both candidates share, in texel-steps: one grid rebuild (128² × 32 cells × 32 steps); a cascade rebuild is 512² × 48. */
export const SUN_DEPTH_FRAME_CAP = 16_777_216
/** Steps a texel's sun ray takes through the union. */
export const SUN_CASCADE_STEPS = 48
/** The pass's name on the timeline. */
export const CLOUD_SUN_CASCADE_LABEL = 'cloud sun cascade'

const CASCADES = SUN_CASCADE_EXTENTS.length
const HALF = SUN_CASCADE_SIZE / 2
const ROWS = SUN_CASCADE_SIZE / SUN_CASCADE_SLICES
/** RGBA16F. */
const TEXEL_BYTES = 8
/** Texels in from a window's edge: a bilinear read reaches half a texel. */
const MARGIN = 1
/** km: a front past every chord, where a column holds no cloud. */
const NO_FRONT = 60_000
const KILOMETERS = 1e-3

interface CascadeUniforms {
  readonly toward: UniformNode<'vec3', Vector3>
  readonly right: UniformNode<'vec3', Vector3>
  readonly up: UniformNode<'vec3', Vector3>
  /** Eye-relative: the window's center corner, in the eye's plane across the sun. */
  readonly center: UniformNode<'vec3', Vector3>
  /** From the center toward the sun to the near plane, meters. */
  readonly near: UniformNode<'float', number>
  readonly texel: UniformNode<'float', number>
  /** The window's origin mod the size: storage texel of its low corner. */
  readonly originMod: UniformNode<'vec2', Vector2>
  readonly valid: UniformNode<'float', number>
}

const cascadeUniforms = (): CascadeUniforms => ({
  toward: uniform(new Vector3(0, 1, 0)),
  right: uniform(new Vector3(1, 0, 0)),
  up: uniform(new Vector3(0, 0, 1)),
  center: uniform(new Vector3()),
  near: uniform(0),
  texel: uniform(1),
  originMod: uniform(new Vector2()),
  valid: uniform(0),
})

/** What a cascade was last drawn with: what its texels mean. */
interface Drawn {
  readonly toward: Vec3
  readonly right: Vec3
  readonly up: Vec3
  /** The near plane's distance from the body's center along `toward`. */
  readonly plane: number
  readonly texelMeters: number
  origin: readonly [number, number]
}

interface Draw {
  readonly cascade: number
  /** Storage texels, or the whole layer. */
  readonly rect: DirtyRect | null
}

const WHOLE: DirtyRect = {
  x: 0,
  y: 0,
  width: SUN_CASCADE_SIZE,
  height: SUN_CASCADE_SIZE,
}

const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

const modulo = (value: number, size: number): number =>
  ((value % size) + size) % size

const steps = (rect: DirtyRect): number =>
  rect.width * rect.height * SUN_CASCADE_STEPS

const sameFrame = (drawn: Drawn, cascade: SunCascade): boolean =>
  cascade.plane !== undefined &&
  drawn.plane === cascade.plane &&
  drawn.texelMeters === cascade.texelMeters &&
  drawn.toward.x === cascade.toward.x &&
  drawn.toward.y === cascade.toward.y &&
  drawn.toward.z === cascade.toward.z

/** A cascade's frame as drawn this frame, its plane recovered where a hand-built one has none. */
function drawnFrom(cascade: SunCascade, eye: Vec3): Drawn {
  return {
    toward: cascade.toward,
    right: cascade.right,
    up: cascade.up,
    plane: cascade.plane ?? cascade.near + dot3(eye, cascade.toward),
    texelMeters: cascade.texelMeters,
    origin: cascade.origin,
  }
}

/** The uniforms that read a drawn cascade from this frame's eye. */
function writeCascade(
  target: CascadeUniforms,
  drawn: Drawn | null,
  eye: Vec3,
): void {
  if (drawn === null) {
    target.valid.value = 0
    return
  }
  const { toward, right, up, texelMeters: texel, origin } = drawn
  // float64 here: the eye's place in sun space less the window's corner.
  const across = (origin[0] + HALF) * texel - dot3(eye, right)
  const upward = (origin[1] + HALF) * texel - dot3(eye, up)
  target.toward.value.set(toward.x, toward.y, toward.z)
  target.right.value.set(right.x, right.y, right.z)
  target.up.value.set(up.x, up.y, up.z)
  target.center.value.set(
    right.x * across + up.x * upward,
    right.y * across + up.y * upward,
    right.z * across + up.z * upward,
  )
  target.near.value = drawn.plane - dot3(eye, toward)
  target.texel.value = texel
  target.originMod.value.set(
    modulo(origin[0], SUN_CASCADE_SIZE),
    modulo(origin[1], SUN_CASCADE_SIZE),
  )
  target.valid.value = 1
}

export class CloudSunCascades implements CloudResource, CloudSunDepthNodes {
  readonly name = 'sunCascades'
  readonly #uniforms: CloudUniforms
  readonly #field: CloudMediumFn
  readonly #target = new RenderTarget(1, 1, {
    depth: CASCADES,
    type: HalfFloatType,
    depthBuffer: false,
  })
  readonly #map: TextureNode
  readonly #read = Array.from({ length: CASCADES }, cascadeUniforms)
  readonly #bake = cascadeUniforms()
  readonly #material = new NodeMaterial()
  readonly #quad = new QuadMesh(this.#material)
  readonly #drawn: (Drawn | null)[] = Array.from(
    { length: CASCADES },
    () => null,
  )
  /** Set when a cascade's texels stop meaning this frame's: cleared when it is drawn whole. */
  readonly #stale: boolean[] = Array.from({ length: CASCADES }, () => true)
  /** The render each stale cascade went stale on: the longest stale is rebuilt first. */
  readonly #staleSince: number[] = Array.from({ length: CASCADES }, () => 0)
  #renders = 0
  #refresh = 0
  #spent = 0
  #rebuilt: number | null = null
  #scenario: WeatherScenario | null = null
  #address: string | null = null
  #last: number | null = null
  #allocated = false
  #warm: Promise<void> | null = null
  #disposed = false

  constructor(uniforms: CloudUniforms, field: CloudMediumFn) {
    this.#uniforms = uniforms
    this.#field = field
    const map = this.#target.texture
    map.name = 'cloud sun cascades'
    // Read by loads, wrapped toroidally in the read itself (`#bilinear`).
    this.#map = texture(map)
    this.#material.name = 'cloud sun cascade'
    this.#material.fragmentNode = this.#bakeNode()
  }

  /* ----------------------------------------------------------------------- */
  /* The read                                                                 */
  /* ----------------------------------------------------------------------- */

  /** Optical depth from an eye-relative body-fixed point to the sun. */
  opticalDepth(offset: Node<'vec3'>): Node<'float'> {
    const holds: Node<'bool'>[] = []
    let layer: Node<'int'> = int(CASCADES - 1)
    let at: Node<'vec2'> = vec2(0)
    let depth: Node<'float'> = float(0)
    for (let c = CASCADES - 1; c >= 0; c -= 1) {
      const cascade = this.#read[c]!
      const toCenter = offset.sub(cascade.center)
      const across = vec2(
        dot(toCenter, cascade.right),
        dot(toCenter, cascade.up),
      ).div(cascade.texel)
      const inside = cascade.valid
        .greaterThan(0.5)
        .and(abs(across.x).lessThanEqual(HALF - MARGIN))
        .and(abs(across.y).lessThanEqual(HALF - MARGIN))
      holds.push(inside)
      layer = select(inside, int(c), layer)
      // Storage texels, continuous: texel i covers [i, i + 1).
      at = select(inside, cascade.originMod.add(HALF).add(across), at)
      depth = select(
        inside,
        cascade.near.sub(dot(offset, cascade.toward)).mul(KILOMETERS),
        depth,
      )
    }
    const held = holds.reduce((any, inside) => any.or(inside))
    const texel = this.#bilinear(at, layer)
    const front = texel.x.add(texel.w)
    const tau = min(texel.y.mul(max(depth.sub(front), 0)), texel.z)
    return select(held, tau, float(0))
  }

  /**
   * The four texels around a storage coordinate, blended in float32 here
   * rather than by the sampler: the suite's Metal device filters a half-float
   * texture in half floats, so a filtered R at 300 km steps by a quarter
   * kilometer whatever A holds — the pair's whole point, lost in the
   * filter. Four loads of exact half floats and a float32 blend keep it.
   */
  #bilinear(at: Node<'vec2'>, layer: Node<'int'>): Node<'vec4'> {
    const corner = floor(at.sub(0.5))
    const share = at.sub(0.5).sub(corner)
    const load = (dx: number, dy: number): Node<'vec4'> =>
      this.#map
        .load(ivec2(wrapped(corner.add(vec2(dx, dy)), SUN_CASCADE_SIZE)))
        .depth(layer)
    return mix(
      mix(load(0, 0), load(1, 0), share.x),
      mix(load(0, 1), load(1, 1), share.x),
      share.y,
    )
  }

  /* ----------------------------------------------------------------------- */
  /* The bake                                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * One texel's column: 48 steps along −ŝ from the near plane between the
   * column's crossings of the union, each height from `altitudeAt`, the
   * crossings from `shellCrossingFrom` (rule 52). The march holds to the
   * first interval: past the base's near crossing the ray is under the
   * cloud, and what lies beyond it on the far side is in the shadow of what
   * the first interval holds, which B carries.
   */
  #bakeNode(): Node<'vec4'> {
    const body = this.#uniforms.served
    const bake = this.#bake
    return Fn(() => {
      const pixel = floor(screenCoordinate.xy)
      const local = wrapped(pixel.sub(bake.originMod), SUN_CASCADE_SIZE)
      const across = local.add(0.5).sub(HALF).mul(bake.texel)
      const column = bake.center
        .add(bake.right.mul(across.x))
        .add(bake.up.mul(across.y))
      const origin = column.add(bake.toward.mul(bake.near))
      const direction = bake.toward.negate()
      const top = shellCrossingFrom(
        body,
        origin,
        direction,
        body.boundariesHigh.y,
      )
      const base = shellCrossingFrom(body, origin, direction, body.boundaries.x)
      const ground = shellCrossingFrom(body, origin, direction, float(0))
      const start = max(top.near, 0)
      const under = select(
        base.hit.and(base.near.greaterThan(start)),
        base.near,
        top.far,
      )
      const end = select(
        ground.hit.and(ground.near.greaterThan(start)),
        min(under, ground.near),
        under,
      )
      const step = end.sub(start).div(SUN_CASCADE_STEPS)
      const front = float(1e30).toVar()
      const back = float(-1e30).toVar()
      const tau = float(0).toVar()
      If(top.hit.and(end.greaterThan(start)), () => {
        Loop(SUN_CASCADE_STEPS, ({ i }) => {
          const s = start.add(float(i).add(0.5).mul(step))
          const point = origin.add(direction.mul(s))
          const medium = this.#field(
            {
              offset: point,
              distance: length(point),
              altitude: altitudeAt(body, point),
              sunMu: sunMuAt(body, point),
              footprint: bake.texel,
            },
            body,
          )
          // The column's mean extinction: a texel holds one optical depth
          // and no clear share, and at the cascades' texels the field's
          // fraction is 1 at the inner two and within 5% of it at the
          // outer's 400 m in every scenario (two-decks' altocumulus, 4.2%).
          const extinction = medium.sigma.mul(medium.fraction)
          If(extinction.greaterThan(0), () => {
            front.assign(min(front, s.sub(step.mul(0.5))))
            back.assign(max(back, s.add(step.mul(0.5))))
            tau.addAssign(extinction.mul(step))
          })
        })
      })
      const cloudy = tau.greaterThan(0)
      const frontKm = select(cloudy, front.mul(KILOMETERS), float(NO_FRONT))
      // `@types/three` types the unpacked pair as the packed word.
      const pair = unpackHalf2x16(
        packHalf2x16(vec2(frontKm, 0)),
      ) as unknown as Node<'vec2'>
      const rounded = pair.x
      const mean = select(
        cloudy,
        tau.div(max(back.sub(front).mul(KILOMETERS), 1e-6)),
        float(0),
      )
      return vec4(rounded, mean, tau, frontKm.sub(rounded))
    })()
  }

  /* ----------------------------------------------------------------------- */
  /* The schedule                                                             */
  /* ----------------------------------------------------------------------- */

  render(
    renderer: WebGPURenderer,
    frame: CloudFrame,
    budget: CloudBudget,
  ): void {
    if (this.#disposed) return
    if (frame.levers.sunDepth !== 'cascades') {
      this.#release()
      return
    }
    this.#allocate()
    const { served } = frame
    const update = served.cascades
    const now = this.#renders
    this.#renders += 1
    // A first frame, a cut and a new picture leave nothing worth reading:
    // each cascade reads as clear until it is drawn. A turned sun or a jump
    // leaves it stale but still read as it stands until its turn comes.
    if (
      this.#last === null ||
      frame.frameIndex !== this.#last + 1 ||
      frame.scenario !== this.#scenario ||
      served.address !== this.#address ||
      frame.reset === 'first' ||
      frame.reset === 'key' ||
      frame.reset === 'cut'
    ) {
      this.#drawn.fill(null)
      this.#stale.fill(true)
      this.#staleSince.fill(now)
    }
    this.#scenario = frame.scenario
    this.#address = served.address
    update.stale.forEach((stale, c) => {
      if (stale || budget.jump) this.#stales(c, now)
    })
    const draws: Draw[] = []
    let left = budget.sunTexelSteps
    // The strips a scroll exposed, the frame they appear.
    update.cascades.forEach((cascade, c) => {
      const drawn = this.#drawn[c] ?? null
      if (this.#stale[c] || drawn === null || !sameFrame(drawn, cascade)) {
        this.#stales(c, now)
        return
      }
      const rects = update.dirty[c] ?? []
      const cost = rects.reduce((sum, rect) => sum + steps(rect), 0)
      if (cost > left) {
        this.#stales(c, now)
        return
      }
      for (const rect of rects) draws.push({ cascade: c, rect })
      drawn.origin = cascade.origin
      left -= cost
    })
    /*
     * One stale cascade whole: the longest stale, the inner of those that
     * went stale together. A warp of a thousand turns Earth's sun 0.07° a
     * frame, past the 0.05° that re-orients, and a scrub jumps every frame,
     * so all three are stale again each frame, and the inner one first every
     * time is the inner one alone forever, the outer two read at the sun
     * they were last drawn under.
     */
    let rebuilt = -1
    this.#stale.forEach((stale, c) => {
      if (!stale || update.cascades[c] === undefined) return
      if (rebuilt < 0 || this.#staleSince[c]! < this.#staleSince[rebuilt]!)
        rebuilt = c
    })
    this.#rebuilt = null
    if (rebuilt >= 0 && steps(WHOLE) <= left) {
      this.#drawn[rebuilt] = drawnFrom(update.cascades[rebuilt]!, served.eye)
      this.#stale[rebuilt] = false
      this.#rebuilt = rebuilt
      draws.push({ cascade: rebuilt, rect: null })
      left -= steps(WHOLE)
    }
    // One slice of the time refresh, of a cascade that holds this frame's.
    for (let tried = 0; tried < CASCADES * SUN_CASCADE_SLICES; tried += 1) {
      const slot = this.#refresh
      this.#refresh = (slot + 1) % (CASCADES * SUN_CASCADE_SLICES)
      const c = Math.floor(slot / SUN_CASCADE_SLICES)
      if (this.#stale[c] || this.#drawn[c] === null || c === rebuilt) continue
      const rect = {
        x: 0,
        y: (slot % SUN_CASCADE_SLICES) * ROWS,
        width: SUN_CASCADE_SIZE,
        height: ROWS,
      }
      if (steps(rect) <= left) {
        draws.push({ cascade: c, rect })
        left -= steps(rect)
      }
      break
    }
    this.#draw(renderer, draws, served.eye)
    this.#spent = budget.sunTexelSteps - left
    this.#read.forEach((target, c) =>
      writeCascade(target, this.#drawn[c] ?? null, served.eye),
    )
    this.#last = frame.frameIndex
  }

  /** Cascade `c` is stale from render `now`, unless it already is from an earlier one. */
  #stales(c: number, now: number): void {
    if (this.#stale[c] === true) return
    this.#stale[c] = true
    this.#staleSince[c] = now
  }

  #draw(renderer: WebGPURenderer, draws: readonly Draw[], eye: Vec3): void {
    if (draws.length === 0) return
    const target = this.#target
    try {
      runQuadPasses(
        renderer,
        this.#quad,
        // A strip replaces only what it covers, and a load's clear ignores
        // the scissor: nothing is cleared. The renderer's scissor test as
        // well as the target's, or every strip draws the whole layer.
        { linear: true, autoClear: false, scissor: true },
        (draw) => {
          for (const { cascade, rect } of draws) {
            writeCascade(this.#bake, this.#drawn[cascade] ?? null, eye)
            const { x, y, width, height } = rect ?? WHOLE
            target.scissor.set(x, y, width, height)
            target.scissorTest = true
            draw(CLOUD_SUN_CASCADE_LABEL, target, this.#material, cascade)
          }
        },
      )
    } finally {
      target.scissorTest = false
      target.scissor.set(0, 0, target.width, target.height)
    }
  }

  /* ----------------------------------------------------------------------- */
  /* The resource                                                             */
  /* ----------------------------------------------------------------------- */

  #allocate(): void {
    this.#allocated = true
    if (this.#target.width === SUN_CASCADE_SIZE) return
    this.#target.setSize(SUN_CASCADE_SIZE, SUN_CASCADE_SIZE, CASCADES)
    this.#forget()
  }

  /** Back to the 1 × 1 layers warming built against, holding nothing. */
  #release(): void {
    if (this.#target.width !== 1) this.#target.setSize(1, 1, CASCADES)
    this.#forget()
  }

  #forget(): void {
    this.#drawn.fill(null)
    this.#stale.fill(true)
    for (const target of this.#read) target.valid.value = 0
    this.#last = null
    this.#spent = 0
    this.#rebuilt = null
  }

  /** A cascade not yet drawn since it went stale. */
  get pending(): boolean {
    return this.#allocated && this.#target.width !== 1
      ? this.#stale.some(Boolean)
      : false
  }

  /** Texel-steps the last frame spent: never over the cap it was given. */
  get spent(): number {
    return this.#spent
  }

  /** The cascade the last frame drew whole, if it drew one. */
  get rebuilt(): number | null {
    return this.#rebuilt
  }

  get bytes(): number {
    if (this.#disposed || !this.#allocated) return 0
    const { width, height } = this.#target
    return textureBytes(width, height, CASCADES, TEXEL_BYTES)
  }

  textures(): readonly Texture[] {
    return this.#disposed || !this.#allocated ? [] : [this.#target.texture]
  }

  /** The bake against a layer; a renderer with no backend builds nothing. */
  warm(renderer: WebGPURenderer): Promise<void> {
    if (this.#disposed || renderer?.backend === undefined)
      return Promise.resolve()
    this.#allocated = true
    this.#warm ??= warmSensorPass(renderer, this.#quad, [
      { target: this.#target, material: this.#material },
    ])
    return this.#warm
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#target.dispose()
    this.#material.dispose()
  }
}
