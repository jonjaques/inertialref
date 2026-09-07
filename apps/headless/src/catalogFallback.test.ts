import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadStarCatalog } from './catalog.ts'
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: vi.fn(),
}))
const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
const volume = actual.readFileSync(
  new URL('../../../data/catalog/stars-150ly.irsc', import.meta.url),
)
afterEach(() => vi.resetAllMocks())
describe('optional sky decoding in Node', () => {
  it.each(['corrupt', 'incompatible', 'missing'])(
    'keeps the volume when the sky is %s',
    (kind) => {
      vi.mocked(readFileSync)
        .mockReturnValueOnce(volume)
        .mockImplementationOnce(() => {
          if (kind === 'missing') throw new Error('missing')
          return kind === 'corrupt' ? Buffer.from([1, 2]) : volume
        })
      const catalog = loadStarCatalog()
      expect(catalog.stars).toHaveLength(7123)
      expect(catalog.sky).toHaveLength(0)
    },
  )
})
