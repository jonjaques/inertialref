import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import GameLoader from './GameLoader.tsx'

it('renders without browser globals or a running engine', () => {
  expect(typeof window).toBe('undefined')
  expect(renderToStaticMarkup(createElement(GameLoader))).toBe('')
})
