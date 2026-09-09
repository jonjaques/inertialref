import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { beforeEach, expect, it, vi } from 'vitest'
import { PICTURES } from '@inertialref/devtools'
import { TooltipProvider } from '../components/ui/tooltip.tsx'
import type { GameEngine } from '../engine/GameEngine.ts'
import { KeymapProvider } from '../input/KeymapProvider.tsx'
import { CatalogPage } from './CatalogPage.tsx'
import { pictureLink, presetLink, readPictureLink } from './presetUrl.ts'

const view = vi.hoisted(() => ({
  navigate: vi.fn(),
  stop: vi.fn(),
  focus: null as (() => void) | null,
}))
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useNavigate: () => view.navigate,
}))
vi.mock('./useWorldSearch.ts', () => ({
  useWorldSearch: () => ({
    matches: [{ address: 's:SOL/b:3' }],
    total: 1,
    progress: 1,
    systems: 1,
    running: false,
    asked: { kinds: ['rocky'] },
    stop: view.stop,
    run: () => {},
  }),
}))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 44,
    getVirtualItems: () => [{ index: 0, key: 'mars', start: 0 }],
    measureElement: () => {},
  }),
}))
vi.mock('./WorldRow.tsx', () => ({
  WorldRow: ({ onFocus }: { onFocus: () => void }) => {
    view.focus = onFocus
    return null
  },
}))

beforeEach(() => {
  view.navigate.mockClear()
  view.stop.mockClear()
  view.focus = null
})

it.each([
  ['a built-in preset', presetLink('earthrise')],
  [
    'a portable picture',
    pictureLink(PICTURES.find((picture) => picture.framing.kind === 'camera')!),
  ],
])('opens a catalog result after viewing %s', (_kind, link) => {
  const params = new URL(link, 'https://inertialref.test').searchParams
  params.set('seed', 'inertialref')
  params.set('presentation', 'occluded')
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        KeymapProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: [`/planetarium/catalog?${params}`] },
          createElement(CatalogPage, { engine: {} as GameEngine }),
        ),
      ),
    ),
  )
  expect(view.focus).not.toBeNull()
  view.focus!()
  expect(view.stop).toHaveBeenCalledOnce()
  expect(view.navigate).toHaveBeenCalledOnce()
  const [destination, options] = view.navigate.mock.calls[0]!
  expect(destination.pathname).toBe('/planetarium')
  expect(options).toEqual({ replace: true })
  const next = new URLSearchParams(destination.search)
  expect(next.get('at')).toBe('s:SOL/b:3')
  expect(next.get('seed')).toBe('inertialref')
  expect(next.get('presentation')).toBe('occluded')
  expect(readPictureLink(next).picture).toBeNull()
})
