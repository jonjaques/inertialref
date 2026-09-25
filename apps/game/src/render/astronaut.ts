import type { Quat, Vec3 } from '@inertialref/spatial'
import { getLogger } from '@inertialref/shared'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { clone } from 'three/addons/utils/SkeletonUtils.js'
import { Box3, Group, Matrix4, SkinnedMesh, Vector3 } from 'three/webgpu'
import {
  createAstronautAnimation,
  type AstronautMotion,
} from './astronautAnimation.ts'
import { rebuildMaterials } from './shipMaterial.ts'

export interface AstronautView extends AstronautMotion {
  /** Meters in the current render frame, about the avatar's feet. */
  readonly position: Vec3
  readonly orientation: Quat
  readonly visible: boolean
}

export interface AstronautSource {
  readonly characterView: AstronautView | null
  readonly world: { readonly clock: { readonly renderTime: number } }
}

export interface LoadedAstronaut {
  readonly group: Group
  update(motion: AstronautMotion, delta: number): void
  dispose(): void
}

/** The skinned asset has a foot datum and faces -Z in the render frame. */
export function createAstronaut(source: GLTF, anisotropy = 1): LoadedAstronaut {
  const model = clone(source.scene) as Group
  rebuildMaterials(model, anisotropy)
  const content = new Group()
  content.add(model)
  const group = new Group()
  group.name = 'astronaut'
  group.add(content)
  const animation = createAstronautAnimation(model, source.animations)
  model.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(model, true)
  content.scale.setScalar(1.8 / (bounds.max.y - bounds.min.y))
  // NASA's authored forward is +Z after glTF's axis conversion.
  content.rotation.y = Math.PI
  const feet: Array<{ mesh: SkinnedMesh; indices: number[] }> = []
  model.traverse((object) => {
    if (!(object instanceof SkinnedMesh)) return
    // Deformed bounds change every pose. Static frustum bounds can cull an
    // arm or a crouching helmet before its skeleton reaches the screen edge.
    object.frustumCulled = false
    const positions = object.geometry.getAttribute('position')
    const indices: number[] = []
    for (let i = 0; i < positions.count; i++) {
      if (positions.getY(i) < 0.2) indices.push(i)
    }
    if (indices.length > 0) feet.push({ mesh: object, indices })
  })
  if (feet.length === 0) throw new Error('astronaut lacks skinned boots')
  const vertex = new Vector3()
  const inverse = new Matrix4()
  const relative = new Matrix4()
  const anchorFeet = (): void => {
    group.updateMatrixWorld(true)
    inverse.copy(group.matrixWorld).invert()
    let floor = Infinity
    for (const { mesh, indices } of feet) {
      relative.multiplyMatrices(inverse, mesh.matrixWorld)
      for (const index of indices) {
        mesh.getVertexPosition(index, vertex).applyMatrix4(relative)
        floor = Math.min(floor, vertex.y)
      }
    }
    if (Math.abs(floor) > 1e-10) content.position.y -= floor
    group.updateMatrixWorld(true)
  }
  anchorFeet()
  return {
    group,
    update(motion, delta) {
      animation.update(motion, delta)
      anchorFeet()
    },
    dispose() {
      animation.dispose()
      // SkeletonUtils shares geometry and textures with the cached asset.
      // Each instance owns only its skeleton and converted node materials.
      model.traverse((object) => {
        if (!(object instanceof SkinnedMesh)) return
        object.skeleton.dispose()
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          material.dispose()
        }
      })
    },
  }
}

const log = getLogger('game.astronaut')
let loading: Promise<GLTF | null> | null = null

/** A failed request resolves once per page, so the frame cannot retry at 60 Hz. */
export async function loadAstronaut(
  anisotropy: number,
): Promise<LoadedAstronaut | null> {
  loading ??= new GLTFLoader()
    .loadAsync('/models/astronaut/astronaut.glb')
    .catch((cause: unknown) => {
      log.warn('astronaut model failed to load', { cause: String(cause) })
      return null
    })
  const source = await loading
  return source === null ? null : createAstronaut(source, anisotropy)
}
