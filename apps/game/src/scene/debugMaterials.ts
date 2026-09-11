import { sensorRadiance } from '../render/radiance.ts'
import { MeshStandardNodeMaterial } from 'three/webgpu'

/** Shared fallback hull materials keep their node pipelines across mounts. */
export const debugMaterials = {
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
}

for (const material of Object.values(debugMaterials)) sensorRadiance(material)
