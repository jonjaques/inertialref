import { useLocation, useNavigate } from 'react-router'
import { Footprints, LockKeyhole, PersonStanding } from 'lucide-react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Action } from '../hud/Action.tsx'
import { useChromeHidden } from '../hud/chrome.ts'
import { CROSSHAIR_RING } from '../hud/crosshair.ts'
import { useActionTitle, useKeyLabel } from '../input/useKeymap.ts'
import {
  isOverlayPath,
  modeForPath,
  PLAY_SOLO,
  resolvedLocation,
} from '../pages/paths.ts'
import { useEngine, useShallow } from '../state/engineStore.ts'
import { useCharacterControls } from './useCharacterControls.ts'

/** Persistent ownership lets the pointer survive entering play from the planetarium. */
export function CharacterControls({ engine }: { engine: GameEngine }) {
  const location = useLocation()
  const navigate = useNavigate()
  const mode = modeForPath(resolvedLocation(location).pathname)
  const dialog = isOverlayPath(location.pathname)
  const hidden = useChromeHidden()
  const state = useEngine(
    useShallow((snapshot) => ({
      available: snapshot.character?.available ?? false,
      active: snapshot.character?.active ?? false,
      view: snapshot.character?.view ?? 'first',
      flying: snapshot.character?.flying ?? false,
      canFly: snapshot.character?.canFly ?? false,
      error: snapshot.character?.error ?? null,
      cinema: snapshot.cinema,
    })),
  )
  const enabled =
    (mode === 'flight' || mode === 'planetarium') && !dialog && !state.cinema
  const controls = useCharacterControls(engine.character, {
    enabled,
    active: state.active,
    onEnter: () => {
      if (mode === 'planetarium') void navigate(PLAY_SOLO)
    },
  })
  const lockTitle = useActionTitle(
    'character.lock',
    'Lock the pointer and walk on the surface',
  )
  const lockKey = useKeyLabel('character.lock')
  const viewTitle = useActionTitle(
    'character.view',
    'Switch between first and third person',
  )
  const viewKey = useKeyLabel('character.view')
  const releaseKey = useKeyLabel('character.release')
  const forwardKey = useKeyLabel('character.forward')
  const leftKey = useKeyLabel('character.left')
  const backKey = useKeyLabel('character.back')
  const rightKey = useKeyLabel('character.right')
  const sprintKey = useKeyLabel('character.sprint')
  const crouchKey = useKeyLabel('character.crouch')
  const jumpKey = useKeyLabel('character.jump')
  const error = controls.error ?? state.error

  if (
    !enabled ||
    hidden ||
    (!state.available && !state.active && error === null)
  )
    return null

  return (
    <>
      {controls.locked && (
        <div className="pointer-events-none absolute top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
          <div className={`size-2 ${CROSSHAIR_RING}`} />
        </div>
      )}
      <div className="pointer-events-none absolute top-3 left-1/2 z-20 max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded border border-slate-700 bg-slate-950/90 px-3 py-2 text-center backdrop-blur">
        <div className="type-ui flex flex-wrap items-center justify-center gap-2 text-slate-200">
          <Footprints aria-hidden className="size-3.5 text-sky-300" />
          <span>
            {state.active
              ? state.flying
                ? 'Flying'
                : 'On foot'
              : 'Explore on foot'}
          </span>
          {state.active && (
            <span className="text-slate-400">
              {state.view === 'first' ? 'First person' : 'Third person'}
            </span>
          )}
          {!controls.locked && (
            <Action
              icon={LockKeyhole}
              label={state.active ? 'Resume controls' : 'Lock to walk'}
              title={lockTitle}
              tone="primary"
              className="pointer-events-auto"
              onClick={controls.request}
            />
          )}
          {!controls.locked && state.active && (
            <Action
              icon={PersonStanding}
              label="Change view"
              title={viewTitle}
              className="pointer-events-auto"
              onClick={() => engine.character.toggleView()}
            />
          )}
          {!controls.locked && state.active && (
            <Action
              label="Return to ship"
              title="Leave character controls and return to the ship"
              className="pointer-events-auto"
              onClick={controls.leave}
            />
          )}
        </div>
        {controls.locked ? (
          <p className="type-ui mt-1 text-balance text-slate-400">
            {[forwardKey, leftKey, backKey, rightKey]
              .filter(Boolean)
              .join(' / ')}{' '}
            move · {sprintKey} sprint · {crouchKey} crouch · {jumpKey} jump ·{' '}
            {viewKey} view · {releaseKey} release
          </p>
        ) : (
          <p className="type-ui mt-1 text-balance text-slate-400">
            {lockKey === null
              ? 'Activate the control to capture the pointer.'
              : `${lockKey} captures the pointer.`}{' '}
            Free look stays available before entering.
          </p>
        )}
        {state.active && state.canFly && (
          <p className="type-ui mt-1 text-slate-400">
            Double-tap {jumpKey} to {state.flying ? 'walk' : 'fly'}
            {state.flying ? ` · ${jumpKey} rise · ${crouchKey} descend` : ''}
          </p>
        )}
        {error !== null && (
          <p
            role="status"
            className="type-ui mt-1 max-w-96 text-pretty text-amber-300"
          >
            {error}
          </p>
        )}
      </div>
    </>
  )
}
