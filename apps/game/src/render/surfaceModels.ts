import {
  Group,
  Mesh,
  type MeshStandardMaterial,
  type MeshStandardNodeMaterial,
} from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { getLogger } from '@inertialref/shared'
import { rebuildShipMaterial } from './shipMaterial.ts'

const log = getLogger('game.surface-model')
const URLS = import.meta.glob<string>('../../../../data/models/*.glb', {
  query: '?url',
  import: 'default',
  eager: true,
})

/** The glTF owns the deck datum and its meters; only materials cross here. */
export function prepareSurfaceModel(model: Group, anisotropy: number): Group {
  const rebuilt = new Map<MeshStandardMaterial, MeshStandardNodeMaterial>()
  const swap = (source: MeshStandardMaterial): MeshStandardNodeMaterial => {
    let material = rebuilt.get(source)
    if (material === undefined) {
      material = rebuildShipMaterial(source, anisotropy)
      rebuilt.set(source, material)
      source.dispose()
    }
    return material
  }
  model.traverse((object) => {
    if (!(object instanceof Mesh)) return
    object.material = Array.isArray(object.material)
      ? object.material.map((material) =>
          swap(material as MeshStandardMaterial),
        )
      : swap(object.material as MeshStandardMaterial)
  })
  return model
}

const loading = new Map<string, Promise<Group | null>>()
/** A bundled structure asset, in authored meters about its attachment datum. */
export function loadSurfaceModel(
  model: string,
  anisotropy: number,
): Promise<Group | null> {
  const cached = loading.get(model)
  if (cached !== undefined) return cached
  const url = Object.entries(URLS).find(([path]) =>
    path.endsWith(`/${model}.glb`),
  )?.[1]
  // A failure is cached like a success. The structure pass asks for every
  // instance it lacks on every frame, so a load that forgets it failed is a
  // new GLTFLoader and a network request at the frame rate for as long as
  // the structure is in view — a 404 or an unfetched LFS pointer is enough.
  // A reload of the page is the retry.
  const pending =
    url === undefined
      ? Promise.resolve(null)
      : new GLTFLoader().loadAsync(url).then(
          ({ scene }) => prepareSurfaceModel(scene, anisotropy),
          (cause: unknown) => {
            log.warn('surface model failed to load', {
              model,
              cause: String(cause),
            })
            return null
          },
        )
  loading.set(model, pending)
  return pending
}
