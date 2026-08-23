import { describe, expect, it } from 'vitest'
import type { Camera, Object3D, Scene } from 'three/webgpu'
import {
  type BootProgress,
  type WarmRenderer,
  createWarmup,
  warmCompile,
} from './warmup.ts'

/*
 * The warm-up plan, in Node.
 *
 * None of this needs a GPU: the recipe is a visibility toggle around one
 * method call, and the census is arithmetic. What *cannot* be tested here is
 * whether a compiled pipeline is the one a frame draws with — a TSL graph
 * cannot be evaluated in Node, so that half stays GPU-verified (see
 * `.claude/rules/rendering.md`). The half that shipped bugs is this one: a
 * compile against an invisible object walks nothing at all, and a progress
 * total that excluded the most expensive producer said "compiling the sky…"
 * while the 88 ms of work had not started.
 */

/** Enough of an `Object3D` for the recipe, which reads exactly one field. */
const object = (visible = false): Object3D =>
  ({ visible }) as unknown as Object3D

const CAMERA = {} as Camera
const SCENE = {} as Scene

/**
 * The second adapter.
 *
 * It records `visible` **at call time**, which is the whole point: a renderer
 * that recorded it afterwards would pass against the bug this guards, because
 * `warmCompile` restores visibility on the next line.
 */
function recorder(behavior: 'resolves' | 'rejects' = 'resolves'): {
  renderer: WarmRenderer
  calls: { object: Object3D; visibleAtCallTime: boolean }[]
} {
  const calls: { object: Object3D; visibleAtCallTime: boolean }[] = []
  return {
    calls,
    renderer: {
      compileAsync(target) {
        calls.push({ object: target, visibleAtCallTime: target.visible })
        return behavior === 'resolves'
          ? Promise.resolve(undefined)
          : Promise.reject(new Error('no such pipeline'))
      },
    },
  }
}

describe('warmCompile', () => {
  it('never compiles an object while it is invisible', () => {
    /*
     * THE REGRESSION. `compileAsync` walks the tree exactly as a render would
     * and skips invisible objects, so warming something dormant — the warp
     * effects, a body visual built ahead of need — compiles nothing at all
     * unless it is made visible first. It fails silently: the promise
     * resolves, the pipeline does not exist, and the cost lands on the one
     * frame the effect first appears in.
     */
    const { renderer, calls } = recorder()
    const dormant = object(false)
    void warmCompile(renderer, {
      object: dormant,
      camera: CAMERA,
      scene: SCENE,
    })
    expect(calls[0]?.visibleAtCallTime).toBe(true)
  })

  it('puts the object back the way it found it', () => {
    // Restored, not set to false: two of the three callers warm objects that
    // are already on screen, and blanking those would drop them for a frame.
    const dormant = object(false)
    const shown = object(true)
    const { renderer } = recorder()
    void warmCompile(renderer, {
      object: dormant,
      camera: CAMERA,
      scene: SCENE,
    })
    void warmCompile(renderer, { object: shown, camera: CAMERA, scene: SCENE })
    expect(dormant.visible).toBe(false)
    expect(shown.visible).toBe(true)
  })

  it('restores visibility synchronously, before anything can draw', () => {
    // `compileAsync`'s traversal is synchronous — only the backend's pipeline
    // promises are awaited — so the toggle closes in the same task. If this
    // ever needed an await, a unit sphere at the origin could reach a frame.
    const dormant = object(false)
    const { renderer } = recorder()
    const pending = warmCompile(renderer, {
      object: dormant,
      camera: CAMERA,
      scene: SCENE,
    })
    expect(dormant.visible).toBe(false)
    return pending
  })

  it('swallows a rejection rather than sinking the boot', async () => {
    const { renderer } = recorder('rejects')
    await expect(
      warmCompile(renderer, { object: object(), camera: CAMERA, scene: SCENE }),
    ).resolves.toBeUndefined()
  })
})

/* ------------------------------------------------------------------------- */

const producer = (label: string, units: number, log: string[] = []) => ({
  label,
  units,
  run: async (done: () => void) => {
    for (let i = 0; i < units; i += 1) {
      log.push(`${label}:${i}`)
      done()
    }
  },
})

describe('the boot census', () => {
  it('totals every producer, not just the running one', async () => {
    const warmup = createWarmup()
    warmup.register(producer('warming surface maps', 19))
    warmup.register(producer('baking atmospheres', 7))
    warmup.register(producer('building bodies', 29))

    const seen: BootProgress[] = []
    await warmup.run((progress) => seen.push(progress))

    expect(seen.at(-1)).toEqual({
      label: 'building bodies',
      done: 55,
      total: 55,
    })
    // And it was 55 from the first report, not a number that grew as each
    // producer started. A bar that reaches 100% three times is not a bar.
    expect(seen[0]?.total).toBe(55)
  })

  it('runs producers in registration order', async () => {
    const log: string[] = []
    const warmup = createWarmup()
    warmup.register(producer('first', 2, log))
    warmup.register(producer('second', 1, log))
    await warmup.run()
    expect(log).toEqual(['first:0', 'first:1', 'second:0'])
  })

  it('picks up a producer registered while it is already running', async () => {
    /*
     * Not an edge case — it is how the scene components join. R3F schedules
     * their mount effects independently of the effect that starts the
     * warm-up, so a component that registers a frame after boot began must
     * still hold the cover up.
     */
    const log: string[] = []
    const warmup = createWarmup()
    warmup.register({
      label: 'first',
      units: 1,
      run: async (done) => {
        warmup.register(producer('late', 1, log))
        done()
      },
    })
    await warmup.run()
    expect(log).toEqual(['late:0'])
  })

  it('does not let a producer that throws sink the run', async () => {
    const log: string[] = []
    const warmup = createWarmup()
    warmup.register({
      label: 'doomed',
      units: 3,
      run: () => Promise.reject(new Error('the device was lost')),
    })
    warmup.register(producer('after', 1, log))

    const seen: BootProgress[] = []
    await warmup.run((progress) => seen.push(progress))

    expect(log).toEqual(['after:0'])
    // Its units are credited anyway, so the bar cannot stall three short of
    // its own total on a producer that gave up.
    expect(seen.at(-1)).toEqual({ label: 'after', done: 4, total: 4 })
  })

  it('credits a producer that reported fewer units than it declared', async () => {
    // A texture that fails to decode is one fewer upload than the manifest
    // promised, and the manifest is the only count available before the fetch.
    const warmup = createWarmup()
    warmup.register({
      label: 'warming surface maps',
      units: 19,
      run: async (done) => {
        done()
      },
    })
    const seen: BootProgress[] = []
    await warmup.run((progress) => seen.push(progress))
    expect(seen.at(-1)?.done).toBe(19)
  })

  it('waits for a producer it counts but does not drive', async () => {
    /*
     * `Bodies.tsx` builds one body visual per frame. Boot cannot await a loop
     * over that — the frames are what it is waiting for — so it reports
     * through a ticket, and `run` does not resolve until the queue is empty.
     * That queue is the 88 ms the boot overlay exists to hide.
     */
    const warmup = createWarmup()
    const ticket = warmup.track('building bodies')
    ticket.expect(3)

    let settled = false
    const running = warmup.run().then(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(settled).toBe(false)

    ticket.done()
    ticket.done()
    ticket.done()
    ticket.finish()
    await running
    expect(settled).toBe(true)
  })

  it('counts a tracked producer in the total from the moment it joins', async () => {
    const warmup = createWarmup()
    warmup.register(producer('warming surface maps', 2))
    const ticket = warmup.track('building bodies', 29)
    const seen: BootProgress[] = []
    const running = warmup.run((progress) => seen.push(progress))
    ticket.finish()
    await running
    expect(seen[0]?.total).toBe(31)
  })

  it('does not time out a frame-driven producer while the document cannot draw', async () => {
    /*
     * Chrome suspends `requestAnimationFrame` entirely for an occluded window,
     * so a page that loads in the background has a frame-driven producer that
     * is not stalled — it has not been given a single frame. Timing it out
     * would abandon the build-ahead for exactly the load with the most time to
     * spare. Measured live before this: a boot in an occluded automation window
     * burned the whole allowance and logged a stall that had not happened.
     */
    let visible = false
    const warmup = createWarmup({ framesPossible: () => visible })
    const ticket = warmup.track('building bodies', 2)

    let settled = false
    const running = warmup.run().then(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    // The window comes back and the drain gets its full allowance.
    visible = true
    ticket.finish()
    await running
    expect(settled).toBe(true)
  })

  it('is idempotent by label, because StrictMode registers everything twice', async () => {
    /*
     * THE REGRESSION, and it was found in the browser rather than here.
     * StrictMode double-invokes effects and state initializers, so every
     * registration happens twice. The second `track('building bodies')` used to
     * return a *second* ticket — one the component never held and could
     * therefore never finish — and boot sat at "building bodies 62/62" with the
     * cover up, forever.
     */
    const log: string[] = []
    const warmup = createWarmup()
    warmup.register(producer('warming surface maps', 2, log))
    warmup.register(producer('warming surface maps', 2, log))

    const first = warmup.track('building bodies', 3)
    const second = warmup.track('building bodies', 3)
    expect(second).toBe(first)

    const seen: BootProgress[] = []
    const running = warmup.run((progress) => seen.push(progress))
    // Finishing through the *other* handle has to be the same ticket.
    second.finish()
    await running

    // Two units and three, counted once each.
    expect(seen[0]?.total).toBe(5)
    expect(log).toEqual(['warming surface maps:0', 'warming surface maps:1'])
  })

  it('reports itself settled once it is done, so a late producer knows', async () => {
    const warmup = createWarmup()
    expect(warmup.settled).toBe(false)
    await warmup.run()
    expect(warmup.settled).toBe(true)
  })
})
