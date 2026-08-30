import { useEffect } from 'react'
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
import { flightPanels } from './panels.tsx'
import type { PlayMode } from '../pages/paths.ts'

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

/** Flight contributes no panels of its own. Named, so the array is stable. */

export function FlightMode({
  engine,
  status,
  play,
  dev,
  onNotice,
}: {
  engine: GameEngine
  status: HarnessStatus | null
  play: PlayMode
  dev: DevWorkspace
  onNotice: (message: string) => void
}) {
  /*
   * The ship is the camera here. The persisted backdrop already pushed
   * flight's stance from the path; this layer is the mode's own claim, so
   * a panel override over the planetarium still restores to chase-on-ship
   * when flight is the document, and `release` puts back the backdrop's
   * floor rather than a literal.
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

      {/*
       * One panel of its own, and it is the one the deleted Navigate panel was
       * standing in for.
       *
       * The cockpit `docs/design/ux.md` specifies is unbuilt and the flight
       * strip above is the whole of what exists — but *going somewhere* is not
       * scaffolding, and until now the only way to do it in flight was a panel
       * behind the author's disclosure. The Catalog is the product's one
       * navigator, so it is here with the verbs a hull has: Orbit and Land,
       * with Face and Burn beside them, because they are the only way to point
       * a ship at a thing.
       */}
      <Workspace
        id="flight"
        title="Flight"
        panels={flightPanels(engine, onNotice)}
        dev={dev}
      />
    </>
  )
}
