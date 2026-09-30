import { describe, expect, it } from 'vitest'
import { SITE } from '../apps/game/src/site.ts'
import config from '../apps/server/cloudflare.config.ts'

/*
 * The config is a function of where it is evaluated (`cloudflare.config.ts`):
 * these are production's answers, which is what the hosting boundary is about.
 */
const at = (context) => config(context).worker
const worker = at({ isPreview: false, mode: 'production' })

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

  it('names the custom domains in production and nowhere else', () => {
    // A Worker Preview upload refuses a config with `domains` in it.
    expect(at({ isPreview: true, mode: undefined }).domains).toBeUndefined()
  })

  it('switches the guide and accounts off in production and on everywhere else', () => {
    const flags = (context) => {
      const { env } = at(context)
      return [env.TOUR_GUIDE_ENABLED.value, env.CLERK_ENABLED.value]
    }
    expect(flags({ isPreview: false, mode: 'production' })).toEqual([
      'false',
      'false',
    ])
    // A Worker Preview, and `cf dev` under `pnpm dev`.
    expect(flags({ isPreview: true, mode: undefined })).toEqual([
      'true',
      'true',
    ])
    expect(flags({ isPreview: false, mode: undefined })).toEqual([
      'true',
      'true',
    ])
  })
})
