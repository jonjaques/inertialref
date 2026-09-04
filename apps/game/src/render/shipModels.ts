import {
  Box3,
  Group,
  Mesh,
  type MeshPhysicalMaterial,
  MeshStandardNodeMaterial,
  type Texture,
  Vector3,
} from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { getLogger } from '@inertialref/shared'
import { type ShipModelSpec, shipSpec } from './ships.ts'

/*
 * Modeled ship hulls, loaded from `data/models/`.
 *
 * One registry for however many ships end up flyable: the manifest names each
 * hull, its glTF file, and the true overall length the model is scaled to —
 * the meshes themselves arrive at whatever scale the artist exported, and
 * render space is strict 1 unit = 1 meter.
 *
 * `GLTFLoader` is the one sanctioned crossing of the "never import from
 * `three`" rule, and it never touches the renderer: the loader builds classic
 * `MeshPhysicalMaterial`s, and every one is rebuilt below as a
 * `MeshStandardNodeMaterial` from `three/webgpu` before the hull is handed
 * out. The classes the loader *shares* with the node build — `Mesh`,
 * `BufferGeometry`, `Texture` — come from `three.core.js`, so identity holds
 * and the geometry and textures carry across untouched.
 */

const log = getLogger('game.ship')

const URLS = import.meta.glob<string>('../../../../data/models/*.glb', {
  query: '?url',
  import: 'default',
  eager: true,
})

const byFile = new Map<string, string>()
for (const [path, url] of Object.entries(URLS)) {
  byFile.set(path.slice(path.lastIndexOf('/') + 1), url)
}

export interface LoadedShip {
  /** The manifest id, so the plumes can find the layout measured for it. */
  readonly id: string
  readonly group: Group
  /** The manifest's true length — what the hull was scaled to. */
  readonly lengthMetres: number
  /** Measured off the scaled bounding box, for placing things beside the hull. */
  readonly beamMetres: number
}

/**
 * Rebuild one of GLTFLoader's classic materials as a node material.
 *
 * Copied rather than converted-in-place because the WebGPU renderer converting
 * a classic material "behind your back" is exactly what AGENTS.md forbids
 * relying on. The loader has already set color spaces (sRGB for base color
 * and emissive, linear for data maps) and `flipY` on every texture, so the
 * maps move across as-is. `KHR_materials_specular` is dropped deliberately:
 * its intensities in these assets are ≤1 and the standard model's default is
 * visually identical under a single key light.
 */
function rebuildMaterial(
  source: MeshPhysicalMaterial,
  anisotropy: number,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()
  material.name = source.name
  material.map = source.map
  material.normalMap = source.normalMap
  if (source.normalMap !== null) material.normalScale.copy(source.normalScale)
  material.metalnessMap = source.metalnessMap
  material.roughnessMap = source.roughnessMap
  material.metalness = source.metalness
  material.roughness = source.roughness
  // KHR_materials_emissive_strength lands here: the lit windows and nacelle
  // grilles are emissive maps with intensity above 1, which is what keeps them
  // glowing on the night side of the hull.
  material.emissive.copy(source.emissive)
  material.emissiveMap = source.emissiveMap
  material.emissiveIntensity = source.emissiveIntensity
  material.transparent = source.transparent
  material.opacity = source.opacity
  material.alphaTest = source.alphaTest
  material.depthWrite = source.depthWrite
  material.side = source.side
  // A hull seen bow-on is all glancing angles; without anisotropy the window
  // rows smear into gray bands exactly where the eye reads the scale.
  const maps: ReadonlyArray<Texture | null> = [
    source.map,
    source.normalMap,
    source.metalnessMap,
    source.roughnessMap,
    source.emissiveMap,
  ]
  for (const texture of maps) {
    if (texture !== null) texture.anisotropy = anisotropy
  }
  return material
}

async function build(
  spec: ShipModelSpec,
  anisotropy: number,
): Promise<LoadedShip> {
  const url = byFile.get(spec.file)
  if (url === undefined) throw new Error(`no bundled model asset: ${spec.file}`)
  const gltf = await new GLTFLoader().loadAsync(url)
  const hull = gltf.scene

  // Recenter on the bounding-box middle so the hull yaws and pitches about its
  // own center; exported origins land wherever the artist left them.
  const box = new Box3().setFromObject(hull)
  const size = box.getSize(new Vector3())
  hull.position.sub(box.getCenter(new Vector3()))

  const rebuilt = new Map<MeshPhysicalMaterial, MeshStandardNodeMaterial>()
  const swap = (source: MeshPhysicalMaterial): MeshStandardNodeMaterial => {
    let material = rebuilt.get(source)
    if (material === undefined) {
      material = rebuildMaterial(source, anisotropy)
      rebuilt.set(source, material)
      source.dispose()
    }
    return material
  }
  hull.traverse((object) => {
    if (!(object instanceof Mesh)) return
    object.material = Array.isArray(object.material)
      ? object.material.map((m) => swap(m as MeshPhysicalMaterial))
      : swap(object.material as MeshPhysicalMaterial)
  })

  const scale = spec.lengthMetres / size.z
  const oriented = new Group()
  oriented.add(hull)
  if (spec.nose === '+z') oriented.rotation.y = Math.PI
  oriented.scale.setScalar(scale)

  const ship = new Group()
  ship.name = `ship:${spec.id}`
  ship.add(oriented)
  return {
    id: spec.id,
    group: ship,
    lengthMetres: spec.lengthMetres,
    beamMetres: size.x * scale,
  }
}

// Keyed by id alone: anisotropy is a device capability, identical for every
// call in a session, so the first caller's value stands.
const loading = new Map<string, Promise<LoadedShip | null>>()

/**
 * The hull for one ship id, fetched and rebuilt on first ask.
 *
 * Resolves `null` rather than rejecting — a missing or unloadable model
 * degrades to the debug hardware the same way a missing star catalog
 * degrades to Sol, and for the same reason: the flight model and everything
 * else work identically without it.
 */
export function loadShipModel(
  id: string,
  anisotropy: number,
): Promise<LoadedShip | null> {
  const cached = loading.get(id)
  if (cached !== undefined) return cached

  const spec = shipSpec(id)
  if (spec === undefined) {
    log.warn('no such ship model in the manifest', { id })
    const missing = Promise.resolve(null)
    loading.set(id, missing)
    return missing
  }

  const promise = build(spec, anisotropy).then(
    (ship) => {
      log.info('ship model ready', {
        id: spec.id,
        length: spec.lengthMetres,
        beam: Math.round(ship.beamMetres),
      })
      return ship
    },
    (cause: unknown) => {
      // Evict so a later mount retries, exactly like a failed surface map.
      loading.delete(id)
      log.warn('ship model failed to load; keeping the debug hull', {
        id,
        cause: String(cause),
      })
      return null
    },
  )
  loading.set(id, promise)
  return promise
}
