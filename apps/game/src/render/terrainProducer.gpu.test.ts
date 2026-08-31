import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openSession, type Session } from '@inertialref/devtools'
import { formatSeed } from '@inertialref/procedural'
import { vec3 } from '@inertialref/spatial'
import {
  type Body,
  generateHeightfield,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  type RegionAddress,
  regionForDirection,
  SOL,
  walkBodies,
} from '@inertialref/universe'
import type {
  HeightfieldRequestPayload,
  HeightfieldResponse,
} from '@inertialref/workers'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { createTileProducer, type TileProducer } from './terrainProducer.ts'

/*
 * The producer around the kernel: batching, the body upload, cancellation,
 * failure, and what a batch costs.
 *
 * `terrainKernel.gpu.test.ts` holds the arithmetic. What is held here is the
 * plumbing that could be wrong while the arithmetic is right: a tile landing
 * in another tile's slot, a body's records left over from the previous batch,
 * a cancelled job resolving, a queued job outliving a failure.
 */

let gpu: GpuSession
let session: Session

beforeAll(async () => {
  gpu = await openGpu()
  session = openSession({ seed: 'inertialref', workers: null })
})

afterAll(() => {
  session.dispose()
  gpu.dispose()
})

function solBody(name: string): Body {
  for (const body of walkBodies(session.world.loadSystem(SOL))) {
    if (body.name === name) return body
  }
  throw new Error(`no ${name} in Sol`)
}

function payloadFor(
  body: Body,
  region: RegionAddress,
): HeightfieldRequestPayload {
  return {
    surfaceSeed: formatSeed(body.surface.seed),
    maxElevation: body.surface.maxElevation,
    roughness: body.surface.roughness,
    seaLevel: body.surface.seaLevel,
    grammar: body.surface.grammar,
    region,
    resolution: HEIGHTFIELD_RESOLUTION,
    border: HEIGHTFIELD_BORDER,
  }
}

/** Regions spread over a body at one level, `count` of them. */
function regions(level: number, count: number): RegionAddress[] {
  const out: RegionAddress[] = []
  for (let i = 0; i < count; i += 1) {
    const z = 1 - (2 * i + 1) / count
    const around = i * Math.PI * (3 - Math.sqrt(5))
    const ring = Math.sqrt(Math.max(0, 1 - z * z))
    out.push(
      regionForDirection(
        vec3(Math.cos(around) * ring, z, Math.sin(around) * ring),
        level,
      ),
    )
  }
  return out
}

function worstGap(a: HeightfieldResponse, b: HeightfieldResponse): number {
  let worst = 0
  for (let i = 0; i < a.elevations.length; i += 1) {
    worst = Math.max(
      worst,
      Math.abs((a.elevations[i] as number) - (b.elevations[i] as number)),
    )
  }
  for (let i = 0; i < a.cover.length; i += 1) {
    if (a.cover[i] !== b.cover[i]) worst = Math.max(worst, 1e9)
  }
  return worst
}

describe('the tile producer', () => {
  let producer: TileProducer

  beforeAll(async () => {
    producer = createTileProducer(gpu.renderer)
    expect(await producer.warm()).toBe(true)
  })

  afterAll(() => {
    producer.dispose()
  })

  it('delivers a batch as the same tiles it would deliver one at a time', async () => {
    /*
     * Twenty tiles of Luna at level 12, asked for at once, against the same
     * twenty asked for one by one through a producer whose batch is one. The
     * kernel is deterministic on one device, so the two are bit-identical:
     * the only way they differ is a tile in the wrong slot or a frame written
     * over another's.
     */
    const luna = solBody('Luna')
    const wanted = regions(12, 20)
    const batched = await Promise.all(
      wanted.map((region) => producer.submit(payloadFor(luna, region)).result),
    )
    const single = createTileProducer(gpu.renderer, { batch: 1 })
    try {
      for (let i = 0; i < wanted.length; i += 1) {
        const alone = await single.submit(
          payloadFor(luna, wanted[i] as RegionAddress),
        ).result
        expect(worstGap(batched[i] as HeightfieldResponse, alone)).toBe(0)
        expect((batched[i] as HeightfieldResponse).region).toEqual(wanted[i])
      }
    } finally {
      single.dispose()
    }
    const stats = producer.stats()
    expect(stats.tiles).toBeGreaterThanOrEqual(20)
    // Twenty in one go is two batches of sixteen and four, not twenty.
    expect(stats.batches).toBeLessThanOrEqual(2)
  })

  it('carries each body’s own records across an interleaved queue', async () => {
    /*
     * Luna, Earth, Luna, Earth in one queue. A batch is one body, so this is
     * four batches and three uploads, and every tile has to match its own
     * body's CPU tile — not the body the buffer held a moment ago.
     */
    const luna = solBody('Luna')
    const earth = solBody('Earth')
    const level = 9
    const [a, b, c, d] = regions(level, 4) as [
      RegionAddress,
      RegionAddress,
      RegionAddress,
      RegionAddress,
    ]
    const jobs = [
      [luna, a],
      [earth, b],
      [luna, c],
      [earth, d],
    ] as const
    const results = await Promise.all(
      jobs.map(
        ([body, region]) => producer.submit(payloadFor(body, region)).result,
      ),
    )
    jobs.forEach(([body, region], i) => {
      const expected = generateHeightfield(body.surface, {
        region,
        resolution: HEIGHTFIELD_RESOLUTION,
        border: HEIGHTFIELD_BORDER,
      })
      let worst = 0
      const got = results[i] as HeightfieldResponse
      for (let k = 0; k < expected.elevations.length; k += 1) {
        worst = Math.max(
          worst,
          Math.abs(
            (got.elevations[k] as number) - (expected.elevations[k] as number),
          ),
        )
      }
      // The kernel's own bound at level 9, from `terrainKernel.gpu.test.ts`:
      // 3e-5 of the budget and eight sample offsets.
      const halfWidth =
        ((Math.PI / 4) * body.surface.grammar.meanRadius) / 2 ** level
      expect(worst).toBeLessThan(
        3e-5 * body.surface.maxElevation + halfWidth * 2 ** -21,
      )
      expect(got.minElevation).toBeLessThanOrEqual(got.maxElevation)
      expect(got.cover).toHaveLength(expected.cover.length)
    })
  })

  it('cancels what is still queued and delivers what was already dispatched', async () => {
    const luna = solBody('Luna')
    const handles = regions(10, 40).map((region) =>
      producer.submit(payloadFor(luna, region)),
    )
    // The first batch is taken on a microtask, so at this instant nothing
    // has been dispatched; cancelling the tail leaves the head to run.
    for (const handle of handles.slice(16)) handle.cancel()
    const outcomes = await Promise.allSettled(handles.map((h) => h.result))
    const delivered = outcomes.filter((o) => o.status === 'fulfilled').length
    const cancelled = outcomes.filter(
      (o) =>
        o.status === 'rejected' && (o.reason as Error).message === 'cancelled',
    ).length
    expect(delivered).toBe(16)
    expect(cancelled).toBe(24)
    expect(producer.stats().queued).toBe(0)
  })

  it('refuses a request shaped for another kernel rather than answering it wrong', async () => {
    const luna = solBody('Luna')
    const [region] = regions(8, 1) as [RegionAddress]
    const payload = { ...payloadFor(luna, region), resolution: 33 }
    await expect(producer.submit(payload).result).rejects.toThrow(
      /producer unavailable/,
    )
    expect(producer.available).toBe(true)
  })

  it('costs a fraction of the worker per tile', async () => {
    /*
     * Not an assertion on a figure — a figure about this machine — but the
     * number the phase exists for, measured where it can be reproduced:
     * sixteen Luna tiles at the detail floor, dispatch to readback in hand,
     * against `generateHeightfield` on this thread for the same tiles.
     */
    const luna = solBody('Luna')
    const wanted = regions(17, 16)
    const before = performance.now()
    await Promise.all(
      wanted.map((region) => producer.submit(payloadFor(luna, region)).result),
    )
    const gpuMs = performance.now() - before
    const cpuStart = performance.now()
    for (const region of wanted) {
      generateHeightfield(luna.surface, {
        region,
        resolution: HEIGHTFIELD_RESOLUTION,
        border: HEIGHTFIELD_BORDER,
      })
    }
    const cpuMs = performance.now() - cpuStart
    console.info(
      `sixteen Luna tiles at level 17: GPU ${gpuMs.toFixed(1)} ms for the batch (${(gpuMs / 16).toFixed(2)} ms a tile), CPU ${cpuMs.toFixed(1)} ms (${(cpuMs / 16).toFixed(1)} ms a tile); mean batch ${producer.stats().meanBatchMs.toFixed(1)} ms`,
    )
    expect(gpuMs).toBeLessThan(cpuMs)
  })
})
