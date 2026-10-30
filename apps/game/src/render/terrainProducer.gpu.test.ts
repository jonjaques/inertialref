import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openSession, type Session } from '@inertialref/devtools'
import { InvariantError } from '@inertialref/shared'
import { vec3 } from '@inertialref/spatial'
import {
  type Body,
  generateHeightfield,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  type HeightfieldRequest,
  type RegionAddress,
  regionForDirection,
  regionSize,
  SOL,
  walkBodies,
} from '@inertialref/universe'
import {
  type HeightfieldResponse,
  Heightfields,
  type HeightfieldSource,
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
 * a canceled job resolving, a queued job outliving a failure.
 */

/*
 * A body the kernel cannot pack. No real graph exceeds the node cap — the
 * lattice is the cap — so the refusal is the packer's own invariant throw,
 * delivered for the surfaces a test names and for no other. A `broken`
 * surface throws what a defect in the packing code would.
 */
const unpackable = vi.hoisted(() => new WeakSet<object>())
const broken = vi.hoisted(() => new WeakSet<object>())
vi.mock('@inertialref/universe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inertialref/universe')>()
  return {
    ...actual,
    surfaceKernel: (surface: object, seabed?: boolean) => {
      if (unpackable.has(surface))
        throw new InvariantError('8000000 drainage nodes exceed the kernel cap')
      if (broken.has(surface))
        throw new TypeError('cannot read properties of undefined')
      return actual.surfaceKernel(
        surface as Parameters<typeof actual.surfaceKernel>[0],
        seabed,
      )
    },
  }
})

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

/** The request the streamer makes of a source, for one region. */
function requestFor(region: RegionAddress): HeightfieldRequest {
  return {
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
      wanted.map(
        (region) => producer.submit(luna.surface, requestFor(region)).result,
      ),
    )
    const single = createTileProducer(gpu.renderer, { batch: 1 })
    try {
      for (let i = 0; i < wanted.length; i += 1) {
        const alone = await single.submit(
          luna.surface,
          requestFor(wanted[i] as RegionAddress),
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
     * Luna, Earth, Luna, Earth in one queue. A batch is one body and `pump`
     * gathers every queued request for the head's body, so this is two
     * batches and one upload — the Luna pair, then the Earth pair — and
     * every tile has to match its own body's CPU tile, not the body the
     * buffer held a moment ago.
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
        ([body, region]) =>
          producer.submit(body.surface, requestFor(region)).result,
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
      const halfWidth = regionSize(body.surface.grammar.meanRadius, level) / 2
      expect(worst).toBeLessThan(
        3e-5 * body.surface.maxElevation + halfWidth * 2 ** -21,
      )
      expect(got.minElevation).toBeLessThanOrEqual(got.maxElevation)
      expect(got.cover).toHaveLength(expected.cover.length)
    })
  })

  it('reads back no water for a body that does not drain, and hands it the NaN', async () => {
    /*
     * With the drainage gate closed the kernel writes "none" at every
     * vertex, so the producer leaves the water buffer on the device and
     * gives each tile the NaN the readback would have come to. Counted at
     * the renderer's readback, which is the one call a copy cannot be issued
     * without: two for Luna's batch, three for Earth's.
     */
    const luna = solBody('Luna')
    const earth = solBody('Earth')
    const own = createTileProducer(gpu.renderer)
    const reads = vi.spyOn(gpu.renderer, 'getArrayBufferAsync')
    try {
      const wanted = regions(0, 4)
      const dry = await Promise.all(
        wanted.map(
          (region) => own.submit(luna.surface, requestFor(region)).result,
        ),
      )
      const dryReads = reads.mock.calls.length
      reads.mockClear()
      const wet = await Promise.all(
        wanted.map(
          (region) => own.submit(earth.surface, requestFor(region)).result,
        ),
      )
      const wetReads = reads.mock.calls.length
      expect(own.stats().batches).toBe(2)
      expect({ dryReads, wetReads }).toEqual({ dryReads: 2, wetReads: 3 })
      // The water a dry tile carries is the CPU tile's, to the bit: a
      // `Float32Array` of NaN at every vertex.
      dry.forEach((tile, i) => {
        const expected = generateHeightfield(
          luna.surface,
          requestFor(wanted[i] as RegionAddress),
        ).water
        expect(tile.water).toBeInstanceOf(Float32Array)
        expect(tile.water).toHaveLength(expected.length)
        expect(new Uint32Array(tile.water.buffer)).toEqual(
          new Uint32Array(expected.buffer),
        )
      })
      // And the wet body's is still read: at level 0 its sea is on every face.
      expect(
        wet.some((tile) => tile.water.some((level) => !Number.isNaN(level))),
      ).toBe(true)
    } finally {
      reads.mockRestore()
      own.dispose()
    }
  })

  it('cancels what is still queued and delivers what was already dispatched', async () => {
    const luna = solBody('Luna')
    const handles = regions(10, 40).map((region) =>
      producer.submit(luna.surface, requestFor(region)),
    )
    // The first batch is taken on a microtask, so at this instant nothing
    // has been dispatched; canceling the tail leaves the head to run.
    for (const handle of handles.slice(16)) handle.cancel()
    const outcomes = await Promise.allSettled(handles.map((h) => h.result))
    const delivered = outcomes.filter((o) => o.status === 'fulfilled').length
    const canceled = outcomes.filter(
      (o) =>
        o.status === 'rejected' && (o.reason as Error).message === 'canceled',
    ).length
    expect(delivered).toBe(16)
    expect(canceled).toBe(24)
    expect(producer.stats().queued).toBe(0)
  })

  it('sends a body it cannot pack to the pool, and keeps the GPU for the next body', async () => {
    const mars = solBody('Mars')
    const luna = solBody('Luna')
    const surface = { ...mars.surface }
    unpackable.add(surface)
    const pooled: string[] = []
    const pool: HeightfieldSource = {
      kind: 'pool',
      available: true,
      submit: (s, request) => {
        pooled.push(s === surface ? 'unpackable' : 'other')
        return {
          id: 0,
          result: Promise.resolve(generateHeightfield(s, request)),
          cancel() {},
        }
      },
    }
    const router = new Heightfields(pool)
    router.preferred = producer
    const before = producer.stats()
    const [region] = regions(9, 1) as [RegionAddress]
    // Both of the body's tiles queued in one batch go to the pool.
    const refused = await Promise.all([
      router.submit(surface, requestFor(region))!.result,
      router.submit(surface, requestFor(regions(9, 2)[1]!))!.result,
    ])
    expect(refused.every((field) => field !== null)).toBe(true)
    expect(pooled).toEqual(['unpackable', 'unpackable'])
    // A later request for it never queues on the GPU.
    await router.submit(surface, requestFor(region))!.result
    expect(pooled).toHaveLength(3)
    // The producer is still the GPU for every other body.
    const tile = await router.submit(luna.surface, requestFor(region))!.result
    expect(tile).not.toBeNull()
    expect(pooled).toHaveLength(3)
    const after = producer.stats()
    expect(after.available).toBe(true)
    expect(after.refused).toBe(before.refused + 1)
    expect(after.tiles).toBe(before.tiles + 1)
  })

  it("settles the refused body's jobs left queued behind the batch", async () => {
    /*
     * A batch of one takes the first tile; the other two are still on the
     * queue when the pack throws, and `refuse` has to find them there.
     */
    const surface = { ...solBody('Mars').surface }
    unpackable.add(surface)
    let pooled = 0
    const pool: HeightfieldSource = {
      kind: 'pool',
      available: true,
      submit: (s, request) => {
        pooled += 1
        return {
          id: 0,
          result: Promise.resolve(generateHeightfield(s, request)),
          cancel() {},
        }
      },
    }
    const single = createTileProducer(gpu.renderer, { batch: 1 })
    try {
      const router = new Heightfields(pool)
      router.preferred = single
      const fields = await Promise.all(
        regions(9, 3).map(
          (region) => router.submit(surface, requestFor(region))!.result,
        ),
      )
      expect(fields.every((field) => field !== null)).toBe(true)
      expect(pooled).toBe(3)
      expect(single.stats()).toMatchObject({
        available: true,
        queued: 0,
        refused: 1,
      })
    } finally {
      single.dispose()
    }
  })

  it('retires on a throw from packing that is not a packer invariant', async () => {
    const surface = { ...solBody('Mars').surface }
    broken.add(surface)
    const pool: HeightfieldSource = {
      kind: 'pool',
      available: true,
      submit: (s, request) => ({
        id: 0,
        result: Promise.resolve(generateHeightfield(s, request)),
        cancel() {},
      }),
    }
    const own = createTileProducer(gpu.renderer)
    try {
      const router = new Heightfields(pool)
      router.preferred = own
      const [region] = regions(9, 1) as [RegionAddress]
      const field = await router.submit(surface, requestFor(region))!.result
      expect(field).not.toBeNull()
      expect(own.stats()).toMatchObject({ available: false, refused: 0 })
    } finally {
      own.dispose()
    }
  })

  it('refuses a request shaped for another kernel rather than answering it wrong', async () => {
    const luna = solBody('Luna')
    const [region] = regions(8, 1) as [RegionAddress]
    const request = { ...requestFor(region), resolution: 33 }
    await expect(producer.submit(luna.surface, request).result).rejects.toThrow(
      /unsupported heightfield request/,
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
      wanted.map(
        (region) => producer.submit(luna.surface, requestFor(region)).result,
      ),
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
