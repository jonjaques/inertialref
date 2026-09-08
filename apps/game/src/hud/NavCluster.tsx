import { useState } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useActionTitle } from '../input/useKeymap.ts'
import { useEngine } from '../state/engineStore.ts'
import { Action } from './Action.tsx'
import { ArcGauge } from './ArcGauge.tsx'
import { NavBall } from './NavBall.tsx'
import {
  CLIMB_ARC,
  climbArc,
  climbGauge,
  formatAltitude,
  formatClimb,
  formatSpeed,
  formatThrottle,
  nextSpeedMode,
  orbitLine,
  type SpeedMode,
  speedReading,
  THROTTLE_ARC,
  throttleArc,
} from './navCluster.ts'
import { releaseFocus, FOCUS_RING } from './focus.ts'
import { useCompact } from './viewport.ts'

/*
 * The navigation cluster: the instrument a ship is flown by.
 *
 * `docs/design/ux.md` puts the attitude and horizon at the bottom centre of
 * the cockpit, subtle, and near a body; this is that element with the
 * readings a pilot needs beside it. In the middle the ball, with the heading
 * over it and the pitch and bank under it. On the left the speed — against
 * the ground near one, in the frame away from it, and a press on the readout
 * to insist on either — and the drive's throttle on a ring up the ball's
 * side. On the right the altitude and the rate of climb on the mirrored
 * ring. Under all of it a row of the ship's states — the thrusters, the
 * assist, the drive with the two presses that slam it — and the orbit: the
 * high point, the low point, the lap.
 *
 * It is chrome, so it goes with `Shift+H`, and it is flight's, so it
 * unmounts with the mode and never sees a cutscene. It stands above the IR
 * menu with the notice band between them rather than at the inset the strip
 * uses: the menu owns the bottom edge and a notice lands at `bottom-16`, so
 * this sits at `bottom-24` and the three stack without covering each other.
 * Below the compact breakpoint it is not drawn — piloting on a phone is not
 * designed, and a 30rem instrument is the whole width of one.
 *
 * Every figure but the ball's is read off the 8 Hz sampler, the way the
 * flight strip reads its four lines: `player` is a fresh object every sample
 * and this component re-rendering at that rate is the job. The ball is the
 * one thing that cannot be drawn at 8 Hz, and `NavBall` says why it is not.
 */

/** The ball's diameter, and the rings sit a stroke outside it. */
const BALL = 168
const RING = BALL + 44

export function NavCluster({
  engine,
  onNotice,
}: {
  engine: GameEngine
  onNotice: (message: string) => void
}) {
  const player = useEngine((snapshot) => snapshot.status?.player ?? null)
  const compact = useCompact()
  // Presentation, not the universe: which of two true figures is showing.
  const [speedMode, setSpeedMode] = useState<SpeedMode>('auto')
  const assistTitle = useActionTitle('flight.assist', 'Flight assist')
  const fullTitle = useActionTitle('flight.throttleFull', 'Full burn')
  const cutTitle = useActionTitle('flight.throttleCut', 'Cut the drive')
  const upTitle = useActionTitle('flight.throttleUp', 'Throttle up')
  const downTitle = useActionTitle('flight.throttleDown', 'Throttle down')
  if (player === null || compact) return null

  const speed = speedReading(player, speedMode)
  const orbit = orbitLine(player.orbit)
  const burning = player.throttle > 0

  return (
    <div
      className="pointer-events-none absolute bottom-24 left-1/2 flex w-[30rem] max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-col items-center gap-1"
      aria-label="Navigation cluster"
    >
      <div className="flex items-center justify-center gap-1">
        {/* The speed, and which one it is. */}
        <div className="pointer-events-auto flex w-32 flex-col items-end gap-1">
          <button
            type="button"
            onClick={(event) => {
              releaseFocus(event)
              setSpeedMode(nextSpeedMode(speedMode))
            }}
            title={`Speed ${speed.mode === 'surface' ? 'against the ground' : 'in the frame'}${speedMode === 'auto' ? ', chosen by altitude' : ''} · press to change`}
            className={`w-full rounded border border-slate-700/60 bg-slate-950/85 px-2 py-1 text-right backdrop-blur transition-colors hover:border-sky-500/60 ${FOCUS_RING}`}
          >
            <span className="type-label block text-sky-400/80">
              {speed.mode}
              {speedMode === 'auto' ? '' : ' ·'}
            </span>
            <span className="type-figure block text-slate-200 tabular-nums">
              {formatSpeed(speed.value)}
            </span>
          </button>
          <div className="type-readout flex w-full items-baseline justify-between rounded border border-slate-700/60 bg-slate-950/85 px-2 py-1 backdrop-blur">
            <span className="type-label text-sky-400/80">Drive</span>
            <span
              className={`tabular-nums ${burning ? 'text-sky-200' : 'text-slate-400'}`}
            >
              {formatThrottle(player.throttle)}
            </span>
          </div>
          <div className="flex w-full items-center justify-end gap-1">
            <Action
              label="−"
              title={downTitle}
              onClick={() => engine.nudgeThrottle(-0.05)}
            />
            <Action
              label="+"
              title={upTitle}
              onClick={() => engine.nudgeThrottle(0.05)}
            />
            <Action
              label="Full"
              title={fullTitle}
              tone={player.throttle >= 1 ? 'primary' : 'normal'}
              onClick={() => engine.setThrottle(1)}
            />
            <Action
              label="Cut"
              title={cutTitle}
              onClick={() => {
                engine.setThrottle(0)
                onNotice('drive cut')
              }}
            />
          </div>
        </div>

        {/* The ball, and the two rings that hug it. */}
        <div className="relative flex flex-col items-center">
          <NavBall engine={engine} size={BALL} velocity={speed.mode} />
          <ArcGauge
            size={RING}
            track={THROTTLE_ARC}
            fill={throttleArc(player.throttle)}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          />
          <ArcGauge
            size={RING}
            track={CLIMB_ARC}
            fill={climbArc(climbGauge(player.verticalSpeed))}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          />
        </div>

        {/* The altitude, and the rate of climb. */}
        <div className="pointer-events-auto flex w-32 flex-col items-start gap-1">
          <div className="w-full rounded border border-slate-700/60 bg-slate-950/85 px-2 py-1 backdrop-blur">
            <span className="type-label block text-sky-400/80">
              {player.landed ? 'Landed' : 'Altitude'}
            </span>
            <span className="type-figure block text-slate-200 tabular-nums">
              {formatAltitude(player.altitude)}
            </span>
          </div>
          <div className="type-readout flex w-full items-baseline justify-between rounded border border-slate-700/60 bg-slate-950/85 px-2 py-1 backdrop-blur">
            <span className="type-label text-sky-400/80">Climb</span>
            <span className="text-slate-300 tabular-nums">
              {formatClimb(player.verticalSpeed)}
            </span>
          </div>
          <div className="flex w-full items-center gap-1">
            <span
              className={`type-label rounded border px-1.5 py-0.5 ${
                player.thrusting
                  ? 'border-sky-500/50 bg-sky-500/15 text-sky-200'
                  : 'border-slate-700/60 bg-slate-950/85 text-slate-400'
              }`}
              title="Lit while maneuvering thrust is commanded"
            >
              Thrusters
            </span>
            <Action
              label="Assist"
              title={assistTitle}
              tone={player.flightAssist ? 'primary' : 'normal'}
              onClick={() =>
                onNotice(
                  `flight assist ${engine.toggleFlightAssist() ? 'on' : 'off'}`,
                )
              }
            />
          </div>
        </div>
      </div>

      {/* The orbit. */}
      <div className="type-readout flex items-baseline gap-3 rounded border border-slate-700/60 bg-slate-950/85 px-3 py-1 text-slate-300 tabular-nums backdrop-blur">
        <span>
          <span className="type-label mr-1 text-sky-400/80">Ap</span>
          {orbit.apoapsis}
        </span>
        <span>
          <span className="type-label mr-1 text-sky-400/80">Pe</span>
          {orbit.periapsis}
        </span>
        <span>
          <span className="type-label mr-1 text-sky-400/80">Lap</span>
          {orbit.period}
        </span>
      </div>
    </div>
  )
}
