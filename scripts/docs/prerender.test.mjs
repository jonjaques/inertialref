import { describe, expect, it } from 'vitest'
import { docHtmlRoutes, docRedirects, loadsThroughShell } from './prerender.mjs'

const pages = {
  '/docs': { kind: 'prose' },
  '/docs/concepts/frames': { kind: 'prose' },
  '/docs/api': { kind: 'api-index' },
  '/docs/api/spatial': { kind: 'api-package' },
  '/docs/api/spatial/Vec3-abc': { kind: 'api-member' },
  '/docs/api/universe': { kind: 'api-package' },
  '/docs/api/universe/Sector': { kind: 'api-member' },
}
const aliases = { '/docs/api/spatial/Vec3': '/docs/api/spatial/Vec3-abc' }
const rules = (manifest) =>
  docRedirects(manifest)
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))

describe('API HTML build policy', () => {
  it('renders prose, the API shell and package pages, and no member page', () => {
    expect(docHtmlRoutes({ pages })).toEqual([
      '/docs',
      '/docs/concepts/frames',
      '/docs/api',
      '/docs/api/spatial',
      '/docs/api/universe',
    ])
  })

  it('loads the API index and member pages through the shell, and nothing else', () => {
    expect(Object.keys(pages).filter(loadsThroughShell)).toEqual([
      '/docs/api',
      '/docs/api/spatial/Vec3-abc',
      '/docs/api/universe/Sector',
    ])
  })

  it('rewrites each package to the shell after its aliases and the normalization rules', () => {
    const table = rules({ pages, aliases })
    expect(table).toEqual([
      '/docs/api/spatial/Vec3 /docs/api/spatial/Vec3-abc 301',
      '/docs/api/*/ /docs/api/:splat 301',
      '/docs/api/*.html /docs/api/:splat 301',
      '/docs/api/spatial/* /docs/api 200',
      '/docs/api/universe/* /docs/api 200',
    ])
    // A package page and the shell are HTML; a rewrite over either would loop
    // or serve the shell in place of the package's article.
    expect(table.some((line) => line.startsWith('/docs/api '))).toBe(false)
    expect(table.some((line) => line.startsWith('/docs/api/spatial '))).toBe(
      false,
    )
    expect(table.some((line) => line.includes('/docs/concepts'))).toBe(false)
  })

  it('keeps an alias that an exact page shadows out of the table', () => {
    const shadowed = {
      ...pages,
      '/docs/api/spatial/Vec3': { kind: 'api-member' },
    }
    expect(rules({ pages: shadowed, aliases })).not.toContain(
      '/docs/api/spatial/Vec3 /docs/api/spatial/Vec3-abc 301',
    )
  })

  it('does not grow with the member count', () => {
    const wide = {
      ...pages,
      ...Object.fromEntries(
        Array.from({ length: 5000 }, (_, i) => [
          `/docs/api/universe/Symbol${i}`,
          { kind: 'api-member' },
        ]),
      ),
    }
    expect(rules({ pages: wide, aliases })).toEqual(rules({ pages, aliases }))
  })

  it('fails before Cloudflare silently drops rules past either of its limits', () => {
    const manyAliases = Object.fromEntries(
      Array.from({ length: 2001 }, (_, i) => [
        `/docs/api/spatial/vec${i}`,
        '/docs/api/spatial/Vec3-abc',
      ]),
    )
    expect(() => docRedirects({ pages, aliases: manyAliases })).toThrow('2,000')
    const manyPackages = Object.fromEntries(
      Array.from({ length: 99 }, (_, i) => [
        `/docs/api/package${i}/Member`,
        { kind: 'api-member' },
      ]),
    )
    expect(() => docRedirects({ pages: manyPackages })).toThrow('100')
  })
})
