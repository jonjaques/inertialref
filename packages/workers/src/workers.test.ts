import { describe, expect, it } from 'vitest'
import { formatSeed, rootSeed } from '@inertialref/procedural'
import { decodeUniverseVector } from '@inertialref/protocol'
import {
  expect as unwrap,
  timingHub,
  type TimingRecord,
} from '@inertialref/shared'
import { UV } from '@inertialref/spatial'
import {
  catalogStub,
  COVER_CHANNELS,
  generateCell,
  galaxySeedOf,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  MAX_REGION_LEVEL,
  MILKY_WAY,
  surfaceDetailFloor,
  surfaceGrammar,
  TEST_CATALOG,
} from '@inertialref/universe'
import { createInlineWorker } from './inline.ts'
import { WorkerPool } from './pool.ts'
import { defineTask, runInline, TaskRegistry } from './task.ts'
import {
  createTaskRegistry,
  decodeSurface,
  encodeStub,
  encodeSurface,
  generateCellTask,
  generateHeightfieldTask,
  surfaceDetailFloorTask,
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
      surface: encodeSurface({
        seed: SEED,
        maxElevation: 8_000,
        roughness: 3,
        seaLevel: null,
        grammar,
      }),
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
    // The cover is the patch's own vertices and carries no border, so it is
    // 33² rather than the elevations' 37². See `cover.ts`.
    expect(result.cover).toBeInstanceOf(Uint8Array)
    expect(result.cover.length).toBe(33 * 33 * COVER_CHANNELS)
    // Both declared transferable, which is what keeps a planet's worth of
    // patches from being copied twice per frame.
    expect(generateHeightfieldTask.transfers?.(result)).toHaveLength(2)

    const again = await p.run(generateHeightfieldTask, payload)
    expect(Array.from(again.elevations)).toEqual(Array.from(result.elevations))
    expect(Array.from(again.cover)).toEqual(Array.from(result.cover))
  })

  it('measures the same detail floor in a worker as it does here', async () => {
    /*
     * The parity `extending.md` asks of every task, and this one earns it twice
     * over: the answer is a *ceiling on refinement*, so a worker that disagreed
     * with the main thread would stream a different depth of ground for the
     * same body without anything failing. It is on the pool because the search
     * is 33-43 ms cold and was paid inside the frame a body arrives — see the
     * task, and `surfaceDetailFloor`'s own docstring.
     *
     * The same Luna-shaped rock the heightfield case uses, for the same reason:
     * a worker gets a payload and nothing else, and an airless body turns the
     * most bands on.
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
    const surface = {
      seed: SEED,
      maxElevation: 8_000,
      roughness: 3,
      seaLevel: null,
      grammar,
    }
    const payload = {
      surface: encodeSurface(surface),
      resolution: HEIGHTFIELD_RESOLUTION,
    }

    const viaPool = await pool().run(surfaceDetailFloorTask, payload)
    const direct = await runInline(surfaceDetailFloorTask, payload)
    // Against the generator itself, not only against the other spelling of the
    // task — two callers of one memo agreeing proves less than either agreeing
    // with the search.
    const here = surfaceDetailFloor(surface, HEIGHTFIELD_RESOLUTION)

    expect(viaPool.level).toBe(here)
    expect(direct.level).toBe(here)
    // A real floor rather than the clamp at either end: the point of the search
    // is that the level is measured from the field rather than assumed, so a
    // task returning 0 or `MAX_REGION_LEVEL` would satisfy the equalities above
    // and mean nothing.
    expect(here).toBeGreaterThan(0)
    expect(here).toBeLessThan(MAX_REGION_LEVEL)

    /*
     * What this catches, stated because it is narrower than it looks.
     *
     * Confirmed by reintroducing each defect: a task that parses the wrong seed
     * fails here. A task that mangles `maxElevation`, `roughness` or
     * `resolution` alone does **not** — the floor is set by where the *band
     * stack* goes quiet, and scaling any of those three moves it by less than a
     * level on this fixture. The grammar is what moves it, which is what the
     * second surface below is for.
     */
    // Two surfaces that genuinely disagree — Luna's bands go quiet at 15 and an
    // Earth-sized rock's at 18 — so a task answering from a constant, or from a
    // grammar it built itself instead of the one it was handed, is caught even
    // where a scaled scalar is not.
    const bigGrammar = surfaceGrammar(SEED, {
      mass: 5.97e24,
      meanRadius: 6.371e6,
      atmosphere: null,
      temperature: 270,
      tidalProxy: 0,
      hasOcean: false,
      reliefSpent: 1,
      publishedRelief: 8_848,
    })
    const biggerSurface = {
      ...surface,
      maxElevation: 8_848,
      grammar: bigGrammar,
    }
    const elsewhere = await pool().run(surfaceDetailFloorTask, {
      ...payload,
      surface: encodeSurface(biggerSurface),
    })
    expect(elsewhere.level).toBe(
      surfaceDetailFloor(biggerSurface, HEIGHTFIELD_RESOLUTION),
    )
    expect(elsewhere.level).not.toBe(here)
  })

  it('carries a surface across the wire as the surface it was', () => {
    /*
     * The seed is the one field that does not survive structured clone as
     * itself, and the two functions are the one place it is converted — so
     * what is held here is that the conversion is lossless and that nothing
     * else is touched, spelled as the decoded surface being equal to the
     * original field for field. A field `SurfaceParameters` grows travels
     * through both without either being edited, and this is what would say
     * so if one of them started dropping it.
     */
    const grammar = surfaceGrammar(SEED, {
      mass: 5.97e24,
      meanRadius: 6.371e6,
      atmosphere: null,
      temperature: 288,
      tidalProxy: 0,
      hasOcean: true,
      reliefSpent: 1,
      publishedRelief: 8_848,
    })
    const surface = {
      seed: SEED,
      maxElevation: 8_848,
      roughness: 2.5,
      seaLevel: 0.31,
      grammar,
    }
    const wire = encodeSurface(surface)
    expect(wire.seed).toBe(formatSeed(SEED))
    expect(wire.seed).toMatch(/^[0-9a-f]{32}$/)
    expect(decodeSurface(wire)).toEqual(surface)
    expect(Object.keys(decodeSurface(wire)).sort()).toEqual(
      Object.keys(surface).sort(),
    )
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

describe('timing across the worker boundary', () => {
  /*
   * The level has to *travel*, and the failure if it does not is silent: the
   * page emits its tracks, the Workers and Tasks tracks stay empty, and nothing
   * reports an error. That is the whole reason this is a message rather than a
   * query on the worker's URL — see `WorkerTiming` in `packages/protocol` for
   * the other three reasons — and it is why the crossing has a test.
   */
  it('sends the level to every worker, once per change', () => {
    const sent: unknown[][] = [[], []]
    const registry = createTaskRegistry()
    const held = new WorkerPool({
      factory: (index) => {
        const port = createInlineWorker(registry)
        return {
          ...port,
          post: (message, transfer) => {
            sent[index]?.push(message)
            port.post(message, transfer)
          },
        }
      },
      size: 2,
    })

    held.setTimingLevel('trace')
    held.setTimingLevel('trace') // idempotent: a repeat is not a broadcast
    held.setTimingLevel('off')

    for (const perWorker of sent) {
      expect(perWorker).toEqual([
        { kind: 'timing', level: 'trace' },
        { kind: 'timing', level: 'off' },
      ])
    }
    held.terminate()
  })

  it('emits queue and run from the pool and the task from the loop', async () => {
    /*
     * Both sides, in one process, over the real `serveTasks`.
     *
     * The browser cannot check this end to end: a worker's entries live on the
     * worker's own performance timeline and the page's `getEntriesByType`
     * cannot see them, which is the separate-`timeOrigin` rule doing its job —
     * so an unwired worker looks exactly like a working one from the page. The
     * inline transport runs the same loop against the same registry with a
     * microtask instead of a thread boundary, which makes the one thing that
     * cannot be observed there observable here.
     */
    const records: TimingRecord[] = []
    const clock = fakeClock()
    const detach = timingHub.attach(
      { write: (record) => records.push(record) },
      { now: clock.now },
    )
    try {
      const registry = createTaskRegistry()
      const held = new WorkerPool({
        factory: () => createInlineWorker(registry, clock.now),
        size: 1,
        now: clock.now,
      })
      await held.run(generateHeightfieldTask, {
        surface: encodeSurface({
          seed: SEED,
          maxElevation: 8_000,
          roughness: 3,
          seaLevel: null,
          grammar: surfaceGrammar(SEED, {
            mass: 7.35e22,
            meanRadius: 1.737e6,
            atmosphere: null,
            temperature: 270,
            tidalProxy: 0,
            hasOcean: false,
            reliefSpent: 1,
            publishedRelief: 8_000,
          }),
        }),
        region: { face: 2, level: 5, i: 11, j: 4 },
        resolution: 17,
      })
      held.terminate()

      const seen = records.map((r) => `${r.detail?.track}/${r.name}`)
      expect(seen).toContain('Workers/queue universe.generateHeightfield')
      expect(seen).toContain('Workers/run universe.generateHeightfield')
      expect(seen).toContain('Tasks/universe.generateHeightfield')

      // The label is the task's name and nothing more. Folding the region into
      // it — which the plan asked for — gives one aggregation bucket per patch,
      // an unbounded retained-name set, and a chart in which no two bars share
      // a name. The address rides in the properties table instead.
      const task = records.find((r) => r.detail?.track === 'Tasks')
      expect(task?.name).toBe('universe.generateHeightfield')
      expect(task?.detail?.properties).toEqual([['region', '2/5:11,4']])

      // Neither side names the application. A track is a component describing
      // itself; the group is branding, and the browser sink fills it in.
      for (const record of records) expect(record.detail?.group).toBeUndefined()
    } finally {
      detach()
    }
  })

  it('hands the worker loop a level it does not itself interpret', async () => {
    // `packages/*` may not name `console.timeStamp`, so the loop decodes the
    // message and the host decides what a level means. A level this build has
    // never heard of still arrives — the host is what rejects it, which is what
    // keeps a page open across a deploy from guessing.
    const seen: string[] = []
    const registry = createTaskRegistry()
    const worker = createInlineWorker(registry, () => 0, {
      onTimingLevel: (level) => seen.push(level),
    })
    worker.post({ kind: 'timing', level: 'full' })
    worker.post({ kind: 'timing', level: 'from-a-later-build' })
    // Inline delivery is deferred through a resolved promise, so a microtask
    // turn is what makes this observable.
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual(['full', 'from-a-later-build'])
    worker.terminate()
  })
})
