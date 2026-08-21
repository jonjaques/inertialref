import { describe, expect, it } from 'vitest'
import { AU, err, ok } from '@inertialref/shared'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import type { AuthorityPort, ClientHello } from '@inertialref/net'
import {
  bodyFrameId,
  formatAddress,
  parseAddress,
  partitionForAddress,
  type PartitionKey,
  systemAddress,
  systemFrameId,
  systemId,
  TEST_CATALOG,
  walkBodies,
  type EntityId,
} from '@inertialref/universe'
import { Quaternion as Q, UV, Vec, vec3 } from '@inertialref/spatial'
import { runCapabilityChecks, summarizeCapabilities } from './capabilities.ts'
import { canHoldOrbit } from './travel.ts'
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
    // The catalogue is a generation input, so a session without one is a
    // different universe — one containing Sol and nothing else that is real.
    // The fixture is five stars rather than 7,123, which is enough for every
    // assertion here and does not make these tests depend on a built asset.
    catalog: TEST_CATALOG,
  })
  return { harness: session.harness, session }
}

describe('capability checks', () => {
  it('proves all twelve milestone capabilities', async () => {
    // This is the milestone's definition of done, executable. It runs in Node
    // here and in the browser through the harness, against the same code.
    const { harness: ir, session } = harness()
    const results = await runCapabilityChecks({
      world: session.world,
      pool: null,
    })
    const failed = results.filter((r) => !r.passed)
    expect(summarizeCapabilities(results).split('\n')[0]).toBe(
      '12/12 capabilities proven',
    )
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
    // Compared against the router, not a literal. The overlay and the thing
    // that would pick a Durable Object have to agree about who owns a ship, and
    // until `systemOfFrameId` existed they agreed only because the frame
    // grammar and the partition grammar spell a system the same way (ADR-0008).
    // A literal here passes for both the right answer and that coincidence.
    expect(entity?.partition).toBe(
      partitionForAddress(systemAddress(session.world.galaxy, systemId('SOL'))),
    )
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

describe('the authority a session joins', () => {
  /*
   * A double, not a mock of `LocalAuthority`.
   *
   * The point of these tests is that the session talks to a *port*, so the
   * thing on the other end has to be something the session has never heard of.
   * Passing another `LocalAuthority` would prove only that the session can call
   * the class it already constructs.
   */
  function recording() {
    const joins: { partition: string; hello: ClientHello }[] = []
    let left = 0
    let refuse: string | null = null
    const port: AuthorityPort = {
      join: (partition, hello) => {
        joins.push({ partition, hello })
        return Promise.resolve(
          refuse === null
            ? ok({ partition, peers: 3, streaming: true })
            : err(refuse),
        )
      },
      leave: () => {
        left += 1
      },
      submit: () => {},
      subscribe: () => () => {},
      status: () => ({
        kind: 'remote',
        state: 'joined',
        partition: joins[0]?.partition as PartitionKey | null,
        peers: 3,
        streaming: true,
        submitted: 0,
        detail: null,
      }),
    }
    return {
      port,
      joins,
      leftCount: () => left,
      refuseWith: (reason: string) => {
        refuse = reason
      },
    }
  }

  it('joins the partition the player is actually in', () => {
    const spy = recording()
    const session = openSession({
      seed: 'inertialref',
      workers: null,
      authority: spy.port,
    })
    expect(spy.joins).toHaveLength(1)
    const join = spy.joins[0]
    // The same key the overlay shows, from the same derivation — not a second
    // opinion about which authority owns this ship.
    expect(join?.partition).toBe(session.harness.status().player?.partition)
    expect(join?.hello.seed).toBe('inertialref')
    expect(join?.hello.owns).toEqual([session.player()])
    session.dispose()
    expect(spy.leftCount()).toBe(1)
  })

  it('changes nothing about the simulation', () => {
    // The milestone's whole claim. An authority is allowed to observe and to
    // supply what the client cannot derive; it is not allowed to be a second
    // writer of canonical state, and a divergent hash here would mean it had
    // become one.
    const withDefault = openSession({ seed: 'inertialref', workers: null })
    const withPort = openSession({
      seed: 'inertialref',
      workers: null,
      authority: recording().port,
    })
    withDefault.harness.step(600)
    withPort.harness.step(600)
    expect(withPort.world.stateHash()).toBe(withDefault.world.stateHash())
    expect(withPort.harness.status().player?.canonical.text).toBe(
      withDefault.harness.status().player?.canonical.text,
    )
    withDefault.dispose()
    withPort.dispose()
  })

  it('flies perfectly well when the authority refuses it', () => {
    // Offline-first is the requirement, not the fallback: a refused handshake
    // is a fact on the overlay, and the universe carries on being derivable.
    const spy = recording()
    spy.refuseWith('generation mismatch: terrain 1≠99')
    const session = openSession({
      seed: 'inertialref',
      workers: null,
      authority: spy.port,
    })
    session.harness.step(600)
    expect(session.harness.status().world.tick).toBe(600)
    expect(session.harness.status().player).not.toBe(null)
    session.dispose()
  })

  it('reports a local authority by default, and puts it on the overlay', async () => {
    const session = openSession({ seed: 'inertialref', workers: null })
    // The join resolves on a microtask; nothing waits for it, so neither does
    // the assertion beyond letting it land.
    await Promise.resolve()
    const authority = session.harness.status().authority
    expect(authority?.kind).toBe('local')
    expect(authority?.state).toBe('joined')
    expect(authority?.peers).toBe(0)
    // H-6 again: alone means nothing is streamed, which is what makes an empty
    // partition cost nothing to run.
    expect(authority?.streaming).toBe(false)
    expect(authority?.partition).toBe(
      session.harness.status().player?.partition,
    )
    session.dispose()
  })
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

describe('travel targets', () => {
  /*
   * The gap these cover is not a broken calculation, it is a missing question.
   * Every driving verb the harness had took an address, and nothing in the
   * running game would tell you one — a session opened above the first landable
   * body of Sol and the only way to learn that anywhere else existed was to read
   * the generator. `targets()` is the answer, so what it must never do is omit
   * somewhere you can actually go.
   */
  it('lists the loaded system, its bodies, and the neighbouring stars', () => {
    const { harness: ir } = harness()
    const targets = ir.targets({ lightYears: 6 })

    const sol = targets.find((t) => t.kind === 'system' && t.system === 'SOL')
    expect(sol?.loaded).toBe(true)
    expect(sol?.depth).toBe(0)

    const bodies = targets.filter((t) => t.kind === 'body')
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.every((t) => t.system === 'SOL')).toBe(true)
    // Planets sit one level under their system and moons one under those, which
    // is what makes the listing renderable as a tree without a second pass.
    expect(bodies.some((t) => t.depth === 1)).toBe(true)
    expect(bodies.some((t) => t.depth === 2)).toBe(true)
    expect(bodies.some((t) => t.landable)).toBe(true)

    // The nearest catalogue neighbours, unloaded but addressable.
    const proxima = targets.find((t) => t.name === 'Proxima Centauri')
    expect(proxima?.loaded).toBe(false)
    expect(proxima?.address).toBe('g:milky-way/s:HIP70890')

    // Systems nearest first, so the top of the list is the useful end of it.
    const systems = targets
      .filter((t) => t.kind === 'system')
      .map((t) => t.distance)
    expect([...systems].sort((a, b) => a - b)).toEqual(systems)
  })

  it('keeps a system listed after the player has left its survey radius', () => {
    // Flying four light years away and having the place you came from drop out
    // of the list is how a debug tool strands you.
    const { harness: ir } = harness()
    ir.goTo('HIP71683')
    const named = ir.targets({ lightYears: 1 }).map((t) => t.system)
    expect(named).toContain('SOL')
    expect(named).toContain('HIP71683')
  })
})

describe('going places', () => {
  it('sends the ship to a body named relative to the system it is in', () => {
    const { harness: ir, session } = harness()
    ir.goTo('b:2')
    const player = ir.inspect()
    expect(player?.frame).toBe('b:g:milky-way/s:SOL/b:2')

    // And arrives looking at it. `orbit` alone aims along the track, so the
    // planet is off to one side and the screen is empty — which reads as a
    // planet that failed to load rather than as a heading.
    const entity = session.world.entities.require(session.player() as EntityId)
    const forward = Q.rotate(entity.state.orientation, vec3(0, 0, -1))
    // The body is at the origin of its own frame, so the way to it is simply
    // back down the position vector.
    const toBody = Vec.normalize(Vec.negate(entity.state.position))
    expect(Vec.dot(forward, toBody)).toBeCloseTo(1, 6)
  })

  it('composes shots of a moon against the sun, not against its planet', () => {
    /*
     * The sun direction fed to `placeShot` used to be the direction of the
     * frame's *parent* — the system frame for a planet, which is the star, but
     * the planet frame for a moon. Every bookmark on a moon was therefore
     * composed against its planet: `full-face` on Luna framed the earthlit
     * side at whatever phase Earth was in. Confirmed to fail before the fix:
     * the measured sun–moon–camera angle came out wherever the Earth–Moon–Sun
     * geometry happened to put it, tens of degrees off the 90° the bookmark
     * promises.
     */
    const { harness: ir, session } = harness()
    ir.shot('half', 'b:2.0')
    const world = session.world
    const time = world.clock.time
    const player = session.player() as EntityId
    const camera = world.canonicalPositionOf(player)
    const moon = world.frames.pose(
      bodyFrameId(parseAddress('g:milky-way/s:SOL/b:2.0')),
      time,
    ).position
    const star = world.frames.pose(
      systemFrameId(systemId('SOL')),
      time,
    ).position
    const toSun = Vec.normalize(UV.difference(star, moon))
    const toCamera = Vec.normalize(UV.difference(camera, moon))
    const phase = (Math.acos(Vec.dot(toSun, toCamera)) * 180) / Math.PI
    // 'half' promises a terminator down the middle: a 90° phase angle.
    expect(phase).toBeCloseTo(90, 1)
  })

  it('keeps a framed shot pointing at the body as the orbit proceeds', () => {
    /*
     * A bookmark used to teleport in with zero angular velocity: a nose fixed
     * in inertial space, so the body slid out of frame as the orbit carried
     * the ship around it. A locked-on camera turns once per revolution about
     * the orbit normal. Twenty minutes of Luna's `gibbous` orbit is ~10° of
     * arc — confirmed to fail before the fix at dot ≈ 0.983.
     */
    const { harness: ir, session } = harness()
    ir.shot('gibbous', 'b:2.0')
    ir.step(64 * 1200)
    const entity = session.world.entities.require(session.player() as EntityId)
    const forward = Q.rotate(entity.state.orientation, vec3(0, 0, -1))
    const toBody = Vec.normalize(Vec.negate(entity.state.position))
    expect(Vec.dot(forward, toBody)).toBeGreaterThan(0.995)
  })

  it('sends the ship to another star system, orbiting the star itself', () => {
    const { harness: ir, session } = harness()
    expect(ir.status().world.loadedSystems).toHaveLength(1)
    ir.goTo('HIP71683')
    expect(ir.status().world.loadedSystems.map((s) => s.id)).toContain(
      'HIP71683',
    )
    // Naming a system asks for the star: the ship ends in the *system* frame —
    // whose origin is the star — not in the frame of whichever body happened
    // to be issued first, which is where this used to leave you.
    expect(ir.inspect()?.frame).toBe('s:HIP71683')

    // In a genuine circular orbit of it, close enough that the disc reads as
    // a sun rather than a bright point...
    const star = session.world.system(systemId('HIP71683'))?.star
    if (star === undefined) throw new Error('HIP71683 not loaded')
    const entity = session.world.entities.require(session.player() as EntityId)
    expect(Vec.length(entity.state.position)).toBeLessThan(star.radius * 12)
    ir.step(64 * 120)
    const after = ir.inspect()?.local
    const radius = Math.hypot(after?.x ?? 0, after?.y ?? 0, after?.z ?? 0)
    expect(radius / Vec.length(entity.state.position)).toBeCloseTo(1, 2)

    // ...and looking at it: the star sits at the frame's origin, so the way
    // to it is back down the position vector.
    const held = session.world.entities.require(session.player() as EntityId)
    const forward = Q.rotate(held.state.orientation, vec3(0, 0, -1))
    const toStar = Vec.normalize(Vec.negate(held.state.position))
    expect(Vec.dot(forward, toStar)).toBeGreaterThan(0.99)
  })

  it('holds off in the dark only when asked to', () => {
    const { harness: ir } = harness()
    ir.goTo('HIP71683', { distanceAu: 40 })
    expect(ir.inspect()?.frame).toBe('s:HIP71683')
    const local = ir.inspect()?.local
    expect(local?.x).toBeGreaterThan(39 * AU)
  })

  it('parks inside the sphere of influence of every body that has one', () => {
    /*
     * The one that is easy to get wrong. A "circular orbit" placed outside a
     * body's sphere of influence is reframed to the parent — so a debug verb
     * that promised to park you somewhere instead flings you across the system,
     * and only for the small moons, which is exactly the case nobody checks by
     * hand. Confirmed to fail: raising the viewing altitude to 40 body radii
     * turns the first moon's frame into its planet's on the very first pass.
     *
     * The exception is not a loophole, it is astronomy. Phobos's sphere of
     * influence is 7.2 km and its radius is 11.3 km, so *nothing* can orbit it;
     * parking there and being handed back to Mars is the correct outcome and
     * `canHoldOrbit` is how the harness and this test agree on which case it is.
     */
    const { harness: ir } = harness()
    const system = ir.world.system(systemId('SOL'))
    if (system === undefined) throw new Error('SOL not loaded')
    const bodyOf = (address: string) =>
      [...walkBodies(system)].find(
        (body) => formatAddress(body.address) === address,
      )

    let unorbitable = 0
    for (const target of ir
      .targets({ lightYears: 1 })
      .filter((t) => t.kind === 'body')) {
      const body = bodyOf(target.address)
      if (body === undefined) continue
      ir.goTo(target.address)
      ir.step(64 * 60)
      const player = ir.inspect()
      if (canHoldOrbit(body)) {
        expect(`${target.name}: ${player?.frame}`).toBe(
          `${target.name}: b:${target.address}`,
        )
      } else {
        unorbitable += 1
        // Handed back to the parent, not flung across the system.
        expect(`${target.name}: ${player?.frame}`).toMatch(/^[^:]+: b:/)
      }
      expect(`${target.name}: landed ${player?.landed}`).toBe(
        `${target.name}: landed false`,
      )
    }
    // Phobos and Deimos. If this ever reaches zero the check above has stopped
    // testing the case it was written for.
    expect(unorbitable).toBeGreaterThan(0)
  }, 20_000)

  it('refuses what it cannot send you to', () => {
    const { harness: ir } = harness()
    expect(() => ir.goTo('')).toThrow(/No destination/)
    expect(() => ir.goTo('g:milky-way')).toThrow(/galaxy/)
    expect(() => ir.goTo('g:milky-way/s:SOL/b:99')).toThrow(/No body/)
  })
})
