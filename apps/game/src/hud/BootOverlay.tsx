import { motion } from 'motion/react'
import { Logomark } from '../icons/Logomark.tsx'

/*
 * The loading screen: a solid cover over the canvas from the first React
 * commit until the scene is provably on screen, then one clean fade.
 *
 * It exists so the reveal can be *gated* rather than hoped for. Boot spends
 * seconds where the canvas is legally black — the renderer probe, `init()`,
 * the warm-up in `render/preload.ts` — and used to spend its first minutes
 * of play paying for textures, atmosphere tables and pipelines on the frames
 * that first needed them. All of that now happens behind this cover, and the
 * fade starts only when `App` has seen both halves finish: the warm-up
 * resolved, and the presentation watchdog's probe found lit pixels. The fade
 * itself is a single full-screen opacity tween — compositor work, so it runs
 * at frame rate no matter what the main thread is finishing up.
 *
 * Visually this continues the `#boot` placeholder in `index.html`: same
 * black ground, same corner, same voice. React clears the placeholder on its
 * first commit, so this component is what stops that clear from flashing the
 * unlit canvas.
 */
export function BootOverlay({
  phase,
  status,
  onRevealed,
}: {
  readonly phase: 'booting' | 'revealing'
  readonly status: string
  readonly onRevealed: () => void
}) {
  return (
    <motion.div
      className={`absolute inset-0 z-50 bg-black ${
        phase === 'booting' ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
      initial={false}
      animate={{ opacity: phase === 'revealing' ? 0 : 1 }}
      transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
      onAnimationComplete={() => {
        if (phase === 'revealing') onRevealed()
      }}
    >
      <div className="absolute bottom-3 left-3">
        <Logomark className="mb-3 h-6 w-auto" />
        <div className="type-readout text-sky-300">InertialRef</div>
        <div
          className="type-readout flex items-center gap-2 text-slate-400"
          role="status"
          aria-live="polite"
        >
          <svg
            viewBox="0 0 16 16"
            className="h-3 w-3 animate-spin text-sky-400"
            aria-hidden="true"
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
          {status}
        </div>
      </div>
    </motion.div>
  )
}
