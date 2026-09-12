import { Box3, Group, Vector3 } from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { getLogger } from '@inertialref/shared'
import { type ShipModelSpec, shipSpec } from './ships.ts'
import { rebuildMaterials } from './shipMaterial.ts'

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
 * `MeshStandardMaterial`s, and every one is rebuilt as a
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
  const box = new Box3().setFromObject(hull, true)
  const size = box.getSize(new Vector3())
  hull.position.sub(box.getCenter(new Vector3()))

  rebuildMaterials(hull, anisotropy)

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
