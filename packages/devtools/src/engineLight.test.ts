import { describe, expect, it } from 'vitest'
import { TEST_CATALOG } from '@inertialref/universe'
import { openSession } from './session.ts'

/*
 * The overlay stance's verb. What a rig relies on is that the plume is the
 * drawn one alone: a stance lit for nine samples has to stand where it stood,
 * so lighting the drive and releasing it leave the world's state hash exactly
 * where it was, across ticks as well as at the call.
 */

function harness() {
  return openSession({
    seed: 'inertialref',
    catalog: TEST_CATALOG,
    workers: null,
  }).harness
}

describe('ir.lightEngine', () => {
  it('holds a throttle the host reads, and releases it', () => {
    const ir = harness()
    expect(ir.lightEngine.throttle).toBeNull()
    expect(ir.lightEngine()).toBe(1)
    expect(ir.lightEngine.throttle).toBe(1)
    expect(ir.lightEngine(0.4)).toBe(0.4)
    expect(ir.lightEngine(3)).toBe(1)
    expect(ir.lightEngine(-1)).toBe(0)
    expect(ir.lightEngine(false)).toBeNull()
    expect(ir.lightEngine.throttle).toBeNull()
    expect(() => ir.lightEngine(Number.NaN)).toThrow(/finite/)
  })

  it('leaves the simulation’s state hash where it was, lit and released', () => {
    const ir = harness()
    // The hash carries each entity's control input, so a held light that set
    // the real throttle would move it at the call, before any tick.
    const before = ir.world.stateHash()
    ir.lightEngine(true)
    expect(ir.world.stateHash()).toBe(before)
    // Ticks under a held light: the same as ticks with none.
    const control = harness()
    ir.step(64)
    control.step(64)
    expect(ir.world.stateHash()).toBe(control.world.stateHash())
    const lit = ir.world.stateHash()
    ir.lightEngine(false)
    expect(ir.world.stateHash()).toBe(lit)
  })
})
