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

  it('cleans the session’s entry address and the URLs the SDK nests', () => {
    const shared = 'https://inertialref.app/planetarium?shot=2&label=My+dog'
    const event = sanitizeEvent({
      properties: {
        $session_entry_url: shared,
        $session_entry_referrer: 'https://chat.example/room?id=7',
        $web_vitals_LCP_event: {
          value: 1200,
          $current_url: shared,
          navigationURL: shared,
        },
        $heatmap_data: {
          [shared]: [{ x: 1 }],
          'https://inertialref.app/planetarium?at=b:4.2': [{ x: 2 }],
        },
      },
    })
    expect(event.properties).toEqual({
      $session_entry_url: 'https://inertialref.app/planetarium',
      $session_entry_referrer: 'https://chat.example/room',
      $web_vitals_LCP_event: {
        value: 1200,
        $current_url: 'https://inertialref.app/planetarium',
        navigationURL: 'https://inertialref.app/planetarium',
      },
      $heatmap_data: {
        'https://inertialref.app/planetarium': [{ x: 1 }, { x: 2 }],
      },
    })
  })
})
