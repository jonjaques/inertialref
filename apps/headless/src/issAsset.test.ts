import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { orbitalAsset } from '@inertialref/universe'

/*
 * The shipped ISS, held to what `data/models/README.md` says about it.
 *
 * Read from the file, as `marsPadAsset.test.ts` reads the pad: the geometry
 * is stored in KHR_mesh_quantization's integer forms under a per-mesh
 * dequantizing transform, so every position here goes through the node
 * chain before it is a meter.
 */

type Triple = [number, number, number]
interface Node {
  name?: string
  mesh?: number
  children?: number[]
  translation?: Triple
  rotation?: [number, number, number, number]
  scale?: Triple
  extras?: {
    joint?: { kind: string; axis: Triple; mast?: Triple; normal?: Triple }
  }
}
interface Accessor {
  bufferView: number
  byteOffset?: number
  componentType: number
  normalized?: boolean
  count: number
  type: string
}
interface Primitive {
  attributes: Record<string, number>
  indices: number
  material: number
}
interface Material {
  name: string
  alphaMode?: string
  normalTexture?: { index: number }
  pbrMetallicRoughness?: {
    baseColorTexture?: { index: number }
    baseColorFactor?: number[]
  }
}
interface Document {
  asset: { extras: Record<string, unknown>; copyright?: string }
  extensionsRequired?: string[]
  scene?: number
  scenes: { nodes: number[] }[]
  nodes: Node[]
  meshes: { primitives: Primitive[] }[]
  accessors: Accessor[]
  bufferViews: {
    byteOffset?: number
    byteLength: number
    byteStride?: number
  }[]
  materials: Material[]
  images: { bufferView: number; mimeType: string }[]
}

const path = fileURLToPath(
  new URL('../../../data/models/iss.glb', import.meta.url),
)
const bytes = readFileSync(path)
const jsonLength = bytes.readUInt32LE(12)
const iss = JSON.parse(
  bytes.subarray(20, 20 + jsonLength).toString('utf8'),
) as Document
const binary = bytes.subarray(28 + jsonLength)
const primitives = iss.meshes.flatMap((mesh) => mesh.primitives)

const WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3 }
const SIZE: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
}

/** An accessor's values as floats, normalized integers resolved. */
function read(index: number): Float64Array {
  const accessor = iss.accessors[index]!
  const view = iss.bufferViews[accessor.bufferView]!
  const width = WIDTH[accessor.type]!
  const size = SIZE[accessor.componentType]!
  const stride = view.byteStride ?? width * size
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const out = new Float64Array(accessor.count * width)
  for (let i = 0; i < accessor.count; i += 1) {
    for (let c = 0; c < width; c += 1) {
      const at = start + i * stride + c * size
      let value: number
      switch (accessor.componentType) {
        case 5126:
          value = binary.readFloatLE(at)
          break
        case 5122:
          value = binary.readInt16LE(at)
          if (accessor.normalized === true) value = Math.max(value / 32767, -1)
          break
        case 5123:
          value = binary.readUInt16LE(at)
          if (accessor.normalized === true) value /= 65535
          break
        case 5120:
          value = binary.readInt8(at)
          if (accessor.normalized === true) value = Math.max(value / 127, -1)
          break
        case 5125:
          value = binary.readUInt32LE(at)
          break
        default:
          throw new Error(`component type ${accessor.componentType}`)
      }
      out[i * width + c] = value
    }
  }
  return out
}

/** A node's own transform applied to a point: scale, then translation (no node here rotates). */
function local(node: Node, [x, y, z]: Triple): Triple {
  expect(node.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1])
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  return [x * sx + tx, y * sy + ty, z * sz + tz]
}

/** Every mesh's points in station meters, with the joints they hang under. */
function walk(): {
  points: Triple[]
  joints: {
    name: string
    pivot: Triple
    joint: NonNullable<Node['extras']>['joint']
  }[]
}[] {
  const out: ReturnType<typeof walk> = []
  const visit = (
    index: number,
    chain: Node[],
    joints: ReturnType<typeof walk>[number]['joints'],
  ): void => {
    const node = iss.nodes[index]!
    const lineage = [node, ...chain]
    const here = node.extras?.joint
    const nested =
      here === undefined
        ? joints
        : [
            ...joints,
            {
              name: node.name ?? '',
              pivot: lineage.reduce<Triple>((p, n) => local(n, p), [0, 0, 0]),
              joint: here,
            },
          ]
    if (node.mesh !== undefined) {
      const points: Triple[] = []
      for (const primitive of iss.meshes[node.mesh]!.primitives) {
        const raw = read(primitive.attributes.POSITION!)
        for (let i = 0; i < raw.length; i += 3) {
          let point: Triple = [raw[i]!, raw[i + 1]!, raw[i + 2]!]
          for (const ancestor of lineage) point = local(ancestor, point)
          points.push(point)
        }
      }
      out.push({ points, joints: nested })
    }
    for (const child of node.children ?? []) visit(child, lineage, nested)
  }
  for (const root of iss.scenes[iss.scene ?? 0]!.nodes) visit(root, [], [])
  return out
}

const meshes = walk()

const sub = (a: Triple, b: Triple): Triple => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
]
const dot = (a: Triple, b: Triple): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const length = (a: Triple): number => Math.sqrt(dot(a, a))

/** The mean position of every vertex drawn with a material. */
function centroid(name: string): Triple {
  const index = iss.materials.findIndex((material) => material.name === name)
  expect(index, name).toBeGreaterThanOrEqual(0)
  const sum: Triple = [0, 0, 0]
  let count = 0
  const visit = (nodeIndex: number, chain: Node[]): void => {
    const node = iss.nodes[nodeIndex]!
    const lineage = [node, ...chain]
    for (const primitive of node.mesh === undefined
      ? []
      : iss.meshes[node.mesh]!.primitives) {
      if (primitive.material !== index) continue
      const raw = read(primitive.attributes.POSITION!)
      for (let i = 0; i < raw.length; i += 3) {
        let point: Triple = [raw[i]!, raw[i + 1]!, raw[i + 2]!]
        for (const ancestor of lineage) point = local(ancestor, point)
        sum[0] += point[0]
        sum[1] += point[1]
        sum[2] += point[2]
        count += 1
      }
    }
    for (const child of node.children ?? []) visit(child, lineage)
  }
  for (const root of iss.scenes[iss.scene ?? 0]!.nodes) visit(root, [])
  return [sum[0] / count, sum[1] / count, sum[2] / count]
}

/** A WebP's pixel size, from whichever of its three headers it carries. */
function webpSize(image: Buffer): [number, number] {
  expect(image.subarray(0, 4).toString()).toBe('RIFF')
  expect(image.subarray(8, 12).toString()).toBe('WEBP')
  const chunk = image.subarray(12, 16).toString()
  if (chunk === 'VP8 ')
    return [image.readUInt16LE(26) & 0x3fff, image.readUInt16LE(28) & 0x3fff]
  if (chunk === 'VP8L') {
    const bits = image.readUInt32LE(21)
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
  }
  expect(chunk).toBe('VP8X')
  return [image.readUIntLE(24, 3) + 1, image.readUIntLE(27, 3) + 1]
}

describe('the shipped ISS', () => {
  it('is a GLB that carries its source, its credit and what was changed', () => {
    expect(bytes.readUInt32LE(0), 'a GLB, not an LFS pointer').toBe(0x46546c67)
    expect(bytes.readUInt32LE(4)).toBe(2)
    expect(bytes.readUInt32LE(8)).toBe(bytes.length)
    expect(iss.asset.extras).toMatchObject({
      id: 'iss',
      sourceSha256:
        '57cecfaf332efb2127d07796c4b65ca570d95a11516c8e046feb5a12efee491d',
      author:
        'NASA/JSC/Integrated Graphics, Operations, and Analysis Laboratory',
      generator: 'apps/ingest/models/build_iss.py',
      units: 'meters',
      upAxis: '+y',
      forwardAxis: '-z',
      starboardAxis: '+x',
    })
    expect(String(iss.asset.extras.license)).toMatch(/NASA Images and Media/)
    expect(iss.asset.copyright).toMatch(/Not endorsed by NASA/)
  })

  it('fits the realtime and hosting budgets without a decoder', () => {
    const triangles = primitives.reduce(
      (sum, primitive) => sum + iss.accessors[primitive.indices]!.count / 3,
      0,
    )
    expect(triangles).toBeGreaterThan(200_000)
    expect(triangles).toBeLessThanOrEqual(450_000)
    expect(primitives.length).toBeLessThanOrEqual(80)
    expect(iss.materials.length).toBeLessThanOrEqual(49)
    // A static asset is at most 25 MiB (`docs/hosting.md`).
    expect(bytes.length).toBeLessThanOrEqual(25 * 1024 * 1024)
    // WebP and quantization are core three; Draco and KTX2 need decoders the
    // client does not carry.
    for (const extension of iss.extensionsRequired ?? [])
      expect(['EXT_texture_webp', 'KHR_mesh_quantization']).toContain(extension)
    for (const primitive of primitives)
      expect(Object.keys(primitive.attributes).sort()).toEqual([
        'NORMAL',
        'POSITION',
        'TEXCOORD_0',
      ])
  })

  it('draws every surface opaque or alpha-tested, with the maps the README lists', () => {
    for (const material of iss.materials) {
      expect(material.alphaMode ?? 'OPAQUE', material.name).not.toBe('BLEND')
      const pbr = material.pbrMetallicRoughness ?? {}
      expect(
        pbr.baseColorTexture !== undefined || pbr.baseColorFactor !== undefined,
        material.name,
      ).toBe(true)
    }
    expect(
      iss.materials
        .filter(
          (material) =>
            material.pbrMetallicRoughness?.baseColorTexture === undefined,
        )
        .map((material) => material.name)
        .sort(),
    ).toEqual([
      'ELC3_Payloads',
      'JEM_EF.Payload',
      'JEM_EF.Payload02',
      'JEM_EF_GEDI',
      'MLI.Generic',
    ])
    expect(
      iss.materials.filter((material) => material.normalTexture !== undefined),
    ).toHaveLength(36)
  })

  it('keeps every map at or under 1024 pixels', () => {
    expect(iss.images.length).toBeGreaterThan(0)
    for (const image of iss.images) {
      expect(image.mimeType).toBe('image/webp')
      const view = iss.bufferViews[image.bufferView]!
      const start = view.byteOffset ?? 0
      const [width, height] = webpSize(
        binary.subarray(start, start + view.byteLength),
      )
      expect(width).toBeGreaterThan(0)
      expect(width).toBeLessThanOrEqual(1024)
      expect(height).toBeGreaterThan(0)
      expect(height).toBeLessThanOrEqual(1024)
    }
  })

  it('stands in the station frame’s axes: starboard +X, zenith +Y, forward −Z', () => {
    // Columbus on Harmony's starboard side and Kibo on its port, which is
    // the chirality the source's mirroring root scale had reversed.
    expect(centroid('Columbus')[0]).toBeGreaterThan(5)
    expect(centroid('JEM_PM')[0]).toBeLessThan(-5)
    // Zvezda aft, the Cupola under Tranquility, the truss above the modules.
    expect(centroid('Zvezda.SM')[2]).toBeGreaterThan(20)
    expect(centroid('Node.Cupola')[1]).toBeLessThan(-5)
    expect(centroid('USLab')[1]).toBeLessThan(0)
    // A loop, not a spread: 700,000 arguments overflow the stack.
    const low: Triple = [Infinity, Infinity, Infinity]
    const high: Triple = [-Infinity, -Infinity, -Infinity]
    for (const mesh of meshes)
      for (const point of mesh.points)
        for (const axis of [0, 1, 2] as const) {
          low[axis] = Math.min(low[axis], point[axis])
          high[axis] = Math.max(high[axis], point[axis])
        }
    // 99.3 m along the truss, 30.6 m from Nauka's bottom to the truss top.
    expect(high[0]! - low[0]!).toBeCloseTo(99.3, 0)
    expect(high[1]! - low[1]!).toBeCloseTo(30.6, 0)
    expect(-low[1]!).toBeGreaterThan(high[1]!)
  })

  it('keeps the ten solar-array joints as nodes that say how they turn', () => {
    const joints = iss.nodes.filter((node) => node.extras?.joint !== undefined)
    expect(joints.map((node) => node.name).sort()).toEqual([
      'PORT_ALPHA_ROT',
      'PORT_BETA_ROT_2A',
      'PORT_BETA_ROT_2B',
      'PORT_BETA_ROT_4A',
      'PORT_BETA_ROT_4B',
      'STBD_ALPHA_ROT',
      'STBD_BETA_ROT_1A',
      'STBD_BETA_ROT_1B',
      'STBD_BETA_ROT_3A',
      'STBD_BETA_ROT_3B',
    ])
    for (const node of joints) {
      const joint = node.extras!.joint!
      expect(node.rotation, node.name).toBeUndefined()
      const children = (node.children ?? []).map((index) => iss.nodes[index]!)
      if (joint.kind === 'alpha') {
        // The truss axis, and every wing it carries with its mast across it.
        expect(Math.abs(joint.axis[0])).toBe(1)
        expect(joint.mast).toEqual([0, 0, 1])
        // On the truss axis itself, so turning it moves no vertex nearer the
        // station's center or farther from it.
        expect(Math.abs(node.translation![1])).toBeLessThan(1e-3)
        expect(Math.abs(node.translation![2])).toBeLessThan(1e-3)
        const betas = children.filter(
          (child) => child.extras?.joint?.kind === 'beta',
        )
        expect(betas).toHaveLength(4)
        for (const beta of betas)
          expect(beta.name!.slice(0, 4)).toBe(node.name!.slice(0, 4))
      } else {
        expect(joint.kind).toBe('beta')
        expect(Math.abs(joint.axis[2])).toBe(1)
        expect(Math.abs(joint.normal![0])).toBe(1)
        // The cells face inboard at rest on both sides.
        expect(Math.sign(joint.normal![0])).toBe(
          node.name!.startsWith('PORT') ? 1 : -1,
        )
      }
    }
  })

  it('holds the record’s bounding radius to the mesh’s own, to 1%, at any joint angle', () => {
    // Alpha turns about the truss axis through the center and moves no
    // vertex nearer or farther; a beta joint sweeps its wing round the mast,
    // and the farthest a point gets is its reach about the axis added to the
    // axis's own distance from the center.
    let reach = 0
    for (const mesh of meshes) {
      const beta = mesh.joints.find((joint) => joint.joint?.kind === 'beta')
      for (const point of mesh.points) {
        if (beta === undefined) {
          reach = Math.max(reach, length(point))
          continue
        }
        const axis = beta.joint!.axis
        const relative = sub(point, beta.pivot)
        const along = dot(relative, axis)
        const radial = length(
          sub(relative, [axis[0] * along, axis[1] * along, axis[2] * along]),
        )
        const foot: Triple = [
          beta.pivot[0] + axis[0] * along,
          beta.pivot[1] + axis[1] * along,
          beta.pivot[2] + axis[2] * along,
        ]
        const parallel = dot(foot, axis)
        const across = length(
          sub(foot, [
            axis[0] * parallel,
            axis[1] * parallel,
            axis[2] * parallel,
          ]),
        )
        reach = Math.max(reach, Math.hypot(parallel, across + radial))
      }
    }
    const record = orbitalAsset('iss')!.radius
    expect(Math.abs(reach - record) / reach).toBeLessThanOrEqual(0.01)
  })
})
