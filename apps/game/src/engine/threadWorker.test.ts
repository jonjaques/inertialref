import { afterEach, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { regionAddress, surfaceGrammar } from '@inertialref/universe'
import {
  WorkerPool,
  encodeSurface,
  generateHeightfieldTask,
  runInline,
} from '@inertialref/workers'
import { createThreadWorkerPort } from './threadWorker.ts'

/*
 * The thread transport agrees with the browser one.
 *
 * The slow descent streams its landing through this port, so what it proves
 * about the ground holds only if a thread serves what a browser Worker serves:
 * the same registry, a structured clone at the boundary, and a refusal of
 * anything that clone cannot carry. `workers.test.ts` holds the inline port to
 * the same two claims.
 */
const pools: WorkerPool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.terminate()
})
function threads(): WorkerPool {
  const pool = new WorkerPool({ factory: createThreadWorkerPort, size: 1 })
  pools.push(pool)
  return pool
}

const seed = rootSeed('outside-sol')
const payload = {
  surface: encodeSurface({
    seed,
    maxElevation: 8000,
    roughness: 3,
    seaLevel: null,
    grammar: surfaceGrammar(seed, {
      mass: 7.35e22,
      meanRadius: 1.737e6,
      atmosphere: null,
      temperature: 270,
      tidalProxy: 0,
      hasOcean: false,
      reliefSpent: 1,
      publishedRelief: 8000,
    }),
  }),
  region: regionAddress(0, 2, 0, 0),
  resolution: 5,
  border: 1,
}

it('answers a real task as the task answers on this thread', async () => {
  const answered = await threads().run(generateHeightfieldTask, payload)
  expect(answered).toEqual(await runInline(generateHeightfieldTask, payload))
  // Transferred, then rebuilt on this side as the typed array it left as.
  expect(answered.elevations).toBeInstanceOf(Float32Array)
})

it('rejects a payload a real Worker could not clone', async () => {
  const pool = threads()
  await expect(
    pool.run(generateHeightfieldTask, {
      ...payload,
      surface: { ...payload.surface, extra: () => 0 },
    } as never),
  ).rejects.toThrow(/could not be cloned|DataClone/i)
  expect(pool.stats().active).toBe(0)
})
