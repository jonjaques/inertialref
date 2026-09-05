import {
  BlendMode,
  CustomBlending,
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

/**
 * One for a draw that is light without a surface — a flare quad, a warp
 * streak, anything that hangs in camera space over what is really there —
 * and zero for everything else.
 *
 * A shader `property` rather than a material field: WGSL zero-initialises a
 * variable nothing assigns, so a material that never heard of overlays is a
 * surface, and `sensorRadiance(material, true)` is the only writer. A
 * material-level `mrtNode` cannot do this job, because three drops every
 * output whose name the target lacks, and the flare still has to draw into a
 * plain single-attachment target.
 */
export const motionOverlay = property('float', 'MotionOverlay')

/** Two half-float attachments: radiance and velocity.xy / reciprocal view meters. */
export function sensorMrt() {
  const node = mrt({
    output,
    // The whole vector, not just the alpha, goes to zero for an overlay: in
    // core mode the alpha blend below keeps the surface underneath, and in
    // compatibility mode, where the material's own additive blend applies to
    // every attachment, a zero adds nothing.
    motion: vec4(
      nodeObject(velocity) as unknown as Node<'vec2'>,
      positionView.z.negate().max(1e-4).reciprocal(),
      1,
    ).mul(motionOverlay.oneMinus()),
  })
  // An attachment three has no blend mode for gets none, so a transparent
  // overlay would replace the surface's velocity and depth over its whole
  // footprint whatever its alpha — the flare's quads sit at twenty metres and
  // would tell the meter the sky behind the Sun is twenty metres away. Every
  // surface writes alpha 1 and still replaces; an overlay writes 0 and leaves
  // the attachment to what it covers.
  const blend = new BlendMode(CustomBlending)
  blend.blendSrc = SrcAlphaFactor
  blend.blendDst = OneMinusSrcAlphaFactor
  blend.blendSrcAlpha = ZeroFactor
  blend.blendDstAlpha = OneFactor
  return node.setBlendMode('motion', blend)
}
