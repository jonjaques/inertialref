import { readFileSync } from 'node:fs'
import { parseConfigFileTextToJson } from 'typescript'
import { describe, expect, it } from 'vitest'

const { config } = parseConfigFileTextToJson(
  'wrangler.jsonc',
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
)

describe('the static hosting boundary', () => {
  it('returns a missing-page response instead of the home document', () => {
    expect(config.assets.not_found_handling).toBe('404-page')
  })

  it('serves a file-built route at its canonical address', () => {
    expect(config.assets.html_handling).toBe('drop-trailing-slash')
  })

  it('invokes the Worker only for its API, socket and media adapters', () => {
    expect(config.assets.run_worker_first).toEqual([
      '/api',
      '/api/*',
      '/ws',
      '/media/*',
    ])
  })
})
