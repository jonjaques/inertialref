#!/usr/bin/env node
/*
 * Where a hull's nozzles are, measured off its glTF.
 *
 *   node scripts/nozzles.mjs data/models/rocinante.glb 'thruster_|engines_'
 *
 * The ship's thruster layout (`apps/game/src/render/thrusterLayouts.ts`) is a
 * table of mouths and exhaust directions in the game's hull axes, and every
 * number in it comes from here rather than from a guess about the artwork.
 * The script parses the GLB container itself — the JSON chunk and the binary
 * chunk — with no Three.js, so it runs in a second and says exactly what it
 * did.
 *
 * For every node whose name matches the pattern it walks the mesh into
 * connected shells and reports, per shell:
 *
 *   - the centroid and the area-weighted mean face normal. A nozzle in these
 *     assets is a capped bump whose open loop is the *attachment* to the hull,
 *     so the mean normal — which leans away from the hull — is the exhaust
 *     axis, and the loop's normal is not.
 *   - each boundary loop (edges owned by one triangle), with its centre,
 *     radius and Newell normal. A bell exported as an open shell has its
 *     mouth here, and the loop's radius is the mouth's.
 *
 * Coordinates are given twice: the artist's, and the game's — recentred on
 * the bounding-box middle, scaled to the manifest's length, and turned a half
 * turn about +Y when the bow points +Z — which is precisely what
 * `render/shipModels.ts` does to the hull, so a number printed here can be
 * copied into the layout as it stands.
 */
import { readFileSync } from 'node:fs'

const [file, patternSource, lengthArg, noseArg] = process.argv.slice(2)
if (file === undefined) {
  console.error(
    'usage: node scripts/nozzles.mjs <model.glb> [name pattern] [length m] [nose +z|-z]',
  )
  process.exit(2)
}
const pattern = new RegExp(patternSource ?? 'thruster|engines_', 'i')
const LENGTH = Number(lengthArg ?? 46)
const HALF_TURN = (noseArg ?? '+z') === '+z'

/* --- the container ------------------------------------------------------ */

const buf = readFileSync(file)
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB')
let json = null
let bin = null
for (let off = 12; off < buf.byteLength;) {
  const len = dv.getUint32(off, true)
  const type = dv.getUint32(off + 4, true)
  const chunk = buf.subarray(off + 8, off + 8 + len)
  if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'))
  else if (type === 0x004e4942) bin = chunk
  off += 8 + len
}
const binView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const ELEMENT_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

function accessor(index) {
  const acc = json.accessors[index]
  const view = json.bufferViews[acc.bufferView]
  const bytes = COMPONENT_BYTES[acc.componentType]
  const n = ELEMENT_COUNT[acc.type]
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const stride = view.byteStride || bytes * n
  const out = new Float64Array(acc.count * n)
  for (let i = 0; i < acc.count; i += 1)
    for (let c = 0; c < n; c += 1) {
      const p = base + i * stride + c * bytes
      out[i * n + c] =
        acc.componentType === 5126
          ? binView.getFloat32(p, true)
          : acc.componentType === 5123
            ? binView.getUint16(p, true)
            : acc.componentType === 5125
              ? binView.getUint32(p, true)
              : binView.getUint8(p)
    }
  return out
}

/* --- vectors and the node transform ------------------------------------ */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const norm = (a) => {
  const l = len(a) || 1
  return a.map((x) => x / l)
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const mul = (a, b) => {
  const r = new Array(16).fill(0)
  for (let i = 0; i < 4; i += 1)
    for (let j = 0; j < 4; j += 1)
      for (let k = 0; k < 4; k += 1) r[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]
  return r
}
const local = (node) => {
  if (node.matrix) return node.matrix
  const t = node.translation ?? [0, 0, 0]
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const s = node.scale ?? [1, 1, 1]
  const xx = x * x
  const yy = y * y
  const zz = z * z
  return [
    (1 - 2 * (yy + zz)) * s[0],
    2 * (x * y + w * z) * s[0],
    2 * (x * z - w * y) * s[0],
    0,
    2 * (x * y - w * z) * s[1],
    (1 - 2 * (xx + zz)) * s[1],
    2 * (y * z + w * x) * s[1],
    0,
    2 * (x * z + w * y) * s[2],
    2 * (y * z - w * x) * s[2],
    (1 - 2 * (xx + yy)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ]
}
const apply = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
]

/* --- the walk ------------------------------------------------------------ */

const min = [Infinity, Infinity, Infinity]
const max = [-Infinity, -Infinity, -Infinity]
const matched = []
function walk(index, parent) {
  const node = json.nodes[index]
  const world = mul(parent, local(node))
  if (node.mesh !== undefined) {
    for (const prim of json.meshes[node.mesh].primitives) {
      const pos = accessor(prim.attributes.POSITION)
      const points = []
      for (let i = 0; i < pos.length; i += 3) {
        const p = apply(world, [pos[i], pos[i + 1], pos[i + 2]])
        points.push(p)
        for (let c = 0; c < 3; c += 1) {
          min[c] = Math.min(min[c], p[c])
          max[c] = Math.max(max[c], p[c])
        }
      }
      if (pattern.test(node.name ?? '')) {
        const indices =
          prim.indices === undefined
            ? points.map((_, i) => i)
            : Array.from(accessor(prim.indices))
        matched.push({ name: node.name, points, indices })
      }
    }
  }
  for (const child of node.children ?? []) walk(child, world)
}
for (const root of json.scenes[json.scene ?? 0].nodes) walk(root, IDENTITY)

const centre = min.map((a, i) => (a + max[i]) / 2)
const size = min.map((a, i) => max[i] - a)
const scale = LENGTH / size[2]
const toGame = (p) => {
  const r = sub(p, centre).map((v) => v * scale)
  return HALF_TURN ? [-r[0], r[1], -r[2]] : r
}
const dirToGame = (d) => (HALF_TURN ? [-d[0], d[1], -d[2]] : d)
const f = (v) => `(${v.map((x) => x.toFixed(3)).join(', ')})`

console.log(
  `model: centre ${f(centre)}, size ${f(size)}, ${scale.toFixed(5)} m per unit at ${LENGTH} m${HALF_TURN ? ', bow +Z turned to −Z' : ''}`,
)

for (const { name, points, indices } of matched) {
  // Weld coincident vertices so a seam of split normals is not a boundary.
  const canon = new Map()
  const weld = points.map((p) => {
    const key = p.map((v) => v.toFixed(4)).join(',')
    if (!canon.has(key)) canon.set(key, canon.size)
    return canon.get(key)
  })
  const verts = []
  for (const [key, i] of canon) verts[i] = key.split(',').map(Number)
  const tris = []
  for (let t = 0; t < indices.length; t += 3)
    tris.push([weld[indices[t]], weld[indices[t + 1]], weld[indices[t + 2]]])

  // Connected shells, by union-find over the welded vertices.
  const parent = verts.map((_, i) => i)
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  for (const [a, b, c] of tris) {
    parent[find(a)] = find(b)
    parent[find(a)] = find(c)
  }
  const shells = new Map()
  for (const tri of tris) {
    const root = find(tri[0])
    if (!shells.has(root)) shells.set(root, [])
    shells.get(root).push(tri)
  }

  console.log(
    `\n## ${name}: ${verts.length} vertices, ${tris.length} triangles, ${shells.size} shell(s)`,
  )
  for (const shell of shells.values()) {
    if (shell.length < 4) continue
    const used = new Set(shell.flat())
    const centroid = [0, 0, 0]
    for (const v of used)
      for (let i = 0; i < 3; i += 1) centroid[i] += verts[v][i] / used.size
    let normal = [0, 0, 0]
    for (const [a, b, c] of shell)
      normal = add(
        normal,
        cross(sub(verts[b], verts[a]), sub(verts[c], verts[a])),
      )
    normal = norm(normal)

    const edges = new Map()
    for (const [a, b, c] of shell)
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const key = u < v ? `${u}-${v}` : `${v}-${u}`
        edges.set(key, (edges.get(key) ?? 0) + 1)
      }
    const adjacency = new Map()
    for (const [key, count] of edges) {
      if (count !== 1) continue
      const [u, v] = key.split('-').map(Number)
      if (!adjacency.has(u)) adjacency.set(u, [])
      if (!adjacency.has(v)) adjacency.set(v, [])
      adjacency.get(u).push(v)
      adjacency.get(v).push(u)
    }
    const seen = new Set()
    const loops = []
    for (const start of adjacency.keys()) {
      if (seen.has(start)) continue
      const loop = []
      let at = start
      let previous = -1
      while (at !== undefined && !seen.has(at)) {
        seen.add(at)
        loop.push(at)
        const next = adjacency
          .get(at)
          .find((n) => n !== previous && !seen.has(n))
        previous = at
        at = next
      }
      if (loop.length >= 3) loops.push(loop)
    }

    console.log(
      `  shell: ${used.size} vertices, ${shell.length} triangles, ${loops.length} loop(s)`,
    )
    console.log(
      `    centroid  model ${f(centroid)}  game ${f(toGame(centroid))}`,
    )
    console.log(
      `    mean normal model ${f(normal)}  game ${f(dirToGame(normal))}`,
    )
    for (const loop of loops) {
      const lc = [0, 0, 0]
      for (const v of loop)
        for (let i = 0; i < 3; i += 1) lc[i] += verts[v][i] / loop.length
      let n = [0, 0, 0]
      for (let i = 0; i < loop.length; i += 1)
        n = add(n, cross(verts[loop[i]], verts[loop[(i + 1) % loop.length]]))
      n = norm(n)
      // Signed toward the shell's own centroid: away from it is "out".
      if (dot(n, sub(lc, centroid)) < 0) n = n.map((x) => -x)
      const radius =
        loop.reduce((s, v) => s + len(sub(verts[v], lc)), 0) / loop.length
      console.log(
        `    loop ×${loop.length}: centre model ${f(lc)}  game ${f(toGame(lc))}  radius ${(radius * scale).toFixed(3)} m  normal game ${f(dirToGame(n))}`,
      )
    }
  }
}
