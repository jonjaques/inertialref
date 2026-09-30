import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { useHydrated } from '../state/hydration.ts'

/**
 * The menu's page shape: type anchored left in a gradient that fades to
 * nothing, so the right of the frame is the planet `MenuScene` keeps turning.
 * The front door and the account pages share it, which is what makes an
 * account page read as a page of the menu rather than as a dialog over it.
 */
export function Poster({ children }: { children: ReactNode }) {
  const hydrated = useHydrated()
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
      {/* An entrance belongs to client navigation. Initial HTML has to stay
          visible when JavaScript never arrives, and hydration must match it.
          The whole poster shares one opacity so no band can remain hidden. */}
      <motion.div
        initial={hydrated ? { opacity: 0, y: 14 } : false}
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
        {children}
      </motion.div>
    </div>
  )
}
