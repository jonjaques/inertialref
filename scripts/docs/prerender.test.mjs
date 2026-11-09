import { describe, expect, it } from 'vitest'
import {
  apiPrerenderEnabled,
  docHtmlRoutes,
  docRedirects,
} from './prerender.mjs'

const pages = {
  '/docs': { kind: 'prose' },
  '/docs/concepts/frames': { kind: 'prose' },
  '/docs/api': { kind: 'api-index' },
  '/docs/api/spatial': { kind: 'api-package' },
  '/docs/api/spatial/Vec3-abc': { kind: 'api-member' },
}
const aliases = { '/docs/api/spatial/Vec3': '/docs/api/spatial/Vec3-abc' }

describe('API HTML build policy', () => {
  it('prerenders main and uses asynchronous reference pages elsewhere', () => {
    expect(apiPrerenderEnabled({}, () => 'main')).toBe(true)
    expect(apiPrerenderEnabled({}, () => 'codex/galaxy')).toBe(false)
    expect(apiPrerenderEnabled({}, () => '')).toBe(false)
  })

  it('uses the CI source branch rather than a checkout or PR target', () => {
    expect(apiPrerenderEnabled({ WORKERS_CI_BRANCH: 'main' }, () => '')).toBe(
      true,
    )
    expect(
      apiPrerenderEnabled({ WORKERS_CI_BRANCH: 'preview' }, () => 'main'),
    ).toBe(false)
    expect(
      apiPrerenderEnabled(
        {
          GITHUB_HEAD_REF: 'feature',
          GITHUB_REF_NAME: '77/merge',
          GITHUB_BASE_REF: 'main',
        },
        () => 'main',
      ),
    ).toBe(false)
    expect(
      apiPrerenderEnabled(
        { GITHUB_HEAD_REF: '', GITHUB_REF_NAME: 'main' },
        () => '',
      ),
    ).toBe(true)
  })

  it('supports an explicit production verification build and rejects typos', () => {
    expect(
      apiPrerenderEnabled({
        IR_PRERENDER_API: '1',
        WORKERS_CI_BRANCH: 'preview',
      }),
    ).toBe(true)
    expect(
      apiPrerenderEnabled({ IR_PRERENDER_API: '0', WORKERS_CI_BRANCH: 'main' }),
    ).toBe(false)
    expect(() => apiPrerenderEnabled({ IR_PRERENDER_API: 'yes' })).toThrow(
      'IR_PRERENDER_API',
    )
  })

  it('emits one API loading shell while keeping prose as HTML', () => {
    expect(docHtmlRoutes({ pages, prerenderApi: false })).toEqual([
      '/docs',
      '/docs/concepts/frames',
      '/docs/api',
    ])
    expect(docHtmlRoutes({ pages, prerenderApi: true })).toEqual(
      Object.keys(pages),
    )
  })

  it('proxies only known API addresses and preserves case-sensitive aliases', () => {
    const redirects = docRedirects({ pages, aliases, prerenderApi: false })
    expect(redirects).toContain(
      '/docs/api/spatial/Vec3 /docs/api/spatial/Vec3-abc 301\n',
    )
    expect(redirects).toContain('/docs/api/spatial/Vec3-abc /docs/api 200\n')
    expect(redirects).not.toContain('/docs/api /docs/api 200')
    expect(redirects).not.toContain('/docs/api/* /docs/api 200')
    expect(redirects).not.toContain('/docs/concepts/frames /docs/api')
    expect(docRedirects({ pages, aliases, prerenderApi: true })).not.toContain(
      ' 200',
    )
  })

  it('collapses the largest package into one rewrite once exact proxies pass the limit', () => {
    const wide = {
      '/docs/api': { kind: 'api-index' },
      '/docs/api/universe': { kind: 'api-package' },
      '/docs/api/spatial': { kind: 'api-package' },
      '/docs/api/spatial/Vec3-abc': { kind: 'api-member' },
      ...Object.fromEntries(
        Array.from({ length: 2001 }, (_, i) => [
          `/docs/api/universe/Symbol${i}`,
          { kind: 'api-member' },
        ]),
      ),
    }
    const rules = docRedirects({ pages: wide, aliases, prerenderApi: false })
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
    const splat = rules.indexOf('/docs/api/universe/* /docs/api 200')
    expect(splat).toBeGreaterThan(
      rules.indexOf('/docs/api/*.html /docs/api/:splat 301'),
    )
    expect(rules).toContain('/docs/api/universe /docs/api 200')
    expect(rules).toContain('/docs/api/spatial/Vec3-abc /docs/api 200')
    expect(rules).toContain(
      '/docs/api/spatial/Vec3 /docs/api/spatial/Vec3-abc 301',
    )
    expect(
      rules.some((line) => line.startsWith('/docs/api/universe/Symbol')),
    ).toBe(false)
    expect(
      rules.filter((line) => !line.includes('*')).length,
    ).toBeLessThanOrEqual(2000)
  })

  it('fails before Cloudflare silently drops routes above its static rule limit', () => {
    const many = Object.fromEntries(
      Array.from({ length: 2001 }, (_, i) => [
        `/docs/api/symbol${i}`,
        { kind: 'api-member' },
      ]),
    )
    expect(() => docRedirects({ pages: many, prerenderApi: false })).toThrow(
      '2,000',
    )
  })

  it('fails before the collapsed packages pass the dynamic rule limit', () => {
    // 3,600 exact rules of two members a package: fitting 2,000 collapses
    // 800 packages, each one splat rule, against a limit of 100.
    const narrow = Object.fromEntries(
      Array.from({ length: 1200 }, (_, i) => [
        [`/docs/api/package${i}`, { kind: 'api-package' }],
        [`/docs/api/package${i}/A`, { kind: 'api-member' }],
        [`/docs/api/package${i}/B`, { kind: 'api-member' }],
      ]).flat(),
    )
    expect(() => docRedirects({ pages: narrow, prerenderApi: false })).toThrow(
      '100 dynamic',
    )
  })
})
