import { useEffect } from 'react'
import { Link, useParams } from 'react-router'
import { CloudOff, Users } from 'lucide-react'
import type { HarnessStatus } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import { ErrorBoundary } from '../hud/ErrorBoundary.tsx'
import { FlightStrip } from '../hud/FlightStrip.tsx'
import { FOCUS_RING } from '../hud/focus.ts'
import { HOME, PLANETARIUM, PLAY_SOLO } from '../pages/paths.ts'

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

  if (play === 'multiplayer') return <Deferred />

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

/**
 * Solo online, honestly.
 *
 * The mode runs — it is the same complete game — and what is missing is the
 * half that needs a server: shared discovery credit, sync and commissions. It
 * says so once, at the top, rather than pretending or refusing to load.
 */
function NotConnected() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
      {/* A floating surface takes the floating radius; the system has no pill. */}
      <p className="pointer-events-auto flex items-center gap-2 rounded-lg border border-amber-500/30 bg-slate-950/85 px-3 py-1 font-mono text-[10px] text-amber-200/90 backdrop-blur">
        <CloudOff aria-hidden className="size-3.5" />
        playing offline — discovery credit and sync are designed, not built
      </p>
    </div>
  )
}

function Deferred() {
  return (
    <div className="pointer-events-auto absolute inset-0 flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-lg border border-slate-700/60 bg-slate-950/85 p-6 backdrop-blur">
        <h1 className="flex items-center gap-2 text-lg text-slate-100">
          <Users aria-hidden className="size-5 text-slate-400" />
          Multiplayer is deferred
        </h1>
        <p className="mt-3 font-mono text-[11px] leading-relaxed text-slate-400">
          Deliberately, and the seams are the reason it can wait: a star system
          is the unit of authority, partition keys are already a live field on
          every entity, and no hosting vendor’s SDK appears anywhere in the
          engine. See ADR-0008.
        </p>
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-slate-400">
          With few players a shared galaxy is indistinguishable from solo online
          — so the mode degrades into one that already works, rather than
          failing.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 font-mono text-[11px]">
          <Link
            to={PLAY_SOLO}
            className={`rounded border border-sky-500/50 bg-sky-500/15 px-3 py-1.5 text-sky-200 hover:bg-sky-500/25 ${FOCUS_RING}`}
          >
            play solo instead
          </Link>
          <Link
            to={PLANETARIUM}
            className={`rounded border border-slate-700 px-3 py-1.5 text-slate-300 hover:border-sky-500/60 ${FOCUS_RING}`}
          >
            open the planetarium
          </Link>
          <Link
            to={HOME}
            className={`rounded border border-slate-700 px-3 py-1.5 text-slate-400 hover:border-slate-500 ${FOCUS_RING}`}
          >
            back
          </Link>
        </div>
      </div>
    </div>
  )
}
