import { type Chord, chordFromEvent } from './chord.ts'
import {
  type ActionDefinition,
  type ActionId,
  actionFor,
  type Bindings,
  type KeyContext,
  resolveBindings,
} from './keymap.ts'
import { isOverlayControl, isTyping } from '../hud/focus.ts'

/*
 * The one window `keydown` listener, and everything it needs to decide.
 *
 * A plain object rather than a hook, because the thing being modelled outlives
 * every component that talks to it: a mode registers handlers on mount and
 * drops them on unmount, and the listener has to keep working across that
 * without being torn down and rebuilt — which on a touch device drops any
 * gesture in flight and, for the flight axes, leaves the drive burning with
 * nothing listening for the key-up that would stop it.
 *
 * `isTyping` and `isOverlayControl` are asked once here, where they used to be
 * asked in three listeners with a fourth that had forgotten to. The typing
 * refusal exists because the overlay has text fields: without it, typing `SOL`
 * into the address box fires the retro thruster twice and toggles nothing you
 * meant.
 */

/** What a handler is told when its action fires. */
export interface ActionEvent {
  /** `up` only ever arrives for a held action. */
  readonly phase: 'down' | 'up'
  /**
   * Whether Shift was down, for an action that reads it as a magnitude.
   *
   * Always false for everything else, because there Shift is part of the chord
   * and an action that answered to both would be two bindings pretending to be
   * one.
   */
  readonly shift: boolean
  /** True for an auto-repeat. A held action ignores it; a press may not want it. */
  readonly repeat: boolean
}

export type ActionHandler = (event: ActionEvent) => void

/** What a mode says about itself while it is on screen. */
export interface ContextClaim {
  readonly context: KeyContext
  /**
   * Global actions this context takes back from the keyboard.
   *
   * The reading room is the case: `docs` is the one mode that is a scrolling
   * document, where `Space` is page down. Bound globally it is neither —
   * `preventDefault` takes the scroll and the press pauses the simulation
   * behind the words instead, which is a control nobody reading a page asked
   * for and nothing on screen explains. A mute is the mode saying so, in one
   * place, instead of the pause binding growing a list of modes it is not in.
   */
  readonly mutes?: readonly ActionId[]
}

export class KeymapStore {
  #bindings: Bindings = resolveBindings()
  readonly #handlers = new Map<ActionId, Set<ActionHandler>>()
  readonly #claims = new Set<ContextClaim>()
  /** Every action currently held down, so a blur can release all of them. */
  readonly #held = new Set<ActionId>()
  readonly #watchers = new Set<() => void>()
  /**
   * Told about every key press, before anything is resolved.
   *
   * The cinema's idle timer is the caller: "was there keyboard activity" is a
   * question about the keyboard rather than about any binding, and a listener
   * of its own for it would be a second `keydown` on the window for a question
   * this object already has the answer to.
   */
  readonly #activity = new Set<() => void>()
  /** What a physical key is called on the keyboard actually attached. */
  #layout: ReadonlyMap<string, string> | null = null

  get bindings(): Bindings {
    return this.#bindings
  }

  get layout(): ReadonlyMap<string, string> | null {
    return this.#layout
  }

  /** The contexts live right now, innermost last. */
  get live(): readonly KeyContext[] {
    return ['global', ...[...this.#claims].map((claim) => claim.context)]
  }

  setBindings(bindings: Bindings): void {
    this.#bindings = bindings
    this.#announce()
  }

  setLayout(layout: ReadonlyMap<string, string> | null): void {
    this.#layout = layout
    this.#announce()
  }

  /**
   * Watch for a change of bindings or layout, so labels redraw.
   *
   * Not for the dispatch — a handler is called directly. This is what makes
   * `Action`'s tooltip say the live chord a frame after the editor changes it,
   * without every label subscribing to `localStorage`.
   */
  watch(watcher: () => void): () => void {
    this.#watchers.add(watcher)
    return () => this.#watchers.delete(watcher)
  }

  #announce(): void {
    for (const watcher of this.#watchers) watcher()
  }

  /** Called on every key press, whatever it turns out to mean. */
  watchActivity(watcher: () => void): () => void {
    this.#activity.add(watcher)
    return () => this.#activity.delete(watcher)
  }

  claim(claim: ContextClaim): () => void {
    this.#claims.add(claim)
    return () => {
      this.#claims.delete(claim)
      // Leaving a context with keys held would leave the drive burning for the
      // rest of the session, with nothing still listening for the key-up.
      this.#releaseHeld()
    }
  }

  register(id: ActionId, handler: ActionHandler): () => void {
    const held = this.#handlers.get(id) ?? new Set()
    held.add(handler)
    this.#handlers.set(id, held)
    return () => {
      held.delete(handler)
      if (held.size === 0) this.#handlers.delete(id)
    }
  }

  /** Fire an action by id, as though its key had been pressed. */
  invoke(id: ActionId, event: ActionEvent): void {
    for (const handler of this.#handlers.get(id) ?? []) handler(event)
  }

  /**
   * What a key press means here, or null.
   *
   * Separated from the listener so the decision is testable without a DOM: what
   * is interesting is the resolution against live contexts and mutes, and none
   * of that needs an event.
   */
  resolve(pressed: Chord): ActionDefinition | null {
    const muted = [...this.#claims].flatMap((claim) => claim.mutes ?? [])
    return actionFor(this.#bindings, this.live, pressed, muted)
  }

  handleKeyDown(event: KeyboardEvent): void {
    // Before every refusal below: the cinema's idle timer wants to know that
    // somebody is still here, and typing into a field is still being here.
    for (const watcher of this.#activity) watcher()
    // A key typed into the search box is not a camera command. The focus check
    // is here rather than in the table because "is something else listening" is
    // a fact about the document, not about the key.
    if (isTyping(event)) return
    const pressed = chordFromEvent(event)
    if (pressed === null) return
    const action = this.resolve(pressed)
    if (action === null) return
    if (action.yieldsToFocus === true && isOverlayControl(event)) return
    // A held key that is already down is auto-repeat, and the control vector it
    // feeds does not change — so the repeat is dropped rather than re-applied
    // at the operating system's repeat rate.
    if (action.held === true && this.#held.has(action.id)) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    if (action.held === true) this.#held.add(action.id)
    this.invoke(action.id, {
      phase: 'down',
      shift: action.shiftScales === true && event.shiftKey,
      repeat: event.repeat,
    })
  }

  handleKeyUp(event: KeyboardEvent): void {
    const released = chordFromEvent(event)
    if (released === null) {
      // A key released with Ctrl or Meta newly down still has to end whatever
      // it started, or the axis it drives stays on forever.
      this.#releaseHeld()
      return
    }
    /*
     * Matched on the physical key alone, and deliberately.
     *
     * Shift can go down or up between the press and the release, so a key-up
     * compared as a whole chord misses its own key-down half the time — and for
     * a held axis "misses" means the thruster never stops. The code is what was
     * physically released.
     */
    for (const id of [...this.#held]) {
      const bound = this.#bindings.get(id)
      if (bound === null || bound === undefined) continue
      if (bound.code !== released.code) continue
      this.#held.delete(id)
      this.invoke(id, { phase: 'up', shift: false, repeat: false })
    }
  }

  /** Everything held goes up. Focus leaving the window, or a mode unmounting. */
  #releaseHeld(): void {
    for (const id of [...this.#held]) {
      this.#held.delete(id)
      this.invoke(id, { phase: 'up', shift: false, repeat: false })
    }
  }

  /**
   * Attach to a window. Returns the detach.
   *
   * The single `addEventListener('keydown')` in `apps/game/src` outside tests,
   * and the reason it can be single is everything above: contexts decide what
   * is live, ids decide who is told, and no mode needs a listener of its own to
   * find out that a key was pressed.
   */
  attach(target: Window): () => void {
    const down = (event: KeyboardEvent): void => this.handleKeyDown(event)
    const up = (event: KeyboardEvent): void => this.handleKeyUp(event)
    const blur = (): void => this.#releaseHeld()
    target.addEventListener('keydown', down)
    target.addEventListener('keyup', up)
    target.addEventListener('blur', blur)
    return () => {
      target.removeEventListener('keydown', down)
      target.removeEventListener('keyup', up)
      target.removeEventListener('blur', blur)
      this.#releaseHeld()
    }
  }
}
