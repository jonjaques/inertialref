import { describe, expect, it } from 'vitest'
import {
  cinemaLink,
  cinemaScene,
  modeForPath,
  planetariumLink,
  QUERY,
} from '../pages/paths.ts'
import {
  durationText,
  parseAutoplay,
  parseFrame,
  secondStep,
  timecode,
} from './timecode.ts'

/*
 * The cinema player's contract is its URL, so this is a test about links.
 *
 * A link is the deliverable: "look at frame 1150 of the title sequence" has to
 * survive being pasted into a chat client and opened on somebody else's
 * machine, and every step between the button and the address bar is somewhere
 * that can silently round, clamp or drop.
 */

describe('timecode', () => {
  it('reads as minutes, seconds and frames', () => {
    expect(timecode(0, 24)).toBe('0:00:00')
    expect(timecode(23, 24)).toBe('0:00:23')
    expect(timecode(24, 24)).toBe('0:01:00')
    expect(timecode(1_150, 24)).toBe('0:47:22')
  })

  it('says so rather than inventing a number', () => {
    // A scene whose fps has not resolved yet is a real state — the director is
    // asked for its status before the first sample lands.
    expect(timecode(10, 0)).toBe('—')
    expect(timecode(Number.NaN, 24)).toBe('—')
    expect(durationText(100, 0)).toBe('—')
  })

  it('rounds a duration to whole seconds for a listing', () => {
    expect(durationText(24 * 95, 24)).toBe('1:35')
  })
})

describe('the frame in a URL', () => {
  it('clamps to a frame the scene actually has', () => {
    // `duration - 1`, because the director stops *on* the last frame: a seek to
    // it would end the scene rather than show it.
    expect(parseFrame('4000', 1_200)).toBe(1_199)
    expect(parseFrame('0', 1_200)).toBe(0)
    expect(parseFrame('1150', 1_200)).toBe(1_150)
  })

  it('opens at the start rather than refusing', () => {
    // The parameter is typed by hand and pasted from clients that append
    // punctuation. A player that will not open is a worse answer than one that
    // opens at frame zero.
    expect(parseFrame(null, 1_200)).toBe(0)
    expect(parseFrame('', 1_200)).toBe(0)
    expect(parseFrame('halfway', 1_200)).toBe(0)
    expect(parseFrame('-40', 1_200)).toBe(0)
    expect(parseFrame('1150.', 1_200)).toBe(1_150)
  })

  it('treats autoplay as opt-in', () => {
    // A link opens on a still by default: the frame is the thing being shared,
    // and a player that started running would take it off screen immediately.
    expect(parseAutoplay(null)).toBe(false)
    expect(parseAutoplay('0')).toBe(false)
    expect(parseAutoplay('1')).toBe(true)
    expect(parseAutoplay('true')).toBe(true)
  })

  it('steps by a whole frame at every frame rate', () => {
    // 23.976 has no whole number of frames in a second, and a fractional seek
    // lands the playhead between two stills.
    expect(secondStep(24)).toBe(24)
    expect(secondStep(23.976)).toBe(24)
    expect(secondStep(0)).toBe(1)
  })
})

describe('the links themselves', () => {
  it('round-trips a scene and a frame', () => {
    const link = cinemaLink('tng-intro', { frame: 1150.62, autoplay: false })
    expect(link).toBe(`/cinema/tng-intro?${QUERY.frame}=1150`)
    // Floored, not rounded: the playhead is fractional between rendered frames,
    // and a link carrying `1150.62` would claim a precision the reference edit
    // does not have.
    const url = new URL(link, 'https://example.invalid')
    expect(parseFrame(url.searchParams.get(QUERY.frame), 1_200)).toBe(1_150)
  })

  it('leaves frame zero out of the URL', () => {
    // The start is the default, and a link to it should look like a link to
    // the scene rather than a link to a position in it.
    expect(cinemaLink('tng-intro')).toBe('/cinema/tng-intro')
    expect(cinemaLink('tng-intro', { frame: 0 })).toBe('/cinema/tng-intro')
  })

  it('carries autoplay when asked', () => {
    expect(cinemaLink('tng-intro', { autoplay: true })).toContain(
      `${QUERY.autoplay}=1`,
    )
  })

  it('escapes an id rather than pasting it in', () => {
    // Scene ids come from a registry today and could come from a save or a
    // server tomorrow; building a path by concatenation is how a `/` in a name
    // becomes a route.
    expect(cinemaScene('a/b')).toBe('/cinema/a%2Fb')
  })

  it('addresses a planetarium view by what it is looking at', () => {
    expect(planetariumLink('g:milky-way/s:SOL/b:5')).toBe(
      `/planetarium?${QUERY.at}=g%3Amilky-way%2Fs%3ASOL%2Fb%3A5`,
    )
    expect(planetariumLink()).toBe('/planetarium')
  })
})

describe('the mode a path runs in', () => {
  it('maps every route to the thing that owns the camera', () => {
    expect(modeForPath('/')).toBe('menu')
    expect(modeForPath('/play/solo')).toBe('flight')
    expect(modeForPath('/play/multiplayer')).toBe('flight')
    expect(modeForPath('/planetarium')).toBe('planetarium')
    expect(modeForPath('/cinema')).toBe('cinema')
    expect(modeForPath('/cinema/tng-intro')).toBe('cinema')
  })

  it('answers `menu` for an overlay, which is what a cold load means', () => {
    // Opened from inside a mode the router carries that mode's location as the
    // background, so this is only consulted for a cold load — and a cold load
    // of `/settings` has no session behind it.
    expect(modeForPath('/settings')).toBe('menu')
    expect(modeForPath('/settings/display')).toBe('menu')
    expect(modeForPath('/about')).toBe('menu')
    expect(modeForPath('/auth/callback')).toBe('menu')
  })

  it('does not mistake a prefix for a mode', () => {
    // `/planetariums` and `/cinemascope` are not modes. String prefixes are the
    // classic way this goes wrong and the guard costs one character.
    expect(modeForPath('/planetariums')).toBe('menu')
    expect(modeForPath('/cinemascope')).toBe('menu')
    expect(modeForPath('/playground')).toBe('menu')
  })
})
