import { afterEach, describe, expect, it } from 'vitest'
import {
  createInlineWorker,
  createTaskRegistry,
  poolHeightfieldSource,
} from '@inertialref/workers'
import { findBody, parseAddress, surveySites } from '@inertialref/universe'
import { descentRegions } from './descent.ts'
import { openSession, type Session } from './session.ts'
import {
  baselineAddresses,
  summarizeBaseline,
  terrainBaseline,
  terrainBaselineWithSource,
} from './terrainBaseline.ts'
import { terrainZoo } from './terrainZoo.ts'

/*
 * The baseline against a live world, generation and all.
 *
 * `terrainRig.test.ts` proves the zoo and the descent; this proves the report
 * built over them — that the untimed pass generates nothing and says so, that
 * a clock turns the warm-up and the timed slice into a figure, and that a
 * host's asynchronous source is measured over the same selections.
 *
 * The zoo is narrowed to eight light years and one generated system. That
 * still finds every archetype — Sol supplies the two icy ones and the first
 * generated system, `Q0_223_6_0_0`, the two rocky ones — and it is the
 * narrowest search that does: at five light years the zoo is Sol's three and
 * comes back short of `rocky-airless`.
 */
const ZOO = { lightYears: 8, systemBudget: 1 } as const

/*
 * Eight descent steps rather than the profile's 128.
 *
 * The last step of a descent is on the ground whatever the count, so the floor
 * each site reaches does not depend on it; what the count buys is the shape of
 * the approach, which `terrainRig.test.ts` asks about. At 128 the untimed pass
 * over this zoo takes 8 to 12 s on its own; at eight it is
 * under a second, and every descent still asks for thousands of regions.
 */
const STEPS = 8

/*
 * The timed passes search Sol alone and generate 9×9 patches.
 *
 * Sol alone is three of the four archetypes, which is enough to time; the
 * archetypes are the untimed test's question. The resolution is the cost: the
 * warm-up is twelve patches a body whatever `timedPatches` says, and at the
 * default 65×65 the two timed passes generate 75 of them in 11 s. At 9×9 they
 * are under a second, and a figure the counting clock makes 1 ms either way.
 */
const TIMED = {
  lightYears: 0,
  systemBudget: 0,
  steps: 2,
  resolution: 9,
} as const

/** Two calls per `measurePatchGeneration`, so every slice reads as 1 ms. */
const counting = (): (() => number) => {
  let tick = 0
  return () => tick++
}

const open: Session[] = []

afterEach(() => {
  for (const session of open.splice(0)) session.dispose()
})

const bodyAt = (world: Session['world'], address: string) => {
  const parsed = parseAddress(address)
  if (parsed.kind !== 'body') throw new Error(`${address} is not a body`)
  const body = findBody(world.loadSystem(parsed.system), parsed.body)
  if (body === undefined) throw new Error(`no body at ${address}`)
  return body
}

function session(options: Parameters<typeof openSession>[0]): Session {
  const opened = openSession(options)
  open.push(opened)
  return opened
}

describe('the terrain baseline', () => {
  it('flies every site without a clock and generates nothing', () => {
    const { world } = session({ seed: 'inertialref', workers: null })
    const baseline = terrainBaseline(world, null, { ...ZOO, steps: STEPS })

    expect(baseline.timed).toBe(false)
    expect(baseline.missing).toEqual([])
    expect(baseline.source).toBeUndefined()
    expect(baselineAddresses(baseline)).toEqual(
      terrainZoo(world, ZOO).map((entry) => entry.address),
    )
    expect(baseline.entries.length).toBeGreaterThan(0)
    for (const entry of baseline.entries) {
      expect(entry.generation.patches).toBe(0)
      expect(entry.generation.totalMs).toBe(0)
      expect(entry.sites.map((site) => site.id)).toEqual(
        surveySites(bodyAt(world, entry.zoo.address)).map((site) => site.id),
      )
      for (const site of entry.sites) {
        expect(site.steps).toBe(STEPS)
        expect(site.floorLevel).toBeGreaterThan(0)
        expect(site.finalLevel).toBeGreaterThanOrEqual(site.floorLevel)
      }
    }

    const text = summarizeBaseline(baseline)
    expect(text).toContain('not timed — the host supplied no clock')
    expect(text).not.toContain('SHORT OF THE FLOOR')
    expect(text).not.toContain('MISSING ARCHETYPES')
  })

  it('times the slice after the warm-up, and names a slice of nothing', () => {
    /*
     * Both `summarizeBaseline` branches from a clock. No descent asks for
     * fewer regions than the twelve the warm-up discards: `simulateDescent`
     * flies at least two steps, and two steps over Sol ask for 690 (Miranda)
     * to 786 (Iapetus). The bound is the warm-up and the default slice of
     * forty-eight, what the module needs, rather than a count a body's ground
     * moves. A timed slice of zero patches is the same `g.patches === 0` a
     * profile that short would produce, reached through the module's own
     * option.
     */
    const { world } = session({ seed: 'inertialref', workers: null })
    const one = terrainBaseline(world, counting(), {
      ...TIMED,
      timedPatches: 1,
    })
    expect(one.timed).toBe(true)
    expect(one.resolution).toBe(TIMED.resolution)
    expect(one.entries.length).toBeGreaterThan(0)
    for (const entry of one.entries) {
      expect(descentRegions(entry.descent).length).toBeGreaterThan(12 + 48)
      expect(entry.generation.patches).toBe(1)
      expect(entry.generation.totalMs).toBe(1)
      expect(entry.generation.msPerPatch).toBe(1)
    }
    const timed = summarizeBaseline(one)
    expect(timed).toContain('generation: 1.00 ms/patch over 1 patches')
    expect(timed).not.toContain('not timed')

    const none = terrainBaseline(world, counting(), {
      ...TIMED,
      timedPatches: 0,
    })
    expect(none.timed).toBe(true)
    for (const entry of none.entries) expect(entry.generation.patches).toBe(0)
    const empty = summarizeBaseline(none)
    expect(empty).toContain('not timed — the descent asked for too few patches')
    expect(empty).not.toContain('ms/patch')
  })

  it('measures a host source over the same selections', async () => {
    const registry = createTaskRegistry()
    const live = session({
      seed: 'inertialref',
      workers: () => createInlineWorker(registry),
    })
    const pool = live.pool()
    if (pool === null) throw new Error('the inline pool did not start')
    const baseline = await terrainBaselineWithSource(
      live.world,
      counting(),
      poolHeightfieldSource(pool),
      { ...TIMED, timedPatches: 1 },
    )

    expect(baseline.source).toBe('pool')
    expect(baseline.timed).toBe(true)
    expect(baselineAddresses(baseline)).toEqual(
      terrainZoo(live.world, TIMED).map((entry) => entry.address),
    )
    for (const entry of baseline.entries) {
      expect(entry.generation.resolution).toBe(TIMED.resolution)
      expect(entry.generation.patches).toBe(1)
      expect(entry.generation.totalMs).toBe(1)
    }
    expect(summarizeBaseline(baseline)).toContain(
      'tile delivery (pool): 1.00 ms/patch over 1 patches',
    )
  })
})
