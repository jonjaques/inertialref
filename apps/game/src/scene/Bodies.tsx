import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  type Color,
  type Group,
  Mesh,
  type Scene,
  SphereGeometry,
  type Texture,
  type Vector3,
  type WebGPURenderer,
} from 'three/webgpu'
import { getLogger } from '@inertialref/shared'
import type { Vec3 } from '@inertialref/spatial'
import type { RenderBody } from '@inertialref/rendering'
import { formatAddress, walkBodies } from '@inertialref/universe'
import type { GameEngine } from '../engine/GameEngine.ts'
import {
  type BodyFrame,
  bodyUniforms,
  type Rgb,
  starAsBody,
  starKey,
  wantsBake,
} from '../render/bodyUniforms.ts'
import { createOrbitalBaker, type OrbitalBaker } from '../render/orbitalBake.ts'
import type { TerrainMaterial } from '../render/terrain.ts'
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
import { scatteringFor, scatteringVia } from '../render/atmosphereLuts.ts'
import { texturesFor } from '../render/planetTextures.ts'
import { proceduralRingStrip } from '../render/proceduralRings.ts'
import { shapeGeometryFor } from '../render/shapeModels.ts'
import { createBodyResidency } from './bodyResidency.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/**
 * How many body visuals may be resident at once. `bodyResidency.ts` evicts.
 *
 * 160 rather than 64 because the Solar System grew. This caps the resident
 * map, which stars enter under a `star:` key alongside the bodies — so it was
 * 29 (eight planets, twenty moons and the Sun) and it is 130 now that the
 * dwarf planets, the asteroids, the comets and the forty-two moons that are
 * rocks or go round one are in it. At 64 the arrivals past the cap silently
 * stopped rendering, which is the failure eviction exists to make graceful
 * and is not one to leave a system permanently over.
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
export function Bodies({
  engine,
  terrain,
}: {
  engine: GameEngine
  terrain: TerrainMaterial
}) {
  const group = useRef<Group>(null)
  /*
   * Which visuals exist, the cap, the build-ahead queue and boot's ticket —
   * `bodyResidency.ts`, whose header says which shipped bugs each of those
   * had. Boot's half of the queue is reported rather than driven: the drain
   * is one body a frame and boot cannot await a loop over it, the frames are
   * what boot is waiting for. So it joins the census, and after boot has
   * lifted this is a no-op ticket and the same code is the mid-session
   * trickle it always was. A state initializer rather than a memo so the
   * instance survives a render; `trackAtMount` is idempotent by label, so
   * StrictMode's second initializer holds the same ticket.
   */
  const [residency] = useState(() =>
    createBodyResidency<BodyVisual, WarmTask>({
      cap: MAX_BODIES,
      ticket: trackAtMount('building bodies'),
      onScreen: (visual) => visual.mesh.visible,
      hide: (visual) => {
        visual.mesh.visible = false
        visual.atmosphere.visible = false
        if (visual.clouds !== null) visual.clouds.visible = false
        if (visual.rings !== null) visual.rings.visible = false
      },
      retire,
    }),
  )
  const anisotropy = useThree(
    (state) => state.gl.capabilities?.getMaxAnisotropy?.() ?? 8,
  )
  const gl = useThree((state) => state.gl)
  const defaultCamera = useThree((state) => state.camera)
  const rootScene = useThree((state) => state.scene)
  /** The loaded systems the build-ahead queue was planned for. */
  const warmedSystems = useRef('')
  const spheres = useMemo(
    () =>
      SPHERE_TIERS.map((tier) => ({
        minAngle: tier.minAngle,
        geometry: new SphereGeometry(1, tier.segments, tier.segments / 2),
      })),
    [],
  )
  const rings = useMemo(ringGeometry, [])
  const baker = useRef<OrbitalBaker | null>(null)
  useEffect(() => {
    // StrictMode retires the first effect before starting another. Each setup
    // owns its baker so the live frame never reuses a disposed cache.
    const built = createOrbitalBaker({
      renderer: gl as unknown as WebGPURenderer,
      terrain,
      bodyFor: (address) => engine.bodyFor(address),
      heightfields: engine.heightfields,
    })
    baker.current = built
    const debug = window as unknown as { orbitalBaker?: OrbitalBaker }
    debug.orbitalBaker = built
    return () => {
      if (debug.orbitalBaker === built) delete debug.orbitalBaker
      baker.current = null
      built.dispose()
    }
  }, [gl, terrain, engine])

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
      residency.dispose()
      for (const tier of spheres) tier.geometry.dispose()
      rings.dispose()
    },
    [residency, spheres, rings],
  )

  useTimedFrame('bodies', () => {
    const scene = engine.scene()
    const container = group.current
    const visibility = engine.visibilityProcessing
    if (scene === null || container === null) return
    residency.begin()

    const geometryFor = (angle: number): SphereGeometry =>
      (
        spheres.find((tier) => angle >= tier.minAngle) ??
        spheres[spheres.length - 1]!
      ).geometry

    /** The meshes and materials for one body; residency decides when. */
    const materialize = (
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

      return {
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
    }

    const frame: BodyFrame = {
      // Render-space position of the key light. `stars[0]` is documented as
      // brightest-apparent-first, which is the same star `CameraRig` lights
      // the scene with — they must not disagree.
      keyLight: scene.stars[0]?.placement.position ?? null,
      keyColor: scene.stars[0]?.color ?? { r: 1, g: 1, b: 1 },
      visibility,
      renderTime: engine.snapshot?.renderTime ?? 0,
      eye: scene.camera.position,
    }

    const draw = (key: string, body: RenderBody, star: Rgb | null): void => {
      const appearance = body.appearance
      const visual = residency.draw(key, () =>
        materialize(
          star !== null,
          appearance.clouds !== null,
          body.rings !== null,
        ),
      )
      if (visual === null) return

      // The textures stay here; the uniforms only need to know which exist.
      const maps = texturesFor(appearance.texture, anisotropy)
      const bake =
        visual.planet !== null && wantsBake(body)
          ? (baker.current?.textureFor(body.address) ?? null)
          : null
      const uniforms = bodyUniforms(
        body,
        frame,
        {
          normal: maps.normal !== null,
          night: maps.night !== null,
          clouds: maps.clouds !== null,
          bake: bake !== null,
        },
        star,
      )
      const { orientation } = body
      const quaternion = visual.mesh.quaternion.set(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w,
      )
      const position = uniforms.position
      visual.mesh.position.set(position.x, position.y, position.z)
      setVector(visual.mesh.scale, uniforms.scale)
      // The figure branch is `bodyUniforms`'s; this only follows it to the
      // mesh. A figured body's shape already carries its polar squash.
      visual.mesh.geometry = uniforms.figured
        ? shapeGeometryFor(body)!
        : geometryFor(body.placement.angularRadius)
      visual.mesh.visible = true
      visual.mesh.renderOrder = uniforms.renderOrder

      if (uniforms.star !== null && visual.star !== null) {
        setColor(visual.star.color, uniforms.star.color)
        setNumber(visual.star.time, uniforms.star.time)
        setNumber(visual.star.exposure, uniforms.star.exposure)
      }

      const sun = uniforms.sun
      const planet = visual.planet
      if (uniforms.planet !== null && planet !== null) {
        const values = uniforms.planet
        // The ring-shadow strip lives under the *ring's* manifest key
        // ('saturn-ring'), not the body's — the body's own set never carries
        // a ring map, so looking it up there disables the shadow entirely.
        // Mapless rings shadow with the same generated strip they are drawn
        // from, so the shadow bands match the rings that cast them.
        planet.setTextures(
          body.rings === null
            ? maps
            : { ...maps, ring: ringStrip(body, body.rings, anisotropy) },
        )
        planet.setBake(bake)
        if (sun !== null) setVector(planet.sunDirection.value, sun)
        setColor(planet.sunColor, uniforms.sunColor)
        setVector(planet.spinAxis.value, uniforms.spinAxis)
        setVector(planet.center.value, position)
        setColor(planet.baseColor, values.baseColor)
        setColor(planet.oceanColor, values.oceanColor)
        setNumber(planet.albedoScale, values.albedoScale)
        setNumber(planet.lunarLambert, values.lunarLambert)
        setNumber(planet.terminator, values.terminator)
        setNumber(planet.reliefScale, values.reliefScale)
        setNumber(planet.limbDarkening, values.limbDarkening)
        setNumber(planet.saturation, values.saturation)
        setNumber(planet.flowRate, values.flowRate)
        setNumber(planet.time, values.time)
        setNumber(planet.hazeStrength, values.hazeStrength)
        if (values.hazeColor !== null)
          setColor(planet.hazeColor, values.hazeColor)
        if (values.hazeLimb !== null) setColor(planet.hazeLimb, values.hazeLimb)
        setNumber(planet.specularStrength, values.specularStrength)
        setNumber(planet.nightStrength, values.nightStrength)
        setNumber(planet.cloudShadow, values.cloudShadow)
        setNumber(planet.cloudHeight, values.cloudHeight)
        setNumber(planet.ringInner, values.ringInner)
        setNumber(planet.ringOuter, values.ringOuter)
        setNumber(planet.ringOpacity, values.ringOpacity)
      }

      /* --- the cloud deck ------------------------------------------------- */
      if (visual.clouds !== null && visual.cloudMaterial !== null) {
        const values = uniforms.clouds
        visual.clouds.visible = values !== null
        if (values !== null) {
          visual.clouds.position.copy(visual.mesh.position)
          visual.clouds.quaternion.copy(quaternion)
          setVector(visual.clouds.scale, values.scale)
          visual.clouds.geometry = geometryFor(body.placement.angularRadius)
          const material = visual.cloudMaterial
          material.setTexture(maps.clouds)
          setNumber(material.entryDistance, values.entryDistance)
          setNumber(material.eyeAltitude, values.eyeAltitude)
          setColor(material.baseColor, values.baseColor)
          if (sun !== null) setVector(material.sunDirection.value, sun)
          setColor(material.sunColor, uniforms.sunColor)
          if (values.sunsetColor !== null)
            setColor(material.sunsetColor, values.sunsetColor)
          setNumber(material.opacity, values.opacity)
          setNumber(material.drift, values.drift)
        }
      }

      /* --- the rings ------------------------------------------------------ */
      if (visual.rings !== null && visual.ringMaterial !== null) {
        const values = uniforms.rings
        const ring = body.rings
        visual.rings.visible = values !== null
        if (values !== null && ring !== null) {
          visual.rings.position.copy(visual.mesh.position)
          visual.rings.quaternion.copy(quaternion)
          visual.rings.scale.setScalar(values.extent)
          const material = visual.ringMaterial
          material.setTexture(ringStrip(body, ring, anisotropy))
          if (sun !== null) setVector(material.sunDirection.value, sun)
          setColor(material.sunColor, uniforms.sunColor)
          setNumber(material.innerFraction, values.innerFraction)
          setVector(material.center.value, position)
          setNumber(material.bodyRadius, values.bodyRadius)
          setNumber(material.opticalDepth, values.opticalDepth)
          setColor(material.baseColor, values.baseColor)
        }
      }

      /* --- the atmosphere ------------------------------------------------- */
      const shell = uniforms.atmosphere
      visual.atmosphere.visible = shell !== null
      if (shell !== null) {
        visual.atmosphere.position.copy(visual.mesh.position)
        visual.atmosphere.quaternion.copy(quaternion)
        setVector(visual.atmosphere.scale, shell.scale)
        visual.atmosphere.geometry = geometryFor(body.placement.angularRadius)
        const air = visual.atmosphereMaterial
        setVector(air.center.value, position)
        setNumber(air.outerRadius, shell.outerRadius)
        setNumber(air.innerRadius, shell.innerRadius)
        setVector(air.spinAxis.value, uniforms.spinAxis)
        setNumber(air.flattening, shell.flattening)
        const haze = appearance.haze
        if (haze !== null) {
          /*
           * Cached after the first ask; baked on the pool when there is one,
           * and drawn with the stand-ins — a vacuum — until the tables land,
           * because a 40 ms bake inside this frame is the largest single
           * thing an arrival would pay. Written every frame, so the frame the
           * tables arrive on is the frame they bind. `atmosphereLuts.ts`.
           */
          const pool = engine.pool()
          const scattering =
            pool === null
              ? scatteringFor(haze, body.atmosphereScale)
              : scatteringVia(pool, haze, body.atmosphereScale)
          if (scattering !== null)
            air.setScattering(
              scattering.recipe,
              scattering.transmittance,
              scattering.multiScatter,
            )
        }
        setColor(air.sunColor, uniforms.sunColor)
        if (sun !== null) setVector(air.sunDirection.value, sun)
      }
    }

    for (const body of scene.bodies) draw(body.address, body, null)
    for (const star of scene.stars)
      draw(starKey(star), starAsBody(star, visibility), star.color)

    residency.end()

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
        // The census hears the queue's length here: boot's progress total
        // once excluded this queue entirely, so the status line said
        // "compiling the sky…" while the work measured at 88 ms had not
        // started.
        residency.plan(queue)
      }

      // Residency decides whether there is room, requeues at a cap nothing
      // can be evicted from, and credits the ticket; what it built is
      // compiled here, the moment it exists.
      const visual = residency.buildAhead((task) =>
        materialize(task.star, task.clouded, task.ringed),
      )
      if (visual !== null) {
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
      }
    }
  })

  return <group ref={group} />
}

/** The strip a ring is drawn from: its photograph, or one generated for it. */
function ringStrip(
  body: RenderBody,
  ring: NonNullable<RenderBody['rings']>,
  anisotropy: number,
): Texture | null {
  return ring.texture === null
    ? proceduralRingStrip(body.kind, body.address)
    : texturesFor(ring.texture, anisotropy).ring
}

/*
 * The writes, each compared first. A uniform is read by reference every
 * frame, so a write that changes nothing is pure cost — and most of a body's
 * uniforms are the same from one frame to the next.
 */
function setNumber(uniform: { value: number }, value: number): void {
  if (uniform.value !== value) uniform.value = value
}

function setColor(uniform: { value: Color }, rgb: Rgb): void {
  const color = uniform.value
  if (color.r !== rgb.r || color.g !== rgb.g || color.b !== rgb.b)
    color.setRGB(rgb.r, rgb.g, rgb.b)
}

function setVector(target: Vector3, value: Vec3): void {
  if (target.x !== value.x || target.y !== value.y || target.z !== value.z)
    target.set(value.x, value.y, value.z)
}
