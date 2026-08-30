import { describe, expect, it } from 'vitest'
import { HEALTH_PATH, NET_PROTOCOL_VERSION } from '@inertialref/protocol'
import { GENERATION_VERSIONS } from '@inertialref/universe'
import { CLIENT_VERSIONS, clientVersions, probeHealth } from './health.ts'

/*
 * The classification half of the healthcheck, in Node.
 *
 * Every case here is a way a real network lies. The point of decoding the body
 * rather than trusting the status is that three of the five below answer 200.
 */

const CATALOG = 'hyg-4.4+nea-2b24daf0'

const healthy = {
  status: 'ok',
  protocol: NET_PROTOCOL_VERSION,
  generation: GENERATION_VERSIONS,
  catalog: CATALOG,
  revision: 'abc1234',
  colo: 'SJC',
}

/** Every probe states which sky this session loaded; there is no default. */
const probe = (
  fetchImpl: Parameters<typeof probeHealth>[0],
  catalog = CATALOG,
) => probeHealth(fetchImpl, { catalog })

const serving =
  (body: unknown, init: ResponseInit = {}) =>
  (): Promise<Response> =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        ...init,
      }),
    )

describe('probing the server', () => {
  it('reports online against a server that derives the same universe', async () => {
    const outcome = await probe(serving(healthy))
    expect(outcome.state).toBe('online')
    expect(outcome.detail).toBe(null)
    expect(outcome.health?.revision).toBe('abc1234')
  })

  it('asks the path the server actually routes', async () => {
    let asked: string | null = null
    await probe((input) => {
      asked = input
      return serving(healthy)()
    })
    expect(asked).toBe(HEALTH_PATH)
  })

  it('is unreachable when the request does not complete', async () => {
    const outcome = await probe(() =>
      Promise.reject(new Error('Failed to fetch')),
    )
    expect(outcome.state).toBe('unreachable')
    expect(outcome.detail).toBe('Failed to fetch')
  })

  it('is unreachable on an error status, whatever the body says', async () => {
    const outcome = await probe(serving(healthy, { status: 503 }))
    expect(outcome.state).toBe('unreachable')
    expect(outcome.detail).toContain('503')
  })

  it('is incompatible when something answers 200 that is not the server', async () => {
    // A captive portal, and an HTML document answering a mistyped endpoint.
    // Both are 200s, and both would look healthy to a status check.
    for (const body of ['<!doctype html><title>Sign in</title>', '']) {
      const outcome = await probe(serving(body))
      expect(outcome.state).toBe('incompatible')
    }
  })

  it('is incompatible when the server derives a different universe', async () => {
    const outcome = await probe(
      serving({
        ...healthy,
        generation: { ...GENERATION_VERSIONS, terrain: 99 },
      }),
    )
    expect(outcome.state).toBe('incompatible')
    expect(outcome.detail).toContain('terrain')
    // The health record still comes back on a mismatch: refusing to talk is not
    // a reason to refuse to say what the other side believed.
    expect(outcome.health?.generation['terrain']).toBe(99)
  })

  it('is incompatible when the server ships a different star catalog', async () => {
    // The hole this closed: `Versions` had no notion of the catalog, so a
    // client whose catalog had moved joined a server whose catalog had not,
    // cleanly, and then disagreed about where the stars were.
    const outcome = await probe(serving({ ...healthy, catalog: 'hyg-4.5' }))
    expect(outcome.state).toBe('incompatible')
    expect(outcome.detail).toContain('catalog hyg-4.5≠')
    expect(outcome.drift.map((one) => one.key)).toEqual(['catalog'])
  })

  it('treats a server that names no catalog as absent, not as agreement', async () => {
    // A deployment too old to state one. Ignoring the field would make the
    // probe pass in exactly the case it exists to catch.
    const { catalog: _omitted, ...silent } = healthy
    const outcome = await probe(serving(silent))
    expect(outcome.state).toBe('incompatible')
    expect(outcome.detail).toContain('catalog absent≠')
  })

  it('says which sky this session actually loaded, not which one it wanted', async () => {
    // A failed catalog fetch degrades the client to Sol alone. That is a
    // different galaxy — procedural stars where the real catalog has observed
    // ones — and the probe has to report it rather than claim otherwise.
    const outcome = await probe(serving(healthy), 'sol-only')
    expect(outcome.state).toBe('incompatible')
    expect(outcome.drift).toEqual([
      { key: 'catalog', ours: CATALOG, theirs: 'sol-only' },
    ])
  })

  it('reports no drift at all against a server that agrees', async () => {
    const outcome = await probe(serving(healthy))
    expect(outcome.drift).toEqual([])
  })

  it('claims exactly what this build generates', () => {
    // If a generator is added and this drifts, two clients would agree on a
    // handshake and disagree about where the mountains are.
    expect(CLIENT_VERSIONS.generation).toBe(GENERATION_VERSIONS)
    expect(CLIENT_VERSIONS.protocol).toBe(NET_PROTOCOL_VERSION)
    expect(clientVersions('sol-only').catalog).toBe('sol-only')
  })
})
