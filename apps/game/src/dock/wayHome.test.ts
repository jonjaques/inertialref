import { describe, expect, it } from 'vitest'
import { holdWayHome, subscribeWayHome, wayHomeHeld } from './wayHome.ts'

/*
 * The skip link renders only while a way-home link is attached, so the count
 * behind `wayHomeHeld` is the whole of its visibility. A node stands in for the
 * element: the ref callback never touches it beyond telling it from `null`.
 */
const node = {} as HTMLElement

describe('the way home', () => {
  it('is held while a link is attached and released by its cleanup', () => {
    expect(wayHomeHeld()).toBe(false)
    const release = holdWayHome(node)
    expect(wayHomeHeld()).toBe(true)
    release?.()
    expect(wayHomeHeld()).toBe(false)
  })

  it('ignores the null a ref callback is handed on detach', () => {
    expect(holdWayHome(null)).toBeUndefined()
    expect(wayHomeHeld()).toBe(false)
  })

  it('survives a second attach before the first detach', () => {
    // A re-keyed menu, or StrictMode's double attach: two holds overlap, and
    // releasing the first must not report the menu gone.
    const first = holdWayHome(node)
    const second = holdWayHome(node)
    first?.()
    expect(wayHomeHeld()).toBe(true)
    second?.()
    expect(wayHomeHeld()).toBe(false)
  })

  it('notifies once, after the commit, across a detach and re-attach', async () => {
    // What `Slot`'s per-render ref does: the count passes through zero inside
    // one commit and is back by its end. A subscriber hears once, afterward,
    // and reads the snapshot it already had.
    const held = holdWayHome(node)
    await Promise.resolve()
    const seen: boolean[] = []
    const stop = subscribeWayHome(() => seen.push(wayHomeHeld()))
    held?.()
    const again = holdWayHome(node)
    expect(seen).toEqual([])
    await Promise.resolve()
    expect(seen).toEqual([true])
    stop()
    again?.()
  })
})
