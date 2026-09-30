import { AnimatePresence, motion } from 'motion/react'
import { BookText, Info, SlidersHorizontal } from 'lucide-react'
import { BootLine } from '../hud/BootLine.tsx'
import { useBoot } from '../hud/useBoot.ts'
import { Logomark } from '../icons/Logomark.tsx'
import { AccountLinks } from './AccountLinks.tsx'
import { FooterLink } from './FooterLink.tsx'
import { ModeLink } from './ModeLink.tsx'
import { ModeRow } from './ModeRow.tsx'
import { Poster } from './Poster.tsx'
import { ENTERABLE, WITHHELD } from './modes.ts'
import { ABOUT, DOCS, SETTINGS } from './paths.ts'
import { MENU_KEYS } from '../input/keymap.ts'
import { useKeyContext } from '../input/useKeymap.ts'
import { useHydrated } from '../state/hydration.ts'

/*
 * The front door.
 *
 * A menu over a running simulation rather than a screen in front of one: the
 * scene behind this is the real engine, framed on Earth, and it keeps turning
 * while the menu is up. That is the same claim `docs/design/ux.md` makes about
 * settings — "the simulation keeps running" — applied to the first thing anyone
 * ever sees, and it is worth the camera code in `MenuScene` because it is the
 * only pitch this project has that a screenshot cannot fake.
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

export function HomePage() {
  const hydrated = useHydrated()
  const boot = useBoot()
  useKeyContext(MENU_KEYS)

  return (
    <Poster>
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
            initial={hydrated ? { y: 12 } : false}
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

      {/* No status pip here. A "simulation running" badge on a front door is
            a product claiming to be live, and this one is a menu over a scene —
            which the turning planet behind the type already says, at no cost
            and without a word. The lead's second line is where the state of
            the project is stated, in a sentence rather than in a label that
            reads like uptime. */}
      <footer className="type-ui flex max-w-[33rem] flex-wrap items-center gap-x-5 gap-y-2">
        <FooterLink to={DOCS} icon={BookText} label="Documentation" />
        <FooterLink to={SETTINGS} icon={SlidersHorizontal} label="Settings" />
        <FooterLink to={ABOUT} icon={Info} label="About" />
        <AccountLinks />
        {/* The scene's own progress, at the end of the status row, while the
              black behind the poster is the cover and not the sky. One line of
              the ledger the scene modes get whole, in the register the figures
              above are set in; it leaves with the cover, a beat after the
              check, so the planet arriving and the line going are one event.
              `ml-auto` in a wrapping row: beside the links while they fit on
              one line, on its own line at the right edge when they do not. */}
        <AnimatePresence>
          {boot !== null && boot.phase !== 'done' && (
            <motion.span
              key="boot"
              className="ml-auto min-w-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
            >
              <BootLine boot={boot} />
            </motion.span>
          )}
        </AnimatePresence>
      </footer>
    </Poster>
  )
}
