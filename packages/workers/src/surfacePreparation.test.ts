import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  catalogStub,
  type DrainageGraph,
  drainageBuilds,
  drainageGraph,
  generateSystem,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  type HeightfieldRequest,
  MILKY_WAY,
  regionAddress,
  surfaceDetailFloor,
  type SurfaceParameters,
  TEST_CATALOG,
  walkBodies,
} from '@inertialref/universe'
import { createInlineWorker } from './inline.ts'
import { WorkerPool } from './pool.ts'
import { SurfacePreparation } from './surfacePreparation.ts'
import { defineTask, TaskRegistry } from './task.ts'
import {
  type ArchivedSource,
  createTaskRegistry,
  type HeightfieldResponse,
  type PreparedSurface,
  prepareSurfaceTask,
} from './tasks.ts'

/*
 * The preparation, over the inline pool.
 *
 * The inline worker shares this thread's memo, so nothing here can show a
 * graph crossing between threads — `drainage.test.ts` holds that, over two
 * module instances. What is held here is the protocol: one job a surface, the
 * graph seeded before the floor is published, the three ways a job fails and
 * what each leaves behind, and a source that waits for its surface.
 */

const SOL = generateSystem(
  rootSeed('inertialref'),
  MILKY_WAY,
  catalogStub(TEST_CATALOG.stars[0] as (typeof TEST_CATALOG.stars)[number]),
)
const surfaceOf = (name: string): SurfaceParameters => {
  for (const body of walkBodies(SOL))
    if (body.name === name) return body.surface
  throw new Error(`no ${name} in Sol`)
}

/** A surface no thread has prepared, so a fake answer cannot meet a real one. */
let fresh = 0
const unseen = (): SurfaceParameters => ({
  ...surfaceOf('Luna'),
  seed: rootSeed(`unseen-${(fresh += 1)}`),
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A pool whose preparation answers when the test says, or fails how it says.
 * A job held open is what lets a test cancel or terminate it mid-flight.
 */
function gatedPool(answer: (surface: SurfaceParameters) => PreparedSurface) {
  const releases: (() => void)[] = []
  let runs = 0
  const registry = new TaskRegistry()
  registry.register(
    defineTask({
      name: prepareSurfaceTask.name,
      version: prepareSurfaceTask.version,
      async run(payload: { surface: unknown }) {
        runs += 1
        await new Promise<void>((resolve) => releases.push(resolve))
        return answer(payload.surface as SurfaceParameters)
      },
    }),
  )
  const pool = new WorkerPool({
    factory: () => createInlineWorker(registry),
    size: 1,
  })
  return {
    pool,
    runs: () => runs,
    release: async () => {
      await settle()
      for (const release of releases.splice(0)) release()
      await settle()
    },
  }
}

function flatField(request: HeightfieldRequest): HeightfieldResponse {
  const border = request.border ?? HEIGHTFIELD_BORDER
  const side = request.resolution + 2 * border
  return {
    region: request.region,
    resolution: request.resolution,
    border,
    elevations: new Float32Array(side * side),
    cover: new Uint8Array(0),
    water: new Float32Array(0),
    minElevation: 0,
    maxElevation: 0,
  }
}

/** A producer that counts what reaches it. */
function countingSource() {
  const asked: SurfaceParameters[] = []
  const source: ArchivedSource & { available: boolean } = {
    kind: 'gpu',
    archive: 'gpu@test',
    available: true,
    maxLevel: 9,
    supports: (request) => request.region.level > 0,
    submit(surface, request) {
      asked.push(surface)
      return {
        id: asked.length,
        result: Promise.resolve(flatField(request)),
        cancel() {},
      }
    },
  }
  return { source, asked }
}

const REQUEST: HeightfieldRequest = {
  region: regionAddress(0, 2, 1, 1),
  resolution: HEIGHTFIELD_RESOLUTION,
  border: HEIGHTFIELD_BORDER,
}

describe('preparing a surface', () => {
  it('answers at once with no pool, with the floor the search measures', () => {
    const surface = surfaceOf('Luna')
    const prepared = new SurfacePreparation(null).prepare(surface)
    expect(prepared?.floor).toBe(surfaceDetailFloor(surface))
  })

  it('prepares on a worker once, and answers every ask after it', async () => {
    const pool = new WorkerPool({
      factory: () => createInlineWorker(createTaskRegistry()),
      size: 2,
    })
    const preparation = new SurfacePreparation(pool)
    const surface = surfaceOf('Earth')
    const heard: SurfaceParameters[] = []
    preparation.subscribe((one) => heard.push(one))

    expect(preparation.prepare(surface)).toBeNull()
    expect(preparation.prepare(surface)).toBeNull()
    const prepared = await preparation.whenPrepared(surface)

    expect(prepared.floor).toBe(surfaceDetailFloor(surface))
    expect(preparation.prepare(surface)).toBe(prepared)
    expect(await preparation.whenPrepared(surface)).toBe(prepared)
    // Two asks while it ran, two after: one job, one announcement.
    expect(pool.stats().completed).toBe(1)
    expect(heard).toEqual([surface])
    pool.terminate()
  })

  it('seeds the graph the worker answers with before the floor is published', async () => {
    const graph = structuredClone(drainageGraph(surfaceOf('Earth')))
    const gate = gatedPool(() => ({ level: 7, drainage: graph }))
    const preparation = new SurfacePreparation(gate.pool)
    const surface = unseen()
    let seen: DrainageGraph | null | undefined
    preparation.subscribe((one) => {
      const before = drainageBuilds()
      seen = drainageGraph(one)
      expect(drainageBuilds()).toBe(before)
    })

    expect(preparation.prepare(surface)).toBeNull()
    await gate.release()

    expect(preparation.prepare(surface)?.floor).toBe(7)
    // A copy, because the answer crossed the worker's structured clone — and
    // read without building, which the listener above holds.
    expect(seen).toStrictEqual(graph)
    gate.pool.terminate()
  })

  it('submits again after its own cancellation, and only then', async () => {
    const gate = gatedPool(() => ({ level: 5, drainage: null }))
    const preparation = new SurfacePreparation(gate.pool)
    const surface = unseen()
    const answered = preparation.whenPrepared(surface)

    expect(gate.pool.stats().active).toBe(1)
    preparation.clear()
    await gate.release()
    // Released: no answer, and no job until something asks.
    expect(gate.pool.stats().canceled).toBe(1)
    expect(gate.runs()).toBe(1)
    expect(preparation.prepare(surface)).toBeNull()
    await settle()
    expect(gate.runs()).toBe(2)

    await gate.release()
    // The waiter from before the cancel hears the second job's answer.
    expect((await answered).floor).toBe(5)
    gate.pool.terminate()
  })

  it('answers nothing and asks nothing once the pool is gone', async () => {
    const gate = gatedPool(() => ({ level: 5, drainage: null }))
    const preparation = new SurfacePreparation(gate.pool)
    const surface = unseen()
    let settled = false
    void preparation.whenPrepared(surface).then(() => (settled = true))
    await settle()

    gate.pool.terminate()
    await settle()
    // Not measured here — a disposed session has no frame to spend it on —
    // and a surface asked for afterward is not submitted, because `submit`
    // on a terminated pool throws its invariant into the frame that asked.
    expect(preparation.prepare(surface)).toBeNull()
    expect(() => preparation.prepare(unseen())).not.toThrow()
    expect(preparation.prepare(unseen())).toBeNull()
    await gate.release()
    expect(settled).toBe(false)
    expect(gate.runs()).toBe(1)
  })

  it('prepares here when the task fails, rather than asking again', async () => {
    const registry = new TaskRegistry()
    registry.register(
      defineTask({
        name: prepareSurfaceTask.name,
        version: prepareSurfaceTask.version,
        run(): PreparedSurface {
          throw new Error('a worker bundle from another deploy')
        },
      }),
    )
    const pool = new WorkerPool({
      factory: () => createInlineWorker(registry),
      size: 1,
    })
    const preparation = new SurfacePreparation(pool)
    const surface = surfaceOf('Luna')

    expect(preparation.prepare(surface)).toBeNull()
    const prepared = await preparation.whenPrepared(surface)

    expect(prepared.floor).toBe(surfaceDetailFloor(surface))
    expect(pool.stats().failed).toBe(1)
    for (let frame = 0; frame < 4; frame += 1) preparation.prepare(surface)
    expect(pool.stats().failed + pool.stats().completed).toBe(1)
    pool.terminate()
  })
})

describe('a source held for its surface', () => {
  it('reaches the producer only once the surface is prepared', async () => {
    const gate = gatedPool(() => ({ level: 5, drainage: null }))
    const preparation = new SurfacePreparation(gate.pool)
    const { source, asked } = countingSource()
    const held = preparation.holding(source)
    const surface = unseen()

    const job = held.submit(surface, REQUEST)
    await settle()
    expect(asked).toEqual([])

    await gate.release()
    const field = await job.result
    expect(field.region).toEqual(REQUEST.region)
    expect(asked).toEqual([surface])
    gate.pool.terminate()
  })

  it('drops a request canceled while it waits, before the producer sees it', async () => {
    const gate = gatedPool(() => ({ level: 5, drainage: null }))
    const preparation = new SurfacePreparation(gate.pool)
    const { source, asked } = countingSource()
    const held = preparation.holding(source)

    const job = held.submit(unseen(), REQUEST)
    job.cancel()
    await expect(job.result).rejects.toThrow('canceled')
    await gate.release()
    expect(asked).toEqual([])
    gate.pool.terminate()
  })

  it('passes a prepared surface straight through, and says what the producer says', async () => {
    const preparation = new SurfacePreparation(null)
    const { source, asked } = countingSource()
    const held = preparation.holding(source)
    const surface = surfaceOf('Luna')

    await held.submit(surface, REQUEST).result
    expect(asked).toEqual([surface])
    expect(held.kind).toBe('gpu')
    expect(held.archive).toBe('gpu@test')
    expect(held.maxLevel).toBe(9)
    expect(held.supports?.(REQUEST)).toBe(true)
    expect(
      held.supports?.({ ...REQUEST, region: regionAddress(0, 0, 0, 0) }),
    ).toBe(false)
    // Read live, not copied at wrap time: a retired producer says so here
    // the frame it retires, and the router routes around it.
    source.available = false
    expect(held.available).toBe(false)
  })
})
