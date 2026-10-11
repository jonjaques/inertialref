import { describe, expect, it } from 'vitest'
import { askGuideVerdict, grantsGuide } from './capabilities.ts'

/*
 * The reader of the Worker's verdict, over an injected fetcher: anything that
 * is not a verdict reads as "not offered", never as an error on screen.
 */

const answering =
  (respond: () => Response | Promise<Response>): typeof fetch =>
  async () =>
    respond()

describe('askGuideVerdict', () => {
  it('reads a grant', async () => {
    const fetcher = answering(() =>
      Response.json({ granted: true, voices: ['cedar'] }),
    )
    expect(await askGuideVerdict(new Headers(), fetcher)).toEqual({
      granted: true,
      voices: ['cedar'],
    })
  })

  it('reads no answer, an error status and a proxy page as nothing', async () => {
    const thrown = answering(() => {
      throw new TypeError('Failed to fetch')
    })
    const unavailable = answering(
      () => new Response('{"granted":true,"voices":[]}', { status: 503 }),
    )
    const page = answering(
      () => new Response('<html>Bad gateway</html>', { status: 200 }),
    )
    for (const fetcher of [thrown, unavailable, page])
      expect(await askGuideVerdict(new Headers(), fetcher)).toBeNull()
  })
})

describe('grantsGuide', () => {
  it('grants only a granted verdict', () => {
    expect(grantsGuide({ granted: true, voices: [] })).toBe(true)
    expect(grantsGuide({ granted: false, reason: 'signed-out' })).toBe(false)
    expect(grantsGuide(null)).toBe(false)
  })
})
