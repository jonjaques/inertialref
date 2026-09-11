import { Check, LoaderCircle } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { Logomark } from '../icons/Logomark.tsx'
import type { BootStage } from '../render/firstLight.ts'

/*
 * The loading screen: a solid cover over the canvas from the runtime's first
 * commit until the scene is provably on screen, then one clean fade.
 *
 * It exists so the reveal can be *gated* rather than hoped for. Boot spends
 * seconds where the canvas is legally black — the renderer probe, `init()`,
 * the warm-up in `render/preload.ts` — and would otherwise spend its first
 * minutes of play paying for textures, atmosphere tables and pipelines on the
 * frames that first needed them. All of that happens behind this cover, and
 * the fade starts only when `App` has seen both halves finish: the warm-up
 * resolved, and the presentation watchdog's probe found lit pixels. The fade
 * itself is a single full-screen opacity tween — compositor work, so it runs
 * at frame rate no matter what the main thread is finishing up.
 *
 * What it shows is a ledger rather than a status line. `render/firstLight.ts`
 * keeps every stage the warm-up has been through and this streams them down
 * the frame as they land: one line replacing itself fourteen times in five
 * seconds is a flicker the eye cannot read, where a column that grows is a
 * record of what the wait bought. A finished line settles to the label grade
 * and takes a check; the running one is the brightest neutral, carries the
 * census count, and turns the ring. The rule between the wordmark and the
 * ledger is the same census drawn as one length.
 *
 * Top right, so the wait is read where the eye already is on an otherwise
 * empty frame, and away from the bottom-left corner the flight strip lands in
 * the moment the cover lifts — a readout there read as the strip's own text
 * changing rather than as a cover coming off. The right pane docks in this
 * corner at first light, so the reveal is the ledger giving way to the
 * navigator in the same column, and the block lifts as it goes to say which
 * of the two is leaving.
 */
export function BootOverlay({
  phase,
  stages,
  fraction,
  quiet,
  onRevealed,
}: {
  readonly phase: 'booting' | 'revealing'
  readonly stages: readonly BootStage[]
  readonly fraction: number
  /**
   * The cover is under a public page: a black ground and the announcement,
   * nothing drawn. The page above carries the mark and the name already.
   */
  readonly quiet: boolean
  readonly onRevealed: () => void
}) {
  const reducedMotion = useReducedMotion()
  const revealing = phase === 'revealing'
  const running = stages[stages.length - 1]

  return (
    <motion.div
      // `hud-bleed`: this is the whole screen going black before first light,
      // so it has to reach past the safe areas `.hud-layer` holds its chrome
      // inside. The readout below it does not, and `flex items-start
      // justify-end` is what says so: `hud-bleed` pads the insets back, and
      // padding only reaches a child that is *in flow* — an `absolute top-3
      // right-3` readout would resolve against the bled-out edge and sit under
      // the notch.
      className={`hud-bleed absolute z-50 flex items-start justify-end bg-black ${
        revealing ? 'pointer-events-none' : 'pointer-events-auto'
      }`}
      initial={false}
      animate={{ opacity: revealing ? 0 : 1 }}
      transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
      onAnimationComplete={() => {
        if (revealing) onRevealed()
      }}
    >
      {quiet ? (
        <p className="sr-only" role="status" aria-live="polite">
          {running?.label}
        </p>
      ) : (
        <motion.div
          // Reduced motion keeps the block still through the reveal: a
          // transform is instant there, and an instant hop at the start of a
          // fade is a glitch rather than a courtesy.
          className="m-3 flex w-[min(18rem,100%)] flex-col items-end"
          initial={false}
          animate={{ y: revealing && !reducedMotion ? -8 : 0 }}
          transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
        >
          {/* The name as the front door sets it — the display face, the accent
            on the second half — one step down, because the front door's size
            names the product once and this corner is not that place. The mark
            keeps the front door's proportion to the name rather than its
            size: three quarters of the name's height, so the name leads. */}
          <Logomark className="h-4 w-auto" />
          <div className="type-title mt-2 text-slate-50">
            Inertial<span className="text-sky-400">Ref</span>
          </div>

          {/* The census as a length. A hairline, because structure here is drawn
            with lines rather than fills; the track is the system's hairline
            grade rather than a darker one, because on void black the darker
            one is 1.4:1 and the fill then reads as a line growing rather than
            as a fraction of a known length. The fill scales rather than
            resizes so it never lays out the column beneath it. */}
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
            in a capped box is what keeps the newest line in view once the
            column is taller than the cap — the overflow goes out the *top*,
            where `boot-ledger`'s mask fades the oldest lines rather than
            clipping them, and only once there is something to fade.

            One grid for the whole column, rows on a subgrid, so the count
            column has one width and every label ends on the same edge. A grid
            per row sized its own count column, and a ledger whose counts run
            from `25/71` to `89/173` then had three label edges. */}
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
                    isRunning ? 'text-slate-200' : 'text-slate-400'
                  }`}
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                >
                  <span className="truncate text-right">
                    {stage.label}
                    {isRunning && stage.count === null ? '…' : ''}
                  </span>
                  <span className="text-right text-slate-400">
                    {stage.count}
                  </span>
                  {/* Both glyphs from one library, so the ring a running line
                    turns and the check it becomes are one stroke and one
                    extent; an authored ring on a 16 grid was half again as
                    heavy as the check beneath it. */}
                  <span
                    className="flex size-3 items-center justify-center text-sky-400"
                    aria-hidden="true"
                  >
                    {isRunning ? (
                      <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Check className="size-3" />
                    )}
                  </span>
                </motion.li>
              )
            })}
          </ol>

          {/* The live region announces a stage once, when it starts. The list
            itself is not live: a census reporting every unit would read
            "22 of 55, 23 of 55" for the whole of boot. */}
          <p className="sr-only" role="status" aria-live="polite">
            {running?.label}
          </p>
        </motion.div>
      )}
    </motion.div>
  )
}
