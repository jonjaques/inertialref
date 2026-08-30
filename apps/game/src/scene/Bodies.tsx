import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  type Group,
  Mesh,
  type Scene,
  SphereGeometry,
  Vector3,
} from 'three/webgpu'
import { getLogger } from '@inertialref/shared'
import type { RenderBody } from '@inertialref/rendering'
import { formatAddress, walkBodies } from '@inertialref/universe'
import type { GameEngine } from '../engine/GameEngine.ts'
import { trackAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import {
  type AtmosphereMaterial,
  createAtmosphereMaterial,
  createStarMaterial,
  type StarMaterial,
} from '../render/materials.ts'
import {
  type CloudMaterial,
  createCloudMaterial,
  createPlanetMaterial,
  createRingMaterial,
  type PlanetMaterial,
  type RingMaterial,
} from '../render/planet.ts'
import { scatteringFor } from '../render/atmosphereLuts.ts'
import { texturesFor } from '../render/planetTextures.ts'
import { proceduralRingStrip } from '../render/proceduralRings.ts'
import { shapeGeometryFor } from '../render/shapeModels.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/**
 * How many body visuals may be resident at once. See `evictStale`.
 *
 * 160 rather than 64 because the Solar System grew. This caps `visuals.size`,
 * which stars enter under a `star:` key alongside the bodies — so it was 29
 * (eight planets, twenty moons and the Sun) and it is 130 now that the dwarf
 * planets, the asteroids, the comets and the forty-two moons that are rocks or
 * go round one are in it. At 64 the arrivals past the cap silently stopped
 * rendering, which is the failure `evictStale` exists to make graceful and is
 * not one to leave a system permanently over.
 */
const MAX_BODIES = 160

const log = getLogger('game.bodies')

interface BodyVisual {
  readonly mesh: Mesh
  readonly planet: PlanetMaterial | null
  readonly atmosphere: Mesh
  readonly atmosphereMaterial: AtmosphereMaterial
  readonly clouds: Mesh | null
  readonly cloudMaterial: CloudMaterial | null
  readonly rings: Mesh | null
  readonly ringMaterial: RingMaterial | null
  readonly star: StarMaterial | null
}

/**
 * Take a body's visuals out of the scene and give their materials back.
 *
 * One place, because both callers below are the same loop and one of them runs
 * on a recovery path — and because `dispose()` on a node material can throw
 * from inside Three.
 *
 * The throw is `TypeError: Cannot read properties of undefined (reading
 * 'usedTimes')`, in `Nodes.delete`. A material's dispose event reaches every
 * `RenderObject` built from it, and `Nodes.delete` reads
 * `this.get(renderObject).nodeBuilderState` and decrements it without checking
 * that there is one — which there is not for a render object the renderer
 * created but never built a pipeline for. That is the ordinary state of the
 * scene when the presentation watchdog gives up on a canvas that never
 * presented and remounts it: the objects exist, nothing was ever drawn, and
 * the remount disposes them.
 *
 * It is Three's bug and there is nothing this side can do to stop it. What
 * this side controls is what the throw takes with it: uncaught, it aborted the
 * loop, so every visual after the first one was left parented to a scene that
 * was about to be replaced with its materials undisposed — on exactly the path
 * whose whole purpose is to rebuild them. Caught per object, the recovery
 * completes and the failure is one line in the log rather than a leak nobody
 * can see.
 */
function retire(visual: BodyVisual): void {
  for (const object of [
    visual.mesh,
    visual.atmosphere,
    visual.clouds,
    visual.rings,
  ]) {
    if (object === null) continue
    object.removeFromParent()
    const material = object.material
    for (const one of Array.isArray(material) ? material : [material]) {
      try {
        one.dispose()
      } catch (cause) {
        log.warn('a material would not dispose', { cause: String(cause) })
      }
    }
  }
}

/*
 * Sphere tessellation, by how much of the screen the body covers.
 *
 * A planet from orbit is a *silhouette* problem before it is a shading one. No
 * amount of normal mapping hides a faceted limb, and the limb is where the eye
 * goes — it is the edge against black, and it is where the atmosphere sits.
 *
 * The near tier is 512×256, which is 262,144 triangles for one body. That is a
 * lot by 2010 standards and nothing at all now, and at most two bodies are ever
 * in that tier: it is keyed on angular radius, so a planet earns it by filling
 * the view rather than by existing. Tiers rather than one geometry because the
 * Solar System puts a hundred and twenty-nine bodies in the scene at once and most of them
 * are a pixel across.
 */
const SPHERE_TIERS: readonly { minAngle: number; segments: number }[] = [
  { minAngle: 0.06, segments: 512 },
  { minAngle: 0.012, segments: 256 },
  { minAngle: 0.002, segments: 96 },
  { minAngle: 0, segments: 32 },
]

/**
 * The rings, as an annulus in the body's equatorial plane.
 *
 * Built rather than taken from `RingGeometry`, for the radial coordinate: the
 * shader wants distance from the axis and nothing else, and this way it reads it
 * straight out of `positionLocal` with no UV channel and no seam. 768 segments
 * because a ring seen nearly edge-on is a straight line a thousand pixels long,
 * and any faceting at all shows as a scalloped edge.
 */
function ringGeometry(): BufferGeometry {
  const segments = 768
  const inner = 0.25
  const positions = new Float32Array((segments + 1) * 2 * 3)
  const indices: number[] = []
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2
    const x = Math.cos(angle)
    const z = Math.sin(angle)
    const base = i * 6
    positions[base] = x * inner
    positions[base + 1] = 0
    positions[base + 2] = z * inner
    positions[base + 3] = x
    positions[base + 4] = 0
    positions[base + 5] = z
    if (i < segments) {
      const a = i * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/*
 * Per-body shading parameters, from what the body is.
 *
 * The one number worth explaining is `lunarLambert`, the weight between Lambert
 * and Lommel-Seeliger in `planet.ts`. It is not a style knob: it is how much the
 * surface backscatters, it is measured for real bodies, and it is the difference
 * between a Moon that looks like a photograph and one that looks like a
 * billiard ball. Airless regolith is around 0.9; a thick atmosphere scatters its
 * way to something much closer to Lambert.
 */
interface PlanetTuning {
  readonly lunarLambert: number
  readonly terminator: number
  readonly reliefScale: number
  readonly specular: number
  readonly night: number
  readonly limbDarkening: number
  readonly saturation: number
  /** Equatorial jet, UV turns per second. Real magnitudes; see `planet.ts`. */
  readonly flowRate: number
}

/**
 * How much to open up for a body too dark to expose the scene for.
 *
 * The star already does this in reverse: `visual.star.exposure` stops *down* as
 * a star fills the frame, because "a sun that fills the frame is exposed for its
 * surface, not for the scene it lights". This is the same decision at the other
 * end. Bennu reflects 4.4% of the light that reaches it and Halley's nucleus
 * 4% — darker than charcoal — and a camera or an eye that spends a minute
 * looking at one from five hundred meters away adapts to it. The renderer has
 * one exposure for the whole scene and cannot.
 *
 * So it is applied as an exposure and not as an albedo: it scales with how much
 * of the frame the body covers, it is 1 the moment the body is one object among
 * several, and it never fires at all above `ADAPTED_ALBEDO`. Every planet sees
 * exactly 1 — Mercury is 0.142 and the Moon 0.136, the two darkest.
 *
 * It is *not* only the small bodies below it. Fifteen moons already in
 * `bodies.ts` are darker than the threshold — Iapetus at 0.05, Thebe 0.047,
 * Himalia 0.057, Phoebe 0.081, Amalthea 0.09, Proteus 0.096 and the rest — and
 * every one of them opens up when it fills the frame. That is the intended
 * reading of the rule rather than an exception to it: a body too dark to expose
 * the scene for is a body too dark to expose the scene for, and Iapetus's
 * leading hemisphere is the canonical example. Saying otherwise here would be a
 * comment that reads as a guarantee and is not one.
 *
 * `docs/design/art.md` licenses this and draws the line it is on the right side
 * of: the *albedo* is the published one, the body is still the darkest thing in
 * the frame, and what is being adjusted is the sensor.
 */
/**
 * The albedo the scene's own exposure already suits.
 *
 * One constant, read twice, because the two readings are only correct together:
 * it is both the cut-off and the target the lift aims at, so `lift` is exactly
 * 1 just below the threshold and the function is continuous there. Written out
 * as two literals — which it was — moving only the guard leaves it
 * discontinuous *and inverted*: at a guard of 0.15 a body at albedo 0.149 gets
 * `lift = 0.8`, so filling the frame would darken it.
 */
const ADAPTED_ALBEDO = 0.12
/** Angular radius at which adaptation starts, and the span over which it completes. */
const ADAPT_FROM = 0.02
const ADAPT_SPAN = 0.2

function adaptationFor(body: RenderBody): number {
  const albedo = body.appearance.geometricAlbedo
  if (albedo >= ADAPTED_ALBEDO) return 1
  // ADAPT_FROM is about a fifth of the frame; by ADAPT_FROM + ADAPT_SPAN the
  // body is the scene.
  const filling = Math.min(
    1,
    Math.max(0, (body.placement.angularRadius - ADAPT_FROM) / ADAPT_SPAN),
  )
  const lift = ADAPTED_ALBEDO / Math.max(albedo, 0.01)
  return 1 + (lift - 1) * filling
}

function tuningFor(body: RenderBody): PlanetTuning {
  const air = body.hasAtmosphere
  const giant = body.kind === 'gas-giant' || body.kind === 'ice-giant'
  if (giant)
    return {
      // A cloud deck kilometers thick is as close to Lambert as anything gets,
      // and its terminator is soft because there is no surface to end at.
      lunarLambert: 0.1,
      terminator: 0.22,
      reliefScale: 0,
      specular: 0,
      night: 0,
      // The two knobs that separate a decal from a photograph of a giant:
      // the disk rolls off toward the limb, and the published near-true-color
      // maps get the chroma stretch every released image has had.
      limbDarkening: 0.72,
      saturation: body.kind === 'gas-giant' ? 1.3 : 1.15,
      // ~110 m/s of equatorial jet for a gas giant, ~400 m/s for an ice
      // giant (Neptune's winds are the fastest in the system), as a fraction
      // of a typical circumference per second.
      flowRate: body.kind === 'gas-giant' ? 2.5e-7 : 2.5e-6,
    }
  return {
    // Closer to Lambert than it was: the aerial veil now brightens the limb
    // on top of this, and 0.45 under the veil left the disk reading flat.
    lunarLambert: air ? 0.3 : 0.92,
    /*
     * The same number the ground uses, from the same producer.
     *
     * A disk and the terrain streamed in front of it are one body, and a
     * descent crosses between them at the eight-pixel relief gate — so a
     * terminator each of them derived for itself is a step at the switch. It
     * was: 4.2× on Luna and 6.6× on Iapetus, because the ground widened its
     * band by the body's own relief and the disk did not. `terminatorFor` is
     * where the widening lives now; `buildScene` spends it once and both the
     * disk and the ground read the result.
     */
    terminator: body.terminator,
    limbDarkening: 0,
    saturation: 1,
    flowRate: 0,
    /*
     * Normal-map exaggeration, and the honest name for it.
     *
     * At 4096 across, one texel of Earth is ten kilometers, and the real slope
     * across ten kilometers is a fraction of a degree — measured: the normal map
     * has a standard deviation of 2.4 out of 255. Rendered at unity it is
     * invisible. `docs/design/art.md` licenses exactly this ("roughness and
     * detail are art") and forbids the thing next door to it: the *elevation* is
     * the published one, the terrain is where it really is, and only how sharply
     * it catches the light is turned up.
     *
     * The Moon needs far less because its craters are genuinely steep.
     */
    reliefScale: air ? 6 : 2.2,
    specular: 1,
    night: 1,
  }
}

/**
 * A body visual waiting to be built ahead of need. Everything the creation
 * block reads, captured at enqueue time so the frame loop never walks a
 * system twice.
 */
interface WarmTask {
  readonly key: string
  readonly star: boolean
  readonly clouded: boolean
  readonly ringed: boolean
}

/** Planets, moons and stars, placed from the scene description. */
export function Bodies({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const visuals = useMemo(() => new Map<string, BodyVisual>(), [])
  const anisotropy = useThree(
    (state) => state.gl.capabilities?.getMaxAnisotropy?.() ?? 8,
  )
  const gl = useThree((state) => state.gl)
  const defaultCamera = useThree((state) => state.camera)
  const rootScene = useThree((state) => state.scene)
  /** Bodies whose visuals should exist before anything looks at them. */
  const warmQueue = useRef<WarmTask[]>([])
  const warmedSystems = useRef('')
  /*
   * Boot's half of that queue, reported rather than driven.
   *
   * The drain is one body a frame and boot cannot await a loop over it — the
   * frames are what boot is waiting for. So it joins the census instead: the
   * units count toward the progress total and `finish()` releases the cover.
   * After boot has lifted this is a no-op ticket and the same code is the
   * mid-session trickle it always was.
   */
  const [ticket] = useState(() => trackAtMount('building bodies'))
  const spheres = useMemo(
    () =>
      SPHERE_TIERS.map((tier) => ({
        minAngle: tier.minAngle,
        geometry: new SphereGeometry(1, tier.segments, tier.segments / 2),
      })),
    [],
  )
  const rings = useMemo(ringGeometry, [])

  const scratch = useMemo(
    () => ({ axis: new Vector3(), sun: new Vector3(), centre: new Vector3() }),
    [],
  )

  /*
   * Take the meshes with us when this component goes.
   *
   * They are added to the group imperatively from inside the frame loop, which
   * is deliberate — see the header — but it means React knows nothing about
   * them and cannot clean them up. Without this, a hot reload leaves the
   * previous mount's objects parented to the scene with nothing updating them:
   * a stale Saturn ring, forty thousand kilometers across and still visible,
   * hung across the Moon as a set of dark horizontal bands that looked
   * convincingly like a texture bug for rather too long.
   */
  useEffect(
    () => () => {
      for (const visual of visuals.values()) retire(visual)
      visuals.clear()
      for (const tier of spheres) tier.geometry.dispose()
      rings.dispose()
    },
    [visuals, spheres, rings],
  )

  useTimedFrame('bodies', () => {
    const scene = engine.scene()
    const container = group.current
    if (scene === null || container === null) return

    // Render-space position of the key light. `stars[0]` is documented as
    // brightest-apparent-first, which is the same star `CameraRig` lights the
    // scene with — they must not disagree.
    const keyLight = scene.stars[0]?.placement.position ?? null
    const keyColour = scene.stars[0]?.color ?? { r: 1, g: 1, b: 1 }

    const geometryFor = (angle: number): SphereGeometry =>
      (
        spheres.find((tier) => angle >= tier.minAngle) ??
        spheres[spheres.length - 1]!
      ).geometry

    const seen = new Set<string>()

    /*
     * At the cap, retire a visual this frame did not draw before refusing to
     * create one. The map deliberately only grows — a body flickering across
     * the cull threshold must not rebuild its pipelines — but without
     * eviction every visited system leaves its meshes resident (Sol alone is
     * 29) and after a couple of systems new arrivals silently stop rendering.
     * Materials only: the sphere and ring geometries are shared tiers.
     */
    const evictStale = (): boolean => {
      for (const [key, visual] of visuals) {
        if (seen.has(key) || visual.mesh.visible) continue
        retire(visual)
        visuals.delete(key)
        return true
      }
      return false
    }

    const materialise = (
      key: string,
      star: boolean,
      clouded: boolean,
      ringed: boolean,
    ): BodyVisual => {
      const starMaterial = star ? createStarMaterial() : null
      const planet = star ? null : createPlanetMaterial()
      const atmosphereMaterial = createAtmosphereMaterial()
      const mesh = new Mesh(
        spheres[0]!.geometry,
        starMaterial?.material ?? planet!.material,
      )
      const atmosphere = new Mesh(
        spheres[1]!.geometry,
        atmosphereMaterial.material,
      )
      atmosphere.visible = false
      container.add(mesh)
      container.add(atmosphere)

      let clouds: Mesh | null = null
      let cloudMaterial: CloudMaterial | null = null
      if (clouded) {
        cloudMaterial = createCloudMaterial()
        clouds = new Mesh(spheres[0]!.geometry, cloudMaterial.material)
        clouds.renderOrder = 1
        container.add(clouds)
      }

      let ringMesh: Mesh | null = null
      let ringMaterial: RingMaterial | null = null
      if (ringed) {
        ringMaterial = createRingMaterial()
        ringMesh = new Mesh(rings, ringMaterial.material)
        ringMesh.renderOrder = 2
        container.add(ringMesh)
      }

      const visual: BodyVisual = {
        mesh,
        planet,
        atmosphere,
        atmosphereMaterial,
        clouds,
        cloudMaterial,
        rings: ringMesh,
        ringMaterial,
        star: starMaterial,
      }
      visuals.set(key, visual)
      return visual
    }

    const draw = (
      key: string,
      body: RenderBody,
      star: { r: number; g: number; b: number } | null,
    ): void => {
      seen.add(key)
      const appearance = body.appearance
      let visual = visuals.get(key)
      if (visual === undefined) {
        if (visuals.size >= MAX_BODIES && !evictStale()) return
        visual = materialise(
          key,
          star !== null,
          appearance.clouds !== null,
          body.rings !== null,
        )
      }

      const { placement, orientation } = body
      const quaternion = visual.mesh.quaternion.set(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w,
      )
      visual.mesh.position.set(
        placement.position.x,
        placement.position.y,
        placement.position.z,
      )
      /*
       * Two shapes, and which one is not a rendering choice.
       *
       * A body with no `figure` is a spheroid, and is drawn the way it always
       * was: a unit sphere, squashed along its spin axis by the measured
       * flattening. Saturn is 9.8% oblate and reads as wrong long before
       * anyone can say why, and the quaternion tilts the bulge with the axis,
       * which is the whole point of doing it in the body's own frame.
       *
       * A body *with* a figure is not a spheroid and never was. Its mesh is
       * built from a measured shape model or from its own seed, already
       * carries its three half-extents and its relief, and is normalized to
       * `trueRadius` — so it scales by one number. Applying `flattening` on
       * top would squash it a second time by a ratio the geometry has already
       * spent.
       */
      const shape = shapeGeometryFor(body)
      if (shape === null) {
        visual.mesh.scale.set(
          placement.scale,
          placement.scale * body.flattening,
          placement.scale,
        )
        visual.mesh.geometry = geometryFor(placement.angularRadius)
      } else {
        visual.mesh.scale.setScalar(placement.scale)
        visual.mesh.geometry = shape
      }
      visual.mesh.visible = true
      // A body drawn as streamed terrain does not also need its datum sphere,
      // except as the sea floor below it.
      visual.mesh.renderOrder = placement.tier === 'surface' ? -1 : 0

      // The color is a uniform rather than a construction argument because a
      // star's rendered color is derived from its temperature every frame, and
      // a material built once from the first frame's value would freeze it.
      if (star !== null && visual.star !== null) {
        visual.star.color.value.setRGB(star.r, star.g, star.b)
        // Presentation time, for the granulation churn — simulation seconds,
        // so time warp stirs the photosphere faster, which reads as intended.
        visual.star.time.value = engine.snapshot?.renderTime ?? 0
        // Stop down as the disk grows: a sun that fills the frame is exposed
        // for its surface, not for the scene it lights. From afar this is 1
        // and the star stays the reference white the HDR path is built on.
        // Fully stopped down by ~0.1 rad — the star-orbit arrival parks at
        // 0.125 — where the ceiling of the tone curve finally lets the
        // granulation through: at radiance 8 every lane clips to the same
        // white and the surface work is invisible.
        const filling = Math.min(
          1,
          Math.max(0, (placement.angularRadius - 0.015) / 0.085),
        )
        visual.star.exposure.value = 1 - filling * 0.9
      }

      const sun = scratch.sun
      if (keyLight !== null)
        sun
          .set(keyLight.x, keyLight.y, keyLight.z)
          .sub(visual.mesh.position)
          // A body sitting exactly on its star — which is what a star's own
          // entry would be — leaves this zero-length, and a normalized zero is
          // NaN across the whole shell.
          .normalize()

      const planet = visual.planet
      if (planet !== null) {
        const tuning = tuningFor(body)
        const maps = texturesFor(appearance.texture, anisotropy)
        // The ring-shadow strip lives under the *ring's* manifest key
        // ('saturn-ring'), not the body's — the body's own set never carries
        // a ring map, so looking it up there disables the shadow entirely.
        // Mapless rings shadow with the same generated strip they are drawn
        // from, so the shadow bands match the rings that cast them.
        planet.setTextures(
          body.rings === null
            ? maps
            : {
                ...maps,
                ring:
                  body.rings.texture === null
                    ? proceduralRingStrip(body.kind, body.address)
                    : texturesFor(body.rings.texture, anisotropy).ring,
              },
        )
        planet.sunDirection.value.copy(sun)
        planet.sunColour.value.setRGB(keyColour.r, keyColour.g, keyColour.b)
        planet.spinAxis.value
          .set(0, 1, 0)
          .applyQuaternion(quaternion)
          .normalize()
        planet.centre.value.copy(visual.mesh.position)
        planet.baseColour.value.setRGB(
          appearance.colour.r,
          appearance.colour.g,
          appearance.colour.b,
        )
        planet.albedoScale.value = adaptationFor(body)
        planet.lunarLambert.value = tuning.lunarLambert
        planet.terminator.value = tuning.terminator
        planet.reliefScale.value = maps.normal === null ? 0 : tuning.reliefScale
        planet.limbDarkening.value = tuning.limbDarkening
        planet.saturation.value = tuning.saturation
        planet.flowRate.value = tuning.flowRate
        planet.time.value = engine.snapshot?.renderTime ?? 0
        /*
         * The aerial term reads the same authored haze the shell does, so the
         * air over the ground and the air past the limb cannot disagree about
         * what color the sky is. Giants get less: their "surface" already is
         * cloud-top, and a full-strength veil flattened Jupiter's bands into
         * fog. The veil is what limb-brightens an atmosphere-bearing disk;
         * lunar-Lambert would otherwise leave it too flat to read as a sphere.
         */
        const airHaze = appearance.haze
        const giant = body.kind === 'gas-giant' || body.kind === 'ice-giant'
        planet.hazeStrength.value =
          airHaze === null ? 0 : giant ? 0.18 : airHaze.thickness
        if (airHaze !== null) {
          planet.hazeColour.value.setRGB(
            airHaze.colour.r,
            airHaze.colour.g,
            airHaze.colour.b,
          )
          planet.hazeLimb.value.setRGB(
            airHaze.limb.r,
            airHaze.limb.g,
            airHaze.limb.b,
          )
        }
        // Sun-glint needs an ocean to land on, and the mask that says where one
        // is rides in the normal map's blue. No normal map, no ocean, no glint.
        planet.specularStrength.value =
          maps.normal === null ? 0 : tuning.specular
        planet.nightStrength.value = maps.night === null ? 0 : tuning.night
        planet.cloudShadow.value = maps.clouds === null ? 0 : 0.55
        planet.cloudHeight.value =
          appearance.clouds === null
            ? 0
            : appearance.clouds.altitude / Math.max(body.trueRadius, 1)
        // In render meters, because the shader measures the sun ray's
        // plane-crossing against `positionWorld` — the dimensionless scales
        // alone sit far inside any drawn sphere and never shadow anything.
        planet.ringInner.value = (body.rings?.innerScale ?? 0) * placement.scale
        planet.ringOuter.value = (body.rings?.outerScale ?? 0) * placement.scale
        planet.ringOpacity.value = Math.min(1, body.rings?.opticalDepth ?? 0)
      }

      /* --- the cloud deck ------------------------------------------------- */
      if (visual.clouds !== null && visual.cloudMaterial !== null) {
        const clouds = appearance.clouds
        const visible = clouds !== null && placement.tier !== 'point'
        visual.clouds.visible = visible
        if (visible && clouds !== null) {
          /*
           * The shell is lifted to at least 0.4% of the radius.
           *
           * Earth's cloud tops are twelve kilometers up on a radius of six
           * thousand, which is 0.2% and is a shell you cannot see past at the
           * limb. What sells a cloud deck from orbit is precisely that parallax
           * — the clouds overhanging the edge of the disk — and the altitude is
           * not on the list of things a player can check.
           */
          const lift = Math.max(
            clouds.altitude / Math.max(body.trueRadius, 1),
            0.004,
          )
          const shell = placement.scale * (1 + lift)
          visual.clouds.position.copy(visual.mesh.position)
          visual.clouds.quaternion.copy(quaternion)
          visual.clouds.scale.set(shell, shell * body.flattening, shell)
          visual.clouds.geometry = geometryFor(placement.angularRadius)
          const material = visual.cloudMaterial
          const cloudMap = texturesFor(appearance.texture, anisotropy).clouds
          material.setTexture(cloudMap)
          // A deck with no map — Titan's, and every procedural world's — is
          // drawn from the body's tint over the opaque fallback texel; a
          // mapped deck keeps its own colors untinted.
          if (cloudMap === null)
            material.baseColour.value.setRGB(
              appearance.colour.r,
              appearance.colour.g,
              appearance.colour.b,
            )
          else material.baseColour.value.setRGB(1, 1, 1)
          material.sunDirection.value.copy(sun)
          material.sunColour.value.setRGB(keyColour.r, keyColour.g, keyColour.b)
          // The deck's dusk color is the body's authored sunset, so clouds
          // and air agree about what the low sun does here.
          const deckHaze = appearance.haze
          if (deckHaze !== null)
            material.sunsetColour.value.setRGB(
              deckHaze.limb.r,
              deckHaze.limb.g,
              deckHaze.limb.b,
            )
          material.opacity.value = clouds.opacity
          // The deck turns against the surface, whose quaternion already spins
          // at the body's own period — so the drift is the *difference* of the
          // two rates. Subtracting a fixed 24-hour day here gave Venus's deck
          // a spurious daily lap and slid Titan's around a tidally locked
          // moon.
          material.drift.value =
            (engine.snapshot?.renderTime ?? 0) / clouds.rotationPeriod -
            (engine.snapshot?.renderTime ?? 0) / body.rotationPeriod
        }
      }

      /* --- the rings ------------------------------------------------------ */
      if (visual.rings !== null && visual.ringMaterial !== null) {
        const ring = body.rings
        const visible = ring !== null && placement.tier !== 'point'
        visual.rings.visible = visible
        if (visible && ring !== null) {
          const extent = placement.scale * ring.outerScale
          visual.rings.position.copy(visual.mesh.position)
          visual.rings.quaternion.copy(quaternion)
          visual.rings.scale.setScalar(extent)
          const material = visual.ringMaterial
          material.setTexture(
            ring.texture === null
              ? proceduralRingStrip(body.kind, body.address)
              : texturesFor(ring.texture, anisotropy).ring,
          )
          material.sunDirection.value.copy(sun)
          material.sunColour.value.setRGB(keyColour.r, keyColour.g, keyColour.b)
          material.innerFraction.value = ring.innerScale / ring.outerScale
          material.centre.value.copy(visual.mesh.position)
          // In render meters: the eclipse test runs on `positionWorld`, so a
          // mesh-local value (1/outerScale) never shadowed a single fragment.
          material.bodyRadius.value = placement.scale
          material.opticalDepth.value = ring.opticalDepth
          // A generated strip carries its own grays — re-dying it with the
          // body's tint is how Uranus's charcoal threads came out cyan. Only
          // a photographed strip is neutral enough to take the tint.
          if (ring.texture === null) material.baseColour.value.setRGB(1, 1, 1)
          else
            material.baseColour.value.setRGB(
              appearance.colour.r,
              appearance.colour.g,
              appearance.colour.b,
            )
        }
      }

      /* --- the atmosphere ------------------------------------------------- */
      visual.atmosphere.visible =
        body.hasAtmosphere && placement.tier !== 'point'
      if (visual.atmosphere.visible) {
        const shell = placement.scale * body.atmosphereScale
        visual.atmosphere.position.copy(visual.mesh.position)
        // Oblate like the body it wraps, or the shell floats a tenth of a
        // radius off Saturn's poles; the shader unstretches it — see the
        // material for what the spherical version looked like.
        visual.atmosphere.quaternion.copy(quaternion)
        visual.atmosphere.scale.set(shell, shell * body.flattening, shell)
        visual.atmosphere.geometry = geometryFor(placement.angularRadius)

        // The shell's shader needs the same geometry the transform above encodes,
        // in render space, because it integrates along the view ray rather than
        // shading a surface. Written every frame for the same reason the matrix
        // is: distance compression rescales both radii whenever the tier moves.
        const air = visual.atmosphereMaterial
        air.centre.value.copy(visual.mesh.position)
        air.outerRadius.value = shell
        air.innerRadius.value = placement.scale
        air.spinAxis.value.set(0, 1, 0).applyQuaternion(quaternion).normalize()
        air.flattening.value = body.flattening
        const haze = appearance.haze
        if (haze !== null) {
          // Baked lazily on the first frame this shell is drawn, cached by
          // its parameters after that — see `atmosphereLuts.ts`.
          const scattering = scatteringFor(haze, body.atmosphereScale)
          air.setScattering(
            scattering.recipe,
            scattering.transmittance,
            scattering.multiScatter,
          )
        }
        air.sunColour.value.setRGB(keyColour.r, keyColour.g, keyColour.b)
        if (keyLight !== null) air.sunDirection.value.copy(sun)
      }
    }

    for (const body of scene.bodies) draw(body.address, body, null)
    for (const star of scene.stars) {
      draw(
        `star:${star.system}`,
        {
          address: `star:${star.system}`,
          name: star.name,
          kind: 'star',
          placement: star.placement,
          orientation: { x: 0, y: 0, z: 0, w: 1 },
          hasAtmosphere: false,
          // A star has no surface and no terminator; the disk is unlit.
          terminator: 0,
          atmosphereScale: 1,
          trueRadius: 1,
          rotationPeriod: 1,
          flattening: 1,
          // A star is a sphere, and the one in this scene is drawn by
          // `createStarMaterial` on a sphere tier regardless.
          figure: null,
          rings: null,
          appearance: STAR_APPEARANCE,
        },
        star.color,
      )
    }

    for (const [key, visual] of visuals) {
      if (seen.has(key)) continue
      visual.mesh.visible = false
      visual.atmosphere.visible = false
      if (visual.clouds !== null) visual.clouds.visible = false
      if (visual.rings !== null) visual.rings.visible = false
    }

    /*
     * Build ahead of need: one body visual per frame, for every body the
     * loaded systems could put on screen, compiled the moment it is built.
     *
     * `render/preload.ts` warms the *archetype* pipelines, but the backend
     * still generates WGSL per material instance to discover that the
     * pipeline is already cached — measured 2026-08-23 at ~5 ms per material,
     * which for Saturn arriving with seven moons was an 88 ms frame with
     * every texture, LUT and pipeline already warm. Draining that work here,
     * one body a frame, spends it behind the boot overlay at startup and
     * during the flight after a mid-session jump — long before anything is
     * close enough to look at. Paused during a cutscene, where a scripted
     * frame has nowhere to hide a ten-millisecond task.
     *
     * The compile has to see visible objects — `compileAsync` walks the tree
     * exactly as a render would — and its traversal is synchronous (only the
     * backend's pipeline promises are awaited), so the toggle around it never
     * lets a unit sphere at the origin reach a real frame.
     */
    if (engine.cinematic === null) {
      const systems = engine.world.loadedSystems()
      const systemsKey = systems.map((system) => system.id).join(',')
      if (systemsKey !== warmedSystems.current) {
        warmedSystems.current = systemsKey
        const queue: WarmTask[] = []
        for (const system of systems) {
          queue.push({
            key: `star:${system.id}`,
            star: true,
            clouded: false,
            ringed: false,
          })
          for (const body of walkBodies(system)) {
            queue.push({
              // The same formatting the snapshot applies, or the key misses
              // the visual the draw loop will look up.
              key: formatAddress(body.address),
              star: false,
              clouded: body.appearance.clouds !== null,
              ringed: body.appearance.rings !== null,
            })
          }
        }
        warmQueue.current = queue
        // The census. Boot's progress total used to exclude this queue
        // entirely, so the status line said "compiling the sky…" while the
        // work measured at 88 ms had not started. Re-declared rather than
        // added to: a mid-session jump replaces the queue, and by then the
        // ticket is the idle one and this is a no-op.
        ticket.expect(queue.length)
      }

      let task = warmQueue.current.shift()
      while (task !== undefined && visuals.has(task.key))
        task = warmQueue.current.shift()
      /*
       * At the cap, retire something — and if nothing can be retired, put the
       * task back rather than dropping it.
       *
       * It was shifted off and then silently discarded when `visuals.size`
       * reached the cap: not materialised, not requeued, and `ticket.done()`
       * never called, while `ticket.finish()` below credited the shortfall so
       * the boot bar still read 100%. The queue is only rebuilt on a system
       * change, so the build-ahead for every body past the cap was gone until
       * the next jump and each paid its ~5 ms of pipeline generation live, on
       * first sight. Sol is 129 bodies against a cap of 160, so a second loaded
       * system reaches this in ordinary flight.
       */
      if (task !== undefined && visuals.size >= MAX_BODIES && !evictStale()) {
        warmQueue.current.unshift(task)
        task = undefined
        // The queue cannot drain while nothing is evictable, and boot waits on
        // it draining. `finish` is already called every frame once the queue
        // empties, so saying it here too is idempotent — and it is the
        // difference between "no build-ahead until something frees up" and a
        // cover that never lifts.
        ticket.finish()
      }
      if (task !== undefined && visuals.size < MAX_BODIES) {
        const visual = materialise(
          task.key,
          task.star,
          task.clouded,
          task.ringed,
        )
        const renderer = warmRenderer(gl)
        for (const part of [
          visual.mesh,
          visual.atmosphere,
          visual.clouds,
          visual.rings,
        ]) {
          if (part === null) continue
          // Fire and forget: the pipelines land whenever the backend is
          // ready. `warmCompile` owns the visibility toggle the compile needs
          // to see anything, and swallows the rejection.
          void warmCompile(renderer, {
            object: part,
            camera: defaultCamera,
            scene: rootScene as Scene,
          })
        }
        ticket.done()
      }
      // Every body the loaded systems could put on screen now has a visual.
      // Boot is waiting on exactly this, so it has to be told.
      if (warmQueue.current.length === 0) ticket.finish()
    }
  })

  return <group ref={group} />
}

/** A star is drawn by `createStarMaterial`; none of this reaches it. */
const STAR_APPEARANCE: RenderBody['appearance'] = {
  texture: null,
  maps: [],
  relief: 0,
  geometricAlbedo: 1,
  roughness: 1,
  clouds: null,
  rings: null,
  haze: null,
  colour: { r: 1, g: 1, b: 1 },
}
