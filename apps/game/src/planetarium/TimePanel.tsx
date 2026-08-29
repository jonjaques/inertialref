import { FastForward, Pause, Play, Rewind } from 'lucide-react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Action } from '../hud/Action.tsx'
import { TransportButton } from '../hud/TransportButton.tsx'
import { nextWarp } from '../hud/warp.ts'
import { useEngine, useShallow } from '../state/engineStore.ts'
import { useActionTitle } from '../input/useKeymap.ts'
import type { PlanetariumContext } from './context.ts'
import { localZone, simulationInstant } from './simulationTime.ts'

/*
 * A transport for the clock, and the instant it is standing at.
 *
 * The shape every planetarium since Stellarium has converged on: slower, play,
 * faster, and a way back to normal time. What is deliberately *not* here is a
 * reverse button, and it is worth writing down why rather than leaving it to be
 * re-proposed. `SimulationClock` counts fixed ticks forward and `setTimeScale`
 * refuses anything that is not positive; ship state is integrated rather than
 * derived, so running it backwards is not a sign flip but a re-simulation from
 * a snapshot. The determinism guarantee — same tick count, same state hash — is
 * built on that being impossible. Time warp is the axis this panel controls.
 *
 * The readout used to be `formatDuration(clock.time)`: "15.23 s", a stopwatch
 * reading in a mode whose entire subject is *when* you are looking. It is an
 * instant now — the elements every orbit is solved from are J2000, so the clock
 * has always had a date, and `@inertialref/shared` is where that mapping lives.
 * A picker that writes into it is the obvious next control and this is the
 * readout it will replace.
 */
export function TimePanel({ engine }: PlanetariumContext) {
  const slower = useActionTitle('time.slower', 'Slower')
  const faster = useActionTitle('time.faster', 'Faster')
  const pause = useActionTitle('time.pause', 'Pause')
  const run = useActionTitle('time.pause', 'Run')
  const realTime = useActionTitle('time.normal', 'Back to normal time')
  /*
   * Four numbers out of the snapshot, not the snapshot.
   *
   * `status` is a fresh object graph every sample and never bails out, so a
   * selector over the whole thing re-renders this eight times a second on a
   * paused clock. Four scalars behind `useShallow` re-render it when one of
   * them moves — which, on a paused clock, is never. The `'use no memo'` this
   * file carried is gone with the mutable read that needed it.
   */
  const world = useEngine(
    useShallow((snapshot) => ({
      time: snapshot.status?.world.time ?? 0,
      timeScale: snapshot.status?.world.timeScale ?? 1,
      achievedTimeScale: snapshot.status?.world.achievedTimeScale ?? 1,
      paused: snapshot.status?.world.paused ?? false,
    })),
  )
  const at = simulationInstant(world.time)
  const normal = world.timeScale === 1

  return (
    <div className="flex flex-col gap-2">
      {/*
       * The instant first, and set in the largest mono step.
       *
       * It is the answer this panel exists to give, and the transport under it
       * is how the answer is changed — which is the order those two belong in.
       */}
      <div title={at.utc}>
        <div className="flex items-baseline gap-2">
          <span className="type-figure shrink-0 text-slate-200">{at.time}</span>
          <span className="type-readout min-w-0 truncate text-slate-300">
            {at.date}
          </span>
        </div>
        <p className="type-micro truncate text-slate-400">{localZone()}</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {/* The keys come from the keymap rather than from the string, so a
            rebind reaches these labels in the same commit that stores it — and
            a screen reader is told the key that is actually bound. */}
        <TransportButton
          label={slower}
          icon={Rewind}
          onClick={() => warp(engine, -1)}
        />
        <TransportButton
          label={world.paused ? run : pause}
          icon={world.paused ? Play : Pause}
          primary
          onClick={() => engine.world.clock.setPaused(!world.paused)}
        />
        <TransportButton
          label={faster}
          icon={FastForward}
          onClick={() => warp(engine, 1)}
        />
        {/*
         * The rate readout *is* the way back to normal time.
         *
         * A separate reset button would be a fourth glyph saying "1×" beside a
         * label already saying "1×". Never disabled, though it was for one
         * revision: at 1× the disabled style took it to 35% opacity, which
         * hides the *readout* — the one number this row exists to show — in
         * order to grey out an action that is a no-op anyway. A reset that is
         * already reset is a control asserting a state, not a dead one.
         */}
        <Action
          label={`${world.timeScale}×`}
          tone={normal ? 'normal' : 'primary'}
          title={
            normal
              ? realTime
              : `${world.timeScale}× — ${realTime.toLowerCase()}`
          }
          onClick={() => engine.world.clock.setTimeScale(1)}
        />
      </div>

      {/* What the clock is actually delivering. Below the requested warp when
          the simulation cannot keep up, and saying so is the whole point —
          `hud/PerfPanel.tsx` found that warp above 5× had never worked. */}
      {world.achievedTimeScale < world.timeScale * 0.95 && (
        <p
          className="type-micro text-amber-300/90"
          title="The simulation is not keeping up with the requested warp"
        >
          {world.achievedTimeScale.toFixed(1)}× actual
        </p>
      )}
    </div>
  )
}

const warp = (engine: GameEngine, direction: number): void => {
  engine.world.clock.setTimeScale(
    nextWarp(engine.world.clock.timeScale, direction),
  )
}
