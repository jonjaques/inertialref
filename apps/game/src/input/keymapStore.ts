import { type Chord, chordFromEvent } from './chord.ts'
import {
  type ActionDefinition,
  type ActionId,
  actionFor,
  arbitrate,
  type Bindings,
  findAction,
  type KeyContext,
  padActions,
  type PadBindings,
  resolveBindings,
  resolvePadBindings,
} from './keymap.ts'
import type { PadControl } from './pad.ts'
import type { PadState } from './padDriver.ts'
import type { PadFamily } from './padFamily.ts'
import { isForeignModal, isOverlayControl, isTyping } from '../hud/focus.ts'

/**
 * The pad driver, as the store sees it: what to draw and how to rumble.
 *
 * A port rather than the class, so the store does not import the driver that
 * imports it, and a test can hand over a stub.
 */
export interface PadPort {
  poll(seconds: number): void
  readonly state: PadState | null
  rumble(strong: number, weak: number, milliseconds: number): void
  capture(take: ((control: PadControl) => void) | null): void
}

/** A pad arriving or leaving, for the notice that says so. */
export interface PadConnection {
  readonly connected: boolean
  readonly id: string
}

/*
 * The one window `keydown` listener, and everything it needs to decide.
 *
 * A plain object rather than a hook, because the thing being modeled outlives
 * every component that talks to it: a mode registers handlers on mount and
 * drops them on unmount, and the listener has to keep working across that
 * without being torn down and rebuilt — which on a touch device drops any
 * gesture in flight and, for the flight axes, leaves the drive burning with
 * nothing listening for the key-up that would stop it.
 *
 * `isTyping` and `isOverlayControl` are asked once, here, because the failure
 * mode of asking per listener is silent: the one that forgets is the one
 * nobody notices. The typing refusal exists because the overlay has text
 * fields — without it, typing `SOL` into the address box fires the retro
 * thruster twice and toggles nothing you meant.
 */

/** Which hand an action came from. Mouse and touch count as the keyboard's. */
export type InputDevice = 'keyboard' | 'pad'

/** What a handler is told when its action fires. */
export interface ActionEvent {
  /**
   * `up` and `change` only ever arrive for a held action.
   *
   * `change` is a stick moving while it stays out of its deadzone: the action
   * is still held and only its magnitude moved. A handler that treats every
   * phase but `down` as a release would stop the thruster the moment the
   * stick shifted, which is why the phase says so rather than repeating
   * `down`.
   */
  readonly phase: 'down' | 'change' | 'up'
  /**
   * How hard, 0..1. One for a key, the stick's shaped magnitude for a pad,
   * and zero on `up`.
   *
   * The held actions are axes with a magnitude, and the keyboard's magnitude
   * is one — so a handler written for the keys and a stick at full throw see
   * the same event, and a stick halfway out is half a thruster.
   */
  readonly value: number
  readonly device: InputDevice
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

/** Told once per frame while frames are running, with the seconds since the last. */
export type FrameConsumer = (seconds: number) => void

/**
 * The longest step a frame consumer is handed, in seconds.
 *
 * A camera turning at a rate integrates `rate × seconds`, and a frame that
 * arrives after a stall — a tab brought back, a long task, a held measurement
 * frame — would otherwise turn it by the stall's length in one jump.
 */
const MAX_FRAME_SECONDS = 1 / 20

/** CSS pixels of pointer travel in one event that count as picking up the mouse. */
const POINTER_SWITCH = 4

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
  #padBindings: PadBindings = resolvePadBindings()
  /** `padActions` for the live set, rebuilt when a claim or a binding moves. */
  #padMap: ReadonlyMap<PadControl, ActionDefinition> | null = null
  readonly #handlers = new Map<ActionId, Set<ActionHandler>>()
  readonly #claims = new Set<ContextClaim>()
  /** Every held action a key is holding down, so a blur can release all of them. */
  readonly #held = new Set<ActionId>()
  /** Every held action a pad is holding, and how far. */
  readonly #padHeld = new Map<ActionId, number>()
  /**
   * The magnitude each held action last reported to its handlers.
   *
   * The two sources are merged here, as the larger of the two, and a handler
   * hears one action rather than two devices: a key let go while the stick
   * still holds the same thruster is a `change` to the stick's magnitude, not
   * an `up` that stops a thruster somebody is still pushing.
   */
  readonly #reported = new Map<ActionId, number>()
  readonly #frames = new Set<FrameConsumer>()
  /** The timestamp of the last frame told, so two clocks share one frame. */
  #lastFrame: number | null = null
  /** Asked to start frames when something new wants them. */
  #wake: () => void = () => {}
  #pad: PadPort | null = null
  readonly #connections = new Set<(event: PadConnection) => void>()
  #device: InputDevice = 'keyboard'
  #family: PadFamily = 'generic'
  /** How many pads are attached, for whether frames must run. */
  #pads = 0
  readonly #watchers = new Set<() => void>()
  /**
   * Told about every key press, before anything is resolved.
   *
   * The cinema's idle timer is the caller: "was there keyboard activity" is a
   * question about the keyboard rather than about any binding, and a listener
   * of its own for it would be a second `keydown` on the window for a question
   * this object already has the answer to.
   */
  readonly #contexts = new Set<() => void>()
  readonly #activity = new Set<() => void>()
  /** What a physical key is called on the keyboard actually attached. */
  #layout: ReadonlyMap<string, string> | null = null

  get bindings(): Bindings {
    return this.#bindings
  }

  get layout(): ReadonlyMap<string, string> | null {
    return this.#layout
  }

  get padBindings(): PadBindings {
    return this.#padBindings
  }

  /**
   * Which hand was used last, which is what every prompt should name.
   *
   * Decided by input rather than by what is attached, because a pad plugged
   * in and lying on the desk is not how somebody is playing: a prompt that
   * printed ✕ the moment a controller connected would be wrong for everybody
   * who keeps one connected and flies with the mouse.
   */
  get device(): InputDevice {
    return this.#device
  }

  /** The family of the pad used last, for its glyphs. */
  get family(): PadFamily {
    return this.#family
  }

  get pads(): number {
    return this.#pads
  }

  /**
   * The contexts live right now, in no particular order.
   *
   * Deliberately not "innermost last": React runs child effects before parent
   * ones, so a nested claim is inserted *first*, and a reader who believed the
   * order would write a resolver that took the last match. `actionFor` decides
   * by `SPECIFICITY` and membership, both order-independent, which is what
   * makes the arbitration a stated rule rather than an accident of mount order.
   */
  get live(): readonly KeyContext[] {
    return ['global', ...[...this.#claims].map((claim) => claim.context)]
  }

  setBindings(bindings: Bindings): void {
    /*
     * Everything held goes up first, because the key-up matches on the *bound*
     * code and the table underneath it is about to move.
     *
     * Rebind the main drive while it is burning and its key-up finds a
     * binding that no longer names the key that was released, so the axis is
     * never cleared and the drive burns for the rest of the session with
     * nothing still listening for the release.
     */
    this.#releaseHeld()
    this.#bindings = bindings
    this.#announce()
  }

  setPadBindings(bindings: PadBindings): void {
    // The keyboard's reason, for the pad: the held set is keyed by action and
    // the table that says which control holds which action is about to move.
    this.#releaseHeld()
    this.#padBindings = bindings
    this.#padMap = null
    this.#announce()
  }

  setLayout(layout: ReadonlyMap<string, string> | null): void {
    this.#layout = layout
    this.#announce()
  }

  /**
   * Somebody used this hand. Labels redraw when it is a change of hand.
   *
   * Called by the keyboard listener, by the pointer and by the pad driver on
   * any input past a deadzone — never on a pad merely connecting.
   */
  useDevice(device: InputDevice, family?: PadFamily): void {
    const moved =
      device !== this.#device ||
      (family !== undefined && family !== this.#family)
    this.#device = device
    if (family !== undefined) this.#family = family
    if (moved) this.#announce()
  }

  /** How many pads are attached. Frames run while one is. */
  setPads(count: number): void {
    const was = this.#pads
    this.#pads = count
    if (count > 0 && was === 0) this.#wake()
    if (count !== was) this.#announce()
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

  /** Observe modal ownership without another window keyboard listener. */
  watchContexts(watcher: () => void): () => void {
    this.#contexts.add(watcher)
    return () => this.#contexts.delete(watcher)
  }

  claim(claim: ContextClaim): () => void {
    this.#claims.add(claim)
    this.#padMap = null
    if (arbitrate(this.live).length !== this.live.length) this.#releaseHeld()
    for (const watcher of this.#contexts) watcher()
    return () => {
      this.#claims.delete(claim)
      this.#padMap = null
      for (const watcher of this.#contexts) watcher()
      // Leaving a context with keys held would leave the drive burning for the
      // rest of the session, with nothing still listening for the key-up.
      this.#releaseUnreachable()
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
    return actionFor(this.#bindings, this.live, pressed, this.#muted())
  }

  #muted(): readonly ActionId[] {
    return [...this.#claims].flatMap((claim) => claim.mutes ?? [])
  }

  /**
   * What every pad control means here, with the same arbitration a key gets,
   * restricted to the actions somebody has registered a handler for — the
   * keyboard's rule that a binding nobody listens for leaves the input alone.
   */
  padMap(): ReadonlyMap<PadControl, ActionDefinition> {
    this.#padMap ??= padActions(this.#padBindings, this.live, this.#muted())
    return this.#padMap
  }

  /** Whether anything is listening for this action right now. */
  claimed(id: ActionId): boolean {
    return this.#handlers.has(id)
  }

  /**
   * A pad pressed a press action. The pad driver has already latched the
   * edge and decided whether this is a repeat the action asked for.
   */
  padPress(id: ActionId, repeat = false): void {
    if (!this.#handlers.has(id)) return
    this.invoke(id, {
      phase: 'down',
      value: 1,
      device: 'pad',
      shift: false,
      repeat,
    })
  }

  /** A pad holds a held action at this magnitude. Zero lets it go. */
  padHold(id: ActionId, value: number): void {
    if (value > 0) this.#padHeld.set(id, value)
    else this.#padHeld.delete(id)
    this.#report(id, 'pad', false)
  }

  /** The merged magnitude of a held action right now, 0..1. */
  value(id: ActionId): number {
    return this.#reported.get(id) ?? 0
  }

  /**
   * Tell the handlers a held action's new merged magnitude, if it moved.
   *
   * The larger of the two sources, not their sum: a key and a stick on one
   * thruster are two hands asking for the same thing, and full throttle plus
   * full throttle is still full throttle.
   */
  #report(id: ActionId, device: InputDevice, shift: boolean): void {
    const value = Math.max(
      this.#held.has(id) ? 1 : 0,
      this.#padHeld.get(id) ?? 0,
    )
    const was = this.#reported.get(id) ?? 0
    if (value === was) return
    if (value > 0) this.#reported.set(id, value)
    else this.#reported.delete(id)
    if (value > 0 && this.#frames.size > 0 && was === 0) this.#wake()
    this.invoke(id, {
      phase: was === 0 ? 'down' : value === 0 ? 'up' : 'change',
      value,
      device,
      shift,
      repeat: false,
    })
  }

  /**
   * Be told once a frame while frames run.
   *
   * The analog camera is the caller: a stick held at half throw turns the
   * view at half rate for as long as it is held, which is a question about
   * time and not about an edge. Frames run while a pad is attached or a held
   * action is down, and stop otherwise.
   */
  onFrame(consumer: FrameConsumer): () => void {
    this.#frames.add(consumer)
    if (this.#reported.size > 0) this.#wake()
    return () => this.#frames.delete(consumer)
  }

  /** Whether the frame clock should keep running. */
  wantsFrames(): boolean {
    return this.#pads > 0 || (this.#frames.size > 0 && this.#reported.size > 0)
  }

  /** Who to ask for frames. The provider's clock. */
  setWake(wake: () => void): void {
    this.#wake = wake
  }

  /** The pad driver, polled from `tick`. */
  setPad(pad: PadPort | null): void {
    this.#pad = pad
  }

  get pad(): PadPort | null {
    return this.#pad
  }

  /** Be told when a pad arrives or leaves. */
  watchConnections(watcher: (event: PadConnection) => void): () => void {
    this.#connections.add(watcher)
    return () => this.#connections.delete(watcher)
  }

  /** A pad arrived or left. The clock calls this from the window's events. */
  announceConnection(event: PadConnection): void {
    for (const watcher of this.#connections) watcher(event)
  }

  /** Rumble the pad in use, when the pad is in use. A no-op otherwise. */
  rumble(strong: number, weak: number, milliseconds: number): void {
    if (this.#device !== 'pad') return
    this.#pad?.rumble(strong, weak, milliseconds)
  }

  /**
   * One frame, at a `requestAnimationFrame` timestamp in milliseconds.
   *
   * Two clocks call this — the scene's own loop, ahead of the simulation step,
   * and the provider's, for the modes and dialogs where the scene is not
   * running — and every callback in one animation frame is handed the same
   * timestamp, so the second caller in a frame is a no-op. Whichever runs
   * first polls; the scene's runs before the step, so a stick moved this
   * frame moves the ship this frame.
   */
  tick(timestamp: number): void {
    if (timestamp === this.#lastFrame) return
    const seconds =
      this.#lastFrame === null
        ? 0
        : Math.min(
            Math.max((timestamp - this.#lastFrame) / 1000, 0),
            MAX_FRAME_SECONDS,
          )
    this.#lastFrame = timestamp
    this.#pad?.poll(seconds)
    if (seconds === 0) return
    for (const consumer of [...this.#frames]) consumer(seconds)
  }

  handleKeyDown(event: KeyboardEvent): void {
    // Before every refusal below: the cinema's idle timer wants to know that
    // somebody is still here, and typing into a field is still being here.
    for (const watcher of this.#activity) watcher()
    // A trusted key only. The pad steps a focused slider by dispatching the
    // slider's own arrow key (`padNavigation.ts`), and that event bubbles here
    // too — counted as a hand, one tap of the d-pad on the deadzone slider
    // would hand the prompts and the cursor back to a keyboard nobody touched.
    if (event.isTrusted !== false) this.useDevice('keyboard')
    // A key typed into the search box is not a camera command. The focus check
    // is here rather than in the table because "is something else listening" is
    // a fact about the document, not about the key.
    if (isTyping(event) || isForeignModal(event)) return
    const pressed = chordFromEvent(event)
    if (pressed === null) return
    const action = this.resolve(pressed)
    if (action === null) return
    if (action.yieldsToFocus === true && isOverlayControl(event)) return
    /*
     * A binding nobody is listening for leaves the key to the browser.
     *
     * The table advertises an act and a component claims it, and nothing ties
     * the two together — so an id can be bound, drawn on the keys sheet, and
     * offered in the editor while no `useAction` ever registers it. Swallowing
     * the key on top of that is the worst of both: `/` stops being the
     * browser's quick-find in every mode *and* focuses nothing, with the sheet
     * still saying it works. Declining is the honest failure, and it costs
     * nothing when the handler is there.
     */
    if (!this.#handlers.has(action.id)) return
    /*
     * The operating system's auto-repeat, dropped unless the action asked for
     * it.
     *
     * A key leant on is one gesture, not thirty — and a press action is a
     * decision, so thirty of them land on whichever parity the release happened
     * to fall on: held `Space` strobes `clock.paused`, held `]` walks the warp
     * ladder to its top rung, held `F5` re-enters the save. Both listeners this
     * dispatcher replaces opened with `if (event.repeat) return`; `repeats` is
     * where an act that is a *quantity* rather than a decision says so.
     *
     * The `#held` check below is the same refusal for a platform that does not
     * set `repeat` — and for a held axis it is the load-bearing one, because
     * the control vector it feeds has not changed since the key went down.
     */
    if (event.repeat && action.repeats !== true) {
      event.preventDefault()
      return
    }
    if (action.held === true && this.#held.has(action.id)) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    if (action.held === true) {
      this.#held.add(action.id)
      this.#report(
        action.id,
        'keyboard',
        action.shiftScales === true && event.shiftKey,
      )
      return
    }
    this.invoke(action.id, {
      phase: 'down',
      value: 1,
      device: 'keyboard',
      shift: action.shiftScales === true && event.shiftKey,
      repeat: event.repeat,
    })
  }

  /**
   * Activity the pad saw, for the cinema's idle timer — the pad's hand is as
   * present as the keyboard's.
   */
  padActivity(): void {
    for (const watcher of this.#activity) watcher()
  }

  handleKeyUp(event: KeyboardEvent): void {
    const released = chordFromEvent(event)
    // Releasing one Shift while its twin stays held does not stop sprinting.
    if (released?.code === 'Shift' && event.shiftKey) return
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
      this.#report(id, 'keyboard', false)
    }
  }

  /**
   * Everything held goes up, from both hands. Focus leaving the window, a mode
   * unmounting, a binding moving.
   *
   * The pad's holds go too, and the pad driver re-asserts whatever a stick is
   * still pushing on its next poll — against the bindings and contexts that
   * are live *then*, which is the point: a stick held across a mode change
   * must not keep driving an action of the mode that left.
   */
  #releaseHeld(): void {
    const padded = new Set(this.#padHeld.keys())
    const ids = new Set([...this.#held, ...padded])
    this.#held.clear()
    this.#padHeld.clear()
    for (const id of ids)
      this.#report(id, padded.has(id) ? 'pad' : 'keyboard', false)
  }

  /**
   * The held actions no live context reaches any more go up; the rest stay.
   *
   * Narrower than `#releaseHeld` on purpose. A layer leaving — the pad's free
   * look dropping `flight-look` — leaves `flight` live under it, and W held
   * through that is still a thruster somebody is holding: the operating
   * system's repeat never presses it again, so releasing it would cut the
   * thruster until the key was lifted and pressed. A mode leaving makes its own
   * held actions unreachable, so they go, which is the case this exists for.
   */
  #releaseUnreachable(): void {
    const reachable = arbitrate(this.live)
    const padded = new Set(this.#padHeld.keys())
    for (const id of new Set([...this.#held, ...padded])) {
      const action = findAction(id)
      if (action !== undefined && reachable.includes(action.context)) continue
      this.#held.delete(id)
      this.#padHeld.delete(id)
      this.#report(id, padded.has(id) ? 'pad' : 'keyboard', false)
    }
  }

  /** The pad's own release: a disconnect, or a pad driver losing its pads. */
  releasePad(): void {
    for (const id of [...this.#padHeld.keys()]) this.padHold(id, 0)
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
    /*
     * The pointer hands the prompts back to the keyboard.
     *
     * Movement rather than any `pointermove`, because a mouse resting on a
     * desk while somebody flies with a pad still reports the odd sub-pixel
     * twitch, and prompts that flickered between ✕ and Space on a twitch
     * would be worse than prompts that lagged a real switch by a frame.
     */
    const pointer = (event: PointerEvent): void => {
      if (this.#device === 'keyboard') return
      if (
        event.type === 'pointermove' &&
        Math.abs(event.movementX) + Math.abs(event.movementY) < POINTER_SWITCH
      )
        return
      this.useDevice('keyboard')
    }
    target.addEventListener('keydown', down)
    target.addEventListener('keyup', up)
    target.addEventListener('blur', blur)
    target.addEventListener('pointerdown', pointer)
    target.addEventListener('pointermove', pointer, { passive: true })
    return () => {
      target.removeEventListener('keydown', down)
      target.removeEventListener('keyup', up)
      target.removeEventListener('blur', blur)
      target.removeEventListener('pointerdown', pointer)
      target.removeEventListener('pointermove', pointer)
      this.#releaseHeld()
    }
  }
}
