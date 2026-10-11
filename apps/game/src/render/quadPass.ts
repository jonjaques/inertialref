import {
  ColorManagement,
  type Material,
  NoToneMapping,
  type QuadMesh,
  type RenderTarget,
  type Renderer,
} from 'three/webgpu'
import { namePass } from './passTimeline.ts'

/*
 * The one place a full-screen quad is drawn into an offscreen target.
 *
 * The optical stages and the galaxy each draw a chain of quads between the
 * frame's own passes, and every one of them has to hand the renderer back as
 * it found it — the target above all. A quad that leaves its target bound is
 * the defect ADR-0029 records: the next pass draws into the optics' scratch
 * texture, and the picture comes out one transfer too dark. Seven modules
 * saved and restored by hand, each a different subset of the state, so the
 * restore lives here, in `finally`, and covers everything any of them sets.
 *
 * And every pass is named as it draws. The timeline labels a target nobody
 * named by its texture and size, so two passes of one size merged into one
 * row; a label given at the draw is a label no stage can forget.
 */

/** What a group of passes sets on the renderer besides the target. */
export interface QuadPassState {
  /**
   * Data, not a picture: no MRT, no tone mapping, the working color space.
   * The galaxy's passes write radiance a later pass reads back.
   */
  readonly linear?: boolean
  /** Clear each target first, or keep what is there; absent leaves the renderer's choice. */
  readonly autoClear?: boolean
  /**
   * The renderer's scissor test on. Three reads the rectangle from the target
   * and the enable flag from the renderer, so a pass that set the first needs
   * this for the second.
   */
  readonly scissor?: boolean
}

/**
 * Draw `material` over the whole of `target` — `face` of a cube target —
 * under `label` on the timeline. A label is an aggregation key, so it is a
 * constant, never a string built per frame.
 */
export type QuadDraw = (
  label: string,
  target: RenderTarget,
  material: Material,
  face?: number,
) => void

/**
 * Run `passes` with `quad`, under `state`, and put the renderer back: the
 * target with its cube face and mip level, the MRT, the tone mapping, the
 * color space, the clear and the scissor test, however `passes` ends.
 */
export function runQuadPasses(
  renderer: Renderer,
  quad: QuadMesh,
  state: QuadPassState,
  passes: (draw: QuadDraw) => void,
): void {
  const target = renderer.getRenderTarget()
  const face = renderer.getActiveCubeFace()
  const mip = renderer.getActiveMipmapLevel()
  const mrt = renderer.getMRT()
  const tone = renderer.toneMapping
  const color = renderer.outputColorSpace
  const autoClear = renderer.autoClear
  const scissor = renderer.getScissorTest()
  const draw: QuadDraw = (label, into, material, intoFace = 0) => {
    namePass(into, label)
    renderer.setRenderTarget(into, intoFace)
    quad.material = material
    quad.render(renderer)
  }
  try {
    if (state.linear === true) {
      renderer.setMRT(null)
      renderer.toneMapping = NoToneMapping
      renderer.outputColorSpace = ColorManagement.workingColorSpace
    }
    if (state.autoClear !== undefined) renderer.autoClear = state.autoClear
    if (state.scissor === true) renderer.setScissorTest(true)
    passes(draw)
  } finally {
    renderer.setRenderTarget(target, face, mip)
    renderer.setMRT(mrt)
    renderer.toneMapping = tone
    renderer.outputColorSpace = color
    renderer.autoClear = autoClear
    renderer.setScissorTest(scissor)
  }
}
