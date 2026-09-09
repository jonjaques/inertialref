import { describe, expect, it } from 'vitest'
import { cacheStartupAssets } from './cacheStartupAssets.ts'

function fixture() {
  const messages: unknown[] = []
  let controlled = false
  let changed = () => {}
  let resources = (_names: readonly string[]) => {}
  let hide = () => {}
  let stopped = false
  cacheStartupAssets({
    origin: 'https://inertialref.app',
    controller: () =>
      controlled ? { postMessage: (message) => messages.push(message) } : null,
    onControllerChange: (run) => {
      changed = run
    },
    observeResources: (run) => {
      resources = run
      run(['https://inertialref.app/assets/shell.js'])
      return () => {
        stopped = true
      }
    },
    onPageHide: (run) => {
      hide = run
    },
  })
  return {
    messages,
    resources: (names: readonly string[]) => resources(names),
    claim: () => {
      controlled = true
      changed()
    },
    hide: () => hide(),
    stopped: () => stopped,
  }
}

describe('assets loaded before service-worker control', () => {
  it('delivers early and in-flight resources after the worker claims the page', () => {
    const f = fixture()
    expect(f.messages).toEqual([])
    f.claim()
    f.resources(['https://inertialref.app/assets/catalog.irsc'])
    expect(f.messages).toEqual([
      {
        type: 'CACHE_ASSETS',
        urls: ['https://inertialref.app/assets/shell.js'],
      },
      {
        type: 'CACHE_ASSETS',
        urls: ['https://inertialref.app/assets/catalog.irsc'],
      },
    ])
  })

  it('deduplicates resources and excludes other origins, live state, media and source maps', () => {
    const f = fixture()
    f.resources([
      'https://inertialref.app/assets/shell.js',
      'https://elsewhere.test/assets/a.js',
      'https://inertialref.app/api/health',
      'https://inertialref.app/media/tng-intro.mp3',
      'https://inertialref.app/assets/shell.js.map',
    ])
    f.claim()
    expect(f.messages).toHaveLength(1)
    f.resources(['https://inertialref.app/assets/shell.js'])
    expect(f.messages).toHaveLength(1)
    f.hide()
    expect(f.stopped()).toBe(true)
  })
})
