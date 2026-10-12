import {
  BlendMode,
  CustomBlending,
  MaxEquation,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
  ZeroFactor,
  type Node,
} from 'three/webgpu'
import {
  mrt,
  nodeObject,
  output,
  positionView,
  property,
  vec4,
  velocity,
} from 'three/tsl'
import type {
  AttachmentBlend,
  SceneAttachmentName,
  SceneLayout,
} from './sceneLayout.ts'

/**
 * One for a draw that is light without a surface — a flare quad, a warp
 * streak, anything that hangs in camera space over what is really there —
 * and zero for everything else.
 *
 * A shader `property` rather than a material field: WGSL zero-initializes a
 * variable nothing assigns, so a material that never heard of overlays is a
 * surface, and `sensorRadiance(material, true)` is the only writer. A
 * material-level `mrtNode` cannot do this job, because three drops every
 * output whose name the target lacks, and the flare still has to draw into a
 * plain single-attachment target.
 */
export const motionOverlay = property('float', 'MotionOverlay')
export const meterOverlay = property('float', 'MeterOverlay')
export const reactiveCoverage = property('float', 'ReactiveCoverage')

/*
 * What each row of the layout writes. The rows say which exist, how wide they
 * are and how they blend; this says what goes in them.
 */
const WRITES: Readonly<Record<SceneAttachmentName, () => Node>> = {
  output: () => output,
  // The whole vector, not just the alpha, goes to zero for an overlay: in
  // core mode the `over` blend keeps the surface underneath, and in
  // compatibility mode, where the material's own additive blend applies to
  // every attachment, a zero adds nothing.
  motion: () =>
    vec4(
      nodeObject(velocity) as unknown as Node<'vec2'>,
      positionView.z.negate().max(1e-4).reciprocal(),
      1,
    ).mul(motionOverlay.oneMinus()),
  meterMask: () => vec4(meterOverlay, 0, 0, 1),
  velocity: () => vec4(nodeObject(velocity) as unknown as Node<'vec2'>, 0, 1),
  reactive: () => vec4(reactiveCoverage, 0, 0, output.a),
}

/*
 * An attachment three has no blend mode for gets none, so a transparent
 * overlay would replace the surface's velocity and depth over its whole
 * footprint whatever its alpha — the flare's quads sit at twenty meters and
 * would tell the meter the sky behind the Sun is twenty meters away. Every
 * surface writes alpha 1 and still replaces; an overlay writes 0 and leaves
 * the attachment to what it covers. That is `over`.
 *
 * `union` is the reactive mask's: opaque geometry replaces the background's
 * mask, and translucent coverage combines as a union. `max` would retain an
 * occluded sky overlay and reject history on every foreground pixel
 * indefinitely.
 */
function blendMode(blend: Exclude<AttachmentBlend, 'material'>): BlendMode {
  const mode = new BlendMode(CustomBlending)
  if (blend === 'over') {
    mode.blendSrc = SrcAlphaFactor
    mode.blendDst = OneMinusSrcAlphaFactor
    mode.blendSrcAlpha = ZeroFactor
    mode.blendDstAlpha = OneFactor
  } else if (blend === 'max') {
    mode.blendEquation = MaxEquation
    mode.blendSrc = OneFactor
    mode.blendDst = OneFactor
  } else {
    mode.blendSrc = OneFactor
    mode.blendDst = OneMinusSrcAlphaFactor
  }
  return mode
}

/** The scene pass's outputs, one per row of `layout`, with the rows' blends. */
export function sensorMrt(layout: SceneLayout) {
  const node = mrt(
    Object.fromEntries(
      layout.attachments.map((row) => [row.name, WRITES[row.name]()]),
    ),
  )
  for (const row of layout.attachments) {
    if (row.blend !== 'material')
      node.setBlendMode(row.name, blendMode(row.blend))
  }
  return node
}
