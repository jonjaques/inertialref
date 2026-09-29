import { describe, expect, it } from 'vitest'
import { SITE } from '../apps/game/src/site.ts'
import config from '../apps/server/cloudflare.config.ts'

const { worker } = config

describe('the static hosting boundary', () => {
  it('deploys on the production domain used by canonical metadata', () => {
    expect(SITE.host).toBe('inertialref.app')
    expect(worker.domains).toEqual([SITE.host, 'inertialref.jonjaques.com'])
  })

  it('returns a missing-page response instead of the home document', () => {
    expect(worker.assets.notFoundHandling).toBe('404-page')
  })

  it('serves a file-built route at its canonical address', () => {
    expect(worker.assets.htmlHandling).toBe('drop-trailing-slash')
  })

  it('invokes the Worker only for its API, socket and media adapters', () => {
    expect(worker.assets.runWorkerFirst).toEqual([
      '/api',
      '/api/*',
      '/ws',
      '/media/*',
    ])
  })
})
