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
})
