import { useEffect } from 'react'
import { motion } from 'motion/react'
import { BookText, Info, SlidersHorizontal } from 'lucide-react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Logomark } from '../icons/Logomark.tsx'
import { FooterLink } from './FooterLink.tsx'
import { ModeLink } from './ModeLink.tsx'
import { ModeRow } from './ModeRow.tsx'
import { ENTERABLE, WITHHELD } from './modes.ts'
import { ABOUT, DOCS, SETTINGS } from './paths.ts'
import { MENU_KEYS } from '../input/keymap.ts'
import { useKeyContext } from '../input/useKeymap.ts'

/*
 * The front door.
 *
 * A menu over a running simulation rather than a screen in front of one: the
 * scene behind this is the real engine, framed on Earth, and it keeps turning
 * while the menu is up. That is the same claim `docs/design/ux.md` makes about
 * settings — "the simulation keeps running" — applied to the first thing anyone
 * ever sees, and it is worth the four lines of camera code below because it is
 * the only pitch this project has that a screenshot cannot fake.
 *
 * The layout is a poster: type and choices anchored left in a gradient that
 * fades to nothing, so the right two-thirds of the frame is the planet. A
 * centered modal over a scrim would have been easier and would have thrown away
 * the reason to have a scene behind it at all.
 *
 * Four registers, in the order they are read, and the page is mostly an
 * argument for having them:
 *
 *   1. the mark and the name    the display face, once, large
 *   2. what this is             sans prose
 *   3. what is true about it    mono — figures, because they are figures
 *   4. where you can go         two doors, then a line of what is not open
 *
 * Before this the whole page was one weight of one face at four sizes, and the
 * name of the product and the caption under it were separated by 6px and a
 * color. There is nothing subtle about the fix: a real display face, used
 * once.
 */

/*
 * The orbit, in phase rather than in azimuth — which is the whole reason the
 * sun crosses the frame at all.
 *
 * `anglesForPhase` solves the camera against the *sun line*: phase 0 is the
 * fully lit face with the star behind the lens, 180 is dead anti-sun, and it is
 * continuous through 360, so ramping it is a real orbit and not a preset being
 * re-applied. Dragging the azimuth — which is what this used to do — orbits
 * around the world's pole instead, and where the star ends up in that circle
 * depends on which way Sol's ecliptic happens to lie against the galactic
 * plane. The old drift was 0.4°/s of azimuth and the star never reliably
 * entered the frame at all.
 *
 * The numbers, and each of them is a composition decision. The phase magnitudes
 * below were read off the running page, not derived:
 *
 *   PHASE_OPEN   112°  arrival: a broad lit disk turned three-quarters away
 *                      from the star, which is still the blue marble and not
 *                      yet a crescent, with the star just past the right edge.
 *   PHASE_RATE   1.8°/s  a turn in 200 s. The star crosses into frame around
 *                      131° and slides behind the limb around 158°, so it
 *                      climbs into shot about ten seconds after the page opens
 *                      and streams across for the next fifteen. At 150° — the
 *                      picture this was tuned on — the disk is a bright rim on
 *                      the left, the star sits clear of it at two thirds of the
 *                      way across, and the anamorphic streak runs the full
 *                      width of the frame under the type.
 *   SWING_TILT   16°   the orbit is tipped off the star's own plane, so the
 *                      star passes above the limb rather than straight through
 *                      it and the axis reads as tilted rather than flat.
 *   FILL         0.66  a hair smaller than the old 0.78. The extra sky is what
 *                      the streak has to cross.
 *
 * The phase is fed in **negative**, which is not a detail. A phase and its
 * negative put the camera on mirror-image arcs either side of the star line, so
 * the sign decides which half of the frame the star crosses — and the poster's
 * left third is a near-solid gradient with all of the type on it. Measured on
 * the positive arc, the star's image sat at NDC x = −0.58: dead center of the
 * black panel, invisible, with its ghost chain out over the empty sky on the
 * right. Negated it is at +0.58, and the picture is the one described above.
 *
 * The ramp is unbounded and deliberately not wrapped: `anglesForPhase` is built
 * out of a sine and a cosine, so −540° is −180° and the orbit simply keeps
 * going. A modulo here would be a discontinuity waiting to be introduced.
 */
const PHASE_OPEN = -112
const PHASE_RATE = -1.8
const SWING_TILT = 16
const FILL = 0.66

/**
 * How much of the lens's ghost chain the front door shows. About a third.
 *
 * The ghosts are strung along the line from the star through the center of the
 * frame, so the closer the star gets to the right edge the further the chain
 * reaches toward the type on the left — and at full strength the red aperture
 * ring is a 260 px hoop that lands on the paragraph. A flight camera earns its
 * artifacts; a page of type does not.
 *
 * Not zero, because `flare.ts` counts the anamorphic streak as an artifact
 * along with the ghosts, and the streak is the *thing this page is composed
 * around* — a blade of light across the whole frame, which is the contrast the
 * gradient was always missing. A third is where the streak reads and the ring
 * has become two faint colored smudges on empty sky.
 */
const MENU_FLARE_ARTIFACTS = 0.35

/**
 * The three facts worth a stranger's first ten seconds, as figures.
 *
 * The Instrument register on the front door, deliberately: these are the
 * numbers the whole project is a claim about, and a sentence containing "7,123"
 * reads as marketing where a monospaced figure reads as a measurement. Which is
 * what it is — `data/catalog/` has exactly that many systems in it.
 */
const SPEC: readonly (readonly [string, string])[] = [
  ['7,123', 'Real Systems'],
  ['150 ly', 'Cataloged'],
  ['0', 'To Install'],
]

export function HomePage({ engine }: { engine: GameEngine }) {
  useKeyContext(MENU_KEYS)
  /*
   * Frame Earth, and carry the sun across it.
   *
   * Through the observatory rather than by moving the ship: the menu must not
   * change canonical state, so that arriving here from a flight session and
   * leaving again puts you back exactly where you were.
   *
   * The observatory solves the phase at render time, before the engine builds
   * the scene. Its automatic orbit follows the simulated clock, so pausing
   * through the harness holds the camera and the sky at the same instant.
   */
  useEffect(() => {
    const observatory = engine.harness.observatory
    /*
     * The menu's stance. It used to capture the previous values and put them
     * back by hand — the only one of the three writers that did, which is why
     * it was the one that worked. Now nobody remembers anything: `release`
     * means whatever was underneath.
     */
    const stance = engine.presentation.push({
      showShip: false,
      flareArtifacts: MENU_FLARE_ARTIFACTS,
      observatory: true,
    })
    try {
      observatory.focus('s:SOL/b:2', { fill: FILL, ease: false })
      observatory.orbitPhase(PHASE_OPEN, PHASE_RATE, SWING_TILT)
    } catch {
      // A world without Sol is not a world this build makes, but a menu that
      // throws is a black page — and the scene behind it is decoration.
    }

    return () => {
      // Releasing the stance is what drops the observatory's target, so the
      // camera goes back to whatever the next layer is holding.
      stance.release()
    }
  }, [engine])

  return (
    /*
     * `hud-bleed`, because the poster's dark side is *picture*.
     *
     * `.hud-layer` holds its chrome clear of the safe areas, which is right for
     * a readout floating over the scene and wrong for a full-bleed gradient:
     * stopped at the safe area, the column's opaque `slate-950` end leaves a
     * strip of live sunlit planet down the left edge of a landscape phone, with
     * the type still scrimmed and the corner not. The column's own padding
     * takes the insets back, below.
     */
    <div className="hud-bleed pointer-events-none absolute">
      {/*
       * The gradient is the poster's dark side, and where it fades is a
       * measurement rather than a taste.
       *
       * The readable column ends at 33rem plus the 3.5rem gutter — 584px — and
       * the fade has to *start* after that, not through it. At `from-40%` of a
       * 48rem panel it was solid to 307px and half gone by 500, so the second
       * mode card, the withheld list and the whole footer were composited over
       * Earth's sunlit limb at about 1.6:1. The panel is wider than the column
       * on purpose: the extra 14rem is room for the fade to happen in.
       */}
      {/*
       * One entrance for the whole poster, not one per band.
       *
       * It was four: a header fade, a per-card stagger, a fade on the withheld
       * list and another on the footer, each with its own delay. Two things
       * wrong with that. It is four authored moments where a page gets one —
       * and it is four independent ways for a piece of the page to be *absent*,
       * which is not hypothetical: a tab that is not focused has its
       * `requestAnimationFrame` throttled, so a load in a background window
       * left the footer sitting at `opacity: 0` indefinitely with the rest of
       * the page fully drawn.
       *
       * Now the column arrives as one object and the only thing that staggers
       * inside it is the two doors, which is the moment worth authoring: a
       * choice being laid out rather than a page loading.
       */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        /* The gradient runs to the physical edge; the words do not.
           `max(…, var(--safe-…))` on the three edges the column touches, and
           `max` rather than a sum — on anything without a notch this is exactly
           the 1.5/3.5/2.5 rem the design already had, and the inset only bites
           where the OS has spent more. Utilities rather than an inline `style`
           because the left gutter has a breakpoint (`sm`) and an inline rule
           would flatten it to the phone value on every desktop. It is here
           rather than on the `hud-bleed` wrapper because this column is
           absolutely positioned, and padding on an ancestor cannot reach an
           absolutely positioned descendant.

           `justify-center-safe`, not `justify-center`, and it is the other half
           of the notch bug. `justify-content: center` centers the items in the
           *content* box and, when they are taller than it, overflows them
           equally past both padding edges — so on a phone the padding above is
           not a floor, it is a hint the overflow walks straight through.
           Measured on the same iPhone 16 Pro screenshot: `pt` resolved to the
           62 px inset and the mark still drew at 27.5 px, under the clock, with
           `overflow-y-auto` clipping the top and no scroll position that could
           bring it back — the start of an overflowing centered flex box is
           unreachable by construction. `safe center` is the keyword for exactly
           this: center while it fits, align to the start the moment it does
           not. */
        className="pointer-events-auto absolute inset-y-0 left-0 flex w-full max-w-[56rem] flex-col justify-center-safe gap-8 overflow-y-auto bg-gradient-to-r from-slate-950 from-64% via-slate-950/85 via-82% to-transparent pt-[max(2.5rem,var(--safe-top))] pr-6 pb-[max(2.5rem,var(--safe-bottom))] pl-[max(1.5rem,var(--safe-left))] sm:pr-14 sm:pl-[max(3.5rem,var(--safe-left))]"
      >
        <header>
          <Logomark className="mb-5 h-9 w-auto" />
          {/*
           * The one place the display face is set large, and the reason it was
           * chosen. `clamp` rather than a breakpoint: this is a single line of
           * a known length, so it can be sized against the viewport directly
           * instead of stepping between two fixed sizes at an arbitrary width.
           *
           * The accent takes the second half of the word rather than a whole
           * line, which is the same move the mark makes — one form, two tones,
           * the brighter one leading.
           */}
          {/*
           * Hand-kerned, because this is the one string in the product set at
           * poster size, and a kern table is tuned for text. Letter-spacing is
           * added *after* a glyph, so a span around a single letter closes the
           * pair it opens: Archivo leaves the r's arm hanging over the t's
           * crossbar at 76px, and the seam where the white half meets the
           * accent half wants a hair of the same closing so "Ref" reads as the
           * second half of one name rather than a second word.
           */}
          <h1 className="type-display text-[clamp(3rem,7vw,4.75rem)] text-slate-50">
            Ine<span className="tracking-[-0.03em]">r</span>tia
            <span className="tracking-[-0.015em]">l</span>
            <span className="text-sky-400">Ref</span>
          </h1>
          {/*
           * Two beats: what it is aiming at, then where it actually is.
           *
           * The second sentence is the one that took the edit. This page used
           * to state the destination — "fly from interstellar space to a rock
           * you can pick up" — in the present tense, and there is no flying in
           * this build at all: `PRODUCT.md` says pre-alpha, no release, no
           * gameplay, and the list four inches below this says the flight modes
           * are not here. A first viewport that promises the finished game is a
           * promise the next thirty seconds break. Naming the stage costs a
           * line and buys the rest of the page its credibility.
           */}
          <p className="type-body mt-4 max-w-[38ch] text-slate-300">
            A spaceflight simulator, built in the open, in a browser tab. The
            Milky Way is the real one, and the aim is one continuous space —
            interstellar distance down to a rock you could pick up.
          </p>
          <p className="type-body mt-2 max-w-[38ch] text-slate-400">
            It is early. What runs today is the sky, the catalog and the camera.
          </p>

          {/*
           * A rule and three figures. The rule is the system's own hairline,
           * doing what a hairline does everywhere else in it: separating two
           * things that are about different questions.
           */}
          <dl className="mt-5 flex max-w-[33rem] flex-wrap items-baseline gap-x-7 gap-y-2 border-t border-slate-800 pt-4">
            {SPEC.map(([figure, what]) => (
              <div key={what} className="flex items-baseline gap-2">
                <dt className="type-stat text-sky-200">{figure}</dt>
                <dd className="type-label text-slate-400">{what}</dd>
              </div>
            ))}
          </dl>
        </header>

        {/* The column stops well inside the gradient's fade. A card that ran
            to the panel's edge had its last few words dissolving into Earth,
            which is a lovely effect and an unreadable sentence. */}
        <nav aria-label="Modes" className="flex max-w-[33rem] flex-col gap-2.5">
          {ENTERABLE.map((mode, index) => (
            <motion.div
              key={mode.to}
              initial={{ y: 12 }}
              animate={{ y: 0 }}
              /*
               * The one stagger on the page, and it is 70 ms — under the
               * threshold where a delay becomes a wait, and enough that two
               * doors read as being laid out one after the other rather than
               * as a page finishing loading.
               *
               * `y` only. Opacity is the parent's, so a door can never be the
               * one element left invisible if this animation does not run.
               */
              transition={{
                duration: 0.45,
                delay: 0.12 + index * 0.07,
                ease: [0.16, 1, 0.3, 1],
              }}
            >
              <ModeLink mode={mode} />
            </motion.div>
          ))}

          {WITHHELD.length > 0 && (
            <div className="mt-3 border-t border-slate-800 pt-3">
              {/*
               * Named, not hidden. `DESIGN.md` keeps a disabled control on
               * screen because its presence is information, and "there is a
               * flight simulator in here" is the single most useful thing a
               * visitor deciding whether to spend an evening can know. What it
               * must not do is look like a door — see `ModeRow`.
               */}
              <h2 className="type-label mb-2.5 text-slate-400">
                Not in This Build
              </h2>
              <div className="flex flex-col gap-1.5">
                {WITHHELD.map((mode) => (
                  <ModeRow key={mode.to} mode={mode} />
                ))}
              </div>
            </div>
          )}
        </nav>

        {/* No status pip here any more. A "simulation running" badge on a front
            door is a product claiming to be live, and this one is a menu over a
            scene — which the turning planet behind the type already says, at
            no cost and without a word. The lead's second line is where the
            state of the project is stated now, in a sentence rather than in a
            label that reads like uptime. */}
        <footer className="type-ui flex max-w-[33rem] flex-wrap items-center gap-x-5 gap-y-2">
          <FooterLink to={DOCS} icon={BookText} label="Documentation" />
          <FooterLink to={SETTINGS} icon={SlidersHorizontal} label="Settings" />
          <FooterLink to={ABOUT} icon={Info} label="About" />
        </footer>
      </motion.div>
    </div>
  )
}
