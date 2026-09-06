import { presentationClock } from '../hud/time.ts'
import { PictureTime } from './PictureTime.tsx'
import { FastForward, Pause, Play, Rewind } from 'lucide-react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Action } from '../hud/Action.tsx'
import { TransportButton } from '../hud/TransportButton.tsx'
import { nextWarp } from '../hud/warp.ts'
import { useEngine, useShallow } from '../state/engineStore.ts'
import { useActionTitle } from '../input/useKeymap.ts'
import type { PlanetariumContext } from './context.ts'
import { localZone, simulationInstant } from './simulationTime.ts'

/** The photographic clock follows the simulation until a shot or date holds it. */
export function TimePanel(context: PlanetariumContext) {
  const { engine } = context
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
      time: snapshot.observer?.time ?? snapshot.status?.world.time ?? 0,
      held: snapshot.observer?.heldTime != null,
      timeScale:
        snapshot.observer?.heldTime != null
          ? snapshot.observer.timeScale
          : (snapshot.status?.world.timeScale ?? 1),
      achievedTimeScale: snapshot.status?.world.achievedTimeScale ?? 1,
      paused:
        snapshot.observer?.heldTime != null
          ? snapshot.observer.timePaused
          : (snapshot.status?.world.paused ?? false),
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

      <PictureTime {...context} />
      {world.held && (
        <div className="flex items-center gap-2">
          <span className="type-ui text-slate-400">Preset Time</span>
          <Action
            label="Live Time"
            onClick={() => engine.harness.observatory.setTime(null)}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* The keys come from the keymap rather than from the string, so a
            rebind reaches these labels in the same commit that stores it — and
            a screen reader is told the key that is actually bound. */}
        <TransportButton
          label={slower}
          icon={Rewind}
          onClick={() => {
            warp(engine, -1)
          }}
        />
        <TransportButton
          label={world.paused ? run : pause}
          icon={world.paused ? Play : Pause}
          primary
          onClick={() => {
            const clock = presentationClock(engine)
            clock.setPaused(!clock.paused)
          }}
        />
        <TransportButton
          label={faster}
          icon={FastForward}
          onClick={() => {
            warp(engine, 1)
          }}
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
        {/* Pushed to the far end, because it is a readout that happens to be
            pressable and not a fourth transport key. Beside the other three it
            read as one of them, in a row with 8 rem of empty panel after it. */}
        <Action
          label={`${world.timeScale}×`}
          className="ml-auto"
          tone={normal ? 'normal' : 'primary'}
          title={
            normal
              ? realTime
              : `${world.timeScale}× — ${realTime.toLowerCase()}`
          }
          onClick={() => {
            presentationClock(engine).setTimeScale(1)
          }}
        />
      </div>

      {/* What the clock is actually delivering. Below the requested warp when
          the simulation cannot keep up, and saying so is the whole point —
          `hud/PerfPanel.tsx` found that warp above 5× had never worked. */}
      {!world.held && world.achievedTimeScale < world.timeScale * 0.95 && (
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
  const clock = presentationClock(engine)
  clock.setTimeScale(nextWarp(clock.timeScale, direction))
}
