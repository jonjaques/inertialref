import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadStarCatalog } from './catalogAsset.ts'

const volume = readFileSync(
  new URL('../../../../data/catalog/stars-150ly.irsc', import.meta.url),
)
afterEach(() => vi.unstubAllGlobals())
describe('optional sky decoding', () => {
  it.each(['corrupt', 'incompatible', 'missing'])(
    'keeps the volume when the sky is %s',
    async (kind) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(new Response(volume))
          .mockResolvedValueOnce(
            kind === 'missing'
              ? new Response(null, { status: 404 })
              : new Response(
                  kind === 'corrupt' ? new Uint8Array([1, 2]) : volume,
                ),
          ),
      )
      const catalog = await loadStarCatalog()
      expect(catalog.stars).toHaveLength(7123)
      expect(catalog.sky).toHaveLength(0)
    },
  )
})
