import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type Accessor = { count: number; min?: number[]; max?: number[] }
type Primitive = {
  attributes: { POSITION: number }
  indices: number
  material: number
}
type PadDocument = {
  asset: { version: string; extras: Record<string, unknown> }
  accessors: Accessor[]
  meshes: { primitives: Primitive[] }[]
  materials: { name: string }[]
  nodes: { translation?: number[]; rotation?: number[]; scale?: number[] }[]
  images?: unknown[]
}

const padPath = fileURLToPath(
  new URL('../../../data/models/mars-pad.glb', import.meta.url),
)

function readPad(): PadDocument {
  const bytes = readFileSync(padPath)
  expect(
    bytes.readUInt32LE(0),
    'the shipped pad is a GLB, not an LFS pointer',
  ).toBe(0x46546c67)
  expect(bytes.readUInt32LE(4)).toBe(2)
  expect(bytes.readUInt32LE(8)).toBe(bytes.length)
  const jsonBytes = bytes.readUInt32LE(12)
  return JSON.parse(
    bytes.subarray(20, 20 + jsonBytes).toString('utf8'),
  ) as PadDocument
}

describe('the shipped Mars pad', () => {
  it('carries its placement contract and original Blender source', () => {
    expect(readPad().asset.extras).toMatchObject({
      id: 'mars-pad',
      author: 'InertialRef',
      source: 'design/structures/mars-pad.blend',
      generator: 'apps/ingest/models/build_mars_pad.py',
      units: 'metres',
      upAxis: '+y',
      landingHeightMetres: 0,
      landingRadiusMetres: 25,
      foundationRadiusMetres: 45,
      skirtDepthMetres: 6,
    })
  })

  it('fits the realtime budget without textures or unbaked node transforms', () => {
    const pad = readPad()
    const primitives = pad.meshes.flatMap((mesh) => mesh.primitives)
    const triangles = primitives.reduce(
      (sum, primitive) => sum + pad.accessors[primitive.indices]!.count / 3,
      0,
    )
    expect(primitives.length).toBeLessThanOrEqual(12)
    expect(triangles).toBeGreaterThan(2_000)
    expect(triangles).toBeLessThanOrEqual(35_000)
    expect(pad.images ?? []).toHaveLength(0)
    for (const node of pad.nodes) {
      expect(node.translation ?? [0, 0, 0]).toEqual([0, 0, 0])
      expect(node.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1])
      expect(node.scale ?? [1, 1, 1]).toEqual([1, 1, 1])
    }
  })

  it('puts the clear landing deck at zero with a buried skirt and low equipment', () => {
    const pad = readPad()
    const positions = pad.meshes
      .flatMap((mesh) => mesh.primitives)
      .map((primitive) => pad.accessors[primitive.attributes.POSITION]!)
    const low = [0, 1, 2].map((axis) =>
      Math.min(...positions.map((accessor) => accessor.min![axis]!)),
    )
    const high = [0, 1, 2].map((axis) =>
      Math.max(...positions.map((accessor) => accessor.max![axis]!)),
    )
    expect(low[1]).toBeCloseTo(-6, 4)
    expect(high[1]).toBeLessThan(3)
    expect(high[0]! - low[0]!).toBeGreaterThan(85)
    expect(high[0]! - low[0]!).toBeLessThan(115)
    expect(high[2]! - low[2]!).toBeGreaterThan(85)
    expect(high[2]! - low[2]!).toBeLessThan(115)
    const deckMaterial = pad.materials.findIndex(
      (material) => material.name === 'landing-deck',
    )
    expect(deckMaterial).toBeGreaterThanOrEqual(0)
    const deck = pad.meshes
      .flatMap((mesh) => mesh.primitives)
      .filter((primitive) => primitive.material === deckMaterial)
    expect(deck).toHaveLength(1)
    const bounds = pad.accessors[deck[0]!.attributes.POSITION]!
    expect(bounds.max![1]).toBeCloseTo(0, 5)
    expect(bounds.max![0]! - bounds.min![0]!).toBeGreaterThan(50)
    expect(bounds.max![2]! - bounds.min![2]!).toBeGreaterThan(50)
  })
})
