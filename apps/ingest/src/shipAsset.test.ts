import { readFileSync } from 'node:fs'
import { Quaternion as Q, vec3 } from '@inertialref/spatial'
import { describe, expect, it } from 'vitest'

type Triple = [number, number, number]
interface ShipPrimitive {
  attributes: Record<string, number>
  indices?: number
  material: number
}
interface ShipNode {
  mesh?: number
  children?: number[]
  matrix?: number[]
  translation?: Triple
  rotation?: [number, number, number, number]
  scale?: Triple
}
interface ShipAsset {
  scene?: number
  scenes: { nodes: number[] }[]
  nodes: ShipNode[]
  meshes: { primitives: ShipPrimitive[] }[]
  accessors: {
    bufferView: number
    byteOffset?: number
    componentType: number
    type: string
    count: number
  }[]
  bufferViews: {
    byteOffset?: number
    byteLength: number
    byteStride?: number
  }[]
  images: { bufferView: number; mimeType: string }[]
  materials: {
    name: string
    normalTexture?: { index: number }
    occlusionTexture?: { index: number }
    pbrMetallicRoughness: {
      baseColorTexture?: { index: number }
      metallicRoughnessTexture?: { index: number }
      metallicFactor?: number
      roughnessFactor?: number
    }
  }[]
  asset: { extras: Record<string, string> }
}

const bytes = readFileSync(
  new URL('../../../data/models/rocinante.glb', import.meta.url),
)
const jsonLength = bytes.readUInt32LE(12)
const ship = JSON.parse(
  bytes.subarray(20, 20 + jsonLength).toString(),
) as ShipAsset
const binary = bytes.subarray(28 + jsonLength)
const primitives = ship.meshes.flatMap((mesh) => mesh.primitives)

function transform(node: ShipNode, [x, y, z]: Triple): Triple {
  const m = node.matrix
  if (m !== undefined) {
    return [
      m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
      m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
      m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    ]
  }
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1]
  const rotated = Q.rotate(
    { x: qx, y: qy, z: qz, w: qw },
    vec3(x * sx, y * sy, z * sz),
  )
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  return [rotated.x + tx, rotated.y + ty, rotated.z + tz]
}

function visitMeshes(
  visit: (primitive: ShipPrimitive, points: Triple[]) => void,
): void {
  function walk(index: number, parents: ShipNode[]): void {
    const node = ship.nodes[index]!
    const chain = [node, ...parents]
    if (node.mesh !== undefined) {
      for (const primitive of ship.meshes[node.mesh]!.primitives) {
        const accessor = ship.accessors[primitive.attributes.POSITION!]!
        expect(accessor.componentType).toBe(5126)
        expect(accessor.type).toBe('VEC3')
        const view = ship.bufferViews[accessor.bufferView]!
        const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
        const stride = view.byteStride ?? 12
        const points: Triple[] = []
        for (let vertex = 0; vertex < accessor.count; vertex += 1) {
          const at = offset + vertex * stride
          let point: Triple = [
            binary.readFloatLE(at),
            binary.readFloatLE(at + 4),
            binary.readFloatLE(at + 8),
          ]
          for (const ancestor of chain) point = transform(ancestor, point)
          points.push(point)
        }
        visit(primitive, points)
      }
    }
    for (const child of node.children ?? []) walk(child, chain)
  }
  for (const root of ship.scenes[ship.scene ?? 0]!.nodes) walk(root, [])
}

function bounds(): { min: Triple; max: Triple } {
  const min: Triple = [Infinity, Infinity, Infinity]
  const max: Triple = [-Infinity, -Infinity, -Infinity]
  visitMeshes((_primitive, points) => {
    for (const point of points) {
      for (const axis of [0, 1, 2] as const) {
        min[axis] = Math.min(min[axis], point[axis])
        max[axis] = Math.max(max[axis], point[axis])
      }
    }
  })
  return { min, max }
}

const sub = (a: Triple, b: Triple): Triple => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
]
const dot = (a: Triple, b: Triple): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Triple, b: Triple): Triple => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

interface Triangle {
  a: Triple
  u: Triple
  v: Triple
  normal: Triple
}

function lineHit(
  point: Triple,
  direction: Triple,
  triangle: Triangle,
): number | null {
  if (Math.abs(dot(direction, triangle.normal)) < 0.98) return null
  const q = cross(direction, triangle.v)
  const determinant = dot(triangle.u, q)
  if (Math.abs(determinant) < 1e-14) return null
  const s = sub(point, triangle.a)
  const u = dot(s, q) / determinant
  if (u < -1e-5 || u > 1 + 1e-5) return null
  const r = cross(s, triangle.u)
  const v = dot(direction, r) / determinant
  if (v < -1e-5 || u + v > 1 + 1e-5) return null
  return dot(triangle.v, r) / determinant
}

describe('the Rocinante realtime asset', () => {
  it('stays within six mesh draws and 141,000 triangles without spare UV sets', () => {
    expect(bytes.readUInt32LE(0)).toBe(0x46546c67)
    expect(bytes.readUInt32LE(24 + jsonLength)).toBe(0x004e4942)
    expect(primitives.length).toBeGreaterThan(0)
    expect(primitives.length).toBeLessThanOrEqual(6)
    let triangles = 0
    for (const primitive of primitives) {
      const accessor = primitive.indices ?? primitive.attributes.POSITION!
      triangles += ship.accessors[accessor]!.count / 3
      expect(primitive.attributes).not.toHaveProperty('TEXCOORD_1')
      expect(primitive.attributes).not.toHaveProperty('TEXCOORD_2')
    }
    expect(triangles).toBeGreaterThan(0)
    expect(triangles).toBeLessThanOrEqual(141_000)
  })

  it('keeps embedded texture dimensions at or below 1024 pixels', () => {
    expect(ship.images.length).toBeGreaterThan(0)
    for (const image of ship.images) {
      expect(image.mimeType).toBe('image/png')
      const view = ship.bufferViews[image.bufferView]!
      const offset = view.byteOffset ?? 0
      expect(binary.subarray(offset + 12, offset + 16).toString()).toBe('IHDR')
      for (const dimension of [16, 20]) {
        const pixels = binary.readUInt32BE(offset + dimension)
        expect(pixels).toBeGreaterThan(0)
        expect(pixels).toBeLessThanOrEqual(1024)
      }
    }
  })

  it('keeps distinct surface finishes and packed PBR occlusion maps', () => {
    const roles = [
      'Roci | Ceramic armor',
      'Roci | PDC gunmetal',
      'Roci | Machinery and safety paint',
      'Roci | Engine titanium',
      'Roci | Hull markings',
    ]
    expect(ship.materials.map((material) => material.name).sort()).toEqual(
      [...roles].sort(),
    )
    for (const role of roles.slice(0, 3)) {
      const material = ship.materials.find(({ name }) => name === role)!
      const pbr = material.pbrMetallicRoughness
      expect(pbr.baseColorTexture).toBeDefined()
      expect(material.normalTexture).toBeDefined()
      expect(pbr.metallicRoughnessTexture).toBeDefined()
      expect(material.occlusionTexture?.index).toBe(
        pbr.metallicRoughnessTexture?.index,
      )
    }
    const engine = ship.materials.find(({ name }) => name === roles[3])!
    expect(engine.pbrMetallicRoughness.metallicFactor).toBeCloseTo(0.9)
    expect(engine.pbrMetallicRoughness.roughnessFactor).toBeCloseTo(0.32)
    expect(engine.normalTexture).toBeDefined()
    expect(engine.occlusionTexture).toBeDefined()
  })

  it('preserves the model bounds that locate the measured thrusters', () => {
    // Measured from every transformed source vertex at 6f5a9f8. The loader
    // centers and scales this box; a changed bound moves every plume anchor.
    const original = {
      min: [-85.68923229477863, -70.44715801427573, -182.61692244630416],
      max: [85.6892697193465, 70.20755526298252, 297.93466044660124],
    }
    const metresPerUnit = 46 / (original.max[2]! - original.min[2]!)
    const actual = bounds()
    for (const side of ['min', 'max'] as const) {
      for (const axis of [0, 1, 2] as const) {
        const error = Math.abs(actual[side][axis] - original[side][axis]!)
        expect(error * metresPerUnit).toBeLessThan(0.001)
      }
    }
  })

  it('keeps all six marking quads 15–35 mm above the underlying hull', () => {
    const markings: Triangle[] = []
    const hull: Triangle[] = []
    visitMeshes((primitive, points) => {
      const name = ship.materials[primitive.material]!.name
      const target = /^(Texts|Roci \| Hull markings)$/.test(name)
        ? markings
        : hull
      const indices =
        primitive.indices === undefined
          ? null
          : ship.accessors[primitive.indices]!
      const view =
        indices === null ? null : ship.bufferViews[indices.bufferView]!
      const width =
        indices === null
          ? 0
          : ({ 5121: 1, 5123: 2, 5125: 4 } as Record<number, number>)[
              indices.componentType
            ]!
      const offset = (view?.byteOffset ?? 0) + (indices?.byteOffset ?? 0)
      const at = (index: number): Triple =>
        points[
          indices === null
            ? index
            : binary.readUIntLE(
                offset + index * (view?.byteStride ?? width),
                width,
              )
        ]!
      for (
        let index = 0;
        index < (indices?.count ?? points.length);
        index += 3
      ) {
        const a = at(index),
          u = sub(at(index + 1), a),
          v = sub(at(index + 2), a)
        const normal = cross(u, v)
        const length = Math.hypot(...normal)
        if (length === 0) continue
        target.push({
          a,
          u,
          v,
          normal: normal.map((value) => value / length) as Triple,
        })
      }
    })
    expect(markings).toHaveLength(12)
    const metresPerUnit = 0.09572333467945615
    // Four interior samples per triangle cover both the middle and corners of
    // each quad; a centroid alone misses a tilted decal intersecting the hull.
    for (const marking of markings) {
      for (const [u, v] of [
        [1 / 3, 1 / 3],
        [0.1, 0.1],
        [0.8, 0.1],
        [0.1, 0.8],
      ] as const) {
        const point = marking.a.map(
          (value, axis) => value + u * marking.u[axis]! + v * marking.v[axis]!,
        ) as Triple
        let nearest = Infinity
        for (const triangle of hull) {
          const distance = lineHit(point, marking.normal, triangle)
          if (distance !== null && Math.abs(distance) < Math.abs(nearest))
            nearest = distance
        }
        const clearance = -nearest * metresPerUnit
        expect(clearance).toBeGreaterThanOrEqual(0.015)
        expect(clearance).toBeLessThanOrEqual(0.035)
      }
    }
  })

  it('carries source attribution and identifies the modifications', () => {
    const provenance = ship.asset.extras
    expect(provenance.author).toContain('Jakub.Vildomec')
    expect(provenance.license).toMatch(/CC-BY-4\.0/i)
    expect(provenance.source).toBe(
      'https://sketchfab.com/3d-models/mcrn-tachi-expanse-tv-show-76fc983ab08c449b9042491a00e621cf',
    )
    expect(provenance.title).toBe('MCRN Tachi [Expanse TV Show]')
    expect(provenance.modifications).toEqual(
      expect.stringContaining('InertialRef'),
    )
    expect(provenance.modifications).toEqual(expect.stringContaining('PBR'))
  })
})
