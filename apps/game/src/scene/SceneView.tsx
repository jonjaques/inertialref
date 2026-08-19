import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { RenderBody } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'

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
 */

const MAX_BODIES = 64
const MAX_STARS = 20_000

export function SceneView({ engine }: { engine: GameEngine }) {
  return (
    <>
      {/* Space is genuinely high-contrast, but a debug build that renders its
          own spacecraft as a black silhouette is not a debug build. A little
          ambient plus a dim camera-mounted fill keeps the near field readable
          without flattening the terminator on a planet. */}
      <ambientLight intensity={0.16} />
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
 * Camera offset from the ship, in ship axes: behind and slightly above.
 *
 * A chase view rather than a cockpit, because the point of this milestone is to
 * see the ship, the metre-scale reference objects beside it and the planet in
 * one frame.
 */
const CHASE_OFFSET = new THREE.Vector3(0, 2.5, 14)

/** Drives the real camera from the ship's canonical state, once per frame. */
function CameraRig({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  const light = useRef<THREE.PointLight>(null)
  const offset = useMemo(() => new THREE.Vector3(), [])

  useFrame((_, delta) => {
    // The one place the wall clock enters the game. Clamped because a
    // backgrounded tab returns with a delta measured in minutes.
    engine.frame(Math.min(delta, 0.25))
    const scene = engine.scene
    if (scene === null) return

    camera.quaternion.set(
      scene.camera.orientation.x,
      scene.camera.orientation.y,
      scene.camera.orientation.z,
      scene.camera.orientation.w,
    )
    offset.copy(CHASE_OFFSET).applyQuaternion(camera.quaternion)
    camera.position.set(
      scene.camera.position.x + offset.x,
      scene.camera.position.y + offset.y,
      scene.camera.position.z + offset.z,
    )
    camera.updateMatrixWorld()

    // Sunlight comes from the nearest star's rendered position, so shadows and
    // terminators line up with where the star actually is.
    const star = scene.stars[0]
    if (star !== undefined && light.current !== null) {
      light.current.position.set(star.placement.position.x, star.placement.position.y, star.placement.position.z)
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

/** Distant stars as a single point cloud, positioned in render space. */
function Starfield({ engine }: { engine: GameEngine }) {
  const points = useRef<THREE.Points>(null)
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_STARS * 3), 3))
    g.setDrawRange(0, 0)
    return g
  }, [])
  const generation = useRef(-1)
  const count = useRef(0)

  useFrame(() => {
    const scene = engine.scene
    const field = engine.starField
    if (scene === null || points.current === null) return
    if (generation.current === scene.origin.generation && count.current === field.positions.length) return

    generation.current = scene.origin.generation
    count.current = field.positions.length
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute
    const array = attribute.array as Float32Array

    // Stars sit far outside the depth range, so they are drawn on a fixed
    // sphere around the camera: direction is what matters, distance is not
    // representable and not observable.
    let written = 0
    for (const position of field.positions) {
      if (written >= MAX_STARS) break
      const dx = (position.sx - scene.origin.position.sx) * 2 ** 40 + (position.ox - scene.origin.position.ox)
      const dy = (position.sy - scene.origin.position.sy) * 2 ** 40 + (position.oy - scene.origin.position.oy)
      const dz = (position.sz - scene.origin.position.sz) * 2 ** 40 + (position.oz - scene.origin.position.oz)
      const length = Math.hypot(dx, dy, dz)
      if (length === 0) continue
      const scale = 8e7 / length
      array[written * 3] = dx * scale
      array[written * 3 + 1] = dy * scale
      array[written * 3 + 2] = dz * scale
      written += 1
    }
    attribute.needsUpdate = true
    geometry.setDrawRange(0, written)
  })

  return (
    <points ref={points} geometry={geometry} frustumCulled={false}>
      <pointsMaterial size={2} sizeAttenuation={false} color="#cfd8ff" />
    </points>
  )
}

interface BodyVisual {
  readonly mesh: THREE.Mesh
  readonly atmosphere: THREE.Mesh
}

/** Planets, moons and stars as spheres, placed from the scene description. */
function Bodies({ engine }: { engine: GameEngine }) {
  const group = useRef<THREE.Group>(null)
  const visuals = useMemo(() => new Map<string, BodyVisual>(), [])
  const geometry = useMemo(() => new THREE.SphereGeometry(1, 48, 32), [])

  useFrame(() => {
    const scene = engine.scene
    const container = group.current
    if (scene === null || container === null) return

    const seen = new Set<string>()
    const draw = (
      key: string,
      body: Pick<RenderBody, 'placement' | 'orientation' | 'hasAtmosphere' | 'atmosphereScale' | 'kind'>,
      color: THREE.ColorRepresentation,
      emissive: boolean,
    ): void => {
      seen.add(key)
      let visual = visuals.get(key)
      if (visual === undefined) {
        if (visuals.size >= MAX_BODIES) return
        const material = emissive
          ? new THREE.MeshBasicMaterial({ color })
          : new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 })
        const mesh = new THREE.Mesh(geometry, material)
        const atmosphere = new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            color: '#6fa8ff',
            transparent: true,
            opacity: 0.14,
            side: THREE.BackSide,
            depthWrite: false,
          }),
        )
        atmosphere.visible = false
        container.add(mesh)
        container.add(atmosphere)
        visual = { mesh, atmosphere }
        visuals.set(key, visual)
      }

      const { placement, orientation } = body
      visual.mesh.position.set(placement.position.x, placement.position.y, placement.position.z)
      visual.mesh.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w)
      visual.mesh.scale.setScalar(placement.scale)
      visual.mesh.visible = true
      // A body drawn as streamed terrain does not also need its datum sphere,
      // except as the sea floor below it.
      visual.mesh.renderOrder = placement.tier === 'surface' ? -1 : 0

      visual.atmosphere.visible = body.hasAtmosphere && placement.tier !== 'point'
      if (visual.atmosphere.visible) {
        visual.atmosphere.position.copy(visual.mesh.position)
        visual.atmosphere.scale.setScalar(placement.scale * body.atmosphereScale)
      }
    }

    for (const body of scene.bodies) {
      draw(body.address, body, bodyColor(body.kind), false)
    }
    for (const star of scene.stars) {
      draw(
        `star:${star.system}`,
        { placement: star.placement, orientation: { x: 0, y: 0, z: 0, w: 1 }, hasAtmosphere: false, atmosphereScale: 1, kind: 'star' },
        new THREE.Color(star.color.r, star.color.g, star.color.b),
        true,
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

function bodyColor(kind: string): THREE.ColorRepresentation {
  switch (kind) {
    case 'gas-giant':
      return '#c9a27a'
    case 'ice-giant':
      return '#7fb3d3'
    case 'ice':
      return '#cfe4ee'
    case 'moon':
      return '#9a9a96'
    default:
      return '#8a6f56'
  }
}

/** Streamed terrain patches, rebuilt by the engine and drawn here. */
function TerrainPatches({ engine }: { engine: GameEngine }) {
  const group = useRef<THREE.Group>(null)
  const meshes = useMemo(() => new Map<string, THREE.Mesh>(), [])
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#9c8367', roughness: 1, flatShading: false }),
    [],
  )

  useFrame(() => {
    const container = group.current
    if (container === null) return
    const state = engine.terrainState()
    const seen = new Set<string>()

    for (const patch of state.patches) {
      const key = `${patch.region.face}.${patch.region.level}.${patch.region.i}.${patch.region.j}`
      seen.add(key)
      let mesh = meshes.get(key)
      if (mesh === undefined) {
        const geometry = new THREE.BufferGeometry()
        mesh = new THREE.Mesh(geometry, material)
        container.add(mesh)
        meshes.set(key, mesh)
      }
      const geometry = mesh.geometry
      geometry.setAttribute('position', new THREE.BufferAttribute(patch.positions, 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(patch.normals, 3))
      geometry.setIndex(new THREE.BufferAttribute(patch.indices, 1))
      geometry.computeBoundingSphere()
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

/** The debug spacecraft. Primitives on purpose: this proves architecture, not art. */
function ShipModel({ engine }: { engine: GameEngine }) {
  const group = useRef<THREE.Group>(null)

  useFrame(() => {
    const scene = engine.scene
    if (scene === null || group.current === null) return
    const ship = scene.entities.find((entity) => entity.isCamera)
    if (ship === undefined) return
    group.current.position.set(ship.position.x, ship.position.y, ship.position.z)
    group.current.quaternion.set(ship.orientation.x, ship.orientation.y, ship.orientation.z, ship.orientation.w)
  })

  return (
    <group ref={group}>
      {/* Nose along −Z, matching the forward convention the whole codebase uses. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[1.4, 6, 4]} />
        <meshStandardMaterial color="#d8dde6" roughness={0.6} metalness={0.2} />
      </mesh>
      <mesh position={[0, 0, 1.6]}>
        <boxGeometry args={[5.2, 0.3, 1.6]} />
        <meshStandardMaterial color="#8f98a8" roughness={0.7} />
      </mesh>
      {/* Engine bell, so which way is aft is unambiguous at a glance. */}
      <mesh position={[0, 0, 3.2]}>
        <cylinderGeometry args={[0.9, 1.2, 1.2, 12]} />
        <meshStandardMaterial color="#3a4048" roughness={0.4} metalness={0.6} />
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
  const group = useRef<THREE.Group>(null)

  useFrame(() => {
    const scene = engine.scene
    if (scene === null || group.current === null) return
    const ship = scene.entities.find((entity) => entity.isCamera)
    if (ship === undefined) return
    group.current.position.set(ship.position.x, ship.position.y, ship.position.z)
    group.current.quaternion.set(ship.orientation.x, ship.orientation.y, ship.orientation.z, ship.orientation.w)
  })

  return (
    <group ref={group}>
      {/* One metre. */}
      <mesh position={[4, 0, 0]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#e0b060" roughness={0.8} />
      </mesh>
      {/* One foot. */}
      <mesh position={[-4, 0, 0]}>
        <boxGeometry args={[0.3048, 0.3048, 0.3048]} />
        <meshStandardMaterial color="#60c0a0" roughness={0.8} />
      </mesh>
      {/* One inch — the smallest thing the spec asks the coordinate system to
          resolve, sitting 8 kiloparsecs from the universe origin. */}
      <mesh position={[-4.7, 0, 0]}>
        <boxGeometry args={[0.0254, 0.0254, 0.0254]} />
        <meshStandardMaterial color="#e06060" roughness={0.8} />
      </mesh>
    </group>
  )
}
