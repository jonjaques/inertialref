import { useEffect, useRef, useState } from 'react'
import type { CharacterController } from '../engine/characterController.ts'
import { lookDelta, lookIds } from '../input/lookRate.ts'
import {
  useActionFrame,
  useActions,
  useKeyContext,
  useKeymap,
} from '../input/useKeymap.ts'
import {
  CONTROLS_PAD_TUNING,
  usePersistentState,
} from '../state/preferences.ts'
import {
  CharacterInput,
  CHARACTER_HELD_ACTIONS,
  enterForLock,
} from './characterInput.ts'
import { PointerLock } from './pointerLock.ts'

const LOOK = lookIds('character')

export function useCharacterControls(
  controller: CharacterController,
  options: {
    readonly enabled: boolean
    readonly active: boolean
    readonly locked: boolean
    /** Called once a walker is out, never on a lock that re-takes one. */
    readonly onStepOut: () => void
  },
) {
  const latest = useRef(options)
  latest.current = options
  const store = useKeymap()
  const [pointerLocked, setLocked] = useState(false)
  /*
   * A walker steered from a pad, which takes no pointer lock.
   *
   * Pointer lock exists so a mouse can turn a head without leaving the
   * window; a pad has no pointer to lose, and asking for the lock on its
   * behalf would hide a cursor nobody is using and add a browser banner to a
   * screen somebody is watching. So a pad engages the walker directly, and
   * the walker is steered exactly when either hand holds it.
   */
  const [padEngaged, setPadEngaged] = useState(false)
  const locked = pointerLocked || padEngaged
  const [error, setError] = useState<string | null>(null)
  const [input] = useState(
    () => new CharacterInput(controller, () => performance.now()),
  )
  const [lock] = useState(
    () =>
      new PointerLock({
        enter: () => enterForLock(controller, latest.current, setError),
        changed: (value) => {
          controller.lockChanged(value)
          if (!value) input.stop()
          setLocked(value)
          if (value) setPadEngaged(false)
        },
        error: setError,
        look: (dx, dy) => controller.look(dx, dy),
      }),
  )

  useEffect(
    () => lock.attach(document, document.documentElement, window),
    [lock],
  )
  const disengage = (): void => {
    if (!padEngaged) return
    controller.lockChanged(false)
    input.stop()
    setPadEngaged(false)
  }
  const latestDisengage = useRef(disengage)
  latestDisengage.current = disengage
  const release = (): void => {
    lock.release()
    latestDisengage.current()
  }

  useEffect(() => {
    if (options.enabled) return
    lock.release()
    latestDisengage.current()
  }, [lock, options.enabled])
  useEffect(() => {
    if (lock.locked && !controller.locked) lock.release()
    if (padEngaged && !controller.locked) latestDisengage.current()
  }, [lock, controller, options.locked, options.active, padEngaged])
  useEffect(
    () =>
      store.watchContexts(() => {
        if (store.live.includes('dialog') || store.live.includes('cutscene')) {
          lock.release()
          latestDisengage.current()
        }
      }),
    [store, lock],
  )

  const request = (): void => {
    if (!latest.current.enabled) return
    if (!controller.available()) {
      setError('Land on a solid surface before entering character controls.')
      return
    }
    lock.request()
  }

  /** The pad's `request`: the same step out, without the lock. */
  const engage = (): void => {
    if (!latest.current.enabled) return
    if (!controller.available()) {
      setError('Land on a solid surface before entering character controls.')
      return
    }
    if (!enterForLock(controller, latest.current, setError)) return
    controller.lockChanged(true)
    setPadEngaged(true)
  }

  useKeyContext({ context: 'character-entry' }, options.enabled)
  useKeyContext(
    { context: 'character' },
    options.enabled && (options.active || locked),
  )
  useActions(
    ['character.lock'],
    (_, event) => {
      if (lock.locked || padEngaged) release()
      else if (event.device === 'pad') engage()
      else request()
    },
    options.enabled,
  )
  useActions(
    CHARACTER_HELD_ACTIONS,
    (id, event) => input.action(id, event),
    options.enabled,
  )
  useActions(
    ['character.view'],
    () => controller.toggleView(),
    options.enabled && (options.active || locked),
  )
  useActions(
    ['character.release'],
    release,
    options.enabled && (options.active || locked),
  )

  const [tuning] = usePersistentState(CONTROLS_PAD_TUNING)
  const speed = useRef(tuning.lookSpeed)
  speed.current = tuning.lookSpeed
  // The walker's head at a rate, through the same `look` a locked mouse
  // drives, so the pitch clamp and the yaw the world takes are one path.
  useActionFrame(
    Object.values(LOOK),
    (values, seconds) => {
      const { x, y } = lookDelta(values, LOOK, seconds, speed.current)
      controller.look(x, y)
    },
    options.enabled && locked,
  )

  return {
    locked,
    /** Whether a pad, not the pointer, holds the walker. */
    padEngaged,
    error,
    request,
    release,
    leave: () => {
      release()
      controller.leave()
    },
  }
}
