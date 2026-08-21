import { describe, expect, it } from 'vitest'
import { HEALTH_PATH, SOCKET_PATH } from '@inertialref/protocol'
import { routeFor } from './routes.ts'

describe('worker routing', () => {
  it('sends the two live paths to the script', () => {
    expect(routeFor(HEALTH_PATH).kind).toBe('health')
    expect(routeFor(SOCKET_PATH).kind).toBe('socket')
  })

  it('answers anything else under /api from the API, not the page', () => {
    // Each of these is served by the SPA fallback if it reaches the asset
    // store, so the client would receive 200 and a document — a healthy-looking
    // server it cannot actually talk to. The bare `/api` case is why
    // run_worker_first lists `/api` as well as `/api/*`.
    for (const path of [
      '/api',
      '/api/',
      '/api/health/',
      '/api/heath',
      '/api/discoveries',
      '/api/v2/anything',
    ]) {
      expect(routeFor(path).kind, path).toBe('api-not-found')
    }
  })

  it('leaves everything else to the asset store', () => {
    for (const path of [
      '/',
      '/index.html',
      '/assets/index-a1b2c3d4.js',
      '/favicon.svg',
      '/apibut-not-really',
      '/ws/extra',
      '/SOL',
    ]) {
      expect(routeFor(path).kind, path).toBe('asset')
    }
  })
})
