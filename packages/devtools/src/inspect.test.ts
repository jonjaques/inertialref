import { describe, expect, it, vi } from 'vitest'
import * as simulation from '@inertialref/simulation'
import { ROOT_FRAME, vec3 } from '@inertialref/spatial'
import { bodyFrameId, parseAddress, TEST_CATALOG } from '@inertialref/universe'
import { inspectWorld } from './inspect.ts'
import { openSession, type Session } from './session.ts'

/*
 * The status sample's cost, held where it shows.
 *
 * The overlay samples `status()` at 8 Hz, and `inspectWorld` inspects every
 * entity. Each inspection reads its entity through `entitySnapshot`, which
 * resolves that entity's own frame chain; a world snapshot poses every loaded
 * body — 129 with the catalog — and building one per entity is garbage the
 * overlay produces eight times a second for nothing.
 */

vi.mock('@inertialref/simulation', async (original) => {
  const actual = await original<typeof simulation>()
  return {
    ...actual,
    snapshot: vi.fn(actual.snapshot),
    entitySnapshot: vi.fn(actual.entitySnapshot),
  }
})

const MARS = 'g:milky-way/s:SOL/b:3'
const EARTH = 'g:milky-way/s:SOL/b:2'

/** A session with ships in three frames, moving, a few ticks in. */
function crowded(): Session {
  const session = openSession({ seed: 'inertialref', catalog: TEST_CATALOG })
  const { world } = session
  world.spawnShip(
    'Mars orbiter',
    bodyFrameId(parseAddress(MARS)),
    vec3(5_000_000, 0, 0),
    vec3(0, 0, 3_000),
  )
  world.spawnShip(
    'Earth orbiter',
    bodyFrameId(parseAddress(EARTH)),
    vec3(0, 7_000_000, 0),
    vec3(7_500, 0, 0),
  )
  world.spawnShip('Drifter', ROOT_FRAME, vec3(1, 2, 3), vec3(10, 0, 0))
  session.harness.step(8)
  // Counted from here: stepping draws its own frames.
  vi.mocked(simulation.snapshot).mockClear()
  vi.mocked(simulation.entitySnapshot).mockClear()
  return session
}

describe('inspection', () => {
  it('reads each entity exactly as the world snapshot lists it', () => {
    const session = crowded()
    const { world } = session
    expect(world.entities.size).toBeGreaterThanOrEqual(4)
    const listed = simulation.snapshot(world, 0).entities
    const ordered = world.entities.ordered()
    expect(listed).toHaveLength(ordered.length)
    for (const [index, entity] of ordered.entries())
      expect(simulation.entitySnapshot(world, entity, 0)).toEqual(listed[index])
    session.dispose()
  })

  it('builds no world snapshot per inspectWorld, and one view per entity', () => {
    const session = crowded()
    const count = session.world.entities.size
    const inspection = inspectWorld(session.world)
    expect(inspection.entities).toHaveLength(count)
    // Nothing in an inspection needs a body it is not inside.
    expect(simulation.snapshot).toHaveBeenCalledTimes(0)
    expect(simulation.entitySnapshot).toHaveBeenCalledTimes(count)
    session.dispose()
  })

  it('inspects the player once per status sample, as the list has it', () => {
    const session = crowded()
    const count = session.world.entities.size
    const status = session.harness.status()
    expect(simulation.snapshot).toHaveBeenCalledTimes(0)
    expect(simulation.entitySnapshot).toHaveBeenCalledTimes(count)
    expect(status.player).not.toBeNull()
    expect(status.player).toBe(
      status.world.entities.find((entry) => entry.id === session.player()),
    )
    // The listed record is the one a direct inspection produces.
    expect(session.harness.inspect()).toEqual(status.player)
    session.dispose()
  })
})
