import { readFileSync } from 'node:fs'

/*
 * Where the hero hull actually is, read off the shipped glTF without a GPU.
 *
 * A cutscene stages its camera relative to the hull in screen terms — a screen
 * position and a range — so nothing in the authoring says how close that is to
 * the *geometry*, and the answer depends on the hull's attitude as much as on
 * the range. `tng-intro`'s skim flew the camera through the saucer for
 * forty-eight frames on beats that read perfectly well as numbers: at f2188 the
 * camera sat inside the disc with the engineering hull's battle bridge visible
 * through the plating. Nothing in the diff against the reference could see it,
 * because the subject channel measures a lit mass and a lit mass is exactly
 * what an interior wall is.
 *
 * So the check has to know the shape. This reads it from the asset the renderer
 * loads, in Node, and reduces it to the cheapest description that can answer
 * "is this point inside the ship": a **height field**. For each column of the
 * hull's own XZ plane it keeps the lowest and highest vertex, and a point is
 * inside when it falls between them. That model fits this subject — a starship
 * is a flattened disc with a hull slung under it, and every camera that has any
 * business near one is above or below the plating rather than threading the
 * gap between two nacelles. It would be the wrong model for a torus.
 *
 * **Vertices, not triangles**, and only the JSON and BIN chunks are touched —
 * no image decode, no index buffer, no draw. 46,000 positions is a few
 * milliseconds. The cost of sampling vertices is that a large flat triangle
 * bulges between them, which is what `CLEARANCE_MARGIN_M` in the test is for.
 */

/**
 * The column a point falls in, packed into one integer, or null when it falls
 * outside the range that packing can represent.
 *
 * `(i + HALF) * SPAN + (j + HALF)` is only injective while both indices are
 * inside ±`HALF`; past that the j term borrows into the i term and the key
 * aliases onto a different column. That is not hypothetical here — the
 * clearance sweep asks about camera positions up to 968 km out in hull axes,
 * and `depthInside({ x: 0, y: 0, z: 65536 })` used to answer "32.8 m inside the
 * hull" for a point 65 km astern. Refusing the key is what turns that back into
 * the honest answer, which is that there is no geometry out there at all.
 */
const HALF = 4096
const SPAN = 8192
function columnKey(x: number, z: number, cell: number): number | null {
  const i = Math.floor(x / cell)
  const j = Math.floor(z / cell)
  if (i < -HALF || i >= HALF || j < -HALF || j >= HALF) return null
  return (i + HALF) * SPAN + (j + HALF)
}

export interface HullField {
  /** Column size, meters. */
  readonly cell: number
  /** Overall extent in hull axes, meters — a sanity check on the transform. */
  readonly extent: {
    readonly x: number
    readonly y: number
    readonly z: number
  }
  readonly columns: number
  /**
   * How far inside the surface envelope a point is, meters. Negative is clear,
   * and `-Infinity` means the column holds no geometry at all.
   */
  depthInside(p: { x: number; y: number; z: number }): number
}

interface Gltf {
  scene?: number
  scenes: { nodes: number[] }[]
  nodes: {
    name?: string
    mesh?: number
    children?: number[]
    matrix?: number[]
    translation?: [number, number, number]
    rotation?: [number, number, number, number]
    scale?: [number, number, number]
  }[]
  meshes: { primitives: { attributes: { POSITION: number } }[] }[]
  accessors: { bufferView: number; byteOffset?: number; count: number }[]
  bufferViews: { byteOffset?: number; byteStride?: number }[]
}

type Mat4 = number[]

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** Column-major, the same convention glTF's own `matrix` uses. */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0)
  for (let row = 0; row < 4; row += 1)
    for (let col = 0; col < 4; col += 1)
      for (let k = 0; k < 4; k += 1)
        (out[col * 4 + row] as number) +=
          (a[k * 4 + row] as number) * (b[col * 4 + k] as number)
  return out
}

function localMatrix(node: Gltf['nodes'][number]): Mat4 {
  if (node.matrix !== undefined) return node.matrix.slice()
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]
}

const transform = (
  m: Mat4,
  x: number,
  y: number,
  z: number,
): [number, number, number] => [
  (m[0] as number) * x +
    (m[4] as number) * y +
    (m[8] as number) * z +
    (m[12] as number),
  (m[1] as number) * x +
    (m[5] as number) * y +
    (m[9] as number) * z +
    (m[13] as number),
  (m[2] as number) * x +
    (m[6] as number) * y +
    (m[10] as number) * z +
    (m[14] as number),
]

const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942
const GLB_MAGIC = 0x46546c67

/**
 * The hull's occupancy, in the axes the game uses: nose along −Z, +Y up,
 * origin on the model's own bounding-box center.
 *
 * The recenter / rotate / rescale here restates what
 * `apps/game/src/render/shipModels.ts` does when it builds the hull, and
 * deliberately takes the same two inputs from the same manifest — the true
 * length and which way the artist pointed the bow — so the two cannot disagree
 * about *those*. They can still disagree about the arrangement, which is why
 * `extent` is returned and asserted: a hull whose Z extent is not the
 * manifest's length has been through a different transform than the renderer's.
 */
export function readHullField(
  glbPath: string,
  lengthMetres: number,
  nose: '+z' | '-z',
  cell = 8,
): HullField {
  const buf = readFileSync(glbPath)
  if (buf.readUInt32LE(0) !== GLB_MAGIC)
    throw new Error(`${glbPath} is not a binary glTF`)

  let offset = 12
  let gltf: Gltf | null = null
  let bin: Buffer | null = null
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset)
    const kind = buf.readUInt32LE(offset + 4)
    const body = buf.subarray(offset + 8, offset + 8 + length)
    if (kind === JSON_CHUNK) gltf = JSON.parse(body.toString('utf8')) as Gltf
    if (kind === BIN_CHUNK) bin = body
    // Chunks are four-byte aligned; the padding is not counted in `length`.
    offset += 8 + length + ((4 - (length % 4)) % 4)
  }
  if (gltf === null || bin === null)
    throw new Error(`${glbPath} has no JSON or BIN chunk`)
  const binary = bin
  const doc = gltf

  const points: [number, number, number][] = []
  const walk = (index: number, parent: Mat4): void => {
    const node = doc.nodes[index]
    if (node === undefined) return
    const world = multiply(parent, localMatrix(node))
    if (node.mesh !== undefined) {
      const mesh = doc.meshes[node.mesh]
      for (const primitive of mesh?.primitives ?? []) {
        const accessor = doc.accessors[primitive.attributes.POSITION]
        if (accessor === undefined) continue
        const view = doc.bufferViews[accessor.bufferView]
        if (view === undefined) continue
        // POSITION is always three floats; a stride is only present when the
        // accessor is interleaved with normals and UVs, which this one is not.
        const stride = view.byteStride ?? 12
        const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
        for (let i = 0; i < accessor.count; i += 1) {
          const at = base + i * stride
          points.push(
            transform(
              world,
              binary.readFloatLE(at),
              binary.readFloatLE(at + 4),
              binary.readFloatLE(at + 8),
            ),
          )
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world)
  }
  const scene = doc.scenes[doc.scene ?? 0]
  for (const root of scene?.nodes ?? []) walk(root, IDENTITY)
  if (points.length === 0) throw new Error(`${glbPath} has no vertex positions`)

  const low = [Infinity, Infinity, Infinity]
  const high = [-Infinity, -Infinity, -Infinity]
  for (const p of points)
    for (let k = 0; k < 3; k += 1) {
      if ((p[k] as number) < (low[k] as number)) low[k] = p[k] as number
      if ((p[k] as number) > (high[k] as number)) high[k] = p[k] as number
    }
  const centre = [0, 1, 2].map(
    (k) => ((low[k] as number) + (high[k] as number)) / 2,
  )
  const size = [0, 1, 2].map((k) => (high[k] as number) - (low[k] as number))
  const scale = lengthMetres / (size[2] as number)
  // `+z` art turns half a turn about Y to face the game's −Z, which negates x
  // and z; `-z` art is already facing the right way.
  const flip = nose === '+z' ? -1 : 1

  const columns = new Map<number, [number, number]>()
  const extent = { x: 0, y: 0, z: 0 }
  for (const p of points) {
    const x = flip * ((p[0] as number) - (centre[0] as number)) * scale
    const y = ((p[1] as number) - (centre[1] as number)) * scale
    const z = flip * ((p[2] as number) - (centre[2] as number)) * scale
    extent.x = Math.max(extent.x, Math.abs(x) * 2)
    extent.y = Math.max(extent.y, Math.abs(y) * 2)
    extent.z = Math.max(extent.z, Math.abs(z) * 2)
    // One integer key rather than a string: 46,000 of these at build time and
    // one per frame of a 2742-frame sweep is the whole cost of the test.
    const key = columnKey(x, z, cell)
    // A vertex outside the key's domain would be a hull tens of kilometers
    // across, which the `extent` assertions would have caught first.
    if (key === null)
      throw new Error(`${glbPath} has a vertex ${x}, ${z} out of range`)
    const found = columns.get(key)
    if (found === undefined) columns.set(key, [y, y])
    else {
      if (y < found[0]) found[0] = y
      if (y > found[1]) found[1] = y
    }
  }

  return {
    cell,
    extent,
    columns: columns.size,
    depthInside(p) {
      const key = columnKey(p.x, p.z, cell)
      // Outside the key's own domain there is provably no geometry — the hull
      // is a few hundred meters across — so a point out there is clear, and
      // saying so is not the same as failing to find its column.
      if (key === null) return -Infinity
      const column = columns.get(key)
      if (column === undefined) return -Infinity
      return Math.min(p.y - column[0], column[1] - p.y)
    },
  }
}
