import type { CharacterController } from '../engine/characterController.ts'
import type { ActionEvent } from '../input/keymapStore.ts'

export type CharacterInputTarget = Pick<
  CharacterController,
  'locked' | 'input' | 'stop' | 'toggleFlight'
>

/** Two intentional presses; operating-system repeat is filtered by the keymap. */
const FLIGHT_DOUBLE_TAP_MS = 280

export const CHARACTER_HELD_ACTIONS = [
  'character.forward',
  'character.back',
  'character.left',
  'character.right',
  'character.sprint',
  'character.crouch',
  'character.jump',
] as const

/** Held intent enters the canonical controller as one complete input snapshot. */
export class CharacterInput {
  readonly #controller: CharacterInputTarget
  readonly #now: () => number
  readonly #held = new Set<string>()
  #jumpAt: number | null = null

  constructor(controller: CharacterInputTarget, now: () => number) {
    this.#controller = controller
    this.#now = now
  }

  action(id: string, event: ActionEvent): void {
    if (!this.#controller.locked) return
    if (event.phase === 'down') {
      if (this.#held.has(id)) return
      this.#held.add(id)
      if (id === 'character.jump') {
        const now = this.#now()
        if (
          this.#jumpAt !== null &&
          now >= this.#jumpAt &&
          now - this.#jumpAt <= FLIGHT_DOUBLE_TAP_MS
        ) {
          this.#controller.toggleFlight()
          this.#jumpAt = null
        } else this.#jumpAt = now
      }
    } else this.#held.delete(id)
    const held = (action: string): boolean =>
      this.#held.has(`character.${action}`)
    this.#controller.input({
      forward: Number(held('forward')) - Number(held('back')),
      right: Number(held('right')) - Number(held('left')),
      sprint: held('sprint'),
      crouch: held('crouch'),
      jump: held('jump'),
      ascend: held('jump'),
      descend: held('crouch'),
    })
  }

  stop(): void {
    this.#held.clear()
    this.#jumpAt = null
    this.#controller.stop()
  }
}
