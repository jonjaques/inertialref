import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { LIGHT_YEAR } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  type Group,
  Mesh,
  MeshStandardNodeMaterial,
  type PointLight,
  SphereGeometry,
  Sprite,
} from 'three/webgpu'
import type { RenderBody } from '@inertialref/rendering'
import { chaseCameraPosition, placeOnStarShell } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import {
  type AtmosphereMaterial,
  createAtmosphereMaterial,
  createBodyMaterial,
  createStarfieldMaterial,
  createStarMaterial,
  createTerrainMaterial,
  type StarMaterial,
} from '../render/materials.ts'

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
      <ShipModel engine={engine} />
      <NearFieldProps engine={engine} />
    </>
  )
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
    const eye = chaseCameraPosition(scene)
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
  readonly atmosphere: Mesh
  readonly atmosphereMaterial: AtmosphereMaterial
  readonly star: StarMaterial | null
}

/** Planets, moons and stars as spheres, placed from the scene description. */
function Bodies({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const visuals = useMemo(() => new Map<string, BodyVisual>(), [])
  const geometry = useMemo(() => new SphereGeometry(1, 48, 32), [])

  useFrame(() => {
    const scene = engine.scene()
    const container = group.current
    if (scene === null || container === null) return

    // Render-space position of the key light, for the atmosphere terminator.
    // `stars[0]` is documented as brightest-apparent-first, which is the same
    // star `CameraRig` lights the scene with — they must not disagree.
    const keyLight = scene.stars[0]?.placement.position ?? null

    const seen = new Set<string>()
    const draw = (
      key: string,
      body: Pick<
        RenderBody,
        | 'placement'
        | 'orientation'
        | 'hasAtmosphere'
        | 'atmosphereScale'
        | 'kind'
      >,
      color: Color,
      star: { r: number; g: number; b: number } | null,
    ): void => {
      seen.add(key)
      let visual = visuals.get(key)
      if (visual === undefined) {
        if (visuals.size >= MAX_BODIES) return
        const starMaterial = star === null ? null : createStarMaterial()
        const atmosphereMaterial = createAtmosphereMaterial()
        const mesh = new Mesh(
          geometry,
          starMaterial?.material ?? createBodyMaterial(color),
        )
        const atmosphere = new Mesh(geometry, atmosphereMaterial.material)
        atmosphere.visible = false
        container.add(mesh)
        container.add(atmosphere)
        visual = { mesh, atmosphere, atmosphereMaterial, star: starMaterial }
        visuals.set(key, visual)
      }

      const { placement, orientation } = body
      visual.mesh.position.set(
        placement.position.x,
        placement.position.y,
        placement.position.z,
      )
      visual.mesh.quaternion.set(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w,
      )
      visual.mesh.scale.setScalar(placement.scale)
      visual.mesh.visible = true
      // A body drawn as streamed terrain does not also need its datum sphere,
      // except as the sea floor below it.
      visual.mesh.renderOrder = placement.tier === 'surface' ? -1 : 0

      // The colour is a uniform rather than a construction argument because a
      // star's rendered colour is derived from its temperature every frame, and
      // a material built once from the first frame's value would freeze it.
      if (star !== null && visual.star !== null)
        visual.star.color.value.setRGB(star.r, star.g, star.b)

      visual.atmosphere.visible =
        body.hasAtmosphere && placement.tier !== 'point'
      if (visual.atmosphere.visible) {
        const shell = placement.scale * body.atmosphereScale
        visual.atmosphere.position.copy(visual.mesh.position)
        visual.atmosphere.scale.setScalar(shell)

        // The shell's shader needs the same geometry the transform above encodes,
        // in render space, because it integrates along the view ray rather than
        // shading a surface. Written every frame for the same reason the matrix
        // is: distance compression rescales both radii whenever the tier moves.
        const air = visual.atmosphereMaterial
        air.centre.value.copy(visual.mesh.position)
        air.outerRadius.value = shell
        air.innerRadius.value = placement.scale
        if (keyLight !== null) {
          air.sunDirection.value
            .set(keyLight.x, keyLight.y, keyLight.z)
            .sub(visual.mesh.position)
            // A body sitting exactly on its star — which is what a star's own
            // entry would be — leaves this zero-length, and a normalised zero is
            // NaN across the whole shell.
            .normalize()
        }
      }
    }

    for (const body of scene.bodies) {
      draw(body.address, body, bodyColor(body.kind), null)
    }
    for (const star of scene.stars) {
      draw(
        `star:${star.system}`,
        {
          placement: star.placement,
          orientation: { x: 0, y: 0, z: 0, w: 1 },
          hasAtmosphere: false,
          atmosphereScale: 1,
          kind: 'star',
        },
        new Color(star.color.r, star.color.g, star.color.b),
        star.color,
      )
    }

    for (const [key, visual] of visuals) {
      if (!seen.has(key)) {
        visual.mesh.visible = false
        visual.atmosphere.visible = false
      }
    }
  })

  return <group ref={group} />
}

function bodyColor(kind: string): Color {
  switch (kind) {
    case 'gas-giant':
      return new Color('#c9a27a')
    case 'ice-giant':
      return new Color('#7fb3d3')
    case 'ice':
      return new Color('#cfe4ee')
    case 'moon':
      return new Color('#9a9a96')
    default:
      return new Color('#8a6f56')
  }
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

/** The debug spacecraft. Primitives on purpose: this proves architecture, not art. */
function ShipModel({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)

  useFrame(() => {
    const scene = engine.scene()
    if (scene === null || group.current === null) return
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

  useFrame(() => {
    const scene = engine.scene()
    if (scene === null || group.current === null) return
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
  )
}
