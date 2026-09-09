import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DocsMode } from '../docs/DocsMode.tsx'
import { DocsContentContext } from '../docs/initialDocs.ts'
import type { DocManifest, DocPage } from '../docs/content.ts'
import { KeymapProvider } from '../input/KeymapProvider.tsx'
import { HomePage } from './HomePage.tsx'
import { OverlayRoutes } from './OverlayRoutes.tsx'
import { PageShell } from './PageShell.tsx'

const PAGE: DocPage = {
  route: '/docs/concepts/frames',
  title: 'Reference frames',
  lead: 'Frames describe motion.',
  kind: 'prose',
  html: '<h2 id="motion">Motion</h2><p>A frame describes relative motion.</p><h2 id="chain">The chain</h2><p>Frames form a chain.</p>',
  headings: [
    { id: 'motion', text: 'Motion', depth: 2 },
    { id: 'chain', text: 'The chain', depth: 2 },
  ],
  words: 12,
  diagrams: 0,
  source: 'docs/concepts/frames.md',
  packageName: null,
  memberKind: null,
}

const MANIFEST: DocManifest = {
  version: 'ssr-test',
  wings: [
    {
      id: 'concepts',
      label: 'Concepts',
      blurb: 'How the universe works.',
      home: PAGE.route,
      framing: { address: 's:SOL/b:5', phase: -135, tilt: 16, fill: 0.6 },
      groups: [{ label: null, head: null, pages: [PAGE.route] }],
    },
  ],
  pages: {
    [PAGE.route]: {
      title: PAGE.title,
      label: PAGE.title,
      wing: 'concepts',
      kind: 'prose',
      asset: 'frames-test.json',
    },
  },
  counts: {
    pages: 1,
    documents: 1,
    words: 12,
    diagrams: 0,
    packages: 0,
    exports: 0,
  },
}

const DEV = { panels: [], open: false, onOpenChange: () => {} }
const at = (path: string, node: ReactNode): string =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        KeymapProvider,
        null,
        createElement(MemoryRouter, { initialEntries: [path] }, node),
      ),
    ),
  )

describe('the HTML page before the renderer starts', () => {
  it('renders a visible homepage and ordinary navigation without DOM globals', () => {
    expect(typeof window).toBe('undefined')
    const html = at('/', createElement(HomePage, { engine: null }))
    expect(html).toContain('A spaceflight simulator')
    expect(html).toContain('href="/docs"')
    expect(html).toContain('href="/planetarium"')
    expect(html).not.toContain('opacity:0')
  })

  it('renders the supplied documentation, rail and contents without an engine', () => {
    const html = at(
      PAGE.route,
      createElement(
        DocsContentContext,
        {
          value: {
            manifest: { value: MANIFEST, pending: false, error: null },
            page: { value: PAGE, pending: false, error: null },
          },
        },
        createElement(DocsMode, { engine: null, dev: DEV }),
      ),
    )
    expect(html).toContain('Reference frames')
    expect(html).toContain('A frame describes relative motion.')
    expect(html).toContain('aria-label="Documentation contents"')
    expect(html).toContain('aria-label="On this page"')
    expect(html).toContain('href="#chain"')
    expect(html).not.toContain('doc-skeleton')
    expect(html).not.toContain('opacity:0')
  })

  it('renders an informational overlay with visible words', () => {
    const html = at(
      '/about',
      createElement(OverlayRoutes, {
        render: { preference: 'auto', output: null, onPreference: () => {} },
        onNotice: () => {},
      }),
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('href="/"')
    expect(html).not.toContain('opacity:0')
  })

  it('carries a request’s document through the complete shell', () => {
    const html = at(
      PAGE.route,
      createElement(PageShell, {
        initialDocs: { manifest: MANIFEST, page: PAGE },
      }),
    )
    expect(html).toContain('A frame describes relative motion.')
    expect(html).toContain('aria-label="Documentation shortcuts"')
    expect(html).not.toContain('doc-skeleton')
    expect(html).not.toContain('<canvas')

    const another = at(
      PAGE.route,
      createElement(PageShell, {
        initialDocs: {
          manifest: MANIFEST,
          page: {
            ...PAGE,
            title: 'Another response',
            html: '<p>Independent request content.</p>',
          },
        },
      }),
    )
    expect(another).toContain('Independent request content.')
    expect(another).not.toContain('A frame describes relative motion.')
  })

  it.each([
    '/planetarium',
    '/planetarium/catalog',
    '/cinema/tng-intro',
    '/play/solo',
  ])(
    'renders a useful admission page for %s without importing a renderer',
    (path) => {
      const html = at(path, createElement(PageShell, {}))
      expect(html).toContain('aria-label="Explore InertialRef"')
      expect(html).toContain('Enable JavaScript to enter')
      expect(html).toContain('href="/docs"')
      expect(html).not.toContain('<canvas')
    },
  )
})
