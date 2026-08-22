import type { HarnessStatus } from '@inertialref/devtools'
import { formatDistance } from '@inertialref/shared'

/**
 * Compact flight readout, bottom left.
 *
 * Deliberately outside the dock: it is what you read *while* flying, and the
 * dock is what you read when you have stopped to look at something. It stays
 * legible with the dock collapsed, which is the state the game is actually
 * played in.
 */
export function FlightStrip({ status }: { status: HarnessStatus | null }) {
  if (status === null || status.player === null) return null
  const { player, world } = status
  // 85% rather than 75%. Measured in front of the Sun filling the frame: at 75%
  // the bottom line of the ladder composites to 2.4:1 and the line above it
  // clears 4.5:1 by 0.01. Alpha is functional here and loses every argument
  // against contrast — DESIGN.md § Legibility-Over-Glass.
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100vw-1.5rem)] rounded-lg border border-slate-700/60 bg-slate-950/85 px-3 py-2 font-mono text-xs text-slate-200 backdrop-blur">
      {/* Entity names come from the universe, and the universe has not promised
          they are short. The strip is anchored to a corner with nothing to push
          against, so an unbounded one would run off the frame. */}
      <div className="truncate text-sky-300" title={player.name}>
        {player.name}
      </div>
      <div className="truncate">{player.localSpeedText} relative to frame</div>
      {/* Four lines in descending brightness, re-spaced onto the grades that
          survive a star behind them: sky-300, 200, 300, 400. It used to end on
          500, which cannot reach 4.5:1 on any ground this system uses. */}
      <div className="truncate text-slate-300">
        {player.altitude === null
          ? player.frame
          : `alt ${formatDistance(player.altitude)}`}
      </div>
      <div className="text-slate-400">
        tick {world.tick} · {world.timeScale}×{world.paused ? ' · paused' : ''}
      </div>
    </div>
  )
}
