import { useEffect } from 'react'
import { useParams } from 'react-router'
import type { HarnessStatus } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import { ErrorBoundary } from '../hud/ErrorBoundary.tsx'
import { FlightStrip } from '../hud/FlightStrip.tsx'
import { DeferredMultiplayer } from './DeferredMultiplayer.tsx'
import { NotConnected } from './NotConnected.tsx'

/*
 * Flying.
 *
 * The three play routes are one component because they are one build.
 * `docs/design/modes.md` is emphatic about it — "offline is not a degraded
 * mode, it is the base case" — and the architectural consequence is that
 * `/play/online` is *solo plus a mutation stream*, not a different game. So the
 * chrome is identical and what differs is a single banner saying which of the
 * three you are in and what it does not have yet.
 *
 * When there is a server to talk to, this is where the difference goes: a
 * connection state, other people's discovery records, and nothing else.
 */

const KNOWN = ['solo', 'online', 'multiplayer'] as const
type PlayMode = (typeof KNOWN)[number]

export function FlightMode({
  engine,
  status,
}: {
  engine: GameEngine
  status: HarnessStatus | null
}) {
  const { mode } = useParams<{ mode?: string }>()
  const play: PlayMode = (KNOWN as readonly string[]).includes(mode ?? '')
    ? (mode as PlayMode)
    : 'solo'

  /*
   * The ship is the camera here, so nothing else may be holding it.
   *
   * Belt and braces with the planetarium's own cleanup: arriving at a flight
   * route by a pasted URL, a back button, or a redirect from a mode that threw
   * all have to end with the chase camera on the ship, and an observatory that
   * kept its target would leave the ship flying away from a stationary view.
   */
  useEffect(() => {
    engine.harness.observatory.clear()
    engine.showShip = true
    engine.showOrbits = false
  }, [engine])

  if (play === 'multiplayer') return <DeferredMultiplayer />

  return (
    <>
      <ErrorBoundary
        what="the flight strip"
        className="pointer-events-auto absolute bottom-3 left-3 max-w-[calc(100vw-1.5rem)] font-mono text-[11px]"
      >
        <FlightStrip status={status} />
      </ErrorBoundary>

      {/* The aiming reticle. Centre of frame, and the only permanent piece of
          cockpit chrome this build has — `docs/design/ux.md` specifies the rest
          and none of it is built. */}
      <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="size-4 rounded-full border border-sky-300/40" />
      </div>

      {play === 'online' && <NotConnected />}
    </>
  )
}
