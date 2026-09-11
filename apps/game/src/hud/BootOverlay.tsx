import { Check } from 'lucide-react'
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
 * census count, and turns the spinner. The rule between the wordmark and the
 * ledger is the same census drawn as one length.
 *
 * Top right, in the corner nothing else claims at first light. The flight
 * strip lands bottom left the moment the cover lifts, and a readout in that
 * corner read as the strip's own text changing rather than as a cover coming
 * off.
 */
export function BootOverlay({
  phase,
  stages,
  fraction,
  onRevealed,
}: {
  readonly phase: 'booting' | 'revealing'
  readonly stages: readonly BootStage[]
  readonly fraction: number
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
      <motion.div
        // The block lifts a few pixels as the cover goes, so the reveal reads
        // as the cover leaving rather than the scene arriving under a static
        // readout. Reduced motion keeps it still: a transform is instant
        // there, and an instant hop at the start of a fade is a glitch.
        className="m-3 flex w-[min(18rem,100%)] flex-col items-end"
        initial={false}
        animate={{ y: revealing && !reducedMotion ? -8 : 0 }}
        transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
      >
        <Logomark className="h-7 w-auto" />
        {/* The name as the front door sets it — the display face, the accent
            on the second half — one step down, because the front door's size
            names the product once and this corner is not that place. */}
        <div className="type-title mt-3 text-slate-50">
          Inertial<span className="text-sky-400">Ref</span>
        </div>

        {/* The census as a length. A hairline, because structure here is drawn
            with lines rather than fills, and the fill scales rather than
            resizes so it never lays out the column beneath it. */}
        <div
          className="mt-3 h-px w-full overflow-hidden bg-slate-800"
          aria-hidden="true"
        >
          <motion.div
            className="h-full w-full origin-left bg-sky-400"
            initial={false}
            animate={{ scaleX: fraction }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          />
        </div>

        {/* The ledger. Newest at the bottom, so it streams down; `justify-end`
            in a capped box is what keeps the newest line in view once the
            column is taller than the cap — the overflow goes out the *top*,
            where `boot-ledger`'s mask fades the oldest lines rather than
            clipping them, and only once there is something to fade. */}
        <ol
          aria-label="Loading"
          className="boot-ledger mt-2 flex w-full flex-col justify-end"
        >
          {stages.map((stage, index) => {
            const isRunning = index === stages.length - 1
            return (
              <motion.li
                // Append-only, so the index is a stable identity; the label
                // joins it because a producer can legitimately run twice.
                key={`${index}:${stage.label}`}
                className={`type-readout grid grid-cols-[minmax(0,1fr)_auto_0.75rem] items-center gap-x-2 transition-colors duration-500 ${
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
                <span className="text-slate-400">{stage.count}</span>
                <span
                  className="flex size-3 items-center justify-center text-sky-400"
                  aria-hidden="true"
                >
                  {isRunning ? (
                    <svg
                      viewBox="0 0 16 16"
                      className="size-3 animate-spin motion-reduce:animate-none"
                    >
                      <circle
                        cx="8"
                        cy="8"
                        r="6.5"
                        fill="none"
                        stroke="currentColor"
                        strokeOpacity="0.25"
                        strokeWidth="2"
                      />
                      <path
                        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
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
    </motion.div>
  )
}
