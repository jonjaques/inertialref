import {
  type MeshStandardMaterial,
  MeshStandardNodeMaterial,
  type Texture,
} from 'three/webgpu'
import { sensorRadiance } from './radiance.ts'

/**
 * Rebuild one of GLTFLoader's classic materials as a node material.
 *
 * The renderer receives a node material explicitly. The loader has already
 * set texture color spaces, UV channels, transforms and `flipY`, so the maps
 * stay shared. Paint factors and vertex colors multiply the base-color map;
 * occlusion uses the packed map's red channel alongside roughness and metalness.
 * Physical-only extensions are outside the ship's metallic-roughness material.
 */
export function rebuildShipMaterial(
  source: MeshStandardMaterial,
  anisotropy: number,
): MeshStandardNodeMaterial {
  const material = sensorRadiance(new MeshStandardNodeMaterial())
  material.name = source.name
  material.color.copy(source.color)
  material.map = source.map
  material.vertexColors = source.vertexColors
  material.flatShading = source.flatShading
  material.normalMap = source.normalMap
  material.normalMapType = source.normalMapType
  material.normalScale.copy(source.normalScale)
  material.aoMap = source.aoMap
  material.aoMapIntensity = source.aoMapIntensity
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
    source.aoMap,
    source.metalnessMap,
    source.roughnessMap,
    source.emissiveMap,
  ]
  for (const texture of maps) {
    if (texture !== null) texture.anisotropy = anisotropy
  }
  return material
}
