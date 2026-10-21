import { describe, expect, it } from 'vitest'
import { createHandover } from './chainHandover.ts'

interface FakeChain {
  readonly name: string
  disposed: boolean
  resolve: () => void
  reject: (cause: unknown) => void
  readonly prepared: Promise<void>
}

const chain = (name: string): FakeChain => {
  let resolve = () => {}
  let reject: (cause: unknown) => void = () => {}
  const prepared = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return {
    name,
    disposed: false,
    prepared,
    get resolve() {
      return resolve
    },
    get reject() {
      return reject
    },
  }
}

/** The handover, and every chain it has put on screen in order. */
function rig() {
  const shows: (string | null)[] = []
  const handover = createHandover<FakeChain>({
    ready: (c) => c.prepared,
    dispose: (c) => {
      expect(c.disposed, `${c.name} disposed twice`).toBe(false)
      c.disposed = true
    },
    show: (c) => shows.push(c?.name ?? null),
  })
  return { handover, shows }
}

/** Long enough for the handover's promise reactions and microtasks to run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the sensor chain handover', () => {
  it('shows the first chain at once, ready or not', () => {
    const { handover, shows } = rig()
    const a = chain('a')
    handover.offer(a)
    expect(handover.shown).toBe(a)
    expect(shows).toEqual(['a'])
  })

  it('keeps the old chain on screen until the new one is ready', async () => {
    const { handover, shows } = rig()
    const a = chain('a')
    const releaseA = handover.offer(a)
    // A dependency change: React runs the old cleanup, then the new setup.
    releaseA()
    const b = chain('b')
    handover.offer(b)
    await settle()
    expect(handover.shown).toBe(a)
    expect(handover.latest).toBe(b)
    expect(a.disposed).toBe(false)

    b.resolve()
    await settle()
    expect(handover.shown).toBe(b)
    expect(a.disposed).toBe(true)
    expect(shows).toEqual(['a', 'b'])
  })

  it('shows a chain whose compile failed rather than holding the old one forever', async () => {
    const { handover } = rig()
    const a = chain('a')
    handover.offer(a)()
    const b = chain('b')
    handover.offer(b)
    b.reject(new Error('no pipeline'))
    await settle()
    expect(handover.shown).toBe(b)
    expect(a.disposed).toBe(true)
  })

  it('disposes a chain superseded before it was ready, and never shows it', async () => {
    const { handover, shows } = rig()
    const a = chain('a')
    handover.offer(a)()
    const b = chain('b')
    const releaseB = handover.offer(b)
    releaseB()
    const c = chain('c')
    handover.offer(c)
    expect(b.disposed).toBe(true)
    b.resolve()
    await settle()
    expect(handover.shown).toBe(a)

    c.resolve()
    await settle()
    expect(handover.shown).toBe(c)
    expect(a.disposed).toBe(true)
    expect(shows).toEqual(['a', 'c'])
  })

  it('takes everything down on unmount, waiting for nothing', async () => {
    const { handover, shows } = rig()
    const a = chain('a')
    handover.offer(a)()
    await settle()
    expect(a.disposed).toBe(true)
    expect(handover.shown).toBe(null)
    expect(shows).toEqual(['a', null])
  })

  it('takes the old chain down too when the pending one unmounts', async () => {
    const { handover, shows } = rig()
    const a = chain('a')
    handover.offer(a)()
    const b = chain('b')
    const releaseB = handover.offer(b)
    releaseB()
    await settle()
    expect(a.disposed).toBe(true)
    expect(b.disposed).toBe(true)
    expect(handover.shown).toBe(null)
    expect(shows).toEqual(['a', null])
  })
})
