import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type Accessor = {
  count: number
  bufferView: number
  byteOffset?: number
  componentType: number
  min?: number[]
  max?: number[]
}
type Primitive = {
  attributes: { POSITION: number }
  indices: number
  material: number
}
type PadDocument = {
  asset: { version: string; extras: Record<string, unknown> }
  accessors: Accessor[]
  bufferViews: { byteOffset?: number; byteStride?: number }[]
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

/** Upward surfaces under a ray reveal hidden plates that fight at grazing angles. */
function surfaceHeights(x: number, z: number): number[] {
  const bytes = readFileSync(padPath)
  const pad = readPad()
  const binaryStart = 28 + bytes.readUInt32LE(12)
  const heights = new Set<number>()
  for (const primitive of pad.meshes.flatMap((mesh) => mesh.primitives)) {
    const position = pad.accessors[primitive.attributes.POSITION]!
    const positionView = pad.bufferViews[position.bufferView]!
    const positionStart =
      binaryStart + (positionView.byteOffset ?? 0) + (position.byteOffset ?? 0)
    const indices = pad.accessors[primitive.indices]!
    const indexView = pad.bufferViews[indices.bufferView]!
    const indexStart =
      binaryStart + (indexView.byteOffset ?? 0) + (indices.byteOffset ?? 0)
    const indexSize = indices.componentType === 5123 ? 2 : 4
    expect([5123, 5125]).toContain(indices.componentType)
    expect(position.componentType).toBe(5126)
    const vertex = (index: number): [number, number, number] => {
      const vertexIndex =
        indexSize === 2
          ? bytes.readUInt16LE(indexStart + index * 2)
          : bytes.readUInt32LE(indexStart + index * 4)
      const start =
        positionStart + vertexIndex * (positionView.byteStride ?? 12)
      return [
        bytes.readFloatLE(start),
        bytes.readFloatLE(start + 4),
        bytes.readFloatLE(start + 8),
      ]
    }
    for (let index = 0; index < indices.count; index += 3) {
      const a = vertex(index)
      const b = vertex(index + 1)
      const c = vertex(index + 2)
      const bx = b[0] - a[0],
        bz = b[2] - a[2]
      const cx = c[0] - a[0],
        cz = c[2] - a[2]
      const determinant = bx * cz - bz * cx
      if (determinant >= -1e-8) continue
      const dx = x - a[0],
        dz = z - a[2]
      const u = (dx * cz - dz * cx) / determinant
      const v = (bx * dz - bz * dx) / determinant
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue
      heights.add(
        Math.round((a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1])) * 1e6) / 1e6,
      )
    }
  }
  return [...heights].sort((a, b) => a - b)
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

  it('has no hidden upward slabs beneath the deck and apron', () => {
    expect(surfaceHeights(2, 2)).toEqual([0])
    expect(
      surfaceHeights(32 * Math.cos(Math.PI / 8), 32 * Math.sin(Math.PI / 8)),
    ).toEqual([-0.08])
    expect(
      surfaceHeights(41 * Math.cos(Math.PI / 8), 41 * Math.sin(Math.PI / 8)),
    ).toEqual([-0.18])
  })

  it('separates the guidance ring from the deck by ten centimetres', () => {
    // At 200 m with a 0.1 m near plane, millimetre decals share depth bins.
    expect(surfaceHeights(24.95, 0.7)).toEqual([0, 0.1])
  })
})
