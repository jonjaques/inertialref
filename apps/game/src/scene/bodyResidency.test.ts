import { describe, expect, it } from 'vitest'
import type { WarmTicket } from '../render/warmup.ts'
import { createBodyResidency } from './bodyResidency.ts'

/*
 * The residency policy, in Node.
 *
 * Every case here is one of the "must not come back" items from the frame
 * callback that used to hold it: the cap that made arrivals vanish, the task
 * dropped at the cap, and the census `finish()` that decides whether the
 * cover lifts. The visual is a record with a visibility flag, because that
 * is all the policy reads of it.
 */

interface Visual {
  key: string
  visible: boolean
  retired: boolean
}

function ticketLog(): { ticket: WarmTicket; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    ticket: {
      expect: (units) => calls.push(`expect:${units}`),
      done: () => calls.push('done'),
      finish: () => calls.push('finish'),
    },
  }
}

function rig(cap: number) {
  const { ticket, calls } = ticketLog()
  const created: string[] = []
  const residency = createBodyResidency<Visual, { key: string }>({
    cap,
    ticket,
    onScreen: (visual) => visual.visible,
    hide: (visual) => {
      visual.visible = false
    },
    retire: (visual) => {
      visual.retired = true
    },
  })
  const make = (key: string) => (): Visual => {
    created.push(key)
    return { key, visible: true, retired: false }
  }
  return { residency, ticket: calls, created, make }
}

describe('body residency', () => {
  it('reuses a resident visual and creates one for a new arrival', () => {
    const f = rig(4)
    f.residency.begin()
    const a = f.residency.draw('a', f.make('a'))
    f.residency.end()
    f.residency.begin()
    expect(f.residency.draw('a', f.make('a'))).toBe(a)
    expect(f.created).toEqual(['a'])
  })

  it('hides what a frame did not draw and evicts it for the next arrival at the cap', () => {
    /*
     * The cap has to be graceful. Without eviction every visited system left
     * its meshes resident and, a couple of systems in, new arrivals silently
     * stopped rendering.
     */
    const f = rig(2)
    f.residency.begin()
    const a = f.residency.draw('a', f.make('a'))!
    f.residency.draw('b', f.make('b'))
    f.residency.end()
    f.residency.begin()
    f.residency.draw('b', f.make('b'))
    f.residency.end()
    expect(a.visible).toBe(false)
    f.residency.begin()
    f.residency.draw('b', f.make('b'))
    const c = f.residency.draw('c', f.make('c'))
    expect(c).not.toBeNull()
    expect(a.retired).toBe(true)
    expect(f.residency.has('a')).toBe(false)
    expect(f.residency.size).toBe(2)
  })

  it('refuses a new arrival only when the cap is full of what this frame drew', () => {
    const f = rig(2)
    f.residency.begin()
    f.residency.draw('a', f.make('a'))
    f.residency.draw('b', f.make('b'))
    expect(f.residency.draw('c', f.make('c'))).toBeNull()
    expect(f.created).toEqual(['a', 'b'])
  })

  it('builds ahead one task at a time and tells the census as it goes', () => {
    const f = rig(8)
    f.residency.plan([{ key: 'a' }, { key: 'b' }, { key: 'c' }])
    expect(f.ticket).toEqual(['expect:3'])
    f.residency.begin()
    f.residency.buildAhead((task) => f.make(task.key)())
    f.residency.buildAhead((task) => f.make(task.key)())
    expect(f.ticket).toEqual(['expect:3', 'done', 'done'])
    f.residency.buildAhead((task) => f.make(task.key)())
    expect(f.ticket).toEqual(['expect:3', 'done', 'done', 'done', 'finish'])
    expect(f.created).toEqual(['a', 'b', 'c'])
    expect(f.residency.queued).toBe(0)
  })

  it('skips a queued body the frame has already drawn rather than building it twice', () => {
    const f = rig(8)
    f.residency.plan([{ key: 'a' }, { key: 'b' }])
    f.residency.begin()
    const a = f.residency.draw('a', f.make('a'))
    const built = f.residency.buildAhead((task) => f.make(task.key)())
    expect(built?.key).toBe('b')
    expect(f.residency.draw('a', f.make('a'))).toBe(a)
    expect(f.created).toEqual(['a', 'b'])
    // `a` was credited by nobody; `finish` credits the shortfall.
    expect(f.ticket).toEqual(['expect:2', 'done', 'finish'])
  })

  it('puts a blocked task back and finishes the ticket so the cover can lift', () => {
    /*
     * THE REGRESSION. The task was shifted off and silently discarded at the
     * cap: not built, not requeued, and never credited — while `finish`
     * credited the shortfall so the bar read 100%. Sol is 129 bodies against
     * a cap of 160, so a second loaded system reached it in ordinary flight,
     * and every body past the cap paid its pipeline live until the next jump.
     */
    const f = rig(2)
    f.residency.begin()
    f.residency.draw('a', f.make('a'))
    f.residency.draw('b', f.make('b'))
    f.residency.end()
    f.residency.plan([{ key: 'c' }, { key: 'd' }])
    f.residency.begin()
    f.residency.draw('a', f.make('a'))
    f.residency.draw('b', f.make('b'))
    f.residency.end()
    expect(f.residency.buildAhead((task) => f.make(task.key)())).toBeNull()
    expect(f.residency.queued).toBe(2)
    expect(f.ticket).toEqual(['expect:2', 'finish'])
    expect(f.created).toEqual(['a', 'b'])

    // Room again: the same task, not the next one.
    f.residency.begin()
    f.residency.draw('a', f.make('a'))
    f.residency.end()
    const built = f.residency.buildAhead((task) => f.make(task.key)())
    expect(built?.key).toBe('c')
    expect(f.residency.has('b')).toBe(false)
  })

  it('retires every resident on disposal and leaves the census to the remount', () => {
    /*
     * StrictMode retires the first mount's effects before the second's run,
     * and the ticket is idempotent by label — the remount holds the same one.
     * A `finish` here would credit the whole build-ahead before the remount
     * has built anything, and the cover would lift onto uncompiled bodies.
     */
    const f = rig(8)
    f.residency.plan([{ key: 'a' }, { key: 'b' }])
    f.residency.begin()
    const a = f.residency.buildAhead((task) => f.make(task.key)())!
    const drawn = f.residency.draw('z', f.make('z'))!
    f.residency.dispose()
    expect(a.retired).toBe(true)
    expect(drawn.retired).toBe(true)
    expect(f.residency.size).toBe(0)
    expect(f.ticket).toEqual(['expect:2', 'done'])
    expect(f.residency.queued).toBe(1)
  })
})
