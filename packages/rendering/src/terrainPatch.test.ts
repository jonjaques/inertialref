import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Vec, vec3, type Vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import {
  type Body,
  COVER_CHANNELS,
  generateHeightfield,
  geodeticDirection,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  heightfieldStride,
  morphIndex,
  morphSide,
  morphVertexSide,
  type RegionAddress,
  regionAddress,
  regionChildren,
  regionDirection,
  regionForDirection,
  regionNeighbor,
  regionParent,
  surveySites,
  systemId,
  TEST_CATALOG,
  walkBodies,
} from '@inertialref/universe'
import {
  buildPatch,
  morphRounding,
  patchIndices,
  type RenderPatch,
  toParentGrid,
} from './terrainMesh.ts'
import { vertexMorph } from './patchGround.ts'
import {
  regionKey,
  type SelectedPatch,
  selectTerrain,
} from './terrainSelect.ts'

/*
 * What a patch has to be true about, for the quadtree not to crack or pop.
 *
 * Both properties are geometry rather than shader, which is the point: the
 * morph is arranged so that the shader's whole share of it is one `mix`
 * between two attributes this file checks, on any Node and with no GPU. If
 * the endpoints are right, the interpolation between them cannot be wrong.
 */

const RESOLUTION = 33

/** A patch's four edge steps, in `PATCH_EDGE`'s bit order. */
const STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/** The grid indices along the edge a step crosses, in the patch's own order. */
const edgeIndices = (resolution: number, di: number, dj: number): number[] =>
  Array.from({ length: resolution }, (_, k) =>
    di === 1
      ? k * resolution + resolution - 1
      : di === -1
        ? k * resolution
        : dj === 1
          ? (resolution - 1) * resolution + k
          : k,
  )

/**
 * Where the parent keeps a child's vertex once it is fully morphed: the
 * child's index rounded onto the parent's grid, in the parent's grid.
 */
function parentIndexOf(
  child: RegionAddress,
  quadrant: number,
  row: number,
  col: number,
  resolution: number,
): number {
  const rounding = morphRounding(child.face)
  const half = (resolution - 1) / 2
  const qi = quadrant % 2
  const qj = quadrant < 2 ? 0 : 1
  return (
    (half * qj + toParentGrid(row, rounding.row) / 2) * resolution +
    (half * qi + toParentGrid(col, rounding.col) / 2)
  )
}

function solidBody(): Body {
  const world = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
  const system = world.loadSystem(systemId('SOL'))
  const body = [...walkBodies(system)].find((b) => b.surface.maxElevation > 0)
  if (body === undefined) throw new Error('no solid body')
  return body
}

function patchOf(
  body: Body,
  region: RegionAddress,
  resolution = RESOLUTION,
  twin = true,
): RenderPatch {
  const field = generateHeightfield(body.surface, { region, resolution })
  return buildPatch({
    region,
    resolution,
    border: field.border,
    elevations: field.elevations,
    cover: field.cover,
    bodyRadius: body.radius,
    morph: twin ? field.morph : null,
  })
}

/** Earth: a world that drains, so a patch and its parent resolve different creeks. */
function wetBody(): Body {
  const world = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
  const system = world.loadSystem(systemId('SOL'))
  const body = [...walkBodies(system)].find((b) => b.name === 'Earth')
  if (body === undefined) throw new Error('no Earth')
  return body
}

/**
 * How far a child's fully morphed tessellation stands from its parent's: the
 * worst vertex, the worst normal component, and how many cover bytes differ.
 */
function handover(
  body: Body,
  parentRegion: RegionAddress,
  resolution: number,
  twin: boolean,
): { position: number; normal: number; cover: number } {
  const parent = patchOf(body, parentRegion, resolution)
  let position = 0
  let normal = 0
  let cover = 0
  for (const [quadrant, childRegion] of regionChildren(
    parentRegion,
  ).entries()) {
    const child = patchOf(body, childRegion, resolution, twin)
    for (let row = 0; row < resolution; row += 1) {
      for (let col = 0; col < resolution; col += 1) {
        const index = row * resolution + col
        const parentIndex = parentIndexOf(
          childRegion,
          quadrant,
          row,
          col,
          resolution,
        )
        const mine = Vec.add(
          child.anchor,
          vec3(
            child.morphPositions[index * 3] as number,
            child.morphPositions[index * 3 + 1] as number,
            child.morphPositions[index * 3 + 2] as number,
          ),
        )
        const theirs = Vec.add(
          parent.anchor,
          vec3(
            parent.positions[parentIndex * 3] as number,
            parent.positions[parentIndex * 3 + 1] as number,
            parent.positions[parentIndex * 3 + 2] as number,
          ),
        )
        position = Math.max(position, Vec.distance(mine, theirs))
        for (let k = 0; k < 3; k += 1) {
          normal = Math.max(
            normal,
            Math.abs(
              (child.morphNormals[index * 3 + k] as number) -
                (parent.normals[parentIndex * 3 + k] as number),
            ),
          )
        }
        for (let k = 0; k < COVER_CHANNELS; k += 1) {
          if (
            child.morphCover[index * COVER_CHANNELS + k] !==
            parent.cover[parentIndex * COVER_CHANNELS + k]
          )
            cover += 1
        }
      }
    }
  }
  return { position, normal, cover }
}

/** A vertex in body-fixed axes: anchor-relative plus the anchor. */
const vertexOf = (patch: RenderPatch, index: number, of = 'positions'): Vec3 =>
  Vec.add(
    patch.anchor,
    vec3(
      (of === 'positions' ? patch.positions : patch.morphPositions)[
        index * 3
      ] as number,
      (of === 'positions' ? patch.positions : patch.morphPositions)[
        index * 3 + 1
      ] as number,
      (of === 'positions' ? patch.positions : patch.morphPositions)[
        index * 3 + 2
      ] as number,
    ),
  )

const normalOf = (patch: RenderPatch, index: number, of = 'normals'): Vec3 =>
  vec3(
    (of === 'normals' ? patch.normals : patch.morphNormals)[
      index * 3
    ] as number,
    (of === 'normals' ? patch.normals : patch.morphNormals)[
      index * 3 + 1
    ] as number,
    (of === 'normals' ? patch.normals : patch.morphNormals)[
      index * 3 + 2
    ] as number,
  )

describe('a terrain patch', () => {
  it('is exactly its parent once fully morphed', () => {
    /*
     * The claim CDLOD makes and the one this whole phase's "no pops" rests on:
     * a patch whose morph has run to one is not *approximately* its parent, it
     * is its parent, vertex for vertex — so the frame where the parent takes
     * over draws the same triangles as the frame before it.
     *
     * It holds because a child covers half its parent's side, 64 quads halved
     * is 32, and every even index of the child therefore lands on a parent grid
     * point. Rounding each odd index to an even neighbor puts every vertex on
     * a parent vertex, and the field is a pure function of direction, so the
     * elevation there is the same number both patches computed.
     */
    const body = solidBody()
    const parentRegion = regionAddress(2, 8, 130, 97)
    const parent = patchOf(body, parentRegion)

    for (const [quadrant, childRegion] of regionChildren(
      parentRegion,
    ).entries()) {
      const child = patchOf(body, childRegion)

      let worst = 0
      let worstNormal = 0
      for (let row = 0; row < RESOLUTION; row += 1) {
        for (let col = 0; col < RESOLUTION; col += 1) {
          const index = row * RESOLUTION + col
          // Where the parent keeps this vertex: the child's own index
          // rounded onto the parent's grid, expressed in the parent's grid.
          const parentIndex = parentIndexOf(
            childRegion,
            quadrant,
            row,
            col,
            RESOLUTION,
          )
          worst = Math.max(
            worst,
            Vec.distance(
              vertexOf(child, index, 'morphPositions'),
              vertexOf(parent, parentIndex),
            ),
          )
          const mine = normalOf(child, index, 'morphNormals')
          const theirs = normalOf(parent, parentIndex)
          /*
           * Compared component-wise rather than as an angle. `acos` of the dot
           * product of two float32 unit vectors reports 3.5e-4 radians for
           * vectors that are *bit-identical*, because it amplifies the
           * quantization by its own square root — which is a measurement
           * artifact of exactly the size a real disagreement would be.
           */
          worstNormal = Math.max(
            worstNormal,
            Math.abs(mine.x - theirs.x),
            Math.abs(mine.y - theirs.y),
            Math.abs(mine.z - theirs.z),
          )
        }
      }
      /*
       * The bound is float32 over a patch half-span and nothing else. At level
       * 8 on this body a patch is tens of kilometers across, where a float32
       * step is a few millimeters; the two patches subtract different anchors
       * from the same float64 position, so that rounding is the whole
       * disagreement.
       */
      expect(worst).toBeLessThan(0.05)
      /*
       * Normals agree *exactly* — the morph normal is a two-cell difference,
       * which is one of the parent's cells, taken over the same samples the
       * parent takes it over. Both patches compute it in float64 from the same
       * field and round once, so the bound is one float32 step in a unit
       * vector and not a tolerance for a near miss.
       */
      expect(worstNormal).toBeLessThan(1e-6)
    }
  })

  it('is exactly its parent once fully morphed where the two resolve different creeks', () => {
    /*
     * The drainage refinement is resolved to one level below a patch's own
     * (`regionDrainageLevel`), so a child carries a level of creeks its
     * parent does not, and its own samples at the parent's grid are not the
     * parent's. The heightfield's morph twin is the child's even samples at
     * the parent's resolution, and the three claims above hold through it:
     * positions to float32 over the patch, normals to a float32 step, cover
     * to the byte.
     *
     * The parent is the level-9 cell over Earth's survey summit, where it
     * resolves level 10 and its children level 11 — both refined — so the
     * handover crosses a level of creeks; without the twin the same handover
     * misses, and the last line says so.
     */
    const body = wetBody()
    const summit = surveySites(body).find((site) => site.id === 'summit')
    if (summit === undefined) throw new Error('Earth has no summit')
    const parentRegion = regionForDirection(
      geodeticDirection(summit.latitude, summit.longitude),
      9,
    )
    const exact = handover(body, parentRegion, RESOLUTION, true)
    expect(exact.position).toBeLessThan(0.05)
    expect(exact.normal).toBeLessThan(1e-6)
    expect(exact.cover).toBe(0)
    const own = handover(body, parentRegion, RESOLUTION, false)
    expect(own.position).toBeGreaterThan(0.05)
  })

  it("wears exactly its parent's cover once fully morphed", () => {
    /*
     * The same claim, for the material. Geometry that hands over exactly while
     * the albedo does not is worse than a pop: the ray edges and the mare
     * margins slide by one child cell across the whole morph band and keep
     * sliding as the camera moves, which reads as a shimmering ring around the
     * viewer rather than as a single switch.
     *
     * **Bit-exact, not close.** The cover is bytes, both patches evaluate the
     * same pure function of the same direction, and the child's rounded vertex
     * *is* a parent vertex — so there is no rounding for a tolerance to
     * absorb, and any disagreement at all is the two grids having been indexed
     * differently.
     */
    const body = solidBody()
    const parentRegion = regionAddress(2, 8, 130, 97)
    const parent = patchOf(body, parentRegion)

    for (const [quadrant, childRegion] of regionChildren(
      parentRegion,
    ).entries()) {
      const child = patchOf(body, childRegion)

      for (let row = 0; row < RESOLUTION; row += 1) {
        for (let col = 0; col < RESOLUTION; col += 1) {
          const index = row * RESOLUTION + col
          const parentIndex = parentIndexOf(
            childRegion,
            quadrant,
            row,
            col,
            RESOLUTION,
          )
          for (let channel = 0; channel < COVER_CHANNELS; channel += 1) {
            expect(child.morphCover[index * COVER_CHANNELS + channel]).toBe(
              parent.cover[parentIndex * COVER_CHANNELS + channel],
            )
          }
        }
      }
    }
  })

  it('shares its edge vertices and its edge normals with its neighbor', () => {
    /*
     * Two patches at the same level meeting inside a cube face. The vertices
     * have to be identical rather than close, and so do the normals — a normal
     * that disagrees across a boundary is the hairline the one-sided edge
     * difference used to draw, which the border row exists to remove.
     */
    const body = solidBody()
    const left = regionAddress(4, 8, 100, 60)
    const right = regionNeighbor(left, 1, 0)
    expect(right.face).toBe(left.face)

    const a = patchOf(body, left)
    const b = patchOf(body, right)
    for (let row = 0; row < RESOLUTION; row += 1) {
      const mine = row * RESOLUTION + (RESOLUTION - 1)
      const theirs = row * RESOLUTION
      expect(Vec.distance(vertexOf(a, mine), vertexOf(b, theirs))).toBeLessThan(
        0.05,
      )
      // Bit-identical, in fact: inside a face a patch's border sample is the
      // same expression its neighbor evaluates for its own first interior row.
      expect(normalOf(a, mine)).toEqual(normalOf(b, theirs))
    }
  })

  it('meets its neighbor across a cube-face edge', () => {
    /*
     * The same thing where the addressing rotates. Which of the neighbor's four
     * edges this one is, and in which direction, is the arithmetic under test —
     * so the assertion is that exactly one of them matches, rather than naming
     * one and agreeing with a wrong answer.
     */
    const body = solidBody()
    const span = 2 ** 8
    for (let face = 0; face < 6; face += 1) {
      const mine = regionAddress(face, 8, span - 1, 120)
      const theirs = regionNeighbor(mine, 1, 0)
      expect(theirs.face).not.toBe(face)

      const a = patchOf(body, mine)
      const b = patchOf(body, theirs)
      const edge = (patch: RenderPatch, which: number): Vec3[] => {
        const out: Vec3[] = []
        for (let k = 0; k < RESOLUTION; k += 1) {
          const index =
            which === 0
              ? k * RESOLUTION
              : which === 1
                ? k * RESOLUTION + (RESOLUTION - 1)
                : which === 2
                  ? k
                  : (RESOLUTION - 1) * RESOLUTION + k
          out.push(vertexOf(patch, index))
        }
        return out
      }
      const target = edge(a, 1)
      /*
       * Matched by distance rather than by an equality on rounded coordinates.
       * The two patches subtract different anchors from the same float64
       * point, so their float32 vertices differ by millimeters — and a
       * quantized comparison turns a millimeter into a miss whenever the two
       * land either side of a bucket boundary.
       */
      const gap = (one: readonly Vec3[], other: readonly Vec3[]): number =>
        one.reduce(
          (worst, point, k) =>
            Math.max(worst, Vec.distance(point, other[k] as Vec3)),
          0,
        )
      const matches = [0, 1, 2, 3].filter((which) => {
        const other = edge(b, which)
        return (
          gap(target, other) < 0.05 || gap(target, [...other].reverse()) < 0.05
        )
      })
      expect(matches).toHaveLength(1)
    }
  })

  it('slides the vertices it shares across every cube-face edge where its neighbor does', () => {
    /*
     * Two patches on one level slide a shared vertex by one factor, so the
     * vertex has to slide to one place — and an odd vertex slides a whole cell
     * along the edge. On four of the twelve edges the faces count the edge in
     * opposite directions, and rounding down on both sides sends the two copies
     * to opposite ends of the cell: mid-band, a gap a cell long down the edge.
     * Every face, every edge, so the flipped four cannot hide among the eight
     * that agree.
     */
    const body = solidBody()
    const span = 2 ** 8
    const edge = (di: number, dj: number): number[] =>
      edgeIndices(RESOLUTION, di, dj)
    let compared = 0
    for (let face = 0; face < 6; face += 1) {
      for (const [di, dj] of STEPS) {
        const mine = regionAddress(
          face,
          8,
          di === 1 ? span - 1 : di === -1 ? 0 : 120,
          dj === 1 ? span - 1 : dj === -1 ? 0 : 120,
        )
        const theirs = regionNeighbor(mine, di, dj)
        expect(theirs.face).not.toBe(face)
        const a = patchOf(body, mine)
        const b = patchOf(body, theirs)
        const candidates = STEPS.flatMap(([ei, ej]) => edge(ei, ej))
        for (const index of edge(di, dj)) {
          const here = vertexOf(a, index)
          // The same vertex on the other side, found by where it stands: which
          // of the neighbor's edges this is, and which way it runs, is what is
          // under test, so neither is assumed. The float32 bound is the one
          // the edge test above gives.
          const twin = candidates.find(
            (other) => Vec.distance(vertexOf(b, other), here) < 0.05,
          )
          expect(twin).toBeDefined()
          expect(
            Vec.distance(
              vertexOf(a, index, 'morphPositions'),
              vertexOf(b, twin as number, 'morphPositions'),
            ),
          ).toBeLessThan(0.05)
          compared += 1
        }
      }
    }
    expect(compared).toBe(24 * RESOLUTION)
  })

  it('shares one index buffer across every patch of a resolution', () => {
    /*
     * 24,576 indices is 98 KB, a whole-disk selection is a couple of hundred
     * patches, and the triangle list is a function of the resolution alone. One
     * array means one GPU buffer for the session rather than one per patch.
     */
    const body = solidBody()
    const one = patchOf(body, regionAddress(0, 6, 12, 40))
    const two = patchOf(body, regionAddress(3, 9, 300, 12))
    expect(one.indices).toBe(two.indices)
    expect(one.indices).toBe(patchIndices(RESOLUTION))
    expect(patchIndices(HEIGHTFIELD_RESOLUTION)).not.toBe(one.indices)
  })

  it('refuses a heightfield that is the wrong size or has no border', () => {
    const body = solidBody()
    const region = regionAddress(1, 5, 7, 7)
    const field = generateHeightfield(body.surface, {
      region,
      resolution: RESOLUTION,
      border: 0,
    })
    expect(() =>
      buildPatch({
        region,
        resolution: RESOLUTION,
        border: 0,
        elevations: field.elevations,
        cover: field.cover,
        bodyRadius: body.radius,
      }),
    ).toThrow(/two rings/)
  })
})

describe('the drawn ground', () => {
  /*
   * The whole surface rather than a patch: a real selection, every patch in
   * it built, every vertex slid exactly as the material slides it, and every
   * edge two patches share drawn by both of them and compared. That is the
   * only form of the crack-free claim that sees both halves of a level
   * boundary — the finer patch has to have arrived on the coarser one's grid,
   * which the selection's own property holds, and the coarser one has to
   * still be drawing that grid, which only `finerEdges` holds. Without the
   * hold, standing two meters up, one edge sample in ten along the level
   * boundaries stands open by more than a quarter of a pixel.
   *
   * The field is synthetic because the claim is about the mesh, and a real
   * one is ten milliseconds a patch. One octave per level the selection
   * reaches, amplitude falling as wavelength^0.8, so every cell carries the
   * curvature an open edge needs in order to show — and it resolves by level
   * the way the creeks do (`regionDrainageLevel`): a patch carries the
   * octaves its cells can draw, two past its own level, and its morph twin
   * the ones its parent's can. So an even vertex moves too, vertically onto
   * the parent's carve, and the corner a held edge shares with a same-level
   * patch diagonal to finer ground is asked. On one field at every level
   * that corner never moves and the test could not see it.
   */
  const radius = 400_000
  const RES = HEIGHTFIELD_RESOLUTION
  const octaves = Array.from({ length: 16 }, (_, n) => {
    const angle = n * 2.399963
    return {
      axis: Vec.normalize(
        vec3(Math.cos(angle), Math.sin(angle * 1.7), Math.cos(angle * 0.3)),
      ),
      frequency: 7 * 2 ** n,
      amplitude: 1_400 * 2 ** (-0.8 * n),
      phase: n * 1.3,
    }
  })
  const relief = octaves.reduce((sum, octave) => sum + octave.amplitude, 0)
  /** The field a patch at `level` draws: every octave its cells resolve. */
  const elevation = (d: Vec3, level: number): number =>
    octaves.reduce(
      (sum, o, n) =>
        n > level + 2
          ? sum
          : sum +
            o.amplitude * Math.sin(o.frequency * Vec.dot(d, o.axis) + o.phase),
      0,
    )
  const cache = new Map<number | string, RenderPatch>()
  const patchAt = (region: RegionAddress): RenderPatch => {
    const key = regionKey(region)
    const held = cache.get(key)
    if (held !== undefined) return held
    const border = HEIGHTFIELD_BORDER
    const stride = heightfieldStride({ resolution: RES, border })
    const at = (row: number, col: number): Vec3 =>
      regionDirection(region, col / (RES - 1), row / (RES - 1))
    const elevations = new Float32Array(stride * stride)
    for (let row = -border; row < RES + border; row += 1)
      for (let col = -border; col < RES + border; col += 1)
        elevations[(row + border) * stride + col + border] = elevation(
          at(row, col),
          region.level,
        )
    // The twin: the parent's field at the even samples, border included,
    // laid out as `generateHeightfield` lays out its own.
    const side = morphSide({ resolution: RES, border })
    const vertexSide = morphVertexSide(RES)
    const twin = new Float32Array(side * side)
    const first = Math.ceil(-border / 2) * 2
    for (let row = first; row < RES + border; row += 2)
      for (let col = first; col < RES + border; col += 2)
        twin[morphIndex(side, border, row, col)] = elevation(
          at(row, col),
          region.level - 1,
        )
    const built = buildPatch({
      region,
      resolution: RES,
      border,
      elevations,
      cover: new Uint8Array(RES * RES * COVER_CHANNELS),
      bodyRadius: radius,
      morph:
        region.level === 0
          ? null
          : {
              elevations: twin,
              cover: new Uint8Array(vertexSide * vertexSide * COVER_CHANNELS),
              water: new Float32Array(vertexSide * vertexSide).fill(Number.NaN),
            },
    })
    cache.set(key, built)
    return built
  }
  const edge = (di: number, dj: number): number[] => edgeIndices(RES, di, dj)
  /** A vertex where the material puts it: slid by its own factor, or held. */
  const drawn = (
    patch: RenderPatch,
    selected: SelectedPatch,
    eye: Vec3,
    index: number,
  ): Vec3 => {
    const k = vertexMorph(
      patch,
      {
        eye,
        start: selected.morphStart,
        end: selected.morphEnd,
        finerEdges: selected.finerEdges,
      },
      Math.floor(index / RES),
      index % RES,
    )
    const at = index * 3
    const p = patch.positions
    const m = patch.morphPositions
    return vec3(
      patch.anchor.x +
        (p[at] as number) +
        ((m[at] as number) - (p[at] as number)) * k,
      patch.anchor.y +
        (p[at + 1] as number) +
        ((m[at + 1] as number) - (p[at + 1] as number)) * k,
      patch.anchor.z +
        (p[at + 2] as number) +
        ((m[at + 2] as number) - (p[at + 2] as number)) * k,
    )
  }
  const toPolyline = (point: Vec3, line: readonly Vec3[]): number => {
    let best = Infinity
    for (let n = 0; n + 1 < line.length; n += 1) {
      const a = line[n] as Vec3
      const along = Vec.sub(line[n + 1] as Vec3, a)
      const square = Vec.lengthSquared(along)
      const t =
        square > 0
          ? Math.min(1, Math.max(0, Vec.dot(Vec.sub(point, a), along) / square))
          : 0
      best = Math.min(
        best,
        Vec.distance(point, Vec.add(a, Vec.scale(along, t))),
      )
    }
    return best
  }

  /** The widest gap between any two patches' copies of an edge they share. */
  const widestGap = (direction: Vec3, height: number): number => {
    const distance = radius + elevation(direction, 14) + height
    const selection = selectTerrain(
      {
        radius,
        relief,
        distance,
        direction: direction as Parameters<
          typeof selectTerrain
        >[0]['direction'],
      },
      { maxLevel: 12 },
    )
    const eye = Vec.scale(direction, distance)
    const byKey = new Map(
      selection.patches.map((patch) => [regionKey(patch.region), patch]),
    )
    let widest = 0
    // The nearest boundaries, which are the widest on screen and bound the run.
    const nearest = [...selection.patches]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 60)
    for (const fine of nearest) {
      for (const [di, dj] of STEPS) {
        const beside = regionNeighbor(fine.region, di, dj)
        const parent = regionParent(beside)
        // The neighbor on this level, or the coarser one covering it. A pair
        // on one level inside a face shares its vertices outright, and is
        // asked anyway: that is the claim, not an assumption under it.
        const coarse =
          byKey.get(regionKey(beside)) ??
          (parent === null ? undefined : byKey.get(regionKey(parent)))
        if (coarse === undefined) continue
        const finePatch = patchAt(fine.region)
        const coarsePatch = patchAt(coarse.region)
        const mine = edge(di, dj)
        // Which of the coarse patch's edges this is, by the direction the
        // middle of this one stands in: an even vertex, so a point of the
        // coarse grid. By direction rather than position, because the two
        // levels carve the same point to different depths.
        const middle = Vec.normalize(
          vertexOf(finePatch, mine[(RES - 1) / 2] as number),
        )
        const theirs = STEPS.map(([ei, ej]) => edge(ei, ej)).find((indices) =>
          indices.some(
            (index) =>
              Vec.distance(
                Vec.normalize(vertexOf(coarsePatch, index)),
                middle,
              ) *
                radius <
              0.05,
          ),
        )
        expect(theirs).toBeDefined()
        const line = (theirs as number[]).map((index) =>
          drawn(coarsePatch, coarse, eye, index),
        )
        for (const index of mine)
          widest = Math.max(
            widest,
            toPolyline(drawn(finePatch, fine, eye, index), line),
          )
      }
    }
    return widest
  }

  /*
   * float32 over a patch half-span, the bound the rest of this file uses: the
   * two copies subtract different anchors from one float64 point. An open
   * edge on this field is meters wide.
   */
  const CLOSED = 0.05

  it('closes on a flipped cube-face edge, standing on it', () => {
    // Faces 0 and 3 meet here and count the edge in opposite directions.
    expect(widestGap(Vec.normalize(vec3(1, -1, 0.01)), 2)).toBeLessThan(CLOSED)
  })

  it('closes at every edge two patches share, on a field that resolves by level (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.double({ min: -0.95, max: 0.95, noNaN: true }),
        fc.double({ min: -0.95, max: 0.95, noNaN: true }),
        fc.double({ min: 1, max: 20_000, noNaN: true }),
        (face, u, v, height) => {
          const direction = regionDirection(
            regionAddress(face, 0, 0, 0),
            (u + 1) / 2,
            (v + 1) / 2,
          )
          expect(widestGap(direction, height)).toBeLessThan(CLOSED)
        },
      ),
      { numRuns: 6 },
    )
  })
})
