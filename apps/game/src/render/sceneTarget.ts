import { DepthTexture, HalfFloatType, RenderTarget } from 'three/webgpu'
import {
  attachmentFormat,
  attachmentType,
  type SceneLayout,
} from './sceneLayout.ts'

/*
 * Its own module because the sensor and the warm-up both reach it, and the
 * sensor imports the warm-up's `warmPipeline`: in `sensor.ts` the two would
 * import each other. This reads `sceneLayout.ts` and three and nothing of the
 * sensor's.
 */

/*
 * The stand-ins the warm-up compiles against, one per renderer and attachment
 * shape.
 *
 * Keyed on what a pipeline is keyed on — the sample count, the rows and the
 * depth type — rather than on the whole layout, whose picture also carries a
 * scale and a sharpness the pipeline never sees; and never disposed. There are
 * eight shapes at most and a stand-in is 4×4, so keeping every one a renderer
 * has used costs nothing — and a stand-in that is never disposed is one no
 * compile can lose mid-queue. Three keys a render context on the attachment
 * shape rather than the target, and `compileAsync` builds each queued pipeline
 * after a yield, reading the depth format from the texture that shared context
 * holds by then; a stand-in disposed under that queue has no format, and every
 * pipeline left in it is refused at the device with `depthStencil.format`
 * undefined. A picture change that changes the shape is a new stand-in, and
 * the old one stays whole for whatever is still building.
 *
 * Keyed on the renderer as well, and weakly, because a stand-in a renderer has
 * compiled against holds that renderer: three adds a `dispose` listener to the
 * target and its textures that closes over the renderer's texture manager, and
 * `Renderer.dispose` removes none of them. Held by the shape alone, each one
 * kept every renderer the canvas replaced — an HDR toggle, a move between an
 * EDR and an SDR display, StrictMode's second mount — reachable for the
 * session.
 */
const standIns = new WeakMap<object, Map<string, RenderTarget>>()

// A row by its name, its channels and its storage: the format comes from the
// last two, and a row whose storage someday follows the picture would
// otherwise share a stand-in of the wrong format, compiling pipelines the
// first frame then builds again.
const shapeKey = (layout: SceneLayout): string =>
  [
    layout.samples,
    layout.depthType ?? 'default',
    ...layout.attachments.map(
      (row) => `${row.name}:${row.channels}:${row.storage}`,
    ),
  ].join('|')

/**
 * A target of the scene pass's layout, for a compile.
 *
 * A stand-in rather than the live pass target because the warm-up starts from
 * the effect that sees the renderer, and the sensor mounts inside the canvas
 * tree the same tick — which of the two runs first is React's business. The
 * pipeline key holds only the sample count and the formats, so any target of
 * the layout compiles the pipeline the pass will use, and 4×4 is the cheapest
 * one that exists.
 */
export function warmTargetFor(
  renderer: object,
  layout: SceneLayout,
): RenderTarget {
  let held = standIns.get(renderer)
  if (held === undefined) {
    held = new Map()
    standIns.set(renderer, held)
  }
  const key = shapeKey(layout)
  let standIn = held.get(key)
  if (standIn === undefined) {
    standIn = sceneTarget(4, 4, layout)
    held.set(key, standIn)
  }
  return standIn
}

function sceneTarget(
  width: number,
  height: number,
  layout: SceneLayout,
): RenderTarget {
  const depthTexture = new DepthTexture(width, height, layout.depthType)
  depthTexture.isRenderTargetTexture = true
  const target = new RenderTarget(width, height, {
    type: HalfFloatType,
    samples: layout.samples,
    depthTexture,
    count: layout.attachments.length,
  })
  layout.attachments.forEach((row, i) => {
    const texture = target.textures[i]!
    texture.name = row.name
    texture.format = attachmentFormat(row)
    texture.type = attachmentType(row)
  })
  return target
}
