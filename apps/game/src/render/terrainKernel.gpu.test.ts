import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ComputeNode } from 'three/webgpu'
import { openSession, type Session, terrainZoo } from '@inertialref/devtools'
import { Vec, vec3 } from '@inertialref/spatial'
import {
  type Body,
  coastRemap,
  coastWidth,
  COVER_CHANNELS,
  drainageGraph,
  DRAINAGE_SHAPE,
  findBody,
  generateHeightfield,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  parseAddress,
  type RegionAddress,
  regionForDirection,
  regionSize,
  SOL,
  surfaceDetailFloor,
  surfaceKernel,
  TILE_STRIDE,
  walkBodies,
  writeTileFrame,
  seaDatumElevation,
  NO_KERNEL_WATER,
} from '@inertialref/universe'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import {
  createTerrainKernel,
  type TerrainKernel,
  uploadSurface,
} from './terrainKernel.ts'

/*
 * The tolerance test `docs/adr/0023-the-gpu-producer.md` promises: a GPU tile
 * matches a CPU tile within a stated bound.
 *
 * The whole band stack, on every archetype the zoo has and on three Sol
 * bodies, from level 0 down to each body's own detail floor — the bordered
 * heightfield sample by sample against `generateHeightfield`, and the cover
 * byte by byte. Nothing here mirrors the kernel in scalar code: the kernel
 * runs, and the CPU function it ports is the reference.
 */

let gpu: GpuSession
let session: Session
let kernel: TerrainKernel

const MAX_TILES = 8

beforeAll(async () => {
  gpu = await openGpu()
  session = openSession({ seed: 'inertialref', workers: null })
  kernel = createTerrainKernel({
    resolution: HEIGHTFIELD_RESOLUTION,
    border: HEIGHTFIELD_BORDER,
    maxTiles: MAX_TILES,
  })
})

afterAll(() => {
  kernel.dispose()
  session.dispose()
  gpu.dispose()
})

function bodyAt(address: string): Body {
  const parsed = parseAddress(address)
  if (parsed.kind !== 'body') throw new Error(`not a body: ${address}`)
  const body = findBody(session.world.loadSystem(parsed.system), parsed.body)
  if (body === undefined) throw new Error(`no body at ${address}`)
  return body
}

function solBody(name: string): Body {
  for (const body of walkBodies(session.world.loadSystem(SOL))) {
    if (body.name === name) return body
  }
  throw new Error(`no ${name} in Sol`)
}

interface GpuTile {
  readonly elevations: Float32Array
  readonly cover: Uint8Array
  /** As the kernel writes it: `NO_KERNEL_WATER` where the field has NaN. */
  readonly water: Float32Array
}

/**
 * Run one batch of tiles of one body through a kernel — this file's unless
 * another is named — and split them out.
 */
async function gpuTiles(
  body: Body,
  regions: readonly RegionAddress[],
  seabed = false,
  on: TerrainKernel = kernel,
): Promise<GpuTile[]> {
  if (regions.length > MAX_TILES)
    throw new Error('too many tiles for one batch')
  const packed = surfaceKernel(body.surface, seabed)
  uploadSurface(on, packed)
  const frames = on.tiles.array as Float32Array
  regions.forEach((region, i) =>
    writeTileFrame(packed, region, frames, i * TILE_STRIDE * 4),
  )
  on.tiles.needsUpdate = true
  on.total.value = regions.length * on.samples
  await gpu.compute(on.compute)
  const elevations = new Float32Array(await gpu.readBuffer(on.elevations))
  const cover = new Uint8Array(await gpu.readBuffer(on.cover))
  const water = new Float32Array(await gpu.readBuffer(on.water))
  return regions.map((_, i) => ({
    elevations: elevations.slice(i * on.samples, (i + 1) * on.samples),
    cover: cover.slice(
      i * on.interior * COVER_CHANNELS,
      (i + 1) * on.interior * COVER_CHANNELS,
    ),
    water: water.slice(i * on.interior, (i + 1) * on.interior),
  }))
}

/** Elements of two equal-length arrays whose bits differ. */
function bitsApart(
  a: Float32Array | Uint8Array | Uint32Array,
  b: Float32Array | Uint8Array | Uint32Array,
): number {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  if (x.length !== y.length) return Math.max(x.length, y.length)
  let apart = 0
  const width = a.BYTES_PER_ELEMENT
  for (let i = 0; i < x.length; i += width) {
    for (let k = 0; k < width; k += 1) {
      if (x[i + k] !== y[i + k]) {
        apart += 1
        break
      }
    }
  }
  return apart
}

/** A spread of regions over a body at one level: four directions. */
function regionsAt(level: number): RegionAddress[] {
  return [
    vec3(0.3, 0.8, 0.5),
    vec3(-0.7, -0.1, 0.7),
    vec3(0.57, -0.57, -0.57),
    vec3(0.05, 0.02, -0.99),
  ].map((d) => regionForDirection(d, level))
}

interface Gap {
  readonly elevation: number
  readonly cover: number
  /**
   * The worst water level, over vertices where both sides have one; a
   * vertex wet on one side and dry on the other counts the level's height
   * above the ground there, which is what the sheet would show.
   */
  readonly water: number
  readonly reliefAtLevel: number
}

/** The worst sample of a tile pair, and the worst cover byte. */
function compare(
  body: Body,
  region: RegionAddress,
  got: GpuTile,
  seabed = false,
): Gap {
  const field = generateHeightfield(body.surface, {
    region,
    resolution: HEIGHTFIELD_RESOLUTION,
    border: HEIGHTFIELD_BORDER,
    seabed,
  })
  let elevation = 0
  for (let i = 0; i < field.elevations.length; i += 1) {
    elevation = Math.max(
      elevation,
      Math.abs((got.elevations[i] as number) - (field.elevations[i] as number)),
    )
  }
  let cover = 0
  for (let i = 0; i < field.cover.length; i += 1) {
    cover = Math.max(
      cover,
      Math.abs((got.cover[i] as number) - (field.cover[i] as number)),
    )
  }
  let water = 0
  const stride = HEIGHTFIELD_RESOLUTION + 2 * HEIGHTFIELD_BORDER
  for (let row = 0; row < HEIGHTFIELD_RESOLUTION; row += 1) {
    for (let col = 0; col < HEIGHTFIELD_RESOLUTION; col += 1) {
      const vertex = row * HEIGHTFIELD_RESOLUTION + col
      const ground = field.elevations[
        (row + HEIGHTFIELD_BORDER) * stride + col + HEIGHTFIELD_BORDER
      ] as number
      const expected = field.water[vertex] as number
      const actual = got.water[vertex] as number
      const expectedWet = !Number.isNaN(expected)
      const actualWet = actual > NO_KERNEL_WATER / 2
      if (expectedWet && actualWet) {
        water = Math.max(water, Math.abs(actual - expected))
      } else if (expectedWet !== actualWet) {
        const level = expectedWet ? expected : actual
        water = Math.max(water, Math.max(0, level - ground))
      }
    }
  }
  return {
    elevation,
    cover,
    water,
    reliefAtLevel: field.maxElevation - field.minElevation,
  }
}

/**
 * Half a region's side on the ground, meters: how far a sample can sit from
 * its tile's center. A face is a quarter turn across, and a region at `level`
 * is `2^level` of them to a side.
 */
const halfWidth = (body: Body, level: number): number =>
  regionSize(body.surface.grammar.meanRadius, level) / 2

/**
 * The bound, as arithmetic about the two limits the kernel has.
 *
 * The first term is float32 doing the band stack's arithmetic. Measured at
 * the levels where the sample point is exact, the worst band is the eroded
 * relief — twelve octaves with the damping accumulator in float32 — at
 * 2.5 × 10⁻⁵ of the budget on the rocky atmosphered world, and every other
 * band is under a fifth of that; 3 × 10⁻⁵ is the measurement with room.
 *
 * The second is the sample point itself. A sample's offset from its tile's
 * center is held in float32, so on the ground it is placed to
 * `halfWidth · 2⁻²⁴`, and every crater rung it crosses reads a crater shifted
 * by that much. Measured on Earth at level 0, where the offset is 0.3 m,
 * fifteen rungs come to 1.21 m — four times the offset, because a rung's
 * slope is under one and most rungs are not at their steepest at any one
 * point. Eight offsets is the bound, and it is under a pixel at every level:
 * at level 6 it is 4 cm on a cell of 1.5 km.
 *
 * `terrainBands.gpu.test.ts` holds each band to its own figure, which is where
 * to look when this goes red.
 */
const bound = (body: Body, level: number): number =>
  3e-5 * body.surface.maxElevation + halfWidth(body, level) * 2 ** -21

/**
 * A cover byte is `round(x · 255)` on both sides, and the two roundings can
 * fall either side of a half — one step — on any channel whose float32
 * evaluation differs from float64's at all, which every channel's does.
 */
const COVER_BOUND = 2

/**
 * `maxStorageBuffersPerShaderStage` as the WebGPU spec defaults it, which is
 * what a device runs at unless it asks for more. Nothing asks: not
 * `createRenderer`, not the producer, not the harness.
 */
const BASELINE_STORAGE_BUFFERS = 8

describe('the kernel’s bindings', () => {
  /*
   * At the baseline a ninth binding fails pipeline validation. Here that is
   * a harness error in the tolerance tests below; in the app it is the
   * producer's `warm()` retiring the GPU for the session with a logged
   * reason, and the ground arriving at the pool's pace with nothing else to
   * say why. Both depend on the device having been granted the default — the
   * adapter on an M5 offers ten — so this counts the bindings in the program
   * itself against the spec's figure, whatever limits a device was given,
   * and says which budget a new one spends. A list the drainage graph grows
   * is a row in its offset table (`DRAINAGE_NODES_AT` and the rest), not a
   * binding.
   */
  it('binds no more storage buffers than the baseline device has', () => {
    const nodes = (
      gpu.renderer as unknown as {
        _nodes: { getForCompute(node: ComputeNode): { computeShader: string } }
      }
    )._nodes
    const wgsl = nodes.getForCompute(kernel.compute).computeShader
    const bindings = wgsl.match(/var<storage\b/g)?.length ?? 0
    console.info(
      `the kernel binds ${bindings} storage buffers of the baseline's ${BASELINE_STORAGE_BUFFERS}`,
    )
    expect(bindings).toBeLessThanOrEqual(BASELINE_STORAGE_BUFFERS)
  })

  it('is held at the baseline by a device granted only the baseline', () => {
    // The other half of the claim above: the tolerance tests in this file
    // build the kernel on a device at the default, as the app does.
    const device = (gpu.renderer.backend as { device?: GPUDevice }).device
    expect(device?.limits.maxStorageBuffersPerShaderStage).toBe(
      BASELINE_STORAGE_BUFFERS,
    )
  })
})

describe('the kernel against generateHeightfield', () => {
  it('agrees on every body at every level, within the stated bound', async () => {
    const zoo = terrainZoo(session.world)
    const bodies = [
      ...zoo.map((entry) => bodyAt(entry.address)),
      solBody('Luna'),
      solBody('Earth'),
      solBody('Mercury'),
    ]
    const rows: string[] = []
    const failures: string[] = []
    for (const body of bodies) {
      const floor = surfaceDetailFloor(body.surface)
      const levels = [...new Set([0, 3, 6, 9, 12, floor - 2, floor])].filter(
        (level) => level >= 0,
      )
      for (const level of levels) {
        const regions = regionsAt(level)
        const tiles = await gpuTiles(body, regions)
        let elevation = 0
        let cover = 0
        let water = 0
        let relief = 0
        regions.forEach((region, i) => {
          const gap = compare(body, region, tiles[i] as GpuTile)
          elevation = Math.max(elevation, gap.elevation)
          cover = Math.max(cover, gap.cover)
          water = Math.max(water, gap.water)
          relief = Math.max(relief, gap.reliefAtLevel)
        })
        const limit = bound(body, level)
        rows.push(
          `${body.name.padEnd(16)} L${String(level).padStart(2)}  elevation ${elevation.toExponential(2).padStart(9)} m of ${limit.toExponential(2)}  water ${water.toExponential(2).padStart(9)}  cover ${String(cover).padStart(2)}  (relief in tile ${relief.toFixed(1)} m)`,
        )
        if (elevation >= limit) {
          failures.push(
            `${body.name} L${level}: ${elevation} m against ${limit}`,
          )
        }
        if (water >= limit) {
          failures.push(
            `${body.name} L${level}: water ${water} m against ${limit}`,
          )
        }
        if (cover > COVER_BOUND) {
          failures.push(`${body.name} L${level}: cover byte off by ${cover}`)
        }
      }
    }
    console.info(`\n${rows.join('\n')}\n`)
    expect(failures).toEqual([])
  }, 120_000)

  /*
   * The flag is one scalar in the packed record, and the test above runs
   * both sides clamped. A wet body's seabed is the same field with the clamp
   * off — so the pair has to agree there too, and the tile has to actually
   * go under the datum, or the flag is a scalar nothing reads.
   */
  it('is the seabed where the request asks for it', async () => {
    // Earth: a body with a datum the field goes under, whatever the zoo holds.
    const wet = solBody('Earth')
    const datum = seaDatumElevation(wet.surface)
    if (datum === null) throw new Error('Earth has no sea datum')
    const regions = regionsAt(0)
    const tiles = await gpuTiles(wet, regions, true)
    let elevation = 0
    let submarine = 0
    regions.forEach((region, i) => {
      const tile = tiles[i] as GpuTile
      elevation = Math.max(
        elevation,
        compare(wet, region, tile, true).elevation,
      )
      for (const sample of tile.elevations) if (sample < datum) submarine += 1
    })
    expect(elevation).toBeLessThan(bound(wet, 0))
    expect(submarine).toBeGreaterThan(0)
  }, 60_000)

  /*
   * The water between two bodies of standing water, where the level is the
   * heavier body's and the two blend only within `lakeMargin` of a tie. The
   * spread above lands on few such places, and this is the part of the lake
   * block with arithmetic in it: tiles centered between a lake and the sea on
   * Earth, and between two lakes on Titan, at a level where a vertex is a
   * kilometer and the blend a few of them across.
   */
  it('reads the water between two bodies as the CPU does', async () => {
    const failures: string[] = []
    const rows: string[] = []
    let blended = 0
    for (const [body, sea] of [
      [solBody('Earth'), true],
      [solBody('Titan'), false],
    ] as const) {
      const graph = drainageGraph(body.surface)
      if (graph === null) throw new Error(`${body.name} has no drainage graph`)
      const reach = (DRAINAGE_SHAPE.lakeReach * Math.PI) / 2 / graph.cells
      const at = (n: number) =>
        vec3(
          graph.positions[n * 3] as number,
          graph.positions[n * 3 + 1] as number,
          graph.positions[n * 3 + 2] as number,
        )
      const isLake = (n: number) => !Number.isNaN(graph.lake[n] as number)
      const sites: { region: RegionAddress; levels: [number, number] }[] = []
      for (let n = 0; n < graph.nodes && sites.length < MAX_TILES; n += 1) {
        if (!isLake(n) || graph.sea[n] === 1) continue
        for (let k = 0; k < 64 && sites.length < MAX_TILES; k += 1) {
          const m = graph.neighbors[n * 8 + (k >> 3)] as number
          if (m < 0) continue
          const o = graph.neighbors[m * 8 + (k & 7)] as number
          if (o < 0 || !isLake(o) || (graph.sea[o] === 1) !== sea) continue
          if (graph.lake[o] === graph.lake[n]) continue
          if (Vec.length(Vec.sub(at(n), at(o))) >= 2 * reach) continue
          const region = regionForDirection(
            Vec.normalize(Vec.add(at(n), at(o))),
            7,
          )
          const taken = sites.some(
            (site) =>
              site.region.face === region.face &&
              site.region.i === region.i &&
              site.region.j === region.j,
          )
          if (taken) continue
          sites.push({
            region,
            levels: [graph.lake[n] as number, graph.lake[o] as number],
          })
          break
        }
      }
      expect(sites.length).toBeGreaterThan(0)
      const tiles = await gpuTiles(
        body,
        sites.map((site) => site.region),
      )
      const datum = seaDatumElevation(body.surface)
      const remap = (level: number): number =>
        datum === null
          ? level
          : coastRemap(level, datum, coastWidth(body.surface))
      sites.forEach((site, i) => {
        const tile = tiles[i] as GpuTile
        const gap = compare(body, site.region, tile)
        const limit = bound(body, site.region.level)
        rows.push(
          `${body.name.padEnd(8)} ${site.region.face}/${site.region.i}/${site.region.j}  elevation ${gap.elevation.toExponential(2)}  water ${gap.water.toExponential(2)} m of ${limit.toExponential(2)}`,
        )
        if (gap.elevation >= limit || gap.water >= limit) {
          failures.push(
            `${body.name} ${site.region.face}/${site.region.i}/${site.region.j}: elevation ${gap.elevation} water ${gap.water} m against ${limit}`,
          )
        }
        const low = remap(Math.min(...site.levels))
        const high = remap(Math.max(...site.levels))
        for (const level of tile.water) {
          if (level > low + 1e-3 && level < high - 1e-3) blended += 1
        }
      })
    }
    console.info(`\n${rows.join('\n')}\n${blended} blended vertices\n`)
    expect(failures).toEqual([])
    // The blend is in the tiles, so the comparison above covered it.
    expect(blended).toBeGreaterThan(0)
  }, 120_000)
})

describe('a dry body after a wet one', () => {
  /*
   * `uploadSurface` uploads nothing into the drainage buffer for a body with
   * no graph, so after a wet body the buffer still holds that body's nodes,
   * segments and cell lists. That is the decision — clearing it is megabytes
   * of writes on every switch — and it is safe only while every reader of
   * the buffer is behind the drainage stage's one gate, which is zero for
   * the dry body. A reader behind anything else carves the previous
   * planet's rivers and lakes into this one.
   *
   * So the dry body's tiles, drawn with Earth's graph still in the buffer,
   * are held bit for bit to the same tiles from a kernel that never held a
   * graph. Mars and Luna: one with a budget for a stale carve to cut into,
   * and the cratered body the plan names beside it.
   */
  it('draws as it does on a kernel that never held a graph', async () => {
    const wet = solBody('Earth')
    const graph = surfaceKernel(wet.surface).drainage
    if (graph === null) throw new Error('Earth has no drainage graph')
    const fresh = createTerrainKernel({
      resolution: HEIGHTFIELD_RESOLUTION,
      border: HEIGHTFIELD_BORDER,
      maxTiles: MAX_TILES,
    })
    const apart: string[] = []
    try {
      for (const dry of [solBody('Mars'), solBody('Luna')]) {
        expect(surfaceKernel(dry.surface).drainage).toBeNull()
        for (const level of [0, 6, 12]) {
          const regions = regionsAt(level)
          await gpuTiles(wet, regions)
          const stale = await gpuTiles(dry, regions)
          // The premise: the wet body's graph is what the buffer holds on
          // the device while the dry body's tiles are drawn.
          const held = new Uint32Array(await gpu.readBuffer(kernel.drainage))
          expect(bitsApart(held, graph.words)).toBe(0)
          const clean = await gpuTiles(dry, regions, false, fresh)
          stale.forEach((tile, i) => {
            const other = clean[i] as GpuTile
            const counts = [
              bitsApart(tile.elevations, other.elevations),
              bitsApart(tile.cover, other.cover),
              bitsApart(tile.water, other.water),
            ]
            if (counts.some((count) => count > 0)) {
              apart.push(
                `${dry.name} L${level} tile ${i}: elevations ${counts[0]}, cover ${counts[1]}, water ${counts[2]} apart`,
              )
            }
          })
        }
      }
    } finally {
      fresh.dispose()
    }
    expect(apart).toEqual([])
  }, 60_000)
})
