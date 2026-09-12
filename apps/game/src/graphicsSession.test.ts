import { expect, it, vi } from 'vitest'
import { createGraphicsSession, STRIKES } from './graphicsSession.ts'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
}

/** A settle timer the test fires by hand. */
function clock() {
  const pending: (() => void)[] = []
  return {
    settle: (run: () => void) => void pending.push(run),
    elapse: () => {
      for (const run of pending.splice(0)) run()
    },
  }
}

const never = () => {}

it('forgives one unclean end and blocks the next', () => {
  const tab = storage()
  expect(createGraphicsSession(tab, never).begin()).toBe(true)
  // The tab died without pagehide: a discard, a kill, a hung page reloaded.
  expect(createGraphicsSession(tab, never).begin()).toBe(true)
  // And again, before it had settled: that is the loop.
  expect(createGraphicsSession(tab, never).begin()).toBe(false)
  expect(createGraphicsSession(tab, never).begin()).toBe(false)
  expect(STRIKES).toBe(2)
})

it('allows ordinary navigation and an explicit retry after a loop', () => {
  const tab = storage()
  const first = createGraphicsSession(tab, never)
  first.begin()
  first.end()
  expect(createGraphicsSession(tab, never).begin()).toBe(true)
  expect(createGraphicsSession(tab, never).begin()).toBe(true)
  const blocked = createGraphicsSession(tab, never)
  expect(blocked.begin()).toBe(false)
  blocked.end()
  expect(blocked.begin()).toBe(true)
})

it('forgets the strikes once a session has run long enough to settle', () => {
  const tab = storage()
  const timer = clock()
  expect(createGraphicsSession(tab, timer.settle).begin()).toBe(true)
  expect(createGraphicsSession(tab, timer.settle).begin()).toBe(true)
  // The second session drew for a minute, then the tab was discarded.
  timer.elapse()
  expect(createGraphicsSession(tab, never).begin()).toBe(true)
  expect(createGraphicsSession(tab, never).begin()).toBe(false)
})

it('reads a marker it did not write as one unclean end', () => {
  const tab = storage()
  tab.setItem('ir.graphics-session', 'active')
  expect(createGraphicsSession(tab, never).begin()).toBe(true)
  expect(createGraphicsSession(tab, never).begin()).toBe(false)
})

it('does not mistake denied storage for unsupported graphics', () => {
  const denied = vi.fn(() => {
    throw new Error('Storage denied')
  })
  const session = createGraphicsSession(
    { getItem: denied, setItem: denied, removeItem: denied },
    never,
  )
  expect(session.begin()).toBe(true)
  expect(() => session.end()).not.toThrow()
})
