import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LIGHT_YEAR } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import {
  BufferAttribute,
  BufferGeometry,
  type Group,
  Mesh,
  MeshStandardNodeMaterial,
  type PointLight,
  SphereGeometry,
  Sprite,
  Vector3,
} from 'three/webgpu'
import type { RenderBody } from '@inertialref/rendering'
import {
  chaseCameraPosition,
  chaseOffsetFor,
  placeOnStarShell,
} from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import {
  type AtmosphereMaterial,
  createAtmosphereMaterial,
  createStarfieldMaterial,
  createStarMaterial,
  createTerrainMaterial,
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
import { createLensFlare } from '../render/flare.ts'
import { createWarpEffects } from '../render/warpEffects.ts'
import { type FlareOccluder, sunVisibility } from '../render/flareMath.ts'
import { texturesFor } from '../render/planetTextures.ts'
import { proceduralRingStrip } from '../render/proceduralRings.ts'
import {
  DEFAULT_SHIP,
  type LoadedShip,
  loadShipModel,
} from '../render/shipModels.ts'
import type { PerspectiveCamera } from 'three/webgpu'

/*
 * The React Three Fiber layer.
 *
 * Every component here is a *consumer* of the scene description the rendering
 * package produced. None of them decide where anything is, none of them hold
 * simulation state, and none of them run gameplay logic in an effect. When a
 * frame is drawn they read plain numbers and write them onto Three.js objects.
 *
 * Bodies and terrain are mutated imperatively rather than re-rendered: a React
 * reconcile per planet per frame at 144 Hz is a great deal of work to arrive at
 * the same matrix, and the scene graph is small and fixed enough that direct
 * mutation stays legible.
 *
 * Everything imports from `three/webgpu`, never `three`. The two entry points
 * share `three.core.js`, so `Mesh` is the same class either way and R3F's own
 * `instanceof` checks hold — but only `three/webgpu` carries the node system,
 * and a material picked out of the wrong one is a classic material that the
 * renderer has to convert behind your back. Materials themselves live in
 * `../render/materials.ts`; what is here is placement.
 */

const MAX_BODIES = 64
const MAX_STARS = 20_000

/** Fallback colour for a star whose survey predates the colour column. */
const WHITE: readonly [number, number, number] = [1, 1, 1]

/**
 * Magnitudes below the brightest star at which a star reaches the floor.
 *
 * Measured, not chosen: a 40 ly sweep from Alpha Centauri spans 20.7 magnitudes
 * with a median at 13.2. At 17 the median star lands around a fifth of the ramp
 * and the top percentile is clearly separated, which is what makes the sky read
 * as a sky rather than as noise. Larger flattens it; smaller loses everything
 * below the median into the floor.
 */
const MAGNITUDE_RANGE = 17

export function SceneView({ engine }: { engine: GameEngine }) {
  return (
    <>
      {/* Space is genuinely high-contrast, but a debug build that renders its
          own spacecraft as a black silhouette is not a debug build. A little
          ambient plus a dim camera-mounted fill keeps the near field readable
          without flattening the terminator on a planet. */}
      <ambientLight intensity={0.16} />
      <EngineTick engine={engine} />
      <CameraRig engine={engine} />
      <Starfield engine={engine} />
      <Bodies engine={engine} />
      <TerrainPatches engine={engine} />
      <SunFlare engine={engine} />
      <ShipModel engine={engine} />
      <NearFieldProps engine={engine} />
      <WarpFx engine={engine} />
    </>
  )
}

/**
 * The cutscene's warp streaks, nacelle glow, flash wash and motion smear —
 * dormant (one visibility check per frame) unless a cutscene is playing.
 * Camera-space quads on the flare's pattern; see `render/warpEffects.ts`.
 */
function WarpFx({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  // Same memo-without-dispose shape as SunFlare, same StrictMode reason.
  const fx = useMemo(
    () => createWarpEffects(() => engine.hull?.lengthMetres ?? 6),
    [engine],
  )

  useFrame(() => {
    fx.update(camera as PerspectiveCamera, engine.cinematic)
  })

  return <primitive object={fx.group} />
}

/**
 * The key light's lens flare, driven from the same scene description as the
 * bodies: `stars[0]` is the star that lights the scene, and the occluders are
 * every drawn body — which is what lets the flare fade *smoothly* behind a
 * limb instead of popping when a depth sample flips. See `render/flare.ts`.
 */
function SunFlare({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  // No dispose-on-unmount effect, deliberately, and `Starfield` is the
  // precedent: StrictMode remounts run cleanup against the *memoized*
  // instance and then mount it again, so a dispose here empties the group
  // for good — seven quads with nothing left inside them. R3F removes the
  // primitive from the scene on unmount; the handful of GPU objects live as
  // long as the renderer, like the starfield's do.
  const flare = useMemo(createLensFlare, [])

  useFrame(() => {
    const scene = engine.scene()
    const star = scene?.stars[0]
    if (!engine.lensFlare || scene == null || star === undefined) {
      flare.group.visible = false
      return
    }
    const occluders: FlareOccluder[] = scene.bodies.map((body) => ({
      position: body.placement.position,
      radius: body.placement.scale,
    }))
    // The flare is a lens's response to an unresolved point of glare. Once
    // the disc is genuinely resolved — the star-orbit arrival subtends ~15°
    // — the camera is exposed for the surface and the artifact stack fades,
    // or the flare's core repaints the stopped-down photosphere back to a
    // clipped white circle. Same ramp as the disc's own exposure.
    const filling = Math.min(
      1,
      Math.max(0, (star.placement.angularRadius - 0.015) / 0.085),
    )
    flare.update(
      camera as PerspectiveCamera,
      star.placement.position,
      star.color,
      star.brightness * (1 - filling * 0.85),
      star.placement.angularRadius,
      sunVisibility(scene.camera.position, star.placement.position, occluders),
      // The cinematic camera is a cleaner lens than the flight one; see the
      // `artifacts` note in `flare.ts`. 0.05 rather than 0 so a scripted shot
      // still has a lens, just not one that argues with the composition: at
      // 0.12 the iris ghosts were still three visible grey discs marching
      // across an empty half-frame beside Jupiter.
      engine.cinematic === null ? 1 : 0.05,
    )
  })

  return <primitive object={flare.group} />
}

/**
 * Steps the simulation, once per animation frame, before anything reads it.
 *
 * Its own component with an explicit negative priority rather than a line at the
 * top of `CameraRig`. R3F runs equal-priority `useFrame` callbacks in mount
 * order, so while the tick lived inside `CameraRig` the correctness of every
 * other consumer — `Starfield`, `Bodies`, `TerrainPatches`, `ShipModel`,
 * `NearFieldProps` — rested on `<CameraRig />` appearing first in the fragment
 * above. Moving one JSX line would have made every planet render a frame stale,
 * silently. Priority says it instead.
 */
function EngineTick({ engine }: { engine: GameEngine }) {
  useFrame((_, delta) => {
    // The one place the wall clock enters the game, and it is handed over raw.
    // It used to be clamped to 0.25 s here, which changed nothing about the
    // spiral of death — `SimulationClock.advance` already caps a step at
    // DEFAULT_MAX_STEPS — and did corrupt the diagnostic: the clock books the
    // excess as `droppedTicks`, so a three-minute background stall was reported
    // in the HUD as 8 dropped ticks instead of 11,520.
    engine.frame(delta)
  }, -1)
  return null
}

/** Drives the real camera from the ship's canonical state, once per frame. */
function CameraRig({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  const light = useRef<PointLight>(null)

  useFrame(() => {
    const scene = engine.scene()
    if (scene === null) return

    // The cutscene owns the whole pose when one is playing: its camera is the
    // scene's eye already (`buildScene` was handed the same pose), so the
    // chase offset must not be applied on top — the director frames shots,
    // not chase views. The flight FOV yields to the script's lens the same
    // way, and both come back the moment `cinematic` returns to null.
    const cinematic = engine.cinematic

    // The camera panel's field of view, applied here rather than pushed at
    // the camera from React: the canvas remounts on an HDR change and R3F
    // builds a fresh camera, so the engine's value is the durable one and
    // this is the only place that writes it. Guarded, because
    // `updateProjectionMatrix` every frame is waste.
    const fov = cinematic === null ? engine.fov : cinematic.fov
    const perspective = camera as PerspectiveCamera
    if (perspective.isPerspectiveCamera && perspective.fov !== fov) {
      perspective.fov = fov
      perspective.updateProjectionMatrix()
    }

    camera.quaternion.set(
      scene.camera.orientation.x,
      scene.camera.orientation.y,
      scene.camera.orientation.z,
      scene.camera.orientation.w,
    )
    // Offset and ground clearance both come from `chaseCameraPosition`. They
    // were three lines of vector arithmetic here, which is exactly where a rule
    // goes to become untestable: nothing in Node could see that pitching up on
    // the pad put the camera under the crust.
    // The offset scales with the modelled hull once one is mounted; the
    // hand-tuned 6 m default covers the debug cone. `engine.hull` rather than
    // anything module-scoped here — see the field's comment in `GameEngine`.
    const eye =
      cinematic === null
        ? chaseCameraPosition(
            scene,
            engine.hull === null
              ? undefined
              : chaseOffsetFor(engine.hull.lengthMetres),
          )
        : cinematic.camera.position
    camera.position.set(eye.x, eye.y, eye.z)
    camera.updateMatrixWorld()

    // Sunlight comes from the nearest star's rendered position, so shadows and
    // terminators line up with where the star actually is.
    const star = scene.stars[0]
    if (star !== undefined && light.current !== null) {
      light.current.position.set(
        star.placement.position.x,
        star.placement.position.y,
        star.placement.position.z,
      )
      light.current.color.setRGB(star.color.r, star.color.g, star.color.b)
    }
  })

  return (
    <>
      {/* decay 0: the star is tens of millions of render-metres away after
          compression, so physical falloff would make it useless as a light. */}
      <pointLight ref={light} intensity={4} distance={0} decay={0} />
      <directionalLight position={[0.4, 1, 0.8]} intensity={0.35} />
    </>
  )
}

/**
 * Distant stars, as one instanced sprite draw.
 *
 * A `Points` cloud until the WebGPU migration, and it could not stay one: WebGPU
 * has no point size, so every star would have been a single pixel on the backend
 * this renderer is for while still looking right on the WebGL fallback. The
 * geometry is the sprite's own unit quad; `count` and the instanced position
 * buffer are what move. See `createStarfieldMaterial`.
 */
function Starfield({ engine }: { engine: GameEngine }) {
  const field = useMemo(() => createStarfieldMaterial(MAX_STARS), [])
  const sprite = useMemo(() => {
    const object = new Sprite(field.material)
    object.count = 0
    // The bounding sphere describes the unit quad at the origin, not the shell
    // the instances are scattered over, so culling it would remove the entire
    // sky the moment the camera looked away from the origin.
    object.frustumCulled = false
    // Behind everything. The shell is far outside the depth range and the stars
    // are additive, so what protects the planets from being drawn over is order.
    object.renderOrder = -2
    return object
  }, [field])

  const generation = useRef(-1)
  const surveyed = useRef(-1)

  useFrame(() => {
    const scene = engine.scene()
    const stars = engine.starField
    if (scene === null) return
    if (
      generation.current === scene.origin.generation &&
      surveyed.current === stars.positions.length
    )
      return

    generation.current = scene.origin.generation
    surveyed.current = stars.positions.length
    const array = field.positions.array as Float32Array
    const colours = field.colours.array as Float32Array
    const prominence = field.prominence.array as Float32Array

    // Stars sit far outside the depth range, so they are drawn on a fixed
    // sphere around the camera: direction is what matters, distance is not
    // representable and not observable. The projection itself belongs to
    // `rendering`, which owns render space — doing it here meant a hand-written
    // copy of the sector arithmetic that also forgot the origin's orientation.
    //
    // Distance is not observable *in the geometry*, which is why how bright each
    // star looks has to be computed here, before it is discarded.
    let written = 0
    let brightest = 0
    const flux: number[] = []
    for (let i = 0; i < stars.positions.length; i += 1) {
      if (written >= MAX_STARS) break
      const position = stars.positions[i] as UniverseVector
      const point = placeOnStarShell(scene.origin, position)
      if (point === null) continue
      array[written * 3] = point.x
      array[written * 3 + 1] = point.y
      array[written * 3 + 2] = point.z
      const colour = stars.colours[i] ?? WHITE
      colours[written * 3] = colour[0]
      colours[written * 3 + 1] = colour[1]
      colours[written * 3 + 2] = colour[2]

      const metres = UV.distance(position, scene.origin.position)
      // The one-light-year floor keeps a star the camera is inside from
      // dividing by nothing. Nothing is that close except the system's own sun,
      // which is drawn as a body rather than a point.
      const light = Math.max(metres, LIGHT_YEAR)
      const value = (stars.luminosities[i] ?? 1) / (light * light)
      flux.push(value)
      if (value > brightest) brightest = value
      written += 1
    }

    /*
     * Flux to a magnitude, then a magnitude to a ramp.
     *
     * Magnitudes because the range is otherwise unusable: within a 40 ly sweep
     * the apparent flux spans 20 magnitudes — a factor of 10^8 — so a linear
     * normalisation leaves the median star at 10^-5 of the brightest and the sky
     * comes out black. That was the first attempt and it is what a photometer
     * would see; a magnitude scale is the logarithmic one astronomy uses for
     * exactly this reason, and it is also roughly how the eye responds.
     *
     * Relative to the brightest star currently in view rather than an absolute
     * zero point, because that is what adaptation does. An absolute scale would
     * darken the whole sky on the way out of the neighbourhood, when what really
     * happens is that your eyes adjust.
     */
    for (let i = 0; i < written; i += 1) {
      const magnitude =
        brightest === 0 ? 0 : -2.5 * Math.log10((flux[i] as number) / brightest)
      prominence[i] = Math.max(0, Math.min(1, 1 - magnitude / MAGNITUDE_RANGE))
    }

    field.colours.needsUpdate = true
    field.prominence.needsUpdate = true
    field.positions.needsUpdate = true
    sprite.count = written
  })

  return <primitive object={sprite} />
}

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
 * Solar System puts twenty-eight bodies in the scene at once and most of them
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

function tuningFor(body: RenderBody): PlanetTuning {
  const air = body.hasAtmosphere
  const giant = body.kind === 'gas-giant' || body.kind === 'ice-giant'
  if (giant)
    return {
      // A cloud deck kilometres thick is as close to Lambert as anything gets,
      // and its terminator is soft because there is no surface to end at.
      lunarLambert: 0.1,
      terminator: 0.22,
      reliefScale: 0,
      specular: 0,
      night: 0,
      // The two knobs that separate a decal from a photograph of a giant:
      // the disc rolls off toward the limb, and the published near-true-colour
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
    // on top of this, and 0.45 under the veil left the disc reading flat.
    lunarLambert: air ? 0.3 : 0.92,
    terminator: air ? 0.09 : 0.025,
    limbDarkening: 0,
    saturation: 1,
    flowRate: 0,
    /*
     * Normal-map exaggeration, and the honest name for it.
     *
     * At 4096 across, one texel of Earth is ten kilometres, and the real slope
     * across ten kilometres is a fraction of a degree — measured: the normal map
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

/** Planets, moons and stars, placed from the scene description. */
function Bodies({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const visuals = useMemo(() => new Map<string, BodyVisual>(), [])
  const anisotropy = useThree(
    (state) => state.gl.capabilities?.getMaxAnisotropy?.() ?? 8,
  )
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
   * a stale Saturn ring, forty thousand kilometres across and still visible,
   * hung across the Moon as a set of dark horizontal bands that looked
   * convincingly like a texture bug for rather too long.
   */
  useEffect(
    () => () => {
      for (const visual of visuals.values()) {
        for (const object of [
          visual.mesh,
          visual.atmosphere,
          visual.clouds,
          visual.rings,
        ]) {
          if (object === null) continue
          object.removeFromParent()
          const material = object.material
          if (Array.isArray(material)) for (const m of material) m.dispose()
          else material.dispose()
        }
      }
      visuals.clear()
      for (const tier of spheres) tier.geometry.dispose()
      rings.dispose()
    },
    [visuals, spheres, rings],
  )

  useFrame(() => {
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
        for (const object of [
          visual.mesh,
          visual.atmosphere,
          visual.clouds,
          visual.rings,
        ]) {
          if (object === null) continue
          object.removeFromParent()
          const material = object.material
          if (Array.isArray(material)) for (const m of material) m.dispose()
          else material.dispose()
        }
        visuals.delete(key)
        return true
      }
      return false
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
        const starMaterial = star === null ? null : createStarMaterial()
        const planet = star === null ? createPlanetMaterial() : null
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
        if (appearance.clouds !== null) {
          cloudMaterial = createCloudMaterial()
          clouds = new Mesh(spheres[0]!.geometry, cloudMaterial.material)
          clouds.renderOrder = 1
          container.add(clouds)
        }

        let ringMesh: Mesh | null = null
        let ringMaterial: RingMaterial | null = null
        if (body.rings !== null) {
          ringMaterial = createRingMaterial()
          ringMesh = new Mesh(rings, ringMaterial.material)
          ringMesh.renderOrder = 2
          container.add(ringMesh)
        }

        visual = {
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
      // Oblate, in the body's own frame — so the quaternion tilts the bulge with
      // the spin axis, which is the whole point. Saturn is 9.8% flattened and
      // reads as wrong long before anyone can say why.
      visual.mesh.scale.set(
        placement.scale,
        placement.scale * body.flattening,
        placement.scale,
      )
      visual.mesh.geometry = geometryFor(placement.angularRadius)
      visual.mesh.visible = true
      // A body drawn as streamed terrain does not also need its datum sphere,
      // except as the sea floor below it.
      visual.mesh.renderOrder = placement.tier === 'surface' ? -1 : 0

      // The colour is a uniform rather than a construction argument because a
      // star's rendered colour is derived from its temperature every frame, and
      // a material built once from the first frame's value would freeze it.
      if (star !== null && visual.star !== null) {
        visual.star.color.value.setRGB(star.r, star.g, star.b)
        // Presentation time, for the granulation churn — simulation seconds,
        // so time warp stirs the photosphere faster, which reads as intended.
        visual.star.time.value = engine.snapshot?.renderTime ?? 0
        // Stop down as the disc grows: a sun that fills the frame is exposed
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
          // entry would be — leaves this zero-length, and a normalised zero is
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
         * what colour the sky is. Giants get less: their "surface" already is
         * cloud-top, and a full-strength veil flattened Jupiter's bands into
         * fog. The veil is what limb-brightens an atmosphere-bearing disc;
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
        // In render metres, because the shader measures the sun ray's
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
           * Earth's cloud tops are twelve kilometres up on a radius of six
           * thousand, which is 0.2% and is a shell you cannot see past at the
           * limb. What sells a cloud deck from orbit is precisely that parallax
           * — the clouds overhanging the edge of the disc — and the altitude is
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
          // mapped deck keeps its own colours untinted.
          if (cloudMap === null)
            material.baseColour.value.setRGB(
              appearance.colour.r,
              appearance.colour.g,
              appearance.colour.b,
            )
          else material.baseColour.value.setRGB(1, 1, 1)
          material.sunDirection.value.copy(sun)
          material.sunColour.value.setRGB(keyColour.r, keyColour.g, keyColour.b)
          // The deck's dusk colour is the body's authored sunset, so clouds
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
          // In render metres: the eclipse test runs on `positionWorld`, so a
          // mesh-local value (1/outerScale) never shadowed a single fragment.
          material.bodyRadius.value = placement.scale
          material.opticalDepth.value = ring.opticalDepth
          // A generated strip carries its own greys — re-dying it with the
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
          atmosphereScale: 1,
          trueRadius: 1,
          rotationPeriod: 1,
          flattening: 1,
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

/**
 * Streamed terrain patches: geometry uploaded once, moved every frame.
 *
 * The two halves are separate on purpose. A patch's vertices are body-fixed and
 * never change, so re-uploading them is pure waste — this used to hand Three.js
 * three new BufferAttributes per patch per frame. Where the patch *is* changes
 * constantly, because the planet is orbiting and turning, and that is a position
 * and a quaternion. Baking the second into the first is what made the ground
 * slide away from the ship between origin rebases.
 */
function TerrainPatches({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const meshes = useMemo(() => new Map<string, Mesh>(), [])
  const material = useMemo(() => createTerrainMaterial(), [])

  useFrame(() => {
    const container = group.current
    if (container === null) return
    const state = engine.terrainState()
    // The streamer owns how present terrain is at this altitude; the material
    // just wears the number. `transparent` toggles with it because an opaque
    // material ignores opacity, and a permanently transparent one would be
    // sorted and blended on every frame of ordinary ground.
    material.opacity = state.opacity
    material.transparent = state.opacity < 1
    const seen = new Set<string>()

    for (const { patch, placement } of state.patches) {
      const key = `${patch.region.face}.${patch.region.level}.${patch.region.i}.${patch.region.j}`
      seen.add(key)
      let mesh = meshes.get(key)
      if (mesh === undefined) {
        const geometry = new BufferGeometry()
        geometry.setAttribute(
          'position',
          new BufferAttribute(patch.positions, 3),
        )
        geometry.setAttribute('normal', new BufferAttribute(patch.normals, 3))
        geometry.setIndex(new BufferAttribute(patch.indices, 1))
        geometry.computeBoundingSphere()
        mesh = new Mesh(geometry, material)
        container.add(mesh)
        meshes.set(key, mesh)
      }
      mesh.position.set(
        placement.position.x,
        placement.position.y,
        placement.position.z,
      )
      mesh.quaternion.set(
        placement.orientation.x,
        placement.orientation.y,
        placement.orientation.z,
        placement.orientation.w,
      )
      mesh.visible = true
    }

    for (const [key, mesh] of meshes) {
      if (!seen.has(key)) {
        mesh.visible = false
        container.remove(mesh)
        mesh.geometry.dispose()
        meshes.delete(key)
      }
    }
  })

  return <group ref={group} />
}

/**
 * Materials for the debug hardware.
 *
 * Module-level because there are six of them, they never change, and a node
 * material is a pipeline: rebuilding them per mount would be six pipeline builds
 * to draw the same grey box. Constructing a node material touches no GPU — it is
 * a graph, and the pipeline is compiled the first time something draws with it.
 */
const debugMaterials = {
  hull: new MeshStandardNodeMaterial({
    color: 0xd8dde6,
    roughness: 0.6,
    metalness: 0.2,
  }),
  wing: new MeshStandardNodeMaterial({ color: 0x8f98a8, roughness: 0.7 }),
  bell: new MeshStandardNodeMaterial({
    color: 0x3a4048,
    roughness: 0.4,
    metalness: 0.6,
  }),
  metre: new MeshStandardNodeMaterial({ color: 0xe0b060, roughness: 0.8 }),
  foot: new MeshStandardNodeMaterial({ color: 0x60c0a0, roughness: 0.8 }),
  inch: new MeshStandardNodeMaterial({ color: 0xe06060, roughness: 0.8 }),
}

/**
 * The player's ship: a modelled hull once its glTF resolves, the debug cone
 * until then and whenever loading fails. The cone is the same degradation
 * story as the star catalogue's Sol fallback — the flight model neither knows
 * nor cares what the hull looks like.
 */
function ShipModel({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const anisotropy = useThree(
    (state) => state.gl.capabilities?.getMaxAnisotropy?.() ?? 8,
  )
  // Seeded from the engine so a Fast Refresh remount, whose effect may not
  // re-run, still renders the hull the session already loaded.
  const [hull, setHull] = useState<LoadedShip | null>(engine.hull)

  useEffect(() => {
    // The loader caches by id, so StrictMode's double-mount and the canvas
    // remount on an HDR change reuse the same fetch and the same meshes.
    let mounted = true
    void loadShipModel(DEFAULT_SHIP, anisotropy).then((ship) => {
      if (mounted && ship !== null) {
        engine.hull = ship
        setHull(ship)
      }
    })
    return () => {
      mounted = false
    }
  }, [engine, anisotropy])

  useFrame(() => {
    const scene = engine.scene()
    if (scene === null || group.current === null) return

    // A playing cutscene borrows the hull as its hero prop: the director says
    // where it is and whether it is on stage at all, and the entity underneath
    // — still simulating, chase-framed, wherever the player left it — is not
    // drawn until the scene hands everything back.
    const cinematic = engine.cinematic
    if (cinematic !== null) {
      group.current.visible = cinematic.ship.visible
      group.current.position.set(
        cinematic.ship.position.x,
        cinematic.ship.position.y,
        cinematic.ship.position.z,
      )
      group.current.quaternion.set(
        cinematic.ship.orientation.x,
        cinematic.ship.orientation.y,
        cinematic.ship.orientation.z,
        cinematic.ship.orientation.w,
      )
      return
    }

    group.current.visible = engine.showShip
    const ship = scene.entities.find((entity) => entity.isCamera)
    if (ship === undefined) return
    group.current.position.set(
      ship.position.x,
      ship.position.y,
      ship.position.z,
    )
    group.current.quaternion.set(
      ship.orientation.x,
      ship.orientation.y,
      ship.orientation.z,
      ship.orientation.w,
    )
  })

  // No dispose on unmount, and Starfield is the precedent: the loader owns the
  // hull for the life of the renderer, and R3F only detaches the primitive.
  return (
    <group ref={group}>
      {hull !== null ? (
        <primitive object={hull.group} />
      ) : (
        <>
          {/* Nose along −Z, matching the forward convention the whole codebase uses. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} material={debugMaterials.hull}>
            <coneGeometry args={[1.4, 6, 4]} />
          </mesh>
          <mesh position={[0, 0, 1.6]} material={debugMaterials.wing}>
            <boxGeometry args={[5.2, 0.3, 1.6]} />
          </mesh>
          {/* Engine bell, so which way is aft is unambiguous at a glance. */}
          <mesh position={[0, 0, 3.2]} material={debugMaterials.bell}>
            <cylinderGeometry args={[0.9, 1.2, 1.2, 12]} />
          </mesh>
        </>
      )}
    </group>
  )
}

/**
 * Metre-scale reference objects around the player.
 *
 * Milestone requirement 8, made visible: a metre grid and a one-metre cube sat
 * next to the ship, four light-years from the galactic origin, so the precision
 * claim is something you can look at rather than only assert in a test.
 */
function NearFieldProps({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const rack = useRef<Group>(null)

  useFrame(() => {
    const scene = engine.scene()
    if (scene === null || group.current === null) return
    // The props ride the same toggle as the ship: both are debug hardware, and
    // a bookmarked composition wants neither in the middle of it. A cutscene
    // wants them even less — a metre cube beside a 642 m hero hull is a gag.
    group.current.visible = engine.showShip && engine.cinematic === null
    // ±4 m from the origin was beside the debug cone; inside a modelled hull
    // it is somewhere in the saucer's wiring. Slide the rack out past the
    // starboard beam so the cubes stay inspectable next to the hull.
    if (rack.current !== null) {
      rack.current.position.x =
        engine.hull === null ? 0 : engine.hull.beamMetres / 2 + 40
    }
    const ship = scene.entities.find((entity) => entity.isCamera)
    if (ship === undefined) return
    group.current.position.set(
      ship.position.x,
      ship.position.y,
      ship.position.z,
    )
    group.current.quaternion.set(
      ship.orientation.x,
      ship.orientation.y,
      ship.orientation.z,
      ship.orientation.w,
    )
  })

  return (
    <group ref={group}>
      <group ref={rack}>
        {/* One metre. */}
        <mesh position={[4, 0, 0]} material={debugMaterials.metre}>
          <boxGeometry args={[1, 1, 1]} />
        </mesh>
        {/* One foot. */}
        <mesh position={[-4, 0, 0]} material={debugMaterials.foot}>
          <boxGeometry args={[0.3048, 0.3048, 0.3048]} />
        </mesh>
        {/* One inch — the smallest thing the spec asks the coordinate system to
            resolve, sitting 8 kiloparsecs from the universe origin. */}
        <mesh position={[-4.7, 0, 0]} material={debugMaterials.inch}>
          <boxGeometry args={[0.0254, 0.0254, 0.0254]} />
        </mesh>
      </group>
    </group>
  )
}
