import { useEffect } from 'react'
import { useParams } from 'react-router'
import type { HarnessStatus } from '@inertialref/devtools'
import { Workspace } from '../dock/Workspace.tsx'
import type { DevWorkspace } from '../dock/workspace.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useChromeHidden } from '../hud/chrome.ts'
import { ErrorBoundary } from '../hud/ErrorBoundary.tsx'
import { FlightStrip } from '../hud/FlightStrip.tsx'
import { useFlightContext } from '../hud/useShipControls.ts'
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

/** Flight contributes no panels of its own. Named, so the array is stable. */
const NO_PANELS = [] as const

export function FlightMode({
  engine,
  status,
  dev,
}: {
  engine: GameEngine
  status: HarnessStatus | null
  dev: DevWorkspace
}) {
  const { mode } = useParams<{ mode?: string }>()
  const play: PlayMode = (KNOWN as readonly string[]).includes(mode ?? '')
    ? (mode as PlayMode)
    : 'solo'

  /*
   * The ship is the camera here, so nothing else may be holding it.
   *
   * A stance rather than three assignments, and no longer "belt and braces":
   * it used to set and never restore, which meant a flight mode entered from
   * the menu left the ship visible after the menu came back. Pushed and
   * released, arriving by a pasted URL, a back button, or a redirect from a
   * mode that threw all end with the chase camera on the ship, and leaving puts
   * back whatever was underneath rather than a literal.
   */
  useEffect(
    () =>
      engine.presentation.push({
        showShip: true,
        showOrbits: false,
        observatory: false,
      }).release,
    [engine],
  )

  // The axes are live here and nowhere else. The planetarium binds the arrows
  // to orbiting a camera and `F` to framing a target, and both are flight axes.
  useFlightContext()
  const chromeHidden = useChromeHidden()

  if (play === 'multiplayer') return <DeferredMultiplayer />

  return (
    <>
      {/* The strip and the reticle are chrome, so `Shift+H` clears them. The
          workspace puts itself away — see `hud/chrome.ts`. */}
      {!chromeHidden && (
        <>
          <ErrorBoundary
            what="the flight strip"
            className="type-readout pointer-events-auto absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)]"
          >
            <FlightStrip status={status} />
          </ErrorBoundary>

          {/* The aiming reticle. Center of frame, and the only permanent piece
              of cockpit chrome this build has — `docs/design/ux.md` specifies
              the rest and none of it is built. */}
          <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="size-4 rounded-full border border-sky-300/40" />
          </div>
        </>
      )}

      {play === 'online' && <NotConnected />}

      {/* No panels of its own — the cockpit `docs/design/ux.md` specifies is
          unbuilt, and the flight strip above is the whole of what exists. What
          this gets is the workspace itself, so the author's instruments are
          reachable here in exactly the arrangement and by exactly the gestures
          they are reachable in everywhere else. */}
      <Workspace id="flight" title="Flight" panels={NO_PANELS} dev={dev} />
    </>
  )
}
