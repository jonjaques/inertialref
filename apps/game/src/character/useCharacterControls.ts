import { useEffect, useRef, useState } from 'react'
import type { CharacterController } from '../engine/characterController.ts'
import { useActions, useKeyContext, useKeymap } from '../input/useKeymap.ts'
import { CharacterInput, CHARACTER_HELD_ACTIONS } from './characterInput.ts'
import { PointerLock } from './pointerLock.ts'

export function useCharacterControls(
  controller: CharacterController,
  options: {
    readonly enabled: boolean
    readonly active: boolean
    readonly locked: boolean
    readonly onEnter: () => void
  },
) {
  const latest = useRef(options)
  latest.current = options
  const store = useKeymap()
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [input] = useState(
    () => new CharacterInput(controller, () => performance.now()),
  )
  const [lock] = useState(
    () =>
      new PointerLock({
        enter: () => {
          if (!latest.current.enabled) return false
          if (!controller.active && !controller.enter()) {
            setError(
              controller.error ??
                'Land on a solid surface before entering character controls.',
            )
            return false
          }
          latest.current.onEnter()
          return true
        },
        changed: (value) => {
          controller.lockChanged(value)
          if (!value) input.stop()
          setLocked(value)
        },
        error: setError,
        look: (dx, dy) => controller.look(dx, dy),
      }),
  )

  useEffect(
    () => lock.attach(document, document.documentElement, window),
    [lock],
  )
  useEffect(() => {
    if (!options.enabled) lock.release()
  }, [lock, options.enabled])
  useEffect(() => {
    if (lock.locked && !controller.locked) lock.release()
  }, [lock, controller, options.locked, options.active])
  useEffect(
    () =>
      store.watchContexts(() => {
        if (store.live.includes('dialog') || store.live.includes('cutscene'))
          lock.release()
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

  useKeyContext({ context: 'character-entry' }, options.enabled)
  useKeyContext(
    { context: 'character' },
    options.enabled && (options.active || locked),
  )
  useActions(
    ['character.lock'],
    () => {
      if (lock.locked) lock.release()
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
    () => lock.release(),
    options.enabled && (options.active || locked),
  )

  return {
    locked,
    error,
    request,
    release: () => lock.release(),
    leave: () => {
      lock.release()
      controller.leave()
    },
  }
}
