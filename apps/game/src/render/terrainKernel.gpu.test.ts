import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openSession, type Session, terrainZoo } from '@inertialref/devtools'
import { vec3 } from '@inertialref/spatial'
import {
  type Body,
  findBody,
  generateHeightfield,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  parseAddress,
  type RegionAddress,
  regionForDirection,
  SOL,
  surfaceDetailFloor,
  surfaceKernel,
  TILE_STRIDE,
  walkBodies,
  writeTileFrame,
} from '@inertialref/universe'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { createTerrainKernel, type TerrainKernel } from './terrainKernel.ts'

/*
 * The tolerance test `TERRAIN-PLAN.md` § 11 promised: a GPU tile matches a
 * CPU tile within a stated bound.
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
}

/** Run one batch of tiles of one body through the kernel and split them out. */
async function gpuTiles(
  body: Body,
  regions: readonly RegionAddress[],
): Promise<GpuTile[]> {
  if (regions.length > MAX_TILES)
    throw new Error('too many tiles for one batch')
  const packed = surfaceKernel(body.surface)
  ;(kernel.records.array as Float32Array).set(packed.records)
  ;(kernel.words.array as Uint32Array).set(packed.words)
  kernel.records.needsUpdate = true
  kernel.words.needsUpdate = true
  const frames = kernel.tiles.array as Float32Array
  regions.forEach((region, i) =>
    writeTileFrame(packed, region, frames, i * TILE_STRIDE * 4),
  )
  kernel.tiles.needsUpdate = true
  kernel.total.value = regions.length * kernel.samples
  await gpu.compute(kernel.compute)
  const elevations = new Float32Array(await gpu.readBuffer(kernel.elevations))
  const cover = new Uint8Array(await gpu.readBuffer(kernel.cover))
  return regions.map((_, i) => ({
    elevations: elevations.slice(i * kernel.samples, (i + 1) * kernel.samples),
    cover: cover.slice(i * kernel.interior * 4, (i + 1) * kernel.interior * 4),
  }))
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
  readonly reliefAtLevel: number
}

/** The worst sample of a tile pair, and the worst cover byte. */
function compare(body: Body, region: RegionAddress, got: GpuTile): Gap {
  const field = generateHeightfield(body.surface, {
    region,
    resolution: HEIGHTFIELD_RESOLUTION,
    border: HEIGHTFIELD_BORDER,
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
  return {
    elevation,
    cover,
    reliefAtLevel: field.maxElevation - field.minElevation,
  }
}

/**
 * Half a region's side on the ground, meters: how far a sample can sit from
 * its tile's center. A face is a quarter turn across, and a region at `level`
 * is `2^level` of them to a side.
 */
const halfWidth = (body: Body, level: number): number =>
  ((Math.PI / 4) * body.surface.grammar.meanRadius) / 2 ** level

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
        let relief = 0
        regions.forEach((region, i) => {
          const gap = compare(body, region, tiles[i] as GpuTile)
          elevation = Math.max(elevation, gap.elevation)
          cover = Math.max(cover, gap.cover)
          relief = Math.max(relief, gap.reliefAtLevel)
        })
        const limit = bound(body, level)
        rows.push(
          `${body.name.padEnd(16)} L${String(level).padStart(2)}  elevation ${elevation.toExponential(2).padStart(9)} m of ${limit.toExponential(2)}  cover ${String(cover).padStart(2)}  (relief in tile ${relief.toFixed(1)} m)`,
        )
        if (elevation >= limit) {
          failures.push(
            `${body.name} L${level}: ${elevation} m against ${limit}`,
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
})
