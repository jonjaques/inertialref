import { describe, expect, it } from 'vitest'
import { createInlineWorker, createTaskRegistry, WorkerPool } from '@inertialref/workers'
import { vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import { bodyFrameId, systemId, walkBodies } from '@inertialref/universe'
import { runCapabilityChecks, summarizeCapabilities } from './capabilities.ts'
import { GameHarness, type HarnessHost } from './harness.ts'
import { inspectWorld } from './inspect.ts'

function harness(): { harness: GameHarness; world: World; host: HarnessHost } {
  const world = new World({ seed: 'inertialref' })
  const system = world.loadSystem(systemId('SOL'))
  const planet = [...walkBodies(system)].find((b) => b.kind === 'rocky' && b.radius > 1e6)
  if (planet === undefined) throw new Error('no planet')
  let player = world.spawnShip('Debug One', bodyFrameId(planet.address), vec3(planet.radius * 3, 0, 0)).id
  const registry = createTaskRegistry()
  const pool = new WorkerPool({ factory: () => createInlineWorker(registry), size: 2 })
  const host: HarnessHost = {
    world,
    player: () => player,
    setPlayer: (id) => {
      player = id
    },
    scene: () => null,
    pool: () => pool,
    frameStats: () => null,
    replaceWorld: () => {},
  }
  return { harness: new GameHarness(host), world, host }
}

describe('capability checks', () => {
  it('proves all twelve milestone capabilities', async () => {
    // This is the milestone's definition of done, executable. It runs in Node
    // here and in the browser through the harness, against the same code.
    const { harness: ir, world } = harness()
    const results = await runCapabilityChecks({ world, pool: null })
    const failed = results.filter((r) => !r.passed)
    expect(summarizeCapabilities(results).split('\n')[0]).toBe('12/12 capabilities proven')
    expect(failed).toEqual([])
    expect(results).toHaveLength(12)
    expect(ir.summary()).toContain('tick')
  }, 30_000)

  it('runs the same checks through a worker pool', async () => {
    const { harness: ir } = harness()
    const report = await ir.selfTest()
    expect(report.passed).toBe(12)
    // Check 10 must genuinely have used the pool this time.
    expect(report.results[9]?.detail).toContain('in a worker')
  }, 30_000)
})

describe('harness', () => {
  it('drives the simulation deterministically', () => {
    const { harness: ir } = harness()
    const before = ir.status().world.stateHash
    ir.step(100)
    const after = ir.status().world.stateHash
    expect(after).not.toBe(before)

    const other = harness().harness
    other.step(100)
    expect(other.status().world.stateHash).toBe(after)
  })

  it('places the ship in an orbit that holds', () => {
    const { harness: ir } = harness()
    const target = ir.bodies()[0]
    if (target === undefined) throw new Error('no bodies')
    ir.orbit(target.address, 500)
    const start = ir.inspect()?.local
    ir.step(64 * 120)
    const end = ir.inspect()?.local
    const startRadius = Math.hypot(start?.x ?? 0, start?.y ?? 0, start?.z ?? 0)
    const endRadius = Math.hypot(end?.x ?? 0, end?.y ?? 0, end?.z ?? 0)
    expect(endRadius / startRadius).toBeCloseTo(1, 2)
  })

  it('parks the ship on the ground and keeps it there', () => {
    const { harness: ir } = harness()
    const target = ir.bodies().find((b) => b.kind === 'rocky')
    if (target === undefined) throw new Error('no rocky body')
    ir.land(target.address, 0.3, -0.8)
    ir.step(64 * 30)
    const player = ir.inspect()
    expect(player?.landed).toBe(true)
    expect(player?.frame.startsWith('sf:')).toBe(true)
    // Still on the ground relative to its own frame...
    expect(player?.localSpeed).toBe(0)
    // ...while carrying the planet's orbital motion in universe axes.
    expect(player?.speed).toBeGreaterThan(1_000)
  })

  it('round-trips a save through the harness', () => {
    const { harness: ir } = harness()
    ir.step(200)
    const text = ir.save()
    const parsed = JSON.parse(text)
    expect(parsed.seed).toBe('inertialref')
    expect(parsed.entities).toHaveLength(1)
  })

  it('reports every field the spec asks to be inspectable', () => {
    const { world } = harness()
    const inspection = inspectWorld(world)
    expect(inspection.seed).toBe('inertialref')
    expect(inspection.seedHex).toHaveLength(32)
    expect(inspection.stateHash).toHaveLength(8)
    const entity = inspection.entities[0]
    expect(entity?.canonical.sector).toHaveLength(3)
    expect(entity?.frameChain[0]).toBe('universe')
    expect(entity?.partition).toBe('s:SOL')
    expect(JSON.stringify(inspection).length).toBeGreaterThan(100)
  })

  it('lists scenarios and refuses unknown ones', async () => {
    const { harness: ir } = harness()
    expect(ir.scenarios()).toContain('surface')
    await expect(ir.scenario('nonsense')).rejects.toThrow(/Unknown scenario/)
    const result = await ir.scenario('surface')
    expect(result.status.player?.landed).toBe(true)
  }, 20_000)
})
