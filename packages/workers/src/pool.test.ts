import { describe, expect, it } from 'vitest'
import type { JobId, WorkerOutbound } from '@inertialref/protocol'
import { WorkerPool } from './pool.ts'
import { defineTask } from './task.ts'
import type { WorkerPort } from './transport.ts'

/*
 * The pool's two lanes, driven through the port by a worker that answers only
 * when the test says so — the in-process fake `transport.ts` exists for. The
 * inline worker answers on a microtask, which is exact about *what* ran and
 * says nothing about *which job a free worker took next*; that choice is the
 * whole of what a lane is.
 */

const tile = defineTask<string, string>({
  name: 'test.tile',
  version: 1,
  run: (name) => name,
})

/** One worker that holds every job it is handed until `answer` names it. */
function heldWorker() {
  const dispatched: string[] = []
  const jobs = new Map<string, JobId>()
  let deliver: (message: WorkerOutbound) => void = () => {}
  const port: WorkerPort = {
    post(message) {
      if (message.kind !== 'request') return
      const name = message.payload as string
      dispatched.push(name)
      jobs.set(name, message.job)
    },
    subscribe(handler) {
      deliver = handler
      return () => {}
    },
    terminate() {},
  }
  return {
    port,
    dispatched,
    answer(name: string) {
      const job = jobs.get(name)
      if (job === undefined) throw new Error(`${name} was never dispatched`)
      deliver({ kind: 'success', job, payload: name, durationMs: 0 })
    },
  }
}

/** Submit, and settle quietly: these tests read dispatch order, not answers. */
function ask(
  pool: WorkerPool,
  name: string,
  lane?: 'foreground' | 'background',
): void {
  pool.submit(tile, name, [], lane).result.catch(() => {})
}

describe('the background lane', () => {
  it('dispatches a foreground job ahead of the background jobs queued before it', () => {
    /*
     * The orbital bake's ninety-six tiles and the streamer's ground share
     * this pool. In one queue a bake that starts on a descent puts all
     * ninety-six ahead of the ground the descent is about to need; in its own
     * lane it waits for a worker nothing in the foreground wants.
     */
    const worker = heldWorker()
    const pool = new WorkerPool({ factory: () => worker.port, size: 1 })
    try {
      for (const name of ['bake 0', 'bake 1', 'bake 2'])
        ask(pool, name, 'background')
      ask(pool, 'ground', 'foreground')
      expect(worker.dispatched).toEqual(['bake 0'])

      worker.answer('bake 0')
      expect(worker.dispatched).toEqual(['bake 0', 'ground'])
      worker.answer('ground')
      worker.answer('bake 1')
      expect(worker.dispatched).toEqual([
        'bake 0',
        'ground',
        'bake 1',
        'bake 2',
      ])
    } finally {
      pool.terminate()
    }
  })

  it('keeps each lane in the order it was asked, and the default is the foreground', () => {
    const worker = heldWorker()
    const pool = new WorkerPool({ factory: () => worker.port, size: 1 })
    try {
      ask(pool, 'first')
      ask(pool, 'bake 0', 'background')
      ask(pool, 'second')
      ask(pool, 'bake 1', 'background')
      ask(pool, 'third')
      for (const name of ['first', 'second', 'third', 'bake 0'])
        worker.answer(name)
      expect(worker.dispatched).toEqual([
        'first',
        'second',
        'third',
        'bake 0',
        'bake 1',
      ])
      expect(pool.queued).toBe(0)
    } finally {
      pool.terminate()
    }
  })

  it('cancels a background job still waiting, and terminates both lanes', async () => {
    const worker = heldWorker()
    const pool = new WorkerPool({ factory: () => worker.port, size: 1 })
    const running = pool.submit(tile, 'ground', [])
    const waiting = pool.submit(tile, 'bake', [], 'background')
    const behind = pool.submit(tile, 'later', [])
    expect(pool.queued).toBe(2)
    waiting.cancel()
    await expect(waiting.result).rejects.toThrow('canceled')
    expect(pool.queued).toBe(1)
    pool.terminate()
    await expect(behind.result).rejects.toThrow('pool terminated')
    await expect(running.result).rejects.toThrow('pool terminated')
  })
})
