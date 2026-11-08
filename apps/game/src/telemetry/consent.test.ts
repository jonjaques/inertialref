import { describe, expect, it } from 'vitest'
import { SITE } from '../site.ts'
import { environmentFor } from './consent.ts'

/*
 * Who reports, as which environment. A gate that lets `localhost` through
 * poisons the numbers with the maintainer's own testing, and one that lets a
 * rig through puts a measurement of ourselves in the visitor counts; neither
 * failure says anything anywhere.
 */

const canonical = {
  production: true,
  token: 'phc_test',
  hostname: SITE.host,
  optedOut: false,
  automated: false,
}

describe('who reports to PostHog', () => {
  it('reports the canonical host as production', () => {
    expect(environmentFor(canonical)).toBe('production')
  })

  it('reports a Workers preview as a preview', () => {
    /*
     * `workers_dev` is `false`, so there is no shared `workers.dev` route,
     * but `preview_urls` is `true`: every uploaded version and every branch
     * preview gets its own hostname on that subdomain. Their errors are worth
     * having; the project's test-account filter keeps them out of the charts.
     */
    for (const hostname of [
      '1a2b3c4d-inertialrefd.jaquers.workers.dev',
      'feat-telemetry-inertialrefd.jaquers.workers.dev',
    ])
      expect(environmentFor({ ...canonical, hostname })).toBe('preview')
  })

  it('reports nothing from any other name for this build', () => {
    for (const hostname of [
      'localhost',
      '127.0.0.1',
      'inertialref.jonjaques.com',
      'jons-air.local',
      'inertialref.app.evil.example',
    ])
      expect(environmentFor({ ...canonical, hostname })).toBeNull()
  })

  it('reports nothing from a development build', () => {
    expect(environmentFor({ ...canonical, production: false })).toBeNull()
  })

  it('reports nothing without a token, which is what a fork builds with', () => {
    expect(environmentFor({ ...canonical, token: '' })).toBeNull()
  })

  it('honors Global Privacy Control and Do Not Track', () => {
    expect(environmentFor({ ...canonical, optedOut: true })).toBeNull()
  })

  it('reports nothing from a driven browser', () => {
    expect(environmentFor({ ...canonical, automated: true })).toBeNull()
  })
})
