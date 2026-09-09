import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DEBUG_ON,
  resetPreferences,
  usePersistentState,
  write,
} from './preferences.ts'

function StoredPreference() {
  const [debug] = usePersistentState(DEBUG_ON)
  return createElement('output', null, String(debug))
}

describe('server preference snapshot', () => {
  it('renders the default even when a browser preference is available', () => {
    write(DEBUG_ON, true)
    try {
      expect(renderToStaticMarkup(createElement(StoredPreference))).toBe(
        '<output>false</output>',
      )
    } finally {
      resetPreferences()
    }
  })
})
