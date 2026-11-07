import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  arrange,
  currentOf,
  EMPTY_QUEUE,
  HISTORY,
  jumpQueue,
  moveTrack,
  nextQueue,
  playable,
  previousQueue,
  type Queue,
  type Random,
  reconcileQueue,
  shuffled,
  startQueue,
  withMember,
} from './playlist.ts'

/** A seeded uniform source, so a failing property replays from its seed. */
function seeded(seed: number): Random {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 2 ** 32
  }
}

const ids = (n: number): readonly string[] =>
  Array.from({ length: n }, (_, i) => `t${i}`)

const TRACKS = [
  { id: 'a', category: 'ambient' as const },
  { id: 'b', category: 'ambient' as const },
  { id: 'c', category: 'lofi' as const },
  { id: 'd', category: 'lofi' as const },
  { id: 'e', category: 'signals' as const },
]

describe('arrange and playable', () => {
  it('puts the arranged ids first and the rest after, in catalog order', () => {
    expect(arrange(TRACKS, ['d', 'nope', 'b', 'd']).map((t) => t.id)).toEqual([
      'd',
      'b',
      'a',
      'c',
      'e',
    ])
  })

  it('leaves out what is switched off, track by track and by category', () => {
    expect(
      playable(TRACKS, {
        order: ['c', 'a'],
        disabled: ['a'],
        mutedCategories: ['signals'],
      }),
    ).toEqual(['c', 'b', 'd'])
  })

  it('always arranges every track exactly once', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'x')),
        (order) => {
          const arranged = arrange(TRACKS, order).map((t) => t.id)
          expect([...arranged].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
        },
      ),
    )
  })
})

describe('shuffled', () => {
  it('is a permutation that does not open on the track to avoid', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.integer(), (n, seed) => {
        const list = ids(n)
        const avoid = list[0] ?? null
        const out = shuffled(list, seeded(seed), avoid)
        expect([...out].sort()).toEqual([...list].sort())
        if (n > 1) expect(out[0]).not.toBe(avoid)
      }),
    )
  })

  /*
   * Uniformity, roughly: across many shuffles of four, each id opens a
   * quarter of them. A shuffle that favored the original order — the classic
   * off-by-one in Fisher–Yates — fails this by a wide margin.
   */
  it('opens with every track about equally often', () => {
    const random = seeded(99)
    const counts = new Map<string, number>()
    const draws = 20_000
    for (let i = 0; i < draws; i += 1) {
      const first = shuffled(ids(4), random)[0]!
      counts.set(first, (counts.get(first) ?? 0) + 1)
    }
    for (const count of counts.values()) {
      expect(Math.abs(count / draws - 0.25)).toBeLessThan(0.015)
    }
  })
})

/** Run `steps` natural track endings and return every track that played. */
function play(
  start: Queue,
  list: readonly string[],
  shuffle: boolean,
  random: Random,
  steps: number,
): string[] {
  let queue: Queue | null = start
  const heard = [currentOf(start)!]
  for (let i = 0; i < steps && queue !== null; i += 1) {
    queue = nextQueue(queue, list, { shuffle, repeat: 'all' }, random, 'ended')
    if (queue !== null) heard.push(currentOf(queue)!)
  }
  return heard
}

describe('the queue', () => {
  it('plays every track once per cycle in a shuffle, and never one twice in a row', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 25 }), fc.integer(), (n, seed) => {
        const list = ids(n)
        const random = seeded(seed)
        const heard = play(
          startQueue(list, true, random),
          list,
          true,
          random,
          n * 4 - 1,
        )
        for (let cycle = 0; cycle < 4; cycle += 1) {
          const round = heard.slice(cycle * n, (cycle + 1) * n)
          expect([...round].sort()).toEqual([...list].sort())
        }
        for (let i = 1; i < heard.length; i += 1) {
          expect(heard[i]).not.toBe(heard[i - 1])
        }
      }),
    )
  })

  it('plays the arrangement in order, round and round', () => {
    const list = ids(4)
    const heard = play(
      startQueue(list, false, seeded(1)),
      list,
      false,
      seeded(1),
      9,
    )
    expect(heard).toEqual([
      't0',
      't1',
      't2',
      't3',
      't0',
      't1',
      't2',
      't3',
      't0',
      't1',
    ])
  })

  it('resumes on the track it is asked to, and continues from there in order', () => {
    const queue = startQueue(ids(5), false, seeded(1), 't3')
    expect(queue).toEqual({ played: ['t3'], upcoming: ['t4'] })
  })

  it('stops at the end with repeat off, but wraps for a skip', () => {
    const list = ids(2)
    const last = nextQueue(
      startQueue(list, false, seeded(1)),
      list,
      { shuffle: false, repeat: 'off' },
      seeded(1),
      'ended',
    )!
    expect(currentOf(last)).toBe('t1')
    expect(
      nextQueue(
        last,
        list,
        { shuffle: false, repeat: 'off' },
        seeded(1),
        'ended',
      ),
    ).toBeNull()
    const wrapped = nextQueue(
      last,
      list,
      { shuffle: false, repeat: 'off' },
      seeded(1),
      'skip',
    )!
    expect(currentOf(wrapped)).toBe('t0')
  })

  it('replays a track that ended with repeat one, and moves on from one that was skipped', () => {
    const list = ids(3)
    const start = startQueue(list, false, seeded(1))
    const again = nextQueue(
      start,
      list,
      { shuffle: false, repeat: 'one' },
      seeded(1),
      'ended',
    )!
    expect(currentOf(again)).toBe('t0')
    const skipped = nextQueue(
      start,
      list,
      { shuffle: false, repeat: 'one' },
      seeded(1),
      'skip',
    )!
    expect(currentOf(skipped)).toBe('t1')
  })

  it('undoes Next with Previous, in a shuffle as in order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        fc.integer(),
        fc.boolean(),
        (n, seed, shuffle) => {
          const list = ids(n)
          const random = seeded(seed)
          const start = startQueue(list, shuffle, random)
          const next = nextQueue(
            start,
            list,
            { shuffle, repeat: 'all' },
            random,
            'skip',
          )!
          const back = previousQueue(next)!
          expect(currentOf(back)).toBe(currentOf(start))
          // And Next again lands on the same track Previous left.
          const forward = nextQueue(
            back,
            list,
            { shuffle, repeat: 'all' },
            random,
            'skip',
          )!
          expect(currentOf(forward)).toBe(currentOf(next))
        },
      ),
    )
  })

  it('has nothing before the first track', () => {
    expect(previousQueue(startQueue(ids(3), false, seeded(1)))).toBeNull()
    expect(previousQueue(EMPTY_QUEUE)).toBeNull()
  })

  it('remembers no more than its history allows', () => {
    const list = ids(3)
    const heard = play(
      startQueue(list, false, seeded(1)),
      list,
      false,
      seeded(1),
      HISTORY * 2,
    )
    expect(heard.length).toBeGreaterThan(HISTORY)
    let queue: Queue | null = startQueue(list, false, seeded(1))
    for (let i = 0; i < HISTORY * 2; i += 1) {
      queue = nextQueue(
        queue!,
        list,
        { shuffle: false, repeat: 'all' },
        seeded(1),
        'ended',
      )
    }
    expect(queue!.played).toHaveLength(HISTORY)
  })

  it('does not replay a chosen track later in the same shuffle', () => {
    const list = ids(6)
    const random = seeded(5)
    const start = startQueue(list, true, random)
    const target = start.upcoming.at(-1)!
    const jumped = jumpQueue(start, list, true, target)
    expect(currentOf(jumped)).toBe(target)
    expect(jumped.upcoming).not.toContain(target)
  })

  it('continues in order from a chosen track', () => {
    const jumped = jumpQueue(
      startQueue(ids(5), false, seeded(1)),
      ids(5),
      false,
      't2',
    )
    expect(jumped.upcoming).toEqual(['t3', 't4'])
  })
})

describe('reconcileQueue', () => {
  it('keeps the current track and drops what was switched off', () => {
    const list = ids(5)
    const random = seeded(3)
    const start = startQueue(list, true, random)
    const current = currentOf(start)!
    const without = list.filter(
      (id) => id !== current && id !== start.upcoming[0],
    )
    const next = reconcileQueue(
      start,
      without,
      list,
      { shuffle: true, wasShuffled: true },
      random,
    )
    expect(currentOf(next)).toBe(current)
    expect(next.upcoming).not.toContain(start.upcoming[0])
    // Everything still enabled and still to come keeps its place in the draw.
    expect(next.upcoming).toEqual(
      start.upcoming.filter((id) => id !== start.upcoming[0]),
    )
  })

  it('adds a track switched on, and not one that already played this cycle', () => {
    const list = ids(4)
    const random = seeded(8)
    let queue = startQueue(list, true, random)
    queue = nextQueue(
      queue,
      list,
      { shuffle: true, repeat: 'all' },
      random,
      'ended',
    )!
    const playedEarlier = queue.played[0]!
    const grown = [...list, 't9']
    const next = reconcileQueue(
      queue,
      grown,
      list,
      { shuffle: true, wasShuffled: true },
      random,
    )
    expect(next.upcoming).toContain('t9')
    expect(next.upcoming).not.toContain(playedEarlier)
  })

  it('draws a fresh shuffle around the current track when shuffle is turned on', () => {
    const list = ids(6)
    const random = seeded(4)
    const ordered = startQueue(list, false, random, 't2')
    const next = reconcileQueue(
      ordered,
      list,
      list,
      { shuffle: true, wasShuffled: false },
      random,
    )
    expect(currentOf(next)).toBe('t2')
    expect([...next.upcoming].sort()).toEqual(list.filter((id) => id !== 't2'))
  })

  it('runs on in order from the current track’s new place', () => {
    const list = ids(5)
    const queue = startQueue(list, true, seeded(2), 't1')
    const rearranged = ['t3', 't1', 't0', 't4', 't2']
    expect(
      reconcileQueue(
        queue,
        rearranged,
        list,
        { shuffle: false, wasShuffled: true },
        seeded(2),
      ).upcoming,
    ).toEqual(['t0', 't4', 't2'])
  })
})

describe('moveTrack', () => {
  it('puts the track where it was dropped and keeps every other in order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.nat(),
        fc.integer({ min: -5, max: 50 }),
        (n, pick, to) => {
          const list = ids(n)
          const from = pick % n
          const moved = moveTrack(list, from, to)
          const landed = Math.min(n - 1, Math.max(0, to))
          expect(moved).toHaveLength(n)
          expect(new Set(moved)).toEqual(new Set(list))
          expect(moved[landed]).toBe(list[from])
          expect(moved.filter((id) => id !== list[from])).toEqual(
            list.filter((id) => id !== list[from]),
          )
        },
      ),
    )
  })

  it('leaves the list alone for a position it does not have', () => {
    const list = ids(4)
    expect(moveTrack(list, 7, 0)).toBe(list)
    expect(moveTrack(list, -1, 2)).toBe(list)
    expect(moveTrack(list, 2, 2)).toBe(list)
  })
})

describe('withMember', () => {
  it('stores one set as one value, however it was reached', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 12 }),
        fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c', 'd'), fc.boolean()), {
          minLength: 1,
        }),
        (start, steps) => {
          let list: readonly string[] = start
          const expected = new Set(start)
          for (const [member, on] of steps) {
            list = withMember(list, member, on)
            if (on) expected.add(member)
            else expected.delete(member)
          }
          expect(list).toEqual([...expected].sort())
        },
      ),
    )
  })
})
