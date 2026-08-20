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
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-slate-700/60 bg-slate-950/75 px-3 py-2 font-mono text-xs text-slate-200 backdrop-blur">
      <div className="text-sky-300">{player.name}</div>
      <div>{player.localSpeedText} relative to frame</div>
      <div className="text-slate-400">
        {player.altitude === null ? player.frame : `alt ${formatDistance(player.altitude)}`}
      </div>
      <div className="text-slate-500">
        tick {world.tick} · {world.timeScale}×{world.paused ? ' · paused' : ''}
      </div>
    </div>
  )
}
