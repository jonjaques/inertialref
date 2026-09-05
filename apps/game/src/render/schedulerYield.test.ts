import { describe, expect, it } from 'vitest'
import { installSchedulerYield } from './schedulerYield.ts'

/*
 * The shim, on a bare object rather than on Node's own global: Node has a
 * `scheduler` of its own in `timers/promises` but not on `globalThis`, and a
 * test that installed there would leave it for every test after.
 */

describe('installSchedulerYield', () => {
  it('gives a host with no scheduler one whose yield is a macrotask', async () => {
    const host: { scheduler?: { yield?: () => Promise<void> } } = {}
    installSchedulerYield(host)
    const scheduler = host.scheduler
    if (scheduler?.yield === undefined) throw new Error('no yield installed')
    /*
     * A macrotask, not a microtask. The microtask queue drains before the
     * next task starts, so a yield that is a task lets a chain ten promises
     * deep finish first; a `Promise.resolve()` in its place resolves after
     * one hop and lands in the middle of the chain. Not a timer, because
     * Node clamps `setTimeout(0)` to a millisecond and a channel message can
     * legitimately arrive first.
     */
    const order: string[] = []
    const yielded = scheduler.yield().then(() => order.push('yield'))
    let chain = Promise.resolve()
    for (let i = 0; i < 10; i += 1) {
      chain = chain.then(() => {
        order.push('micro')
      })
    }
    await yielded
    expect(order).toEqual([...Array<string>(10).fill('micro'), 'yield'])
  })

  it('adds yield onto a scheduler that has only postTask', () => {
    const postTask = (): Promise<void> => Promise.resolve()
    const host = {
      scheduler: { postTask } as {
        postTask: typeof postTask
        yield?: () => Promise<void>
      },
    }
    installSchedulerYield(host)
    expect(host.scheduler.postTask).toBe(postTask)
    expect(typeof host.scheduler.yield).toBe('function')
  })

  it('leaves a native yield alone', () => {
    const native = (): Promise<void> => Promise.resolve()
    const host = { scheduler: { yield: native } }
    installSchedulerYield(host)
    expect(host.scheduler.yield).toBe(native)
  })
})
