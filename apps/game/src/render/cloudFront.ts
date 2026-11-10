import {
  type Node,
  NodeUpdateType,
  TempNode,
  type Texture,
  type TextureNode,
} from 'three/webgpu'
import {
  float,
  int,
  ivec2,
  max,
  mix,
  nodeObject,
  saturate,
  select,
  texture,
  vec3,
} from 'three/tsl'
import { ATMOSPHERE_GAIN } from '@inertialref/rendering'
import { screenTexel } from './cloudGeometry.ts'
import type { CloudTraceTextures } from './cloudTrace.ts'
import type { CloudUniforms } from './cloudUniforms.ts'

/*
 * What a transparent object at `distance` along its own pixel's ray sees of
 * the clouds in front of it, from the trace's four knots: the transmittance
 * and the light of every layer nearer than it, linear inside a layer it
 * stands in (§5.12). The knots are this frame's — in the immediate regime
 * the last phase's, at the same extent — so they are read at the trace texel
 * nearest the object's pixel and never reprojected.
 *
 * Span-relative: the air in front of t₀ is the object's own material's, and
 * phase 0 leaves it out.
 */

/**
 * A node that puts texture nodes back on the textures their getters hand out
 * now, ahead of every draw it is part of, and is `child` in the program.
 *
 * A texture node's binding reads its value when the draw's bindings update,
 * which three does after a draw's `updateBefore` nodes have run: so anything
 * that swaps an output between frames — a history's parity, a target resized
 * by reallocating — is followed with no rebuild. `onRenderUpdate` on the
 * texture node itself cannot do this: `TextureNode.setup` resets its own
 * update type. Three runs `updateBefore` children first, so with the cloud
 * frame node as `child` this runs after the frame's cloud work, whose history
 * pass is what flips the parity.
 */
export class TextureFollower extends TempNode<'float'> {
  static get type(): string {
    return 'TextureFollower'
  }

  readonly #child: Node<'float'>
  readonly #follow: () => void

  constructor(child: Node<'float'>, follow: () => void) {
    super('float')
    this.#child = child
    this.#follow = follow
    this.updateBeforeType = NodeUpdateType.RENDER
  }

  override setup(): Node {
    return this.#child
  }

  override updateBefore(): undefined {
    this.#follow()
    return undefined
  }
}

/** Point `node` at `map`, if it is not there already. */
export function follow(node: TextureNode, map: Texture): void {
  if (node.value !== map) node.value = map
}

/*
 * A knot the trace did not record is padding with T = 1. A recorded one
 * closed a segment whose own transmittance was under 0.98, so its T is under
 * 0.98 of the one before it and under 1 on its own: half a percent of
 * headroom tells the two apart through a half float, whose step under 1 is
 * 2⁻¹¹.
 */
const RECORDED = 0.995
/** km: a knot of no length is a step at its depth, not a division by zero. */
const NO_LENGTH = 1e-9

/**
 * The trace's knots at the object's pixel, and what they put in front of a
 * point `distance` true meters along its ray: the transmittance, and the
 * light in the composite's units — per unit sun irradiance times the day's
 * color and π, before the scene's gain, which the object's own
 * `sensorRadiance` applies. `screen` is the object's image point, y up.
 *
 * An additive object multiplies its light by the transmittance; an
 * alpha-blended one replaces its color with transmittance·color + light and
 * keeps its alpha, which over a frame that already holds the cloud's light
 * lights the object under the cloud in front of it without darkening it.
 */
export function cloudFront(
  trace: () => CloudTraceTextures,
  uniforms: CloudUniforms,
  screen: Node<'vec2'>,
  distance: Node<'float'>,
): { readonly transmittance: Node<'float'>; readonly light: Node<'vec3'> } {
  const now = trace()
  const knotDepth = texture(now.knotDepth)
  const knotLight = texture(now.knotLight)
  const follower = new TextureFollower(float(0), () => {
    const { knotDepth: depths, knotLight: lights } = trace()
    follow(knotDepth, depths)
    follow(knotLight, lights)
  })
  const texel = screenTexel(screen, uniforms.trace.size)
  // Integer arithmetic throughout: a bare number is a float constant in TSL.
  const column = texel.x.mul(int(2))
  const row = texel.y.mul(int(2))
  const depthsNear = knotDepth.load(ivec2(column, texel.y))
  const depthsFar = knotDepth.load(ivec2(column.add(int(1)), texel.y))
  const entries = [depthsNear.x, depthsNear.z, depthsFar.x, depthsFar.z]
  const exits = [depthsNear.y, depthsNear.w, depthsFar.y, depthsFar.w]
  const at = distance.mul(1e-3)
  /*
   * One mix a knot covers all three places a point can be: before the
   * knot's entry the factor is 0 and the previous knot's (T, L) carries
   * across the clear gap; inside it is the share of the knot crossed, the
   * in-cloud attenuation of an object inside a layer; past its exit it is 1.
   * The knots are in depth order, so a point before one knot is before
   * every later one, and nothing after it moves the result.
   */
  let transmittance: Node<'float'> = float(1)
  let light: Node<'vec3'> = vec3(0)
  for (let k = 0; k < 4; k += 1) {
    const knot = knotLight.load(
      ivec2(column.add(int(k & 1)), row.add(int(k >> 1))),
    )
    const entry = entries[k]!
    const span = max(exits[k]!.sub(entry), NO_LENGTH)
    const share = saturate(at.sub(entry).div(span))
    const recorded = knot.w.lessThan(RECORDED)
    transmittance = select(
      recorded,
      mix(transmittance, knot.w, share),
      transmittance,
    )
    light = select(recorded, mix(light, knot.xyz, share), light)
  }
  return {
    transmittance: transmittance.add(nodeObject(follower)),
    light: light.mul(uniforms.served.dayColor).mul(ATMOSPHERE_GAIN),
  }
}
