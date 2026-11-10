import { getLogger } from '@inertialref/shared'
import {
  type Camera,
  ExternalTexture,
  type MRTNode,
  type Node,
  type NodeFrame,
  NodeUpdateType,
  type Renderer,
  RenderTarget,
  type Scene,
  TempNode,
  type Texture,
} from 'three/webgpu'
import { vec4 } from 'three/tsl'
import { OVER_CLOUDS_LAYERS } from './cloudLayers.ts'
import type { CLOUD_OVERS } from './cloudLevers.ts'
import { namePass, passName } from './passTimeline.ts'

/*
 * What stands over the scene on a frame the clouds draw, in the sensor's
 * dependency sum after the scene's term and before the upscaler. It binds
 * nothing in the post program: its node is `vec4(0)`, there only for its
 * order, since three runs the graph's `updateBefore` nodes children first,
 * left to right. It takes one of three forms a frame.
 *
 * **`passes`: the second scene pass, pass B.** The OVER layer drawn into the
 * scene target with load ops, the composite its first opaque. The target and
 * the MRT object are the scene pass's own, so pass B is one render context
 * with pass A and every overlay draws with the pipeline its boot warm-up
 * built against the scene's layout. Load ops for color and depth come from
 * `autoClear` off: the overlays land on what pass A drew, and are
 * depth-tested against it. The scene carries no background — three clears for
 * a color one whatever `autoClear` says (`Background.js`), and draws a node
 * one as the first opaque without a depth test — so nothing of pass A is
 * drawn over.
 *
 * The camera tests layer 1 alone for the pass, and the lights must test every
 * layer: three keeps a light in a render's set only when its layers pass the
 * camera's, so a light on layer 0 alone would light pass A and leave pass B
 * dark, and every overlay would build a second, unlit pipeline on its first
 * pass-B frame.
 *
 * **`lean`: pass B, storing its samples once.** Three stores every sample of
 * every attachment at a pass's end and resolves each multisampled color
 * beside it. After pass B nothing reads a color sample, only the resolve, so
 * each multisampled color takes `storeOp: 'discard'` under its resolve
 * target; and where nothing the pass draws writes depth, the depth attachment
 * is read-only, which stores nothing and keeps what pass A wrote. No pixel
 * moves.
 *
 * **`chain`: no second scene pass.** On a frame with nothing marked over the
 * clouds the scene is drawn once, on every layer, and the composite alone is
 * drawn over the scene target's resolved rows, in place. Its fragment runs
 * once a pixel with one transmittance and one light, and the blend is linear
 * in what it lands on, so `resolve(dst·T + L) = resolve(dst)·T + L`: the
 * frame is pass B's to the rounding of a half float.
 */

const log = getLogger('game.clouds')

/** Pass B's name on the pass timeline. */
export const OVER_PASS_LABEL = 'scene over clouds'
/** The chain form's draw of the composite over the resolved rows, on the pass timeline. */
export const CHAIN_PASS_LABEL = 'cloud composite'

/** The composite's form on a frame: the `over` lever's values. */
export type CloudOverForm = (typeof CLOUD_OVERS)[number]

/**
 * The composite as the chain form draws it: alone, in a scene of its own.
 * Read at the draw and at the warm-up, never at construction, because the
 * composite builds its graph at its first use.
 */
export interface CloudOverSource {
  readonly over: Scene
}

/* ------------------------------------------------------------------------- */
/* Three's records the two edits reach                                        */
/* ------------------------------------------------------------------------- */

/*
 * The backend's record of a texture — its GPU object, and the format three
 * builds a pipeline's color target from — and its `beginRender`, inside which
 * three builds a pass's descriptor, makes its encoder and begins the pass, in
 * that one call (`WebGPUBackend.js:826-940`). `seaReflection.ts` and
 * `passTimeline.ts` read the same records.
 */
interface Backend {
  readonly device?: GPUDevice
  get(object: object): { readonly texture?: GPUTexture; format?: string }
  beginRender(context: RenderContext): void
}

interface RenderContext {
  readonly renderTarget: RenderTarget | null
}

const backendOf = (renderer: Renderer): Backend =>
  renderer.backend as unknown as Backend

/* ------------------------------------------------------------------------- */
/* Lean: pass B's store                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Pass B's descriptor as `lean` begins it: three's own, copied, with each
 * multisampled color discarded under its resolve target, and the depth
 * read-only when `depthReadOnly`. A copy, because the descriptor and its
 * attachments are three's cached objects: three writes their ops again at the
 * next `beginRender`, and resumes a pass from them after a framebuffer copy.
 */
export function leanDescriptor(
  descriptor: GPURenderPassDescriptor,
  depthReadOnly: boolean,
): GPURenderPassDescriptor {
  const depth = descriptor.depthStencilAttachment
  return {
    ...descriptor,
    colorAttachments: [...descriptor.colorAttachments].map((attachment) =>
      attachment === null || attachment.resolveTarget === undefined
        ? attachment
        : { ...attachment, storeOp: 'discard' },
    ),
    /*
     * Read-only is the depth aspect with no ops at all: WebGPU refuses a
     * load or a store beside the flag. An attachment that carries stencil ops
     * is left as it is, since the scene's depth has no stencil and nothing
     * here knows what a pass that had one would want of it.
     */
    ...(depth !== undefined &&
    depthReadOnly &&
    depth.stencilLoadOp === undefined &&
    depth.stencilStoreOp === undefined
      ? { depthStencilAttachment: { view: depth.view, depthReadOnly: true } }
      : {}),
  }
}

/**
 * What became of an edit: it began the pass; it began the pass and the pass
 * was then resumed, which loads what the edit may have dropped; or three
 * never began a pass where the hold stood.
 */
type Begun = 'edited' | 'resumed' | 'untouched'

/**
 * Run `render` with the first pass it begins on `target` begun through
 * `edit`.
 *
 * Three builds the descriptor, sets every op on it, makes the encoder and
 * begins the pass inside one `beginRender`, and exposes none of the three in
 * between: the ops are written after the timeline's hook has run, and the
 * encoder is a local. So the hold is two deep and each as short as it can
 * be: the backend's `beginRender` for this render, and inside the one call
 * that is `target`'s, the device's `createCommandEncoder`, whose encoder
 * begins its first pass through the edit. The cloud work pass B's composite
 * issues makes encoders of its own, in renders nested inside this one; they
 * come after pass B's `beginRender` has returned, with the device's own
 * method back in place.
 *
 * A second pass begun on that encoder is three resuming the first after a
 * framebuffer copy (`copyFramebufferToTexture`), from its own descriptor,
 * which loads every sample. It goes through untouched and is reported, since
 * an edit that dropped a sample has by then dropped what the resume loads.
 */
function beginThrough(
  renderer: Renderer,
  target: RenderTarget,
  edit: (descriptor: GPURenderPassDescriptor) => GPURenderPassDescriptor,
  render: () => void,
): Begun {
  const backend = backendOf(renderer)
  const device = backend.device
  if (device === undefined) {
    render()
    return 'untouched'
  }
  let begun: Begun = 'untouched'
  const own = Object.hasOwn(backend, 'beginRender')
  const beginRender = backend.beginRender
  const held = backend as { beginRender: Backend['beginRender'] }
  held.beginRender = (context) => {
    if (begun !== 'untouched' || context.renderTarget !== target) {
      beginRender.call(backend, context)
      return
    }
    const create = device.createCommandEncoder
    const ownCreate = Object.hasOwn(device, 'createCommandEncoder')
    device.createCommandEncoder = (descriptor) => {
      const encoder = create.call(device, descriptor)
      const begin = encoder.beginRenderPass
      // Left on the encoder, which lives for this one render.
      encoder.beginRenderPass = (pass) => {
        if (begun !== 'untouched') {
          begun = 'resumed'
          return begin.call(encoder, pass)
        }
        begun = 'edited'
        return begin.call(encoder, edit(pass))
      }
      return encoder
    }
    try {
      beginRender.call(backend, context)
    } finally {
      if (ownCreate) device.createCommandEncoder = create
      else
        delete (device as { createCommandEncoder?: unknown })
          .createCommandEncoder
    }
  }
  try {
    render()
  } finally {
    if (own) held.beginRender = beginRender
    else delete (backend as { beginRender?: unknown }).beginRender
  }
  return begun
}

/* ------------------------------------------------------------------------- */
/* Chain: the scene target's resolved rows                                    */
/* ------------------------------------------------------------------------- */

/** The rows the composite writes: it leaves `meterMask` as the scene drew it. */
const composited = (row: Texture): boolean => row.name !== 'meterMask'

function rowOf(source: Texture, width: number, height: number): Texture {
  const row = new ExternalTexture()
  row.name = source.name
  row.format = source.format
  row.type = source.type
  row.colorSpace = source.colorSpace
  row.generateMipmaps = false
  // What `RenderTarget` gives its own textures, and `setSize` then keeps.
  ;(row as unknown as { image: object }).image = { width, height, depth: 1 }
  // As a target's own attachment: three then takes a new source texture by
  // dropping its record of the row and making it again.
  row.isRenderTargetTexture = true
  return row
}

/**
 * The scene target's resolved rows as a target of their own: one sample, no
 * depth, each attachment an `ExternalTexture` over the GPU texture the scene
 * pass resolves that row into. It holds no memory. A draw into it lands on
 * the textures every reader of the scene already reads — the upscaler, the
 * meter, the defocus and motion stages, the clouds' own meters — so the
 * chain form asks nothing of any of them.
 *
 * Where the scene target has no samples its attachments are the rows
 * themselves, and the same target draws into them.
 */
class ResolvedRows {
  readonly target: RenderTarget
  readonly #source: RenderTarget
  readonly #sources: readonly Texture[]
  readonly #rows: readonly ExternalTexture[]

  constructor(source: RenderTarget) {
    this.#source = source
    this.#sources = source.textures.filter(composited)
    const { width, height } = source
    this.#rows = this.#sources.map(
      (texture) => rowOf(texture, width, height) as ExternalTexture,
    )
    this.target = new RenderTarget(width, height, {
      depthBuffer: false,
      count: this.#rows.length,
    })
    this.#rows.forEach((row, k) => {
      this.target.textures[k] = row
    })
    namePass(this.target, CHAIN_PASS_LABEL)
  }

  /**
   * Point every row at the texture the scene pass resolves into now. False
   * where one does not exist yet: the scene pass has drawn nothing.
   *
   * The scene target is made again at another size, and its GPU textures
   * with it. Three caches a target's attachment views by its size alone, so
   * the target is disposed on any change, which drops three's records of it
   * and of its rows, and the next draw takes the new textures.
   */
  follow(renderer: Renderer): boolean {
    const backend = backendOf(renderer)
    let moved = false
    for (let k = 0; k < this.#rows.length; k += 1) {
      const texture = backend.get(this.#sources[k]!).texture
      if (texture === undefined) return false
      const row = this.#rows[k]!
      if (row.sourceTexture === texture) continue
      row.sourceTexture = texture
      moved = true
    }
    if (!moved) return true
    const { width, height } = this.#source
    const resized = this.target.width !== width || this.target.height !== height
    // `setSize` disposes on a change of size, and only then.
    this.target.setSize(width, height)
    if (!resized) this.target.dispose()
    /*
     * Three takes a pipeline's color formats from its record of each
     * attachment (`WebGPUUtils.getTextureFormatGPU`), and for an external
     * texture it records the GPU object alone: the format is written on the
     * one path three itself draws into external textures by, WebXR's
     * (`setXRRenderTargetTextures`). Without it the composite's pipeline is
     * asked for with no format and the device refuses it. Written after the
     * dispose, which dropped the record this replaces.
     */
    for (const row of this.#rows)
      backend.get(row).format = (row.sourceTexture as GPUTexture).format
    return true
  }

  dispose(): void {
    this.target.dispose()
  }
}

/** A target of the resolved rows' shape, for the warm-up: the chain draw's pipeline is keyed on the shape. */
function standIn(source: RenderTarget): RenderTarget {
  const rows = source.textures.filter(composited)
  const target = new RenderTarget(4, 4, {
    depthBuffer: false,
    count: rows.length,
  })
  rows.forEach((row, k) => {
    const texture = target.textures[k]!
    texture.name = row.name
    texture.format = row.format
    texture.type = row.type
    texture.colorSpace = row.colorSpace
    texture.generateMipmaps = false
  })
  return target
}

/* ------------------------------------------------------------------------- */
/* The node                                                                   */
/* ------------------------------------------------------------------------- */

export class CloudOverPassNode extends TempNode<'vec4'> {
  static get type(): string {
    return 'CloudOverPassNode'
  }

  /**
   * The form this frame's composite takes, set with the scene pass's
   * layers: null on a frame the clouds do not draw.
   */
  form: CloudOverForm | null = null
  /**
   * Under `lean`: nothing pass B draws this frame writes depth. A pipeline
   * that writes depth is refused in a pass whose depth is read-only, and the
   * refusal takes the whole pass with it, so this is true only where the
   * frame's count of the marks says so.
   */
  depthReadOnly = false

  readonly #scene: Scene
  readonly #camera: Camera
  readonly #target: RenderTarget
  readonly #mrt: MRTNode
  readonly #composite: CloudOverSource | null
  #resolved: ResolvedRows | null = null
  #refused = false

  constructor(
    scene: Scene,
    camera: Camera,
    target: RenderTarget,
    mrt: MRTNode,
    composite: CloudOverSource | null = null,
  ) {
    super('vec4')
    this.#scene = scene
    this.#camera = camera
    this.#target = target
    this.#mrt = mrt
    this.#composite = composite
    this.updateBeforeType = NodeUpdateType.RENDER
  }

  /** vec4(0): in the sensor's dependency sum for its order, binding nothing in the post program. */
  override setup(): Node {
    return vec4(0)
  }

  /** The frame's form: pass B, pass B through the lean edit, or the composite over the resolved rows. */
  override updateBefore(frame: NodeFrame): undefined {
    const form = this.form
    if (form === null) return undefined
    const renderer = frame.renderer
    if (renderer === null) return undefined
    if (form === 'chain') this.#overResolved(renderer)
    else this.#passB(renderer, form === 'lean')
    return undefined
  }

  /**
   * The chain form's pipeline, against a target of the resolved rows' shape.
   * Pass B's is the composite's own to warm, against the scene's layout.
   */
  async warm(renderer: Renderer): Promise<void> {
    const composite = this.#composite
    if (composite === null) return
    const scene = composite.over
    const target = renderer.getRenderTarget()
    const face = renderer.getActiveCubeFace()
    const mip = renderer.getActiveMipmapLevel()
    const mrt = renderer.getMRT()
    const depth = renderer.depth
    const shape = standIn(this.#target)
    let compiled: Promise<unknown>
    try {
      renderer.setRenderTarget(shape)
      renderer.setMRT(this.#mrt)
      // r185 takes a compile's depth off the renderer, where a draw takes it
      // off its target (`warmup.ts`, `bindWarmTarget`): left on, the compile
      // builds a depth variant the depthless draw cannot use.
      renderer.depth = false
      // One renderable, so its setup runs in the call's synchronous half,
      // with this target bound.
      compiled = renderer.compileAsync(scene, this.#camera, scene)
    } finally {
      renderer.depth = depth
      renderer.setMRT(mrt)
      renderer.setRenderTarget(target, face, mip)
    }
    try {
      await compiled
    } catch {
      // A pipeline that will not build resurfaces at its first draw.
    } finally {
      shape.dispose()
    }
  }

  override dispose(): void {
    this.#resolved?.dispose()
    this.#resolved = null
    super.dispose()
  }

  /** Renders the OVER layer into the scene target with load ops, the target named `OVER_PASS_LABEL` meanwhile. */
  #passB(renderer: Renderer, lean: boolean): void {
    const camera = this.#camera
    const target = renderer.getRenderTarget()
    const face = renderer.getActiveCubeFace()
    const mip = renderer.getActiveMipmapLevel()
    const mrt = renderer.getMRT()
    const autoClear = renderer.autoClear
    const mask = camera.layers.mask
    // Pass B takes the target's name for its own render and hands back
    // whatever pass A is called: the sensor's 'scene', or a test's own.
    const named = passName(this.#target) ?? null
    namePass(this.#target, OVER_PASS_LABEL)
    const render = (): void => {
      renderer.render(this.#scene, camera)
    }
    try {
      camera.layers.mask = OVER_CLOUDS_LAYERS.mask
      renderer.setRenderTarget(this.#target)
      renderer.setMRT(this.#mrt)
      renderer.autoClear = false
      if (!lean || this.#refused) render()
      else {
        const readOnly = this.depthReadOnly
        const begun = beginThrough(
          renderer,
          this.#target,
          (descriptor) => leanDescriptor(descriptor, readOnly),
          render,
        )
        if (begun !== 'edited') this.#refuse(begun)
      }
    } finally {
      camera.layers.mask = mask
      renderer.autoClear = autoClear
      renderer.setMRT(mrt)
      renderer.setRenderTarget(target, face, mip)
      namePass(this.#target, named)
    }
  }

  /** The composite alone, blended over the scene target's resolved rows. */
  #overResolved(renderer: Renderer): void {
    const composite = this.#composite
    if (composite === null) return
    const rows = (this.#resolved ??= new ResolvedRows(this.#target))
    // Nothing to land on: the frame goes without its clouds, not without
    // its scene.
    if (!rows.follow(renderer)) return
    const target = renderer.getRenderTarget()
    const face = renderer.getActiveCubeFace()
    const mip = renderer.getActiveMipmapLevel()
    const mrt = renderer.getMRT()
    const autoClear = renderer.autoClear
    try {
      renderer.setRenderTarget(rows.target)
      renderer.setMRT(this.#mrt)
      renderer.autoClear = false
      renderer.render(composite.over, this.#camera)
    } finally {
      renderer.autoClear = autoClear
      renderer.setMRT(mrt)
      renderer.setRenderTarget(target, face, mip)
    }
  }

  /*
   * `lean` is off for this node from here, and says so once. A pass three
   * resumed after a framebuffer copy has loaded samples the edit discarded,
   * so the frame that found it is wrong where pass B drew after the copy,
   * and no later one is. A pass three began somewhere the hold does not
   * stand was never edited, and draws the pixels pass B draws.
   */
  #refuse(begun: Begun): void {
    if (this.#refused) return
    this.#refused = true
    log.warn('pass B’s store is not edited; it stores every sample', {
      cause:
        begun === 'resumed'
          ? 'something over the clouds read the framebuffer'
          : 'three began the pass outside the hold',
    })
  }
}
