import { Check, LoaderCircle } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { Logomark } from '../icons/Logomark.tsx'
import type { BootStage } from '../render/bootState.ts'
import { useHydrated } from '../state/hydration.ts'

/*
 * The cover's block: the mark, the name, the census as a rule, and the ledger
 * of every stage the wait has been through.
 *
 * Its own component because two covers draw it. The document arrives with a
 * scene mode's admission — server-rendered, one line, before there is a
 * runtime — and the runtime then mounts `BootOverlay` over it with the same
 * block in the same corner, one line longer. Drawn by one component from one
 * shape, the hand-off is the ledger growing; drawn by two, it was a title
 * card giving way to a different screen, which is the flash this replaces.
 *
 * A ledger rather than a status line. One line replacing itself fourteen
 * times in five seconds is a flicker the eye cannot read, where a column that
 * grows is a record of what the wait bought. A finished line settles to the
 * label grade and takes a check; the running one is the brightest neutral,
 * carries the census count, and turns the ring. The rule between the wordmark
 * and the ledger is the same census drawn as one length.
 *
 * It lays out in flow, at the end of a row, and insets itself with a margin:
 * the covers that hold it are `hud-bleed` boxes, whose padding reaches only
 * an in-flow child — an `absolute top-3 right-3` block would resolve against
 * the bled-out edge and sit under the notch.
 */
export function BootLedger({
  stages,
  fraction,
  lifted,
  halted = false,
}: {
  readonly stages: readonly BootStage[]
  readonly fraction: number
  /** The cover is leaving; the block goes with it, to say which of the two is. */
  readonly lifted: boolean
  /**
   * The wait is over and nothing arrived. The running line keeps its name
   * and loses the ring: a spinner over a runtime that has already failed is
   * a promise, and the notice beside it has just withdrawn that promise.
   */
  readonly halted?: boolean
}) {
  const reducedMotion = useReducedMotion()
  /*
   * A line entering belongs to a live ledger. The admission's first line is
   * server-rendered, and an entrance there is an inline `opacity: 0` that
   * nothing lifts until hydration — which is never, without JavaScript, and
   * the one line the page had was invisible. `initial` is read once, at
   * mount, so the line the document arrives with is still and every line
   * the runtime appends after hydration streams in.
   */
  const hydrated = useHydrated()

  return (
    <motion.div
      // Reduced motion keeps the block still through the reveal: a transform
      // is instant there, and an instant hop at the start of a fade is a
      // glitch rather than a courtesy.
      className="m-3 flex w-[min(18rem,100%)] flex-col items-end"
      initial={false}
      animate={{ y: lifted && !reducedMotion ? -8 : 0 }}
      transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
    >
      {/* The name as the front door sets it — the display face, the accent
        on the second half — one step down, because the front door's size
        names the product once and this corner is not that place. The mark
        keeps the front door's proportion to the name rather than its size:
        three quarters of the name's height, so the name leads. */}
      <Logomark className="h-4 w-auto" />
      <div className="type-title mt-2 text-slate-50">
        Inertial<span className="text-sky-400">Ref</span>
      </div>

      {/* The census as a length. A hairline, because structure here is drawn
        with lines rather than fills; the track is the system's hairline grade
        rather than a darker one, because on void black the darker one is
        1.4:1 and the fill then reads as a line growing rather than as a
        fraction of a known length. The fill scales rather than resizes so it
        never lays out the column beneath it. */}
      <div
        className="mt-3 h-px w-full overflow-hidden bg-slate-700"
        aria-hidden="true"
      >
        <motion.div
          className="h-full w-full origin-left bg-sky-400"
          initial={false}
          animate={{ scaleX: fraction }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>

      {/* The ledger. Newest at the bottom, so it streams down; `content-end`
        in a capped box is what keeps the newest line in view once the column
        is taller than the cap — the overflow goes out the *top*, where
        `boot-ledger`'s mask fades the oldest lines rather than clipping them,
        and only once there is something to fade.

        One grid for the whole column, rows on a subgrid, so the count column
        has one width and every label ends on the same edge. A grid per row
        sized its own count column, and a ledger whose counts run from `25/71`
        to `89/173` then had three label edges. */}
      <ol
        aria-label="Loading"
        className="boot-ledger mt-2 grid w-full grid-cols-[minmax(0,1fr)_auto_0.75rem] content-end gap-x-2"
      >
        {stages.map((stage, index) => {
          const isRunning = index === stages.length - 1
          return (
            <motion.li
              // Append-only, so the index is a stable identity; the label
              // joins it because a producer can legitimately run twice.
              key={`${index}:${stage.label}`}
              className={`type-readout col-span-3 grid grid-cols-subgrid items-center transition-colors duration-500 ${
                isRunning && !halted ? 'text-slate-200' : 'text-slate-400'
              }`}
              initial={hydrated ? { opacity: 0, y: -6 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            >
              <span className="truncate text-right">
                {stage.label}
                {isRunning && !halted && stage.count === null ? '…' : ''}
              </span>
              <span className="text-right text-slate-400">{stage.count}</span>
              {/* Both glyphs from one library, so the ring a running line
                turns and the check it becomes are one stroke and one extent;
                an authored ring on a 16 grid was half again as heavy as the
                check beneath it. */}
              <span
                className="flex size-3 items-center justify-center text-sky-400"
                aria-hidden="true"
              >
                {isRunning ? (
                  halted ? null : (
                    <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
                  )
                ) : (
                  <Check className="size-3" />
                )}
              </span>
            </motion.li>
          )
        })}
      </ol>
    </motion.div>
  )
}
