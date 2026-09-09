import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocManifest, DocPage } from '../docs/content.ts'
import { DocsContentContext } from '../docs/initialDocs.ts'
import { canonicalUrl, documentTitle, metadataForPath } from '../site.ts'
import { DocumentMeta } from './DocumentMeta.tsx'

const { effects, pageView, startAnalytics } = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  pageView: vi.fn(),
  startAnalytics: vi.fn(),
}))

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => void) => {
    effects.push(effect)
  },
}))
vi.mock('../analytics.ts', () => ({
  recordPageView: pageView,
  startAnalytics,
}))

const PAGE: DocPage = {
  route: '/docs/api/spatial/Sector-type',
  title: 'Sector',
  lead: 'A sector is an integer coordinate.',
  kind: 'api-member',
  html: '<p>A sector is an integer coordinate.</p>',
  headings: [],
  words: 6,
  diagrams: 0,
  source: null,
  packageName: '@inertialref/spatial',
  memberKind: 'Type alias',
}
const ALIAS = '/docs/api/spatial/Sector'
const MANIFEST: DocManifest = {
  version: 'metadata-test',
  wings: [],
  pages: {
    [PAGE.route]: {
      title: PAGE.title,
      label: PAGE.title,
      wing: 'api',
      kind: PAGE.kind,
      asset: 'sector.json',
    },
  },
  aliases: { [ALIAS]: PAGE.route },
  counts: {
    pages: 1,
    documents: 0,
    words: 6,
    diagrams: 0,
    packages: 1,
    exports: 1,
  },
}

afterEach(() => {
  effects.length = 0
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function renderMetadata(
  path: string,
  page: DocPage | null = PAGE,
  pending = false,
): void {
  vi.stubGlobal('document', { title: '', head: { querySelector: () => null } })
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        DocsContentContext,
        {
          value: {
            manifest: { value: MANIFEST, pending: false, error: null },
            page: { value: page, pending, error: null },
          },
        },
        createElement(DocumentMeta),
      ),
    ),
  )
  for (const effect of effects) effect()
}

describe('metadata for a live documentation address', () => {
  it('records an alias as the canonical document before the router replaces it', () => {
    renderMetadata(`${ALIAS}?seed=paper#definition`)
    expect(pageView).toHaveBeenCalledExactlyOnceWith(
      canonicalUrl(PAGE.route),
      documentTitle(metadataForPath(PAGE.route, PAGE)),
    )
    expect(document.title).not.toContain('Not Found')
  })

  it('waits for the canonical article instead of recording a provisional view', () => {
    renderMetadata(ALIAS, null, true)
    expect(pageView).not.toHaveBeenCalled()
  })

  it('describes a dialog address while documentation remains behind it', () => {
    renderMetadata('/settings')
    expect(pageView).toHaveBeenCalledExactlyOnceWith(
      canonicalUrl('/settings'),
      documentTitle(metadataForPath('/settings')),
    )
  })

  it('still reports an unknown article as missing', () => {
    renderMetadata('/docs/missing', null)
    expect(document.title).toContain('Page Not Found')
  })
})
