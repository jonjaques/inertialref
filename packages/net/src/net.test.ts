import { describe, expect, it } from 'vitest'
import { NET_PROTOCOL_VERSION } from '@inertialref/protocol'
import { restState, vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import {
  type EntityId,
  GENERATION_VERSIONS,
  partitionForAddress,
  systemAddress,
  systemFrameId,
  systemId,
} from '@inertialref/universe'
import {
  type AuthorityUpdate,
  clientHello,
  type Intent,
  partitionOfEntity,
} from './authority.ts'
import { LocalAuthority } from './local.ts'

/*
 * The authority port, and the implementation of it that a player who is alone
 * actually runs.
 *
 * The temptation with a degenerate implementation is to test that it does
 * nothing, which passes just as well when it has quietly stopped doing the
 * things it should. So these assert the true statements instead: which
 * partition, refused on what grounds, and — the one that matters — that it
 * never replicates anything, because there is nothing to replicate.
 */

function worldWithShip(): { world: World; player: EntityId } {
  const world = new World({ seed: 'inertialref' })
  const system = world.loadSystem(systemId('SOL'))
  const ship = world.spawnShip(
    'Test One',
    systemFrameId(system.id),
    vec3(1e9, 0, 0),
  )
  return { world, player: ship.id }
}

const SOL_PARTITION = partitionForAddress(
  systemAddress(new World({ seed: 'inertialref' }).galaxy, systemId('SOL')),
)

function localAuthority(): {
  world: World
  player: EntityId
  authority: LocalAuthority
} {
  const { world, player } = worldWithShip()
  return {
    world,
    player,
    authority: new LocalAuthority({
      world: () => world,
      player: () => player,
    }),
  }
}

describe('locating an authority', () => {
  it('puts a ship under the system it is flying in', () => {
    const { world, player } = worldWithShip()
    expect(partitionOfEntity(world, player)).toBe(SOL_PARTITION)
  })

  it('falls back to the galactic cell out between the stars', () => {
    const { world, player } = worldWithShip()
    // Three light years out, in no system's frame at all.
    world.teleport(player, {
      ...restState(world.entities.require(player).state.frame),
      frame: 'universe' as ReturnType<typeof systemFrameId>,
      position: vec3(3e16, 0, 0),
    })
    const partition = partitionOfEntity(world, player)
    expect(partition?.startsWith('c:')).toBe(true)
    expect(partition).not.toBe(SOL_PARTITION)
  })

  it('has no answer for an entity that is not there', () => {
    const { world } = worldWithShip()
    expect(partitionOfEntity(world, null)).toBe(null)
    expect(partitionOfEntity(world, '#404' as EntityId)).toBe(null)
  })
})

describe('the local authority', () => {
  it('accepts this build and reports being alone', async () => {
    const { world, player, authority } = localAuthority()
    expect(authority.status().state).toBe('idle')

    const result = await authority.join(
      SOL_PARTITION,
      clientHello(world, [player]),
    )
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.peers).toBe(0)
    // H-6: with one player there is nothing to replicate, so it says so rather
    // than streaming an empty set forever.
    expect(result.ok && result.value.streaming).toBe(false)

    const status = authority.status()
    expect(status.kind).toBe('local')
    expect(status.state).toBe('joined')
    expect(status.partition).toBe(SOL_PARTITION)
    expect(status.detail).toBe(null)
  })

  it('refuses a client that would derive a different universe', async () => {
    const { world, player, authority } = localAuthority()
    const stale = {
      ...clientHello(world, [player]),
      generation: { ...GENERATION_VERSIONS, terrain: 99 },
    }
    const result = await authority.join(SOL_PARTITION, stale)
    expect(result.ok).toBe(false)
    // Read as server≠client: this authority is on terrain 1, the hello on 99.
    expect(!result.ok && result.error).toMatch(/terrain 1≠99/)
    expect(authority.status().state).toBe('refused')
    // Refusal is an answer, so the reason survives on the status for the
    // overlay to show rather than being thrown away with the promise.
    expect(authority.status().detail).toMatch(/terrain/)
  })

  it('refuses a client running a different seed', async () => {
    const { world, player, authority } = localAuthority()
    const elsewhere = {
      ...clientHello(world, [player]),
      seed: 'somewhere-else',
    }
    const result = await authority.join(SOL_PARTITION, elsewhere)
    // The seed *is* the universe: a position replicated between two of them
    // refers to a planet that only one of them has.
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/somewhere-else/)
  })

  it('never replicates anything, however much intent it is given', async () => {
    const { world, player, authority } = localAuthority()
    const seen: AuthorityUpdate[] = []
    authority.subscribe((update) => seen.push(update))
    await authority.join(SOL_PARTITION, clientHello(world, [player]))

    const intent: Intent = {
      entity: player,
      tick: 1,
      control: { translation: [0, 0, 1], rotation: [0, 0, 0] },
      flightAssist: true,
    }
    for (let i = 0; i < 50; i += 1) authority.submit({ ...intent, tick: i })

    expect(authority.status().submitted).toBe(50)
    // Intent is outbound only, and there is no recipient. An `entities` update
    // here would mean the authority was echoing the client's own ship back at
    // it, which would fight the local simulation every tick.
    expect(seen.filter((u) => u.kind === 'entities')).toEqual([])
    expect(seen.map((u) => u.kind)).toEqual(['presence'])
  })

  it('follows the ship rather than remembering where it joined', async () => {
    const { world, player, authority } = localAuthority()
    await authority.join(SOL_PARTITION, clientHello(world, [player]))
    expect(authority.status().partition).toBe(SOL_PARTITION)

    world.teleport(player, {
      ...restState(world.entities.require(player).state.frame),
      frame: 'universe' as ReturnType<typeof systemFrameId>,
      position: vec3(3e16, 0, 0),
    })
    // A remembered partition would be right until the first frame transition
    // and quietly wrong afterwards — which is the H4 handoff question, made
    // visible a milestone early instead of discovered inside a Durable Object.
    expect(authority.status().partition?.startsWith('c:')).toBe(true)
  })

  it('tells its subscribers when the session ends, once', async () => {
    const { world, player, authority } = localAuthority()
    const seen: AuthorityUpdate[] = []
    await authority.join(SOL_PARTITION, clientHello(world, [player]))
    authority.subscribe((update) => seen.push(update))

    authority.leave()
    authority.leave()
    expect(seen).toEqual([{ kind: 'closed', reason: 'left' }])
    expect(authority.status().state).toBe('closed')
    expect(authority.status().partition).toBe(null)
  })

  it('stops delivering to an unsubscribed handler', async () => {
    const { world, player, authority } = localAuthority()
    const seen: AuthorityUpdate[] = []
    const unsubscribe = authority.subscribe((u) => seen.push(u))
    unsubscribe()
    await authority.join(SOL_PARTITION, clientHello(world, [player]))
    expect(seen).toEqual([])
  })
})

describe('the client hello', () => {
  it('claims exactly what this build generates', () => {
    const { world, player } = worldWithShip()
    const hello = clientHello(world, [player])
    // If a generator is added and this drifts, two peers agree on a handshake
    // and disagree about where the mountains are.
    expect(hello.generation).toBe(GENERATION_VERSIONS)
    expect(hello.protocol).toBe(NET_PROTOCOL_VERSION)
    expect(hello.seed).toBe(world.seedText)
    expect(hello.galaxy).toBe(world.galaxy)
    expect(hello.owns).toEqual([player])
  })

  it('lets a client own nothing', () => {
    // A spectator, or the headless runner joining to watch. Inferring ownership
    // from the connection would leave no way to say this.
    const { world } = worldWithShip()
    expect(clientHello(world, []).owns).toEqual([])
  })
})
