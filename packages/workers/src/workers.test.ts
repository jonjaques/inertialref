import { describe, expect, it } from 'vitest'
import { formatSeed, rootSeed } from '@inertialref/procedural'
import { decodeUniverseVector } from '@inertialref/protocol'
import { expect as unwrap } from '@inertialref/shared'
import { UV } from '@inertialref/spatial'
import {
  catalogStub,
  generateCell,
  galaxySeedOf,
  HEIGHTFIELD_BORDER,
  MILKY_WAY,
  surfaceGrammar,
  TEST_CATALOG,
} from '@inertialref/universe'
import { createInlineWorker } from './inline.ts'
import { WorkerPool } from './pool.ts'
import { defineTask, runInline, TaskRegistry } from './task.ts'
import {
  createTaskRegistry,
  encodeStub,
  generateCellTask,
  generateHeightfieldTask,
  surveySystemTask,
  surveyRegionTask,
} from './tasks.ts'

const SEED = rootSeed('inertialref')
const GALAXY_SEED = galaxySeedOf(SEED, MILKY_WAY)

/** A deterministic fake clock, so timing assertions are exact. */
function fakeClock() {
  let now = 0
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

function pool(size = 2, now: () => number = () => 0): WorkerPool {
  const registry = createTaskRegistry()
  return new WorkerPool({
    factory: () => createInlineWorker(registry, now),
    size,
    now,
  })
}

describe('task contracts', () => {
  it('runs the same code inline as it does in a worker', async () => {
    // The property that makes worker code testable: a task is a function, and
    // the worker is only a place to call it.
    const payload = {
      seed: formatSeed(GALAXY_SEED),
      cell: { x: 3, y: 0, z: -7 },
    }
    const direct = await runInline(generateCellTask, payload)
    const viaPool = await pool().run(generateCellTask, payload)
    expect(viaPool).toEqual(direct)
    // ...and it agrees with calling the generator itself.
    expect(direct.stars.length).toBe(
      generateCell(GALAXY_SEED, payload.cell).length,
    )
  })

  it('produces positions that survive the wire', async () => {
    const result = await pool().run(generateCellTask, {
      seed: formatSeed(GALAXY_SEED),
      cell: { x: 0, y: 0, z: 0 },
    })
    const local = generateCell(GALAXY_SEED, { x: 0, y: 0, z: 0 })
    for (const [index, star] of result.stars.entries()) {
      const decoded = unwrap(decodeUniverseVector(star.position, 'p'), 'decode')
      expect(UV.equals(decoded, local[index]?.position as never)).toBe(true)
    }
  })

  it('rejects an unknown task and a stale task version', async () => {
    const registry = new TaskRegistry()
    const real = defineTask<number, number>({
      name: 'double',
      version: 2,
      run: (n) => n * 2,
    })
    registry.register(real)
    const p = new WorkerPool({
      factory: () => createInlineWorker(registry),
      size: 1,
    })

    await expect(p.run({ ...real, name: 'missing' }, 1)).rejects.toThrow(
      /Unknown task missing/,
    )
    // A page left open across a deploy must fail loudly rather than mixing
    // algorithm versions inside one universe.
    await expect(p.run({ ...real, version: 1 }, 1)).rejects.toThrow(
      /version mismatch/,
    )
    expect(await p.run(real, 21)).toBe(42)
  })

  it('surfaces a thrown task as a rejected job without killing the worker', async () => {
    const registry = new TaskRegistry()
    const boom = defineTask<null, null>({
      name: 'boom',
      version: 1,
      run: () => {
        throw new Error('deliberate')
      },
    })
    const fine = defineTask<number, number>({
      name: 'fine',
      version: 1,
      run: (n) => n + 1,
    })
    registry.register(boom)
    registry.register(fine)
    const p = new WorkerPool({
      factory: () => createInlineWorker(registry),
      size: 1,
    })
    await expect(p.run(boom, null)).rejects.toThrow(/deliberate/)
    expect(await p.run(fine, 1)).toBe(2)
    expect(p.stats().failed).toBe(1)
  })
})

describe('worker pool', () => {
  it('spreads work across workers and drains the queue', async () => {
    const p = pool(3)
    const jobs = Array.from({ length: 12 }, (_, i) =>
      p.run(generateCellTask, {
        seed: formatSeed(GALAXY_SEED),
        cell: { x: i, y: 1, z: 1 },
      }),
    )
    const results = await Promise.all(jobs)
    expect(results).toHaveLength(12)
    const stats = p.stats()
    expect(stats.completed).toBe(12)
    expect(stats.queued).toBe(0)
    expect(stats.active).toBe(0)
    expect(stats.idle).toBe(3)
  })

  it('measures queue latency separately from execution time', async () => {
    // The two fail differently — slow tasks want optimizing, a deep queue wants
    // more workers — so the pool has to be able to tell them apart.
    const clock = fakeClock()
    const registry = new TaskRegistry()
    registry.register(
      defineTask<number, number>({
        name: 'slow',
        version: 1,
        run: (n) => {
          clock.advance(50)
          return n
        },
      }),
    )
    const slow = registry.get('slow')
    const p = new WorkerPool({
      factory: () => createInlineWorker(registry, clock.now),
      size: 1,
      now: clock.now,
    })
    const first = p.run(slow as never, 1)
    clock.advance(30)
    const second = p.run(slow as never, 2)
    await Promise.all([first, second])
    const stats = p.stats()
    expect(stats.averageRunMs).toBeGreaterThan(0)
    expect(stats.longestQueueMs).toBeGreaterThanOrEqual(30)
  })

  it('cancels a queued job before it runs', async () => {
    const p = pool(1)
    const busy = p.submit(surveyRegionTask, {
      seed: formatSeed(GALAXY_SEED),
      min: { x: 0, y: 0, z: 0 },
      max: { x: 2, y: 2, z: 2 },
    })
    const doomed = p.submit(generateCellTask, {
      seed: formatSeed(GALAXY_SEED),
      cell: { x: 9, y: 9, z: 9 },
    })
    doomed.cancel()
    await expect(doomed.result).rejects.toThrow(/cancelled/)
    await busy.result
    expect(p.stats().cancelled).toBe(1)
  })

  it('rejects everything outstanding when terminated', async () => {
    const p = pool(1)
    const job = p.submit(generateCellTask, {
      seed: formatSeed(GALAXY_SEED),
      cell: { x: 1, y: 2, z: 3 },
    })
    p.terminate()
    await expect(job.result).rejects.toThrow(/terminated/)
  })
})

describe('terrain task', () => {
  it('returns a transferable heightfield that matches local generation', async () => {
    const p = pool(2)
    /*
     * A grammar built here rather than taken off a body, because the point of
     * the task is that a worker needs nothing but its payload — no system, no
     * star, no parent planet. A Luna-sized airless rock is the case with the
     * most bands turned on.
     */
    const grammar = surfaceGrammar(SEED, {
      mass: 7.35e22,
      meanRadius: 1.737e6,
      atmosphere: null,
      temperature: 270,
      tidalProxy: 0,
      hasOcean: false,
      reliefSpent: 1,
      publishedRelief: 8_000,
    })
    const payload = {
      surfaceSeed: formatSeed(SEED),
      maxElevation: 8_000,
      roughness: 3,
      seaLevel: null,
      grammar,
      region: { face: 2, level: 5, i: 11, j: 4 },
      resolution: 33,
    }
    const result = await p.run(generateHeightfieldTask, payload)
    expect(result.elevations).toBeInstanceOf(Float32Array)
    // Bordered: two rings outside the patch, which the mesh differences
    // against so its edge normals are central rather than one-sided.
    expect(result.border).toBe(HEIGHTFIELD_BORDER)
    expect(result.elevations.length).toBe(37 * 37)
    expect(result.maxElevation).toBeLessThanOrEqual(8_000 * 1.2)
    // Declared as transferable, which is what keeps a planet's worth of patches
    // from being copied twice per frame.
    expect(generateHeightfieldTask.transfers?.(result)).toHaveLength(1)

    const again = await p.run(generateHeightfieldTask, payload)
    expect(Array.from(again.elevations)).toEqual(Array.from(result.elevations))
  })

  it('surveys a system through the same generator the world uses', async () => {
    // The stub travels, not the id. The worker has no star catalog and cannot
    // resolve one — see the header of `tasks.ts` — and the caller has already
    // resolved it, so passing the id would be asking for the work twice.
    const sol = TEST_CATALOG.get('SOL' as never)
    if (sol === undefined) throw new Error('no Sol in the fixture')
    const survey = await pool().run(surveySystemTask, {
      seed: formatSeed(SEED),
      galaxy: MILKY_WAY,
      stub: encodeStub(catalogStub(sol)),
    })
    expect(survey.name).toBe('Sol')
    expect(survey.bodies.length).toBeGreaterThan(0)
    expect(survey.bodies[0]?.address).toMatch(/^g:milky-way\/s:SOL\/b:/)
  })

  it('generates the same cell with and without the catalog context', async () => {
    // The context is what stops the worker inventing stars the catalog has
    // already accounted for. A wrong value has to change the answer, or passing
    // it is decorative.
    const cell = { x: 0, y: 0, z: 0 }
    const bare = await pool().run(generateCellTask, {
      seed: formatSeed(GALAXY_SEED),
      cell,
    })
    const filled = await pool().run(generateCellTask, {
      seed: formatSeed(GALAXY_SEED),
      cell,
      context: { catalogued: 5, completeRadius: 0 },
    })
    expect(filled.stars.length).toBe(Math.max(0, bare.stars.length - 5))
  })
})

describe('the inline transport matches the browser one', () => {
  /*
   * Two adapters at one seam have to agree about aliasing, or the seam is
   * decorative: a bug that only appears once something is not
   * structured-cloneable has to appear here too, and a transferred buffer has to
   * detach here too. Neither was true — the inline port passed the message
   * object by reference and dropped its transfer list — so a payload holding a
   * Map or a class instance passed every Node test and threw DataCloneError in
   * Chrome.
   */
  it('copies messages rather than passing them by reference', async () => {
    const registry = new TaskRegistry()
    registry.register(
      defineTask<{ box: { n: number } }, { n: number }>({
        name: 'peek',
        version: 1,
        run: (payload) => ({ n: payload.box.n }),
      }),
    )
    const pool = new WorkerPool({
      factory: () => createInlineWorker(registry),
      size: 1,
    })
    const box = { n: 1 }
    const result = await pool.run(registry.get('peek') as never, { box })
    box.n = 99
    // The task saw the value at post time, not the mutation afterwards.
    expect(result).toEqual({ n: 1 })
    pool.terminate()
  })

  it('rejects a payload a real Worker could not clone', async () => {
    const registry = new TaskRegistry()
    registry.register(
      defineTask<{ fn: unknown }, number>({
        name: 'nope',
        version: 1,
        run: () => 1,
      }),
    )
    const pool = new WorkerPool({
      factory: () => createInlineWorker(registry),
      size: 1,
    })
    // A function is not structured-cloneable. This used to pass silently here
    // and fail only in the browser. The pool turns the synchronous `post` throw
    // into a rejected job rather than leaving it active forever.
    await expect(
      pool.run(registry.get('nope') as never, { fn: () => 0 }),
    ).rejects.toThrow(/could not be cloned|DataClone/i)
    expect(pool.stats().active).toBe(0)
    pool.terminate()
  })
})
