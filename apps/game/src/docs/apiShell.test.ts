import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { expect, it } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip.tsx'
import { KeymapProvider } from '../input/KeymapProvider.tsx'
import { PageShell } from '../pages/PageShell.tsx'

const shell = (route: string): string =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        KeymapProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: [route] },
          createElement(PageShell),
        ),
      ),
    ),
  )

it('hydrates the shared API loading HTML at any known API address', () => {
  const html = shell('/docs/api')
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain('href="/docs"')
  for (const route of [
    '/docs/api/spatial',
    '/docs/api/spatial/Vec3-abc?reader=1#x',
  ])
    expect(shell(route)).toBe(html)
})
