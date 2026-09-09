import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { KeymapProvider } from '../input/KeymapProvider.tsx'

// A settings page must be importable while the client runtime is unavailable.
// This also catches a future indirect import through one of the lens controls.
vi.mock('../engine/GameEngine.ts', () => {
  throw new Error('The server shell must not evaluate GameEngine')
})
vi.mock('../dock/Workspace.tsx', () => {
  throw new Error('The server shell must not evaluate the live workspace')
})

describe('the shell before the runtime starts', () => {
  it('renders the camera settings without importing the game engine', async () => {
    const { LensSection } = await import('../hud/LensSection.tsx')
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(KeymapProvider, null, createElement(LensSection)),
      ),
    )
    expect(html).toContain('Focal length')
    expect(html).toContain('Back to the ')
  })

  it('imports the reading room before the live workspace is available', async () => {
    await expect(import('../docs/DocsMode.tsx')).resolves.toHaveProperty(
      'DocsMode',
    )
  })
})
