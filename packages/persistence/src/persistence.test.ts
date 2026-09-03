import { describe, expect, it } from 'vitest'
import { expect as unwrap } from '@inertialref/shared'
import { SAVE_SCHEMA_VERSION } from '@inertialref/protocol'
import { UV, Vec, vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import {
  bodyFrameId,
  systemFrameId,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import { migrateSave } from './migrate.ts'
import { captureSave, parseSave, restoreSave, serializeSave } from './save.ts'
import { MemorySaveStore } from './store.ts'

const SOL = systemId('SOL')

function flownWorld(ticks = 500) {
  const world = new World({ seed: 'inertialref' })
  const system = world.loadSystem(SOL)
  const planet = [...walkBodies(system)].find(
    (b) => b.kind === 'rocky' && b.radius > 1e6,
  )
  if (planet === undefined) throw new Error('no planet')
  const ship = world.spawnShip(
    'Debug One',
    bodyFrameId(planet.address),
    vec3(planet.radius * 3, 0, 0),
    vec3(0, 0, -3_000),
  )
  world.setControl(ship.id, vec3(0, 0, 0.4), vec3(0, 0.1, 0))
  world.runTicks(ticks)
  return { world, ship, planet }
}

describe('save round trip', () => {
  it('restores a universe that continues identically', () => {
    // The claim this test makes is the whole persistence model: what is stored
    // is a reference, what comes back is regenerated, and the two are the same
    // universe down to the state hash.
    const { world, ship } = flownWorld()
    const before = world.stateHash()
    const save = captureSave(world, ship.id)

    const restored = unwrap(restoreSave(save), 'restore')
    expect(restored.world.stateHash()).toBe(before)
    expect(restored.playerEntity).toBe(ship.id)

    // ...and they stay in step when both are stepped further.
    world.runTicks(300)
    restored.world.runTicks(300)
    expect(restored.world.stateHash()).toBe(world.stateHash())
  })

  it('restores a coasting ship onto the same conic, to the bit', () => {
    /*
     * The epoch is canonical (ADR-0025): a world that dropped it and
     * re-anchored on load would follow a marginally different rounding of the
     * same orbit, and three hundred jumped ticks later the hashes would part.
     */
    const { world, ship } = flownWorld()
    // Hands off, and the drive is the only thing keeping it off the rails.
    world.setControl(ship.id, Vec.ZERO, Vec.ZERO)
    world.runTicks(64)
    expect(world.isCoasting(ship.id)).toBe(true)
    const save = captureSave(world, ship.id)
    expect(save.entities[0]?.rails).not.toBeNull()

    const restored = unwrap(restoreSave(save), 'restore')
    expect(restored.world.isCoasting(ship.id)).toBe(true)
    expect(restored.world.stateHash()).toBe(world.stateHash())
    world.runTicks(300)
    restored.world.runTicks(300)
    expect(restored.world.stateHash()).toBe(world.stateHash())
  })

  it('continues a descent from a save the way it continues from a cache', () => {
    /*
     * The reuse invariant, from the only side that can see it.
     *
     * An integrated tick samples the ground under where it *ends up*, at the
     * instant it gets there, and the next tick takes that number instead of
     * sampling again — the two are the same question, so the answer is reused
     * rather than recomputed. A restored world has no such cache and samples
     * fresh on its first tick, so these two worlds agree only if the reuse is
     * exact. Deep inside an atmosphere, where altitude drives the drag term
     * and therefore the trajectory, a disagreement of one tick's worth of the
     * planet's motion compounds into the hash within a few hundred ticks.
     *
     * This is what catches the post-step tests being asked at the tick's
     * *start* while holding the state from its end: seven meters of ground
     * rotation under a landing, 470 m of orbital motion at a sphere crossing,
     * and nothing else in the suite goes red for either.
     */
    const world = new World({ seed: 'inertialref' })
    const system = world.loadSystem(SOL)
    const planet = [...walkBodies(system)].find(
      (body) =>
        body.kind === 'rocky' && body.radius > 1e6 && body.atmosphere !== null,
    )
    if (planet === undefined) throw new Error('no planet with air')

    // Well inside the air, descending: the drag term reads the altitude every
    // tick, so the sampled ground is in the trajectory rather than beside it.
    const entry = planet.radius + (planet.atmosphere?.scaleHeight ?? 0)
    const ship = world.spawnShip(
      'entry',
      bodyFrameId(planet.address),
      vec3(entry, 0, 0),
    )
    world.teleport(ship.id, {
      ...world.entities.require(ship.id).state,
      velocity: vec3(-120, 0, 900),
    })
    world.runTicks(120)
    // Cached: this tick's post-step sample is next tick's pre-step altitude.
    const save = captureSave(world, ship.id)

    const restored = unwrap(restoreSave(save), 'restore')
    expect(restored.world.stateHash()).toBe(world.stateHash())

    // The restored world samples fresh where the original reuses. Same answer,
    // or the reuse was never the same question.
    world.runTicks(400)
    restored.world.runTicks(400)
    expect(restored.world.stateHash()).toBe(world.stateHash())
  })

  it('stores a reference to the universe, not the universe', () => {
    const { world, ship } = flownWorld(60)
    const text = serializeSave(captureSave(world, ship.id))
    // One ship, one system id, one seed. A save that grew with the size of the
    // universe would be the failure mode this design exists to avoid.
    expect(text.length).toBeLessThan(2_000)
    expect(text).toContain('"SOL"')
    expect(text).not.toContain('elevations')
    expect(JSON.parse(text).entities).toHaveLength(1)
  })

  it('regenerates a surface frame for a landed ship', () => {
    const world = new World({ seed: 'inertialref' })
    const system = world.loadSystem(SOL)
    const planet = [...walkBodies(system)].find(
      (b) => b.kind === 'rocky' && b.atmosphere !== null,
    )
    if (planet === undefined) throw new Error('no landable planet')
    const ship = world.spawnShip(
      'Lander',
      bodyFrameId(planet.address),
      vec3(planet.radius + 30, 0, 0),
      vec3(-2, 0, 0),
    )
    for (let i = 0; i < 60_000 && !world.isLanded(ship.id); i += 1) world.step()
    expect(world.isLanded(ship.id)).toBe(true)

    const before = world.canonicalPositionOf(ship.id)
    const restored = unwrap(restoreSave(captureSave(world, ship.id)), 'restore')
    // The surface frame did not exist in the fresh world; it was rebuilt from
    // the frame id, and terrain being a pure function of the seed is what makes
    // that land in exactly the same place.
    expect(restored.world.isLanded(ship.id)).toBe(true)
    expect(
      UV.distance(restored.world.canonicalPositionOf(ship.id), before),
    ).toBeLessThan(1e-3)
  })

  it('survives a trip through text', () => {
    const { world, ship } = flownWorld(120)
    const parsed = unwrap(
      parseSave(serializeSave(captureSave(world, ship.id))),
      'parse',
    )
    expect(parsed.schemaVersion).toBe(SAVE_SCHEMA_VERSION)
    expect(unwrap(restoreSave(parsed), 'restore').world.stateHash()).toBe(
      world.stateHash(),
    )
  })

  it('goes through a store', async () => {
    // Serialize, store, read, parse, restore — the path the game actually takes.
    // `writeSave`/`readSave` used to wrap this pair, and their only callers were
    // this test: they took a `SaveGame` while every production path (browser,
    // headless runner, harness) works in serialized text, so two APIs existed
    // for one job and the shipped one was the untested one.
    const store = new MemorySaveStore()
    const { world, ship } = flownWorld(90)

    unwrap(
      await store.write('slot-1', serializeSave(captureSave(world, ship.id))),
      'write',
    )
    expect(await store.list()).toEqual(['slot-1'])

    const contents = unwrap(await store.read('slot-1'), 'read')
    const loaded = unwrap(parseSave(contents), 'parse')
    expect(unwrap(restoreSave(loaded), 'restore').world.stateHash()).toBe(
      world.stateHash(),
    )

    expect((await store.read('missing')).ok).toBe(false)

    await store.remove('slot-1')
    expect(await store.list()).toEqual([])
  })
})

describe('migrations', () => {
  it('runs the chain from the oldest shape', () => {
    const v0 = {
      schemaVersion: 0,
      seed: 'inertialref',
      tick: 42,
      ship: {
        id: '#0',
        kind: 'ship',
        name: 'Old Faithful',
        state: {
          frame: 's:SOL',
          position: [1, 2, 3],
          orientation: [0, 0, 0, 1],
          velocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        },
        mass: 40_000,
        landed: false,
        hasThrusters: true,
        ballisticCoefficient: 320,
      },
      loadedSystems: ['SOL'],
    }
    const migrated = unwrap(migrateSave(v0), 'migrate')
    expect(migrated['schemaVersion']).toBe(SAVE_SCHEMA_VERSION)
    const save = unwrap(parseSave(JSON.stringify(v0)), 'parse')
    expect(save.entities).toHaveLength(1)
    expect(save.playerEntity).toBe('#0')
    expect(save.meta['migratedFrom']).toBe('v0')
    // And it actually loads.
    const restored = unwrap(restoreSave(save), 'restore')
    expect(restored.world.clock.tick).toBe(42)
    expect(restored.world.entities.size).toBe(1)
  })

  it('refuses a save from a newer build rather than dropping its state', () => {
    const future = migrateSave({ schemaVersion: SAVE_SCHEMA_VERSION + 5 })
    expect(future.ok).toBe(false)
    if (!future.ok) expect(future.error).toMatch(/newer than this build/)
  })

  it('rejects corrupt data at the boundary', () => {
    expect(parseSave('not json').ok).toBe(false)
    expect(parseSave('[]').ok).toBe(false)
    const badFrame = parseSave(
      JSON.stringify({
        schemaVersion: 1,
        seed: 's',
        galaxy: 'milky-way',
        tick: 0,
        generation: {},
        entities: [
          {
            id: '#0',
            kind: 'ship',
            name: 'x',
            state: {
              frame: 's:SOL',
              position: [1, 2],
              orientation: [0, 0, 0, 1],
              velocity: [0, 0, 0],
              angularVelocity: [0, 0, 0],
            },
            mass: 1,
            landed: false,
            hasThrusters: false,
            ballisticCoefficient: 1,
          },
        ],
        playerEntity: '#0',
        dynamicIdCounter: 1,
        loadedSystems: [],
      }),
    )
    expect(badFrame.ok).toBe(false)
  })

  it('reports a save that refers to a frame it cannot rebuild', () => {
    const save = unwrap(
      parseSave(
        JSON.stringify({
          schemaVersion: 1,
          seed: 'inertialref',
          galaxy: 'milky-way',
          tick: 0,
          generation: {},
          entities: [
            {
              id: '#0',
              kind: 'ship',
              name: 'ghost',
              state: {
                frame: 'b:g:milky-way/s:SOL/b:0',
                position: [1, 2, 3],
                orientation: [0, 0, 0, 1],
                velocity: [0, 0, 0],
                angularVelocity: [0, 0, 0],
              },
              mass: 1,
              landed: false,
              hasThrusters: false,
              ballisticCoefficient: 1,
            },
          ],
          playerEntity: '#0',
          dynamicIdCounter: 1,
          // SOL deliberately not listed, so the frame cannot exist.
          loadedSystems: [],
        }),
      ),
      'parse',
    )
    const restored = restoreSave(save)
    expect(restored.ok).toBe(false)
    if (!restored.ok) expect(restored.error).toMatch(/does not exist/)
  })
})

describe('the universe a save was written against', () => {
  /*
   * A save records two manifests — the generation versions and the catalog
   * version — and until `versionDrift` existed nothing compared them. The
   * loader could only mention them while building the message for a load that
   * had already failed, so the interesting case had nowhere to be reported: the
   * load *worked*, and it is not the same sky.
   */

  it('reports a moved catalog on a load that succeeded', () => {
    const { world, ship } = flownWorld(50)
    const save = { ...captureSave(world, ship.id), catalog: 'hyg-4.4' }

    const restored = unwrap(restoreSave(save), 'restore')
    // It loaded. Sol resolves under any catalog, the entities spawned, and the
    // state hash is the one that was saved — which is exactly why a silent
    // success here is the failure mode worth catching.
    expect(restored.world.stateHash()).toBe(world.stateHash())
    expect(restored.drift).toEqual([
      { key: 'catalog', ours: 'hyg-4.4', theirs: 'sol-only' },
    ])
  })

  it('reports a generation algorithm this build has never heard of', () => {
    // Not ignored. A generator the save ran and this build does not is a
    // universe this build cannot derive, and the reverse is the same thing.
    const { world, ship } = flownWorld(50)
    const captured = captureSave(world, ship.id)
    const save = {
      ...captured,
      generation: { ...captured.generation, weather: 1 },
    }
    const restored = unwrap(restoreSave(save), 'restore')
    expect(restored.drift.map((one) => one.key)).toContain('weather')
    expect(restored.drift).toContainEqual({
      key: 'weather',
      ours: 1,
      theirs: undefined,
    })
  })

  it('says nothing at all when the save is from this build', () => {
    const { world, ship } = flownWorld(50)
    const restored = unwrap(restoreSave(captureSave(world, ship.id)), 'restore')
    expect(restored.drift).toEqual([])
    expect(restored.catalog).toBe(restored.world.catalog.version)
  })
})

describe('velocity survives the trip', () => {
  it('preserves motion exactly, not approximately', () => {
    const { world, ship } = flownWorld(200)
    const before = world.entities.require(ship.id).state
    const restored = unwrap(restoreSave(captureSave(world, ship.id)), 'restore')
    const after = restored.world.entities.require(ship.id).state
    // A save that shifted velocity by an ULP per load would drift a ship out of
    // its orbit over a few dozen reloads.
    expect(Vec.equals(after.velocity, before.velocity)).toBe(true)
    expect(Vec.equals(after.position, before.position)).toBe(true)
    expect(after.frame).toBe(before.frame)
    expect(restored.world.loadedSystems().map((s) => s.id)).toContain(SOL)
    expect(systemFrameId(SOL)).toBeTruthy()
  })
})
