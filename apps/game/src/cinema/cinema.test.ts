import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  cinemaLink,
  cinemaScene,
  modeForPath,
  modeHasBootCover,
  planetariumLink,
  QUERY,
  stanceForPath,
} from '../pages/paths.ts'
import { MENU_FLARE_ARTIFACTS } from '../pages/menuFraming.ts'
import {
  durationText,
  parseAutoplay,
  parseFrame,
  secondStep,
  secondsText,
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
    // Rounded once, before the split. The library listing rounded the seconds
    // *within* the minute and rendered a 119.6 s scene as `1:60`.
    expect(secondsText(119.6)).toBe('2:00')
    expect(secondsText(59.4)).toBe('0:59')
    expect(secondsText(0)).toBe('0:00')
  })

  it('counts on the rate the scene is actually authored at', () => {
    /*
     * 24000/1001, which is what `TNG_INTRO` runs at and what nothing in this
     * file exercised until the readout was found running backwards. The
     * seconds field ticks between 1006 and 1007 — 23.976 × 42 = 1006.99 — so a
     * frames field wrapping on 24 restarted the second at 23 and then dropped
     * to 0 on the *next* frame.
     */
    const fps = 24_000 / 1001
    expect(timecode(1_006, fps)).toBe('0:41:22')
    expect(timecode(1_007, fps)).toBe('0:42:00')
    expect(timecode(1_008, fps)).toBe('0:42:01')
  })

  it('never goes backwards, at any rate a scene is cut on', () => {
    /*
     * The property the example above is one instance of, and the reason this is
     * a property rather than three more examples: a timecode is a *name* for a
     * frame, and a name that occurs twice in a sequence names nothing. Both
     * halves matter — monotonic, so two people comparing stills agree on which
     * came first, and `frames < ceil(fps)` so the field is a position within
     * its second rather than a counter that has run past it.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(24_000 / 1001, 24, 25, 30_000 / 1001, 30, 60),
        fc.integer({ min: 0, max: 5_000 }),
        (fps, from) => {
          const fields = (at: number): [number, number, number] =>
            timecode(at, fps).split(':').map(Number) as [number, number, number]
          /*
           * A *window* of consecutive frames rather than one sampled frame.
           * The defect was 21 bad transitions in 1500 frames, and a property
           * that picks single frames at random almost never lands on one — it
           * passed against the broken implementation, which is the trap this
           * whole file's header is about. A run of 400 crosses sixteen second
           * boundaries, and every second boundary is where the two rates
           * disagree.
           */
          let previous = fields(from)
          for (let frame = from + 1; frame <= from + 400; frame += 1) {
            const here = fields(frame)
            expect(here[2]).toBeLessThan(Math.ceil(fps))
            expect(here[1]).toBeLessThan(60)
            // Field by field rather than as one number: a frames field is not
            // base 60, and folding it into one would smuggle in the assumption
            // this is meant to be checking.
            const first = here.findIndex((value, i) => value !== previous[i])
            if (first >= 0)
              expect(here[first] as number).toBeGreaterThan(
                previous[first] as number,
              )
            previous = here
          }
        },
      ),
    )
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
    expect(modeForPath('/docs')).toBe('docs')
    expect(modeForPath('/docs/concepts/frames')).toBe('docs')
    expect(modeForPath('/docs/api/spatial/Sector')).toBe('docs')
  })

  /*
   * The documentation's arm is tested for its *boundary* as well as its match,
   * because it is the first predicate in the chain and it is the only one whose
   * prefix is a common English word. Without the slash, `startsWith('/docs')`
   * claims every future route that happens to begin with those five letters,
   * and the reading room would open on it with no page to draw.
   */
  it('does not claim a path that merely starts the same way', () => {
    expect(modeForPath('/docsomething')).toBe('menu')
    expect(modeForPath('/docs-archive')).toBe('menu')
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

describe('the boot cover', () => {
  it('covers the interactive modes and not the content pages', () => {
    // A word of prose is the document; an unlit canvas behind it is a backdrop
    // arriving late, not a page that is not there. A planetarium or a cockpit
    // with no scene yet is a black hole in the mode's own box.
    expect(modeHasBootCover('menu')).toBe(false)
    expect(modeHasBootCover('docs')).toBe(false)
    expect(modeHasBootCover('flight')).toBe(true)
    expect(modeHasBootCover('planetarium')).toBe(true)
    expect(modeHasBootCover('cinema')).toBe(true)
  })
})

describe('the stance a path asks for', () => {
  it('is the menu on the front door and on a cold overlay', () => {
    const menu = stanceForPath('/')
    expect(menu).toEqual({
      showShip: false,
      flareArtifacts: MENU_FLARE_ARTIFACTS,
      observatory: true,
    })
    expect(stanceForPath('/settings')).toEqual(menu)
    expect(stanceForPath('/about')).toEqual(menu)
  })

  it('holds the ship and the observatory for the reading room', () => {
    expect(stanceForPath('/docs')).toEqual({
      showShip: false,
      showOrbits: false,
      flareArtifacts: MENU_FLARE_ARTIFACTS,
      observatory: true,
    })
    expect(stanceForPath('/docs/concepts/frames')).toEqual(
      stanceForPath('/docs'),
    )
  })

  it('gives flight the chase camera on a visible ship', () => {
    expect(stanceForPath('/play/solo')).toEqual({
      showShip: true,
      showOrbits: false,
      observatory: false,
    })
  })

  it('claims the observatory for the planetarium and releases it for cinema', () => {
    expect(stanceForPath('/planetarium')).toEqual({ observatory: true })
    expect(stanceForPath('/cinema')).toEqual({
      showShip: false,
      observatory: false,
    })
  })
})
