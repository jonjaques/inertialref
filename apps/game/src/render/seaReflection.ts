import {
  DepthTexture,
  FloatType,
  FramebufferTexture,
  NearestFilter,
  type Node,
  type NodeBuilder,
  type NodeFrame,
  type Renderer,
  type RenderTarget,
  ViewportTextureNode,
} from 'three/webgpu'
import {
  Break,
  cameraFar,
  cameraNear,
  cameraProjectionMatrix,
  dot,
  float,
  Fn,
  getScreenPosition,
  If,
  Loop,
  max,
  min,
  mix,
  nodeObject,
  oneMinus,
  perspectiveDepthToViewZ,
  select,
  smoothstep,
  texture,
  vec4,
} from 'three/tsl'
import { asVector, type Vector } from './noiseNodes.ts'

/*
 * The land, mirrored in the sea.
 *
 * The sheet reflects the sky and the sun by Fresnel's law; what it cannot get
 * that way is a cliff standing over the water, because the cliff is not in
 * any sky. This is the search that finds it: from each pixel of sea, the
 * reflected ray is marched across the screen over the depth the opaque pass
 * left, and where the ray passes behind the drawn surface the frame's color
 * there is what the water mirrors. A ray that leaves the frame, runs out of
 * reach, or passes behind something thinner than it could have hit is a miss,
 * and a miss is the sky reflection the material already draws — the hit is
 * weighted in, never switched, so the two meet without a seam.
 *
 * **The frame and the depth are copied once, in one split.** The sheet is
 * transparent, so it draws after every opaque draw; three ends the scene pass
 * to copy the frame behind it and begins the pass again. A second copy through
 * the same path would end and begin it a second time, and on a tiled GPU every
 * split stores and reloads all four samples of every attachment — so the
 * depth copy rides in the split the color copy already makes. `SeaFrameNode`
 * is that one node; everything else here only reads what it copied.
 *
 * **Precision.** Everything is in view space, where a position is meters
 * from the eye: no planetary radius is in any of it, and nothing takes a
 * screen-space derivative. The depth buffer is reversed float32 under WebGPU,
 * which `perspectiveDepthToViewZ` decodes for the camera's own planes. The
 * WebGL fallback writes a logarithmic depth and draws the sea without the
 * search, which `landReflection` decides when it is built.
 *
 * **Exposure.** The frame holds radiance pre-exposed by `sceneRadianceGain`;
 * the caller divides that back out exactly as the refraction does, so the
 * mirrored land arrives at the brightness the land itself was drawn at and
 * the meter downstream sees the sea it would have seen with the sky in it.
 */

/**
 * Screen-space steps along the reflected ray before the crossing is refined.
 *
 * Uniform in screen space, so a long ray spends its samples where they land
 * on screen rather than near its start, and at the same fractions for every
 * pixel, so neighboring rays read neighboring texels of the depth. A jitter
 * per pixel turns a missed rock into a dither rather than a band, and costs
 * a cache miss a step: at 3840×2400, twenty jittered steps cost three and a
 * half times what these twelve do.
 */
const STEPS = 12

/** Bisection steps between the last sample in front and the first behind. */
const REFINE = 4

/**
 * How far the reflected ray may travel, meters. The screen clips it long
 * before this from a standing stance; the figure only has to put the end past
 * anything a lake's far shore can hold.
 */
const REACH = 20_000

/**
 * How far behind a surface the ray may be and still count as hitting it, as
 * a fraction of that surface's distance with a floor in meters. The ground is
 * solid below its surface, so a generous figure costs nothing on terrain; it
 * exists for the hull and the rocks, which a ray can pass behind.
 */
const THICKNESS_FRACTION = 0.08
const THICKNESS_FLOOR = 1.5

/**
 * The band at the frame's edge over which a hit fades to the sky, in screen
 * fractions. What lies past the edge is not in the copy, so a ray that would
 * have found it reads the last column instead: a smear, unless the reflection
 * has already handed over to the sky by the time it gets there.
 */
const EDGE = 0.08

/**
 * The frame behind the sea, read once and shared by the refraction and the
 * reflection, and — when the sea mirrors the land — the depth that frame was
 * drawn with, copied in the same split.
 *
 * A `ViewportTextureNode` rather than three's shared one: the copy is this
 * node's own `updateBefore`, so it decides what else rides along, and the
 * shared node's module-level framebuffer is a texture any other reader of
 * `viewportSharedTexture` would bind as well. A sample of this node at
 * another position — `sample(uv)`, which the reflection takes at its hit — is
 * a clone carrying `referenceNode`, and a clone copies nothing: three runs
 * each node's `updateBefore` once per render, so every clone that copied
 * would be another split.
 */
export class SeaFrameNode extends ViewportTextureNode {
  static get type(): string {
    return 'SeaFrameNode'
  }

  /** The depth copy, or null for a sea that only refracts. */
  readonly depthTexture: DepthTexture | null
  #samples = -1

  constructor(
    uv: Node,
    depth: DepthTexture | null,
    color?: FramebufferTexture,
  ) {
    super(uv, null, color ?? new FramebufferTexture(1, 1))
    this.depthTexture = depth
  }

  override clone(): this {
    const copy = new SeaFrameNode(
      this.uvNode as Node,
      this.depthTexture,
      this.value as FramebufferTexture,
    )
    return copy as this
  }

  /*
   * The depth copy takes its sample count from the target it is tied to.
   * Three reads a depth texture's samples from `texture.renderTarget`, and a
   * texture with none from whatever target is bound when it asks — which is
   * the scene pass's shape while the graph is set up, inside the warm-up's
   * synchronous half, and the canvas by the time `compileAsync` builds the
   * binding layout after its yield. Warmed that way, the layout said
   * single-sampled, the first frame said four, and the frame built the
   * pipeline the warm-up had paid for. Tied here, both read the same target.
   */
  override setup(builder: NodeBuilder): Node | null | undefined {
    this.#tie(builder.renderer.getRenderTarget())
    return super.setup(builder)
  }

  #tie(target: RenderTarget | null): void {
    const depth = this.depthTexture
    if (depth === null || target === null || target.depthTexture === null)
      return
    depth.renderTarget = target
  }

  override updateBefore(frame: NodeFrame): boolean | undefined {
    if (this.referenceNode !== null) return undefined
    const copyColor = (): void => {
      ;(ViewportTextureNode.prototype as unknown as Copier).updateBefore.call(
        this,
        frame,
      )
    }
    const renderer = frame.renderer as Renderer | null
    const depth = this.depthTexture
    if (renderer === null || depth === null) {
      copyColor()
      return undefined
    }
    const target = renderer.getRenderTarget()
    const source = target?.depthTexture ?? null
    const backend = renderer.backend as unknown as Backend
    if (
      target === null ||
      source === null ||
      backend.isWebGPUBackend !== true
    ) {
      copyColor()
      return undefined
    }
    /*
     * The copy is the whole attachment, so it is the attachment's size,
     * format and sample count: a multisampled texture copies only whole and
     * only to one with as many samples.
     */
    this.#tie(target)
    const samples = target.samples
    if (
      depth.image.width !== source.image.width ||
      depth.image.height !== source.image.height ||
      depth.type !== source.type ||
      samples !== this.#samples
    ) {
      depth.image.width = source.image.width
      depth.image.height = source.image.height
      depth.type = source.type
      depth.needsUpdate = true
      this.#samples = samples
    }
    renderer.initTexture(depth)
    const context = (renderer as unknown as RendererInternals)
      ._currentRenderContext
    const encoder =
      context === null ? undefined : (backend.get(context).encoder ?? undefined)
    const from = backend.get(source).texture
    const to = backend.get(depth).texture
    if (
      encoder === undefined ||
      from === undefined ||
      to === undefined ||
      from.format !== to.format ||
      from.sampleCount !== to.sampleCount
    ) {
      copyColor()
      return undefined
    }
    /*
     * The color copy ends the pass, copies, and begins the pass again from
     * the same encoder. The depth copy is encoded between the two by holding
     * the encoder's `beginRenderPass` for that one call — through three's own
     * path, so the pass timeline's hook on it still names the resumed pass.
     */
    const begin = encoder.beginRenderPass
    encoder.beginRenderPass = (descriptor) => {
      encoder.copyTextureToTexture({ texture: from }, { texture: to }, [
        from.width,
        from.height,
        1,
      ])
      return begin.call(encoder, descriptor)
    }
    try {
      copyColor()
    } finally {
      encoder.beginRenderPass = begin
    }
    return undefined
  }
}

/** The one method of `ViewportTextureNode` the override defers to. */
interface Copier {
  updateBefore(frame: NodeFrame): unknown
}

/*
 * Three's internals the single split reaches: the render context the scene
 * pass is encoding into, and the backend's record of it — its encoder — and
 * of a texture — its GPU object. `passTimeline.ts` reads the same records.
 */
interface RendererInternals {
  readonly _currentRenderContext: object | null
}
interface Backend {
  readonly isWebGPUBackend?: boolean
  get(object: object): {
    readonly texture?: GPUTexture
    readonly encoder?: GPUCommandEncoder | null
  }
}

/** A sea's frame read: the color behind it, and with `depth`, the depth too. */
export function seaFrame(uv: Node, depth: boolean): SeaFrameNode {
  const depthTexture = depth ? new DepthTexture(1, 1, FloatType) : null
  if (depthTexture !== null) {
    // A depth texture is read with `textureLoad` whatever its filter says,
    // and a multisampled one cannot be filtered at all; nearest says so.
    depthTexture.minFilter = NearestFilter
    depthTexture.magFilter = NearestFilter
  }
  return nodeObject(new SeaFrameNode(uv, depthTexture)) as SeaFrameNode
}

/** What the march is handed, all of it in view space. */
export interface ReflectionRay {
  /** The point on the sheet, meters from the eye. */
  readonly position: Vector
  /** The reflected direction, unit length. */
  readonly direction: Vector
  /** The sheet's own up, unit length: a ray below the water mirrors nothing. */
  readonly up: Vector
}

/**
 * The land the ray finds, as `rgb` the frame's radiance there and `a` how much
 * of the reflection it is — zero on a miss.
 *
 * `frame` must carry a depth copy. Built for the WebGL fallback it is a miss
 * everywhere at compile time: that backend's depth is logarithmic and the
 * copy path above is WebGPU's, and a sea that reflects the sky alone there is
 * the sea every other picture of it already draws.
 */
export function landReflection(
  frame: SeaFrameNode,
  ray: ReflectionRay,
): Node<'vec4'> {
  const depthTexture = frame.depthTexture
  if (depthTexture === null)
    throw new Error('landReflection needs a frame built with its depth')
  const depthNode = texture(depthTexture)
  return Fn((builder) => {
    const backend = builder.renderer.backend as { isWebGPUBackend?: boolean }
    if (backend.isWebGPUBackend !== true) return vec4(0)
    const start = ray.position
    const direction = ray.direction
    const end = asVector(start.add(direction.mul(REACH))).toVar()
    // A ray toward the eye is stopped short of the near plane, where its
    // projection would turn over.
    If(end.z.greaterThan(cameraNear.mul(-2)), () => {
      const t = cameraNear.mul(-2).sub(start.z).div(direction.z)
      end.assign(start.add(direction.mul(t)))
    })
    const uv0 = getScreenPosition(start, cameraProjectionMatrix).toVar()
    const uv1 = getScreenPosition(end, cameraProjectionMatrix)
    const span = uv1.sub(uv0).toVar()
    /*
     * The fraction of the segment that is on screen. The distance to the
     * edge and the span it is divided by carry the same sign, so the floor
     * keeps the span's: a span of zero, or a rounding step under it, never
     * reaches that edge, and a positive floor under it divides the near
     * edge's negative distance into a reach of millions below zero, which
     * is a miss. An unrolled level eye over a flat sheet sends every
     * reflected ray straight down its own column, where the span across is
     * zero to rounding, of either sign.
     */
    const exit = (from: Node<'float'>, along: Node<'float'>) =>
      select(
        along.greaterThan(0),
        oneMinus(from).div(max(along, float(1e-7))),
        from.negate().div(min(along, float(-1e-7))),
      )
    const exitX = exit(uv0.x, span.x)
    const exitY = exit(uv0.y, span.y)
    const reach = min(float(1), min(exitX, exitY)).toVar()
    // 1/z is linear across the screen, so the ray's own depth at a screen
    // fraction is a reciprocal of a mix rather than a mix.
    const inverseStart = float(1).div(start.z).toVar()
    const inverseEnd = float(1).div(end.z).toVar()
    const rayZ = (t: Node<'float'>) =>
      float(1).div(mix(inverseStart, inverseEnd, t))
    const at = (t: Node<'float'>) => uv0.add(span.mul(t))
    const sceneZ = (uv: Node<'vec2'>) =>
      perspectiveDepthToViewZ(depthNode.sample(uv).x, cameraNear, cameraFar)

    const found = float(0).toVar()
    const front = float(0).toVar()
    const behind = float(0).toVar()
    Loop(STEPS, ({ i }) => {
      const t = float(i).add(0.5).div(STEPS).mul(reach).toVar()
      // A view z is negative, so the ray is behind the surface when its z is
      // the more negative of the two.
      If(rayZ(t).lessThan(sceneZ(at(t))), () => {
        behind.assign(t)
        found.assign(1)
        Break()
      })
      front.assign(t)
    })

    const result = vec4(0).toVar()
    If(found.greaterThan(0), () => {
      Loop(REFINE, () => {
        const middle = front.add(behind).mul(0.5).toVar()
        If(rayZ(middle).lessThan(sceneZ(at(middle))), () => {
          behind.assign(middle)
        }).Else(() => {
          front.assign(middle)
        })
      })
      const uv = at(behind).toVar()
      const surface = sceneZ(uv)
      const gap = surface.sub(rayZ(behind))
      const thickness = max(
        float(THICKNESS_FLOOR),
        surface.negate().mul(THICKNESS_FRACTION),
      )
      const solid = oneMinus(smoothstep(thickness, thickness.mul(2), gap))
      const edge = smoothstep(float(0), float(EDGE), uv.x)
        .mul(smoothstep(float(0), float(EDGE), oneMinus(uv.x)))
        .mul(smoothstep(float(0), float(EDGE), uv.y))
        .mul(smoothstep(float(0), float(EDGE), oneMinus(uv.y)))
      result.assign(vec4(frame.sample(uv).rgb, solid.mul(edge)))
    })
    // A ray that leaves the water downward, which a steep wave can send at a
    // grazing view, mirrors the seabed's backside and nothing above it.
    const upward = smoothstep(float(0), float(0.04), dot(direction, ray.up))
    return vec4(result.rgb, result.a.mul(upward))
  })() as Node<'vec4'>
}
