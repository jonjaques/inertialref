import { describe, expect, it } from 'vitest'
import { HEALTH_PATH, NET_PROTOCOL_VERSION } from '@inertialref/protocol'
import { GENERATION_VERSIONS } from '@inertialref/universe'
import { CLIENT_VERSIONS, probeHealth } from './health.ts'

/*
 * The classification half of the healthcheck, in Node.
 *
 * Every case here is a way a real network lies. The point of decoding the body
 * rather than trusting the status is that three of the five below answer 200.
 */

const healthy = {
  status: 'ok',
  protocol: NET_PROTOCOL_VERSION,
  generation: GENERATION_VERSIONS,
  revision: 'abc1234',
  colo: 'SJC',
}

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
    const outcome = await probeHealth(serving(healthy))
    expect(outcome.state).toBe('online')
    expect(outcome.detail).toBe(null)
    expect(outcome.health?.revision).toBe('abc1234')
  })

  it('asks the path the server actually routes', async () => {
    let asked: string | null = null
    await probeHealth((input) => {
      asked = input
      return serving(healthy)()
    })
    expect(asked).toBe(HEALTH_PATH)
  })

  it('is unreachable when the request does not complete', async () => {
    const outcome = await probeHealth(() =>
      Promise.reject(new Error('Failed to fetch')),
    )
    expect(outcome.state).toBe('unreachable')
    expect(outcome.detail).toBe('Failed to fetch')
  })

  it('is unreachable on an error status, whatever the body says', async () => {
    const outcome = await probeHealth(serving(healthy, { status: 503 }))
    expect(outcome.state).toBe('unreachable')
    expect(outcome.detail).toContain('503')
  })

  it('is incompatible when something answers 200 that is not the server', async () => {
    // A captive portal, and the SPA fallback answering a mistyped endpoint with
    // index.html. Both are 200s, and both would look healthy to a status check.
    for (const body of ['<!doctype html><title>Sign in</title>', '']) {
      const outcome = await probeHealth(serving(body))
      expect(outcome.state).toBe('incompatible')
    }
  })

  it('is incompatible when the server derives a different universe', async () => {
    const outcome = await probeHealth(
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

  it('claims exactly what this build generates', () => {
    // If a generator is added and this drifts, two clients would agree on a
    // handshake and disagree about where the mountains are.
    expect(CLIENT_VERSIONS.generation).toBe(GENERATION_VERSIONS)
    expect(CLIENT_VERSIONS.protocol).toBe(NET_PROTOCOL_VERSION)
  })
})
