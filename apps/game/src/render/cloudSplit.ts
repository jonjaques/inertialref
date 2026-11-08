import {
  FramebufferTexture,
  type Renderer,
  type RenderTarget,
  Vector2,
} from 'three/webgpu'
import { nameResume } from './passTimeline.ts'

/*
 * Placement B's split: end the scene pass, put what its encoder holds on the
 * queue, and resume on a fresh encoder, so the ordinary three renders and
 * computes issued in between execute after the first half and before the
 * resumed one (§4.2).
 *
 * Every three render and compute makes an encoder of its own and submits it
 * as it finishes, and the GPU runs submissions in order. The scene pass is
 * the exception that matters: its encoder goes on the queue only when the
 * whole pass finishes, so a pass issued from inside it — from a mesh's
 * `updateBefore` — is submitted first and runs ahead of every draw the scene
 * pass has made, reading the depth the previous frame left.
 *
 * The end and the resume are three's own framebuffer copy, the sea's path: it
 * ends the pass, copies, sets every load op to `load`, and begins the pass
 * again from the same descriptor with its viewport and scissor, and the pass
 * timeline names the resumed half on that path. The copy is one texel into a
 * probe of the split's own. What the split adds is a hold on the encoder's
 * `beginRenderPass` for that one call: submit what the encoder holds, make a
 * fresh one, write it into the context's record, and begin the resumed pass
 * on it. `finishRender` reads that record fresh before it submits
 * (`WebGPUBackend.js:1278`), so the resumed half goes on the queue after
 * whatever `during` submitted.
 */

/** The resumed half's name on the pass timeline, and pass B's under placement A. */
export const SPLIT_LABEL = 'scene over clouds'

/** The first texel, at the probe's own 1 × 1 size: a `Vector2` copies the texture's size. */
const ORIGIN = /*@__PURE__*/ new Vector2(0, 0)

/*
 * One probe per scene target. Three takes a framebuffer texture's format from
 * the target bound when the texture is first copied into, and refuses a copy
 * whose formats differ without ending the pass, so one probe shared by two
 * targets of two formats would decline every split of the second.
 */
const probes = new WeakMap<RenderTarget, FramebufferTexture>()

function probeFor(target: RenderTarget): FramebufferTexture {
  let probe = probes.get(target)
  if (probe === undefined) {
    probe = new FramebufferTexture(1, 1)
    probe.name = 'cloud split probe'
    // The copy hook would name the resumed half `scene after copy`, and
    // behind a sea sheet `scene after copy after copy`.
    nameResume(probe, SPLIT_LABEL)
    probes.set(target, probe)
  }
  return probe
}

/*
 * Three's internals the split reaches, as `seaReflection.ts` reaches them: the
 * render context the scene pass is encoding into, and the backend's record of
 * it. Its one write is `record.encoder`.
 */
interface RenderContextInternals {
  readonly renderTarget: RenderTarget | null
}
interface ContextRecord {
  encoder?: GPUCommandEncoder | null
  readonly currentPass?: GPURenderPassEncoder | null
}
interface BackendInternals {
  readonly isWebGPUBackend?: boolean
  readonly device: GPUDevice
  get(context: object): ContextRecord
}

/*
 * The render tree, which three puts back at the end of a render and not in a
 * `finally`: a nested render that throws leaves its context current, its call
 * depth and render id raised, its object handlers installed and its lights on
 * the lighting stack, and the render it was nested in then draws through all
 * of them into a pass that has ended.
 */
interface RenderTree {
  _currentRenderContext: RenderContextInternals | null
  _currentRenderObjectFunction: unknown
  _handleObjectFunction: unknown
  _callDepth: number
  readonly _nodes: { readonly nodeFrame: { renderId: number } } | null
  readonly lighting: { readonly _cache: unknown[] }
}

/**
 * The renderer as nested work finds it, and the function that puts it back:
 * the render tree, and the target, MRT, clear, tone mapping, color space and
 * scissor test a pass sets. What a throw inside that work leaves behind is
 * whatever it had changed by then, three's own bookkeeping included.
 */
export function keepRenderer(renderer: Renderer): () => void {
  const tree = renderer as unknown as RenderTree
  const context = tree._currentRenderContext
  const objectFunction = tree._currentRenderObjectFunction
  const handleObject = tree._handleObjectFunction
  const depth = tree._callDepth
  const nodeFrame = tree._nodes?.nodeFrame ?? null
  const renderId = nodeFrame?.renderId ?? 0
  const lights = tree.lighting._cache.length
  const target = renderer.getRenderTarget()
  const face = renderer.getActiveCubeFace()
  const mip = renderer.getActiveMipmapLevel()
  const mrt = renderer.getMRT()
  const autoClear = renderer.autoClear
  const toneMapping = renderer.toneMapping
  const colorSpace = renderer.outputColorSpace
  const scissor = renderer.getScissorTest()
  return () => {
    tree._currentRenderContext = context
    tree._currentRenderObjectFunction = objectFunction
    tree._handleObjectFunction = handleObject
    tree._callDepth = depth
    if (nodeFrame !== null) nodeFrame.renderId = renderId
    // Only pushes go unmatched, so the stack is never shorter than it was.
    const cache = tree.lighting._cache
    if (cache.length > lights) cache.length = lights
    renderer.setRenderTarget(target, face, mip)
    renderer.setMRT(mrt)
    renderer.autoClear = autoClear
    renderer.toneMapping = toneMapping
    renderer.outputColorSpace = colorSpace
    renderer.setScissorTest(scissor)
  }
}

/**
 * End the scene pass, put what its encoder holds on the queue, resume on a
 * fresh encoder; three renders and computes `during` issues execute between
 * the halves. False, and `during` not run, off WebGPU or outside an open
 * render pass into a target.
 *
 * A throw inside `during` comes back out of here with the renderer put back
 * as `during` found it, and the resumed pass still open for the scene pass to
 * finish.
 */
export function splitScenePass(
  renderer: Renderer,
  during: () => void,
): boolean {
  const backend = (renderer as { readonly backend?: unknown }).backend as
    BackendInternals | undefined
  if (backend?.isWebGPUBackend !== true) return false
  const context = (renderer as unknown as RenderTree)._currentRenderContext
  // The canvas is not a scene pass: its probe would take the canvas's format,
  // which no 1 × 1 texture three makes for a target shares.
  if (context === null || context.renderTarget === null) return false
  const record = backend.get(context)
  const encoder = record.encoder
  if (encoder === undefined || encoder === null || !record.currentPass)
    return false
  const device = backend.device
  let resumed = false
  const begin = encoder.beginRenderPass
  encoder.beginRenderPass = (descriptor) => {
    encoder.beginRenderPass = begin
    device.queue.submit([encoder.finish()])
    const next = device.createCommandEncoder({ label: SPLIT_LABEL })
    record.encoder = next
    resumed = true
    return next.beginRenderPass(descriptor)
  }
  try {
    renderer.copyFramebufferToTexture(probeFor(context.renderTarget), ORIGIN)
  } finally {
    encoder.beginRenderPass = begin
  }
  // A copy three refused — the probe's format against the target's — never
  // ended the pass, so nothing is split and `during` would run ahead of it.
  if (!resumed) return false
  const restore = keepRenderer(renderer)
  try {
    during()
  } catch (cause) {
    restore()
    throw cause
  }
  return true
}
