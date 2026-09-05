import { sensorRadiance } from '../render/radiance.ts'
import { MeshStandardNodeMaterial } from 'three/webgpu'

/**
 * Materials for the debug hardware.
 *
 * Module-level because there are six of them, they never change, and a node
 * material is a pipeline: rebuilding them per mount would be six pipeline builds
 * to draw the same gray box. Constructing a node material touches no GPU — it is
 * a graph, and the pipeline is compiled the first time something draws with it.
 */
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
  metre: new MeshStandardNodeMaterial({ color: 0xe0b060, roughness: 0.8 }),
  foot: new MeshStandardNodeMaterial({ color: 0x60c0a0, roughness: 0.8 }),
  inch: new MeshStandardNodeMaterial({ color: 0xe06060, roughness: 0.8 }),
}

for (const material of Object.values(debugMaterials)) sensorRadiance(material)
