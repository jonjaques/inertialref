import type { CSSProperties } from 'react'
import type { CinematicTextState } from '../engine/GameEngine.ts'

/*
 * How a title card is set.
 *
 * Its own module because it is measurement rather than markup — every number
 * below came out of the reference edit's frames or out of the font's own
 * metrics — and because `CutsceneOverlay.tsx` must export components and
 * nothing else, or Fast Refresh gives up on it and a change to one line of
 * chrome reloads the page, rebuilding the renderer and losing the camera.
 */

/** The measured text colour: RGB ≈ (64,138,230); the logo runs deeper. */
const TEXT_BLUE = 'rgb(64,138,230)'
const LOGO_BLUE = 'rgb(24,120,215)'
const ACCENT_GOLD = 'rgb(216,180,90)'
const GLOW = '0 0 14px rgba(64,138,230,0.45)'

/*
 * Sizes are the reference's measured cap heights divided by this face's own
 * cap-height-to-em ratio.
 *
 * Both halves are measurements. The reference's blue-mask row bands give a
 * name's caps as 0.0750 of the frame height, a label's ascenders 0.0546, the
 * subtitle 0.0639, a main-logo word 0.1546 and the opening card's logotype
 * 0.1056. The divisors come from the faces themselves, through
 * `measureText().actualBoundingBoxAscent`: TNG Credits sets caps at 0.80 em
 * and TNG Title at 0.595. Guessing those two instead — 0.72 and 0.7, the usual
 * rules of thumb — set every credit 19% too large and the logotype 15% too
 * small, and no amount of adjusting the *other* end would have found it. Ask
 * the font.
 *
 * With the sizes right the tracking falls out at zero: a name then measures
 * 0.516 of the frame against the reference's 0.489, and a logo word 0.323
 * against 0.328. The old `0.2em` was compensating for a size two steps wrong.
 */
const CAP_RATIO = { credits: 0.8, title: 0.595 } as const
const size = (capFraction: number, face: keyof typeof CAP_RATIO): string =>
  `${(capFraction * 100) / CAP_RATIO[face]}vh`

/**
 * How far the label's box sits above the name's, in vh.
 *
 * Tuned against the rendered result rather than derived: the reference puts a
 * label's cap centre 0.1056 of the frame height above its name's, and what
 * stands between a CSS margin and a cap centre is two line boxes' worth of two
 * fonts' ascent and descent metrics. Measuring the drawn bands and solving for
 * the margin is one round trip; deriving it is several, and wrong again the
 * moment the face changes.
 */
const LABEL_GAP = '2.5vh'

export function textStyle(text: CinematicTextState): CSSProperties {
  const base: CSSProperties = {
    position: 'absolute',
    // `left`/`top` are written every frame, not baked here: the main logotype
    // flies in from off-frame, so position is an animated channel.
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    whiteSpace: 'pre',
    opacity: 0,
    color: TEXT_BLUE,
    textShadow: GLOW,
    fontFamily: "'TNG Credits', ui-sans-serif, sans-serif",
    fontStyle: 'italic',
    lineHeight: 1,
  }
  switch (text.style) {
    case 'logo':
      return {
        ...base,
        fontFamily: "'TNG Title', ui-sans-serif, sans-serif",
        fontStyle: 'normal',
        fontSize: size(0.1546, 'title'),
        letterSpacing: '0',
        color: LOGO_BLUE,
        textShadow: '0 0 22px rgba(24,120,215,0.5)',
      }
    case 'subtitle':
      return {
        ...base,
        fontSize: size(0.0639, 'credits'),
        letterSpacing: '0.02em',
      }
    case 'name':
      return {
        ...base,
        fontSize: size(0.075, 'credits'),
        letterSpacing: '0',
      }
    case 'label':
      return {
        ...base,
        fontSize: size(0.0546, 'credits'),
        letterSpacing: '0',
      }
    case 'card':
      // The display face, not the credits face: the opening and outro cards
      // are titles, and the project's own name should be set the way the
      // main logotype is.
      return {
        ...base,
        fontFamily: "'TNG Title', ui-sans-serif, sans-serif",
        fontStyle: 'normal',
        fontSize: size(0.1056, 'title'),
        letterSpacing: '0.02em',
        color: LOGO_BLUE,
        textShadow: '0 0 18px rgba(24,120,215,0.5)',
      }
    case 'accent':
      return {
        ...base,
        fontSize: size(0.075, 'credits'),
        letterSpacing: '0',
        color: ACCENT_GOLD,
        textShadow: '0 0 14px rgba(216,180,90,0.4)',
      }
  }
}

/*
 * The label line — 'Starring', 'Executive Producer'.
 *
 * Absolutely positioned inside its name's own box, flush left against it,
 * because that is what the reference does and the name's rendered width is a
 * property of the typeface rather than a number the script can supply: every
 * measured pair has the label's left edge within 0.006 of the name's. Anchor
 * the block on the name and the pair survives a font change; position the
 * label independently and it does not.
 */
export function labelStyle(text: CinematicTextState): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    bottom: '100%',
    marginBottom: LABEL_GAP,
    whiteSpace: 'pre',
    fontSize: size(0.0546, 'credits'),
    letterSpacing: '0',
    color: text.style === 'accent' ? ACCENT_GOLD : TEXT_BLUE,
  }
}
