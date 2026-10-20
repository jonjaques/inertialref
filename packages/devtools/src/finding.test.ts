import { describe, expect, it } from 'vitest'
import { LIGHT_YEAR } from '@inertialref/shared'
import { UV } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import { systemId, TEST_CATALOG } from '@inertialref/universe'
import type { WorkerPool } from '@inertialref/workers'
import {
  boundedTravelRadius,
  findWorlds,
  hereOf,
  nearbyTargets,
  rowsFor,
  searchByName,
  systemsNearby,
  type Vantage,
} from './finding.ts'
import { openSession } from './session.ts'

/** Sirius, 8.6 ly out: far enough that a listing from it is another listing. */
const SIRIUS = 'HIP32349'

/** A ship over Earth, and the vantage a search is asked from. */
function vantage(observer: 'sirius' | null = null): Vantage {
  const session = openSession({
    seed: 'inertialref',
    catalog: TEST_CATALOG,
    workers: null,
  })
  return {
    world: session.world,
    player: session.player(),
    observer:
      observer === null
        ? null
        : session.world.loadSystem(systemId(SIRIUS)).position,
  }
}

describe('where a search is asked from', () => {
  it('is the player, or the first system loaded when there is none', () => {
    const { world, player } = vantage()
    expect(hereOf(world, player)).toEqual(world.canonicalPositionOf(player!))
    expect(hereOf(world, null)).toEqual(world.loadedSystems()[0]!.position)
    const empty = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
    expect(hereOf(empty, null)).toEqual(UV.UNIVERSE_ORIGIN)
  })

  it('is the planetarium’s eye only when the question says so', () => {
    const there = vantage('sirius')
    const fromShip = searchByName(there, 'sol')[0]!
    const fromEye = searchByName(there, 'sol', { origin: 'observer' })[0]!
    expect(fromShip.distance / LIGHT_YEAR).toBeLessThan(0.01)
    expect(fromEye.distance / LIGHT_YEAR).toBeGreaterThan(8)
    expect(fromEye.distance / LIGHT_YEAR).toBeLessThan(9)
  })

  it('falls back to the ship when the eye holds nothing yet', () => {
    const here = vantage()
    expect(nearbyTargets(here, { lightYears: 1, origin: 'observer' })).toEqual(
      nearbyTargets(here, { lightYears: 1 }),
    )
  })
})

describe('the travel radius', () => {
  it('is light-years in, meters out, inside 0 to 500', () => {
    expect(boundedTravelRadius(10)).toBe(10 * LIGHT_YEAR)
    expect(boundedTravelRadius(0)).toBe(0)
    expect(boundedTravelRadius(500)).toBe(500 * LIGHT_YEAR)
    expect(boundedTravelRadius(600)).toBe(500 * LIGHT_YEAR)
    expect(boundedTravelRadius(-3)).toBe(0)
    expect(boundedTravelRadius(Number.NaN)).toBe(0)
    expect(boundedTravelRadius(Infinity)).toBe(500 * LIGHT_YEAR)
  })
})

describe('the near questions', () => {
  it('systemsNearby is nearest first, from the ship, Sol at the head', () => {
    const near = systemsNearby(vantage('sirius'), 10)
    expect(near[0]?.id).toBe('SOL')
    expect(near[0]!.lightYears).toBeLessThan(0.01)
    for (let i = 1; i < near.length; i += 1)
      expect(near[i]!.lightYears).toBeGreaterThanOrEqual(
        near[i - 1]!.lightYears,
      )
    expect(near.map((s) => s.id)).toContain(SIRIUS)
    expect(near.every((s) => s.lightYears <= 10)).toBe(true)
  })

  it('nearbyTargets from the eye starts at the star the eye is on', () => {
    const rows = nearbyTargets(vantage('sirius'), {
      lightYears: 1,
      origin: 'observer',
    })
    expect(rows[0]?.address).toBe(`g:milky-way/s:${SIRIUS}`)
  })

  it('rowsFor keeps the caller’s order, resolves relative forms, drops strangers', () => {
    const rows = rowsFor(vantage(), ['b:2', SIRIUS, 'b:99', 'SOL'])
    expect(rows.map((row) => row.name)).toEqual(['Earth', 'Sirius', 'Sol'])
  })
})

describe('sweeping the volume', () => {
  it('keeps the nearest under the cap and counts the rest', async () => {
    const totals: number[] = []
    const progress: number[] = []
    const sweep = findWorlds(
      vantage(),
      null,
      {},
      {
        lightYears: 12,
        limit: 3,
        onBatch: (_, done, total) => {
          progress.push(done)
          totals.push(total)
        },
      },
    )
    expect(sweep.systems).toBeGreaterThan(1)
    const found = await sweep.done
    expect(found).toHaveLength(3)
    for (let i = 1; i < found.length; i += 1)
      expect(found[i]!.lightYears).toBeGreaterThanOrEqual(
        found[i - 1]!.lightYears,
      )
    expect(totals.at(-1)).toBeGreaterThan(3 * 2)
    expect(progress.at(-1)).toBe(1)
  })

  it('is asked from the eye when there is one, whatever the origin option', async () => {
    const found = await findWorlds(
      vantage('sirius'),
      null,
      {},
      { lightYears: 1 },
    ).done
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((one) => one.address.includes(SIRIUS))).toBe(true)
  })

  it('stops an inline sweep that is canceled while it answers', async () => {
    let batches = 0
    const sweep = findWorlds(
      vantage(),
      null,
      {},
      {
        lightYears: 20,
        onBatch: () => {
          batches += 1
          sweep.cancel()
        },
      },
    )
    expect(Math.ceil(sweep.systems / 32)).toBeGreaterThan(1)
    await sweep.done
    expect(batches).toBe(1)
  })

  it('counts a failed batch as a gap rather than failing the search', async () => {
    const canceled: number[] = []
    const failing = {
      submit: () => ({
        result: Promise.reject(new Error('worker lost')),
        cancel: () => canceled.push(1),
      }),
    } as unknown as WorkerPool
    let batches = 0
    const sweep = findWorlds(
      vantage(),
      failing,
      {},
      { lightYears: 20, onBatch: () => (batches += 1) },
    )
    await expect(sweep.done).resolves.toEqual([])
    expect(batches).toBe(0)
    sweep.cancel()
    expect(canceled.length).toBe(Math.ceil(sweep.systems / 32))
  })
})
