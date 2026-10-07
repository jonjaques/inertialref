import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { decode } from './codec.ts'
import {
  decodeGuideSessionCreated,
  decodeGuideSessionRequest,
  decodeGuideVerdict,
  GUIDE_REFUSAL_SENTENCES,
  GUIDE_REFUSALS,
  GUIDE_SESSION_LIMITS,
  utf8Bytes,
} from './guideWire.ts'

describe('the guide verdict', () => {
  it('reads a grant with its voices, and a refusal with its reason', () => {
    expect(
      decode(decodeGuideVerdict, { granted: true, voices: ['marin'] }),
    ).toEqual({
      ok: true,
      value: { granted: true, voices: ['marin'] },
    })
    for (const reason of GUIDE_REFUSALS)
      expect(decode(decodeGuideVerdict, { granted: false, reason })).toEqual({
        ok: true,
        value: { granted: false, reason },
      })
  })

  it('refuses anything that is not a verdict', () => {
    for (const value of [
      null,
      '<!doctype html>',
      { granted: 'true', voices: [] },
      { granted: true, voices: ['nobody'] },
      { granted: false, reason: 'maybe' },
      // The shape the Worker answered before the verdict was a union.
      {
        available: true,
        signedIn: true,
        authorized: true,
        voices: ['marin'],
        reason: null,
      },
    ])
      expect(decode(decodeGuideVerdict, value).ok).toBe(false)
  })

  it('has one sentence for every reason', () => {
    for (const reason of GUIDE_REFUSALS)
      expect(GUIDE_REFUSAL_SENTENCES[reason]).toMatch(/\.$/)
  })
})

describe('the session request', () => {
  const request = { voice: 'cedar', sdp: 'v=0', scene: 'Saturn, gibbous.' }

  it('reads a request inside its limits', () => {
    expect(decode(decodeGuideSessionRequest, request).ok).toBe(true)
  })

  it('bounds the scene in bytes, not in UTF-16 units', () => {
    // Three bytes a character in UTF-8, one unit in UTF-16: 600 of them are
    // 600 units, inside a bound counted in units, and 1,800 bytes, outside
    // the provider's.
    const scene = '…'.repeat(600)
    expect(scene.length).toBeLessThan(GUIDE_SESSION_LIMITS.sceneBytes)
    expect(decode(decodeGuideSessionRequest, { ...request, scene }).ok).toBe(
      false,
    )
  })

  it('refuses an unknown voice, an empty offer and an oversized one', () => {
    for (const change of [
      { voice: 'nobody' },
      { sdp: '' },
      { sdp: 'a'.repeat(GUIDE_SESSION_LIMITS.sdpBytes + 1) },
    ])
      expect(
        decode(decodeGuideSessionRequest, { ...request, ...change }).ok,
      ).toBe(false)
  })

  it('reads the session the Worker created', () => {
    expect(
      decode(decodeGuideSessionCreated, {
        sessionId: 'live_1',
        expiresAt: 0,
        sdp: 'answer',
      }).ok,
    ).toBe(true)
    expect(
      decode(decodeGuideSessionCreated, {
        sessionId: '',
        expiresAt: 0,
        sdp: 'a',
      }).ok,
    ).toBe(false)
  })
})

describe('utf8Bytes', () => {
  it('counts what a UTF-8 encoder writes', () => {
    // `encodeURIComponent` writes each UTF-8 byte outside the unreserved set
    // as one `%XX`, and each unreserved byte as itself.
    const reference = (text: string): number =>
      encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, '.').length
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (text) => {
        expect(utf8Bytes(text)).toBe(reference(text))
      }),
    )
  })
})
