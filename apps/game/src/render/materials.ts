import {
  AdditiveBlending,
  BackSide,
  Color,
  InstancedBufferAttribute,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PointsNodeMaterial,
  Vector3,
} from 'three/webgpu'
import {
  abs,
  cameraPosition,
  cross,
  dot,
  exp,
  float,
  instancedBufferAttribute,
  length,
  max,
  mix,
  normalize,
  normalWorld,
  oneMinus,
  positionWorld,
  saturate,
  smoothstep,
  sqrt,
  step,
  uniform,
  uv,
  vec3,
} from 'three/tsl'

/*
 * Every material the scene draws, as node graphs.
 *
 * Built imperatively and handed to meshes through the `material` prop rather
 * than declared as JSX. R3F reconciles node materials perfectly well once they
 * are `extend()`ed, but the scene here is already mutated imperatively for the
 * reason `SceneView.tsx` gives at the top, and a material constructed in one
 * place is a material whose uniforms can be written from the frame loop without
 * a second lookup.
 *
 * The three materials that carry real TSL — star, atmosphere, star field — are
 * each a self-contained function returning its own uniforms and reaching into
 * nothing else. That shape is deliberate: `docs/design/technical.md` § The path
 * names terrain, atmosphere and the star field as the three places a
 * hand-written pipeline might eventually be worth it, and asks that they stay
 * expressible as standalone passes so that decision stays available.
 */

/** Scene-linear radiance of a star's disc, in multiples of diffuse white. */
const STAR_RADIANCE = 8

/**
 * Solar limb darkening, visual band. 0.6 is a G star, which is what the default
 * seed puts the player in front of.
 */
const LIMB_DARKENING = 0.6

export interface StarMaterial {
  readonly material: MeshBasicNodeMaterial
  readonly color: { value: Color }
}

/**
 * A star's disc: unlit, above white, limb-darkened.
 *
 * This is the material the HDR path exists for. `docs/design/art.md` makes the
 * star the scene's reference white — everything else sits below it — so its
 * radiance is authored well above 1 and the tone curve decides what a given
 * display can do with that. On the sRGB path the disc saturates, which is what
 * a star does; on the extended path it is the one thing in the frame brighter
 * than the HUD.
 *
 * Limb darkening rather than a flat disc because `I(mu)/I(1) = 1 − u(1 − mu)`
 * costs one dot product and is the difference between a light source and a hole
 * cut in the sky.
 */
export function createStarMaterial(): StarMaterial {
  const color = uniform(new Color(1, 1, 1))

  // `abs` because a sphere seen from inside — which happens for exactly one
  // frame if the origin rebases while a star fills the view — otherwise flips
  // `mu` negative and turns the disc black.
  const mu = abs(dot(normalize(normalWorld), normalize(cameraPosition.sub(positionWorld))))
  const limb = oneMinus(float(LIMB_DARKENING).mul(oneMinus(mu)))

  const material = new MeshBasicNodeMaterial()
  material.colorNode = color.mul(limb).mul(STAR_RADIANCE)
  return { material, color }
}

export interface AtmosphereMaterial {
  readonly material: MeshBasicNodeMaterial
  /** Body centre in render space. Written every frame — the planet is orbiting. */
  readonly centre: { value: Vector3 }
  /** Render-space radius of the shell, and of the ground beneath it. */
  readonly outerRadius: { value: number }
  readonly innerRadius: { value: number }
  /** Unit vector from the body towards its star, in render space. */
  readonly sunDirection: { value: Vector3 }
}

/**
 * The atmosphere, as the length of air a view ray actually crosses.
 *
 * The shell is a back-side sphere, so the fragment is always on its far wall and
 * the opaque planet has already depth-killed anything inside its silhouette.
 * What is left is the segment of the view ray that is inside the air, and that
 * is a ray–sphere intersection with the near end clamped to the camera:
 *
 *     near = max(t꜀ − √(Rₐ² − b²), 0)
 *     far  = the ground if the ray meets it in front, otherwise the far wall
 *
 * Clamping the near end is what makes one expression serve both cases. From
 * orbit the camera is outside and `near` is where the ray entered the air; from
 * the ground the camera is *inside* and `near` is zero, so the sky is the air
 * between the player and space rather than a whole chord they are standing in
 * the middle of. A symmetric chord — which is what this was first — reports a
 * ground observer's zenith as twice the air that is actually above them.
 *
 * Two square roots, no loop, and that is the point. Spike 2 measured a
 * 256-sample single-scattering raymarch at **7.27 ms on an M5** against a 3.0 ms
 * budget for atmosphere *and* post; a raymarch does not fit here even as the
 * only thing on screen.
 *
 * **A placeholder with a named replacement.** Uniform density is wrong — air is
 * exponential in altitude — and a path length is not scattering. The specified
 * answer is Bruneton's precomputed transmittance and multiple-scattering LUTs,
 * which spike 2 promoted from optimisation to requirement and which is M2 work.
 * What this buys meanwhile is a limb that thins towards space, a sky from the
 * ground and a terminator in the right place, all from geometry rather than
 * asserted by a constant.
 */
export function createAtmosphereMaterial(): AtmosphereMaterial {
  const centre = uniform(new Vector3())
  const outerRadius = uniform(1)
  const innerRadius = uniform(1)
  const sunDirection = uniform(new Vector3(0, 1, 0))

  const rayDirection = normalize(positionWorld.sub(cameraPosition))
  const toCentre = centre.sub(cameraPosition)

  // Closest approach along the ray, and the impact parameter squared. `|d × c|`
  // with d a unit vector gives the perpendicular distance directly and, unlike
  // solving the quadratic, cannot go imaginary on a grazing ray — which is every
  // ray that matters here.
  const closest = dot(toCentre, rayDirection)
  const impactSquared = max(length(cross(rayDirection, toCentre)).pow(2), 0)

  const halfOuter = sqrt(max(outerRadius.mul(outerRadius).sub(impactSquared), 0))
  const halfInner = sqrt(max(innerRadius.mul(innerRadius).sub(impactSquared), 0))

  // Clamped at 0 so a camera already inside the air starts counting from itself.
  const near = max(closest.sub(halfOuter), 0)
  // `step` rather than a branch: 1 when the ray passes inside the planet, and
  // then the air stops at the ground instead of continuing to the far wall.
  const meetsGround = step(impactSquared, innerRadius.mul(innerRadius))
  const far = mix(closest.add(halfOuter), max(closest.sub(halfInner), near), meetsGround)
  const airDepth = max(far.sub(near), 0)

  // Normalised against the deepest path the shell admits — grazing it at the
  // planet's edge — so a moon's wisp and a gas giant's envelope read the same,
  // and the render-space scale drops out. It has to: distance compression
  // rescales both radii together every time the LOD tier changes.
  const deepest = max(sqrt(max(outerRadius.mul(outerRadius).sub(innerRadius.mul(innerRadius)), 0)).mul(2), 1e-6)
  const optical = airDepth.div(deepest).mul(2.4)

  // Beer–Lambert, so the limb saturates smoothly rather than clipping to a hard
  // edge wherever the path runs long.
  const alpha = oneMinus(exp(optical.negate()))

  // Day/night from the middle of the air actually crossed, not from the fragment.
  // The fragment is on the far wall of the shell, a planet-diameter away from
  // the air being shaded, and using it puts the terminator on the wrong limb.
  // The midpoint degrades correctly at both ends: from orbit it is the graze
  // point, from the ground it is a few kilometres over the player's head.
  const sample = cameraPosition.add(rayDirection.mul(near.add(far).mul(0.5)))
  const sunlit = saturate(dot(normalize(sample.sub(centre)), normalize(sunDirection)))
  // A wide terminator rather than a step: air scatters around the edge, which is
  // the entire reason twilight exists.
  const daylight = smoothstep(-0.35, 0.25, sunlit.mul(2).sub(1))

  // Rayleigh blue towards the zenith, a warmer forward-scattered limb near the
  // terminator. Both are authored constants standing in for the LUT.
  const scattered = mix(vec3(0.86, 0.45, 0.26), vec3(0.28, 0.48, 0.95), daylight)

  const material = new MeshBasicNodeMaterial()
  material.colorNode = scattered.mul(mix(0.05, 1, daylight))
  material.opacityNode = alpha.mul(mix(0.18, 1, daylight))
  material.transparent = true
  material.depthWrite = false
  material.side = BackSide
  return { material, centre, outerRadius, innerRadius, sunDirection }
}

export interface StarfieldMaterial {
  readonly material: PointsNodeMaterial
  readonly positions: InstancedBufferAttribute
  /** Screen size of a star, in logical pixels. */
  readonly size: { value: number }
}

/**
 * The distant star field, as instanced sprites rather than points.
 *
 * Not a stylistic choice. **WebGPU renders point primitives at exactly one
 * pixel** and has no point-size facility at all, so `PointsNodeMaterial` on a
 * `Points` object silently ignores `sizeNode` under the WebGPU backend: the
 * field would have shrunk on the one backend this migration is for and stayed
 * correct on the WebGL fallback, which is the worst way for a rendering bug to
 * behave. three's documented answer is a `Sprite` fed by an instanced position
 * attribute, with `Sprite.count` driving the draw.
 *
 * @param capacity Instances to allocate. The buffer is written in place and only
 *   the draw count moves; reallocating per survey would rebuild the pipeline.
 */
export function createStarfieldMaterial(capacity: number): StarfieldMaterial {
  const positions = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
  const size = uniform(2.4)

  // Round, with a soft edge. A star is a point source seen through an aperture,
  // and the corners of the quad fade to nothing rather than being discarded —
  // the blend is cheaper than the branch at this instance count.
  const radius = length(uv().sub(0.5)).mul(2)
  const profile = oneMinus(smoothstep(0.15, 1, radius))

  const material = new PointsNodeMaterial()
  material.positionNode = instancedBufferAttribute(positions)
  material.sizeNode = size
  material.sizeAttenuation = false
  material.colorNode = vec3(0.81, 0.85, 1).mul(profile.mul(profile)).mul(1.6)
  material.opacityNode = profile
  material.transparent = true
  material.depthWrite = false
  // Overlapping stars in a dense field add rather than occlude, and the Milky
  // Way's band is that addition and nothing else.
  material.blending = AdditiveBlending
  return { material, positions, size }
}

/** A planet, moon or gas giant. No TSL: the standard model is what these want. */
export function createBodyMaterial(color: Color): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({ color, roughness: 0.95, metalness: 0 })
}

/**
 * Streamed terrain.
 *
 * One material for every patch on the body, because the streamer's altitude fade
 * applies to all of them together and a material per patch is a pipeline per
 * patch. The fade stays a plain `opacity` property rather than an `opacityNode`:
 * the cost is identical and it keeps the `transparent` toggle — which an opaque
 * material would otherwise ignore — next to the number it depends on.
 */
export function createTerrainMaterial(): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({ color: 0x9c8367, roughness: 1, flatShading: false })
}
