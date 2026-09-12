import { motion } from 'motion/react'
import type { BootStage } from '../render/bootState.ts'
import { BootLedger } from './BootLedger.tsx'
import { BootNav } from './BootNav.tsx'

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
 * Two forms, chosen by the mode the cover is under. A mode that owns the scene
 * — flight, the planetarium, the cinema — gets the whole cover: black to the
 * edges, the ledger in `hud/BootLedger.tsx` top right, the way out bottom
 * right. It continues the admission `pages/ModeRoutes.tsx` server-renders at
 * the same address, which draws the same block one line shorter, so the
 * runtime arriving is the ledger growing and not a screen being replaced. A
 * page that is readable without a scene — the front door, the reading room —
 * gets the `quiet` form: the black ground and the announcement, nothing
 * drawn, because the page above it carries the mark and the name already
 * and draws its own line of the ledger where its layout has room for one.
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
  const revealing = phase === 'revealing'
  const running = stages[stages.length - 1]

  return (
    <motion.div
      // `hud-bleed`: this is the whole screen going black before first light,
      // so it has to reach past the safe areas `.hud-layer` holds its chrome
      // inside. The block and the nav below it do not, and `flex-col
      // items-end justify-between` is what says so: `hud-bleed` pads the
      // insets back, and padding only reaches a child that is *in flow* — an
      // `absolute top-3 right-3` readout would resolve against the bled-out
      // edge and sit under the notch.
      className={`hud-bleed absolute z-50 flex flex-col items-end justify-between bg-black ${
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
        <>
          <BootLedger stages={stages} fraction={fraction} lifted={revealing} />
          <div className="m-3">
            <BootNav />
          </div>

          {/* The live region announces a stage once, when it starts. The list
            itself is not live: a census reporting every unit would read
            "22 of 55, 23 of 55" for the whole of boot. */}
          <p className="sr-only" role="status" aria-live="polite">
            {running?.label}
          </p>
        </>
      )}
    </motion.div>
  )
}
