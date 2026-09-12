import { AnimatePresence, motion } from 'motion/react'
import { BootLine } from '../hud/BootLine.tsx'
import { useBoot } from '../hud/useBoot.ts'
import type { FramedBody } from './useDocsFraming.ts'

/**
 * The strip of sky that never leaves.
 *
 * Outside the scroller, so it is the one part of this section that does not
 * move: the masthead below it is the same picture, taller, and scrolling
 * shortens the band from nineteen rem to three rather than closing it. There is
 * always a live simulation at the top of a page of documentation about a live
 * simulation.
 *
 * It draws almost nothing itself. The element is transparent — the canvas is a
 * sibling of `.hud-layer` and this is a window onto it, not a picture of one —
 * and the only ink is a readout naming what the camera has found, which is what
 * turns the band from a texture into an instrument. No border underneath: at
 * the top of the page the strip and the masthead are one sky, and the rule
 * that separates them once the page has scrolled is the sticky bar's own.
 *
 * While the scene is still booting the band is the cover's black, and the
 * readout is the boot's running line instead: the framing is solved before
 * the picture exists, and a strip naming "Earth · rocky · observed" over
 * nothing was a readout of a picture nobody could see. The two swap through
 * the same crossfade, so the body's name arrives as the sky does.
 */
export function DocsHorizon({ framed }: { framed: FramedBody | null }) {
  const boot = useBoot()
  const booting = boot !== null && boot.phase !== 'done'
  return (
    <div className="relative flex h-12 shrink-0 items-center justify-end px-4">
      {/*
       * A short gradient at the right edge only.
       *
       * The readout is eleven-pixel mono over whatever the camera is pointed
       * at, and "whatever" includes a sunlit limb. A scrim across the whole
       * strip would put a grey band over the picture the strip exists to show;
       * ten rem of it under the words is the smallest thing that makes them
       * legible, and over empty sky it is invisible.
       */}
      <div className="pointer-events-none absolute inset-y-0 right-0 w-64 bg-gradient-to-l from-slate-950/85 via-slate-950/45 to-transparent" />
      <AnimatePresence mode="wait">
        {booting ? (
          <motion.div
            key="boot"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="relative flex min-w-0 truncate"
          >
            <BootLine boot={boot} />
          </motion.div>
        ) : (
          framed !== null && (
            <motion.div
              key={framed.name}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35 }}
              className="type-readout relative flex min-w-0 items-baseline gap-2 truncate"
              /* A live region would announce a camera move nobody asked for.
               The title attribute is the whole string for a pointer, and the
               readout is decorative to a reader who cannot see the band. */
              title={`${framed.name} — ${framed.detail}`}
            >
              <span className="text-slate-200">{framed.name}</span>
              <span className="truncate text-slate-400">{framed.detail}</span>
            </motion.div>
          )
        )}
      </AnimatePresence>
    </div>
  )
}
