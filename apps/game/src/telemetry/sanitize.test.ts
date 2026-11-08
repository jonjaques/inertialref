import { describe, expect, it } from 'vitest'
import { cleanUrl, sanitizeEvent } from './sanitize.ts'

describe('what leaves the page in a URL', () => {
  it('keeps the origin, the path and the campaign keys, and nothing else', () => {
    expect(
      cleanUrl(
        'https://inertialref.app/planetarium?p=eyJsYWJlbCI6Ik15IGRvZyJ9&at=b:4.2&utm_source=hn&utm_medium=link#__clerk_token',
      ),
    ).toBe('https://inertialref.app/planetarium?utm_source=hn&utm_medium=link')
  })

  it('leaves a value that is not a URL alone', () => {
    expect(cleanUrl('$direct')).toBe('$direct')
  })

  it('cleans the event, its person properties and the nested ones', () => {
    const event = sanitizeEvent({
      properties: {
        $current_url: 'https://inertialref.app/cinema/intro?frame=120',
        $referrer: 'https://news.example/item?id=42',
        $set_once: {
          $initial_current_url: 'https://inertialref.app/?q=secret',
        },
        title: 'Cinema · InertialRef',
      },
      $set: { $current_url: 'https://inertialref.app/settings?tab=x' },
    })
    expect(event.properties).toEqual({
      $current_url: 'https://inertialref.app/cinema/intro',
      $referrer: 'https://news.example/item',
      $set_once: { $initial_current_url: 'https://inertialref.app/' },
      title: 'Cinema · InertialRef',
    })
    expect(event.$set).toEqual({
      $current_url: 'https://inertialref.app/settings',
    })
  })
})
