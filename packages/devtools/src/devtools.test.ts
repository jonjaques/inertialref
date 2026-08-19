import { describe, expect, it } from 'vitest'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { formatAddress } from '@inertialref/universe'
import { runCapabilityChecks, summarizeCapabilities } from './capabilities.ts'
import type { GameHarness } from './harness.ts'
import { inspectWorld } from './inspect.ts'
import { openSession, type Session } from './session.ts'

function harness(): { harness: GameHarness; session: Session } {
  // The same call the browser client and the headless runner make. When these
  // three assembled a session independently they drifted — the client spawned
  // at 2.5 body radii and everything else at 3 — and no test could have seen it.
  const registry = createTaskRegistry()
  const session = openSession({
    seed: 'inertialref',
    workers: () => createInlineWorker(registry),
  })
  return { harness: session.harness, session }
}

describe('capability checks', () => {
  it('proves all twelve milestone capabilities', async () => {
    // This is the milestone's definition of done, executable. It runs in Node
    // here and in the browser through the harness, against the same code.
    const { harness: ir, session } = harness()
    const results = await runCapabilityChecks({ world: session.world, pool: null })
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

  it('reports on the loaded world, not the discarded one', () => {
    // The host's `world` must be a getter. With a captured reference the
    // harness kept inspecting the world that load had thrown away, which read
    // from outside as "load does nothing".
    const { harness: ir } = harness()
    const saved = ir.save()
    const savedHash = ir.status().world.stateHash
    ir.step(500)
    expect(ir.status().world.stateHash).not.toBe(savedHash)

    const result = ir.load(saved)
    expect(result.ok).toBe(true)
    expect(ir.status().world.stateHash).toBe(savedHash)
  })

  it('reports every field the spec asks to be inspectable', () => {
    const { session } = harness()
    const inspection = inspectWorld(session.world)
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

describe('landing through the harness', () => {
  /*
   * `ir.land()` used to assert landedness rather than achieve it: it teleported
   * the ship 3 m above the pad and passed `landed = true`. `stepFlight`
   * short-circuits to `stepLanded` for an entity that is already landed, so the
   * contact test never ran, nothing brought the ship down, and it hovered there
   * for the rest of the session while the overlay reported an altitude of 0.
   *
   * Landedness is a consequence of geometry now — `teleport` has no flag to set
   * — so the only way to be landed is to have actually touched the ground.
   */
  it('puts the ship on the pad, not hovering above it', () => {
    const { session } = harness()
    const player = session.player()
    if (player === null) throw new Error('no player')

    session.harness.land(formatAddress(session.target.address), 0.35, -1.1)
    // Not landed yet: the contact test decides, on the next tick.
    expect(session.world.isLanded(player)).toBe(false)

    session.world.runTicks(64)
    expect(session.world.isLanded(player)).toBe(true)

    // Local y in a surface frame is height above the pad, and the pad is what
    // the frame's origin is. Reporting 0 while sitting at 3 was the bug.
    const height = () => session.world.entities.require(player).state.position.y
    expect(height()).toBeCloseTo(0, 6)
    expect(session.world.altitudeOf(player)).toBe(0)

    // And it stays there rather than drifting or re-landing forever.
    session.world.runTicks(64 * 60)
    expect(height()).toBeCloseTo(0, 6)
    expect(session.world.isLanded(player)).toBe(true)
  })
})
