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
  screenUV,
  select,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import { ATMOSPHERE_GAIN } from '@inertialref/rendering'
import { screenTexel } from './cloudGeometry.ts'
import { cloudStorageTexture } from './cloudNodes.ts'
import type { CloudFrontHandle } from './cloudSystem.ts'
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

/** The two numbers of the cloud uniforms `cloudFront` reads beside the trace. */
export interface CloudFrontInputs {
  readonly trace: Pick<CloudUniforms['trace'], 'size'>
  readonly served: Pick<CloudUniforms['served'], 'dayColor'>
}

/** What the clouds put in front of a point: what an object drawn there is seen through. */
export interface CloudFrontSeen {
  readonly transmittance: Node<'float'>
  readonly light: Node<'vec3'>
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
  uniforms: CloudFrontInputs,
  screen: Node<'vec2'>,
  distance: Node<'float'>,
): CloudFrontSeen {
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
    /*
     * The previous knot's (T, L) is read once a step: a padding knot mixes
     * by 0, which returns it exactly, since the trace writes every knot
     * finite. A select between the mix and the previous value would read it
     * twice, and TSL inlines an expression wherever it is read, so four
     * knots would unroll sixteen-fold into every program that reads them,
     * 16 to 37 KB of fragment WGSL a material. A `toVar` a step keeps the
     * size and draws nothing on the Metal adapter the suite runs on.
     */
    const factor = select(recorded, share, float(0))
    transmittance = mix(transmittance, knot.w, factor)
    light = mix(light, knot.xyz, factor)
  }
  return {
    transmittance: transmittance.add(nodeObject(follower)),
    light: light.mul(uniforms.served.dayColor).mul(ATMOSPHERE_GAIN),
  }
}

/*
 * The handle's side: what a material drawn over the clouds reads them
 * through, built once and fed for the page's life by whatever system draws
 * the frame.
 *
 * **A frame with no trace reads clear.** The handle answers null before the
 * first cloud frame, after `failed`, and on a frame the clouds do not draw.
 * The texture nodes still need a texture to compile against and to bind, so
 * they wait on a stand-in of the trace's own kind (a value swap does not
 * rebuild the program, `.claude/rules/rendering.md`), and a uniform the
 * follower writes beside the swap selects T = 1 and no light. The stand-in's
 * contents are never read for an answer: the extent `cloudFront` addresses it
 * with is the last trace's, and a load past a texture's edge returns zero or
 * any texel in it, either of which would read as a recorded knot.
 *
 * Two stand-ins a call, never one shared by two nodes: a texture node's
 * binding is keyed by its texture, and two nodes over one object in one
 * program compile to one binding.
 */

/**
 * What the clouds put in front of a fragment `distance` true meters along its
 * own pixel's ray, read through the engine's front handle: this frame's knots
 * at the fragment's screen point, or clear air on a frame with no trace.
 *
 * `distance` is true meters because the knots are: a compressed object
 * divides its view distance by its own placement's compression.
 */
export function cloudFrontThrough(
  handle: CloudFrontHandle,
  distance: Node<'float'>,
): CloudFrontSeen {
  const standIn: CloudTraceTextures = {
    light: cloudStorageTexture(1, 1, 'rgba16float', 'front stand-in light'),
    aux: cloudStorageTexture(2, 1, 'rgba16float', 'front stand-in aux'),
    knotDepth: cloudStorageTexture(2, 1, 'rgba16float', 'front stand-in depth'),
    knotLight: cloudStorageTexture(2, 2, 'rgba16float', 'front stand-in knots'),
    extent: { width: 1, height: 1 },
  }
  const live = uniform(0)
  const trace = (): CloudTraceTextures => {
    const now = handle.textures()
    live.value = now === null ? 0 : 1
    return now ?? standIn
  }
  // The fragment's image point, y up, as the trace addresses its texels.
  const screen = vec2(screenUV.x.mul(2).sub(1), float(1).sub(screenUV.y.mul(2)))
  const seen = cloudFront(
    trace,
    {
      trace: { size: handle.screen.traceSize },
      served: { dayColor: handle.screen.dayColor },
    },
    screen,
    distance,
  )
  const drawn = live.greaterThan(0.5)
  return {
    transmittance: select(drawn, seen.transmittance, float(1)),
    light: select(drawn, seen.light, vec3(0)),
  }
}
