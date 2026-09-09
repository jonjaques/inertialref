import { expect, it, vi } from 'vitest'
import { createGraphicsSession } from './graphicsSession.ts'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
}

it('blocks repeated startup when the previous tab dies without pagehide', () => {
  const tab = storage()
  expect(createGraphicsSession(tab).begin()).toBe(true)
  expect(createGraphicsSession(tab).begin()).toBe(false)
  expect(createGraphicsSession(tab).begin()).toBe(false)
})

it('allows ordinary navigation and an explicit retry after a crash', () => {
  const tab = storage()
  const first = createGraphicsSession(tab)
  first.begin()
  first.end()
  expect(createGraphicsSession(tab).begin()).toBe(true)
  const replacement = createGraphicsSession(tab)
  expect(replacement.begin()).toBe(false)
  replacement.end()
  expect(replacement.begin()).toBe(true)
})

it('does not mistake denied storage for unsupported graphics', () => {
  const denied = vi.fn(() => {
    throw new Error('Storage denied')
  })
  const session = createGraphicsSession({
    getItem: denied,
    setItem: denied,
    removeItem: denied,
  })
  expect(session.begin()).toBe(true)
  expect(() => session.end()).not.toThrow()
})
