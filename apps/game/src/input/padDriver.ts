import {
  isPadBindable,
  isPadStick,
  PAD_BUTTONS,
  PAD_CONTROLS,
  type PadControl,
  type PadStick,
} from './pad.ts'
import { type PadFamily, padFamily } from './padFamily.ts'
import {
  AT_REST,
  FLICK_PRESS,
  type Hysteresis,
  latch,
  repeatsDue,
  shapeStick,
  shapeTrigger,
  type StickValue,
  TRIGGER_PRESS,
} from './padShape.ts'
import {
  DEFAULT_TUNING,
  type PadTuning,
  promptFamily,
  stickShapeOf,
} from './padTuning.ts'
import type { ActionDefinition, ActionId } from './keymap.ts'
import type { KeymapStore } from './keymapStore.ts'

/*
 * The pad, read once a frame and told to the keymap.
 *
 * The Gamepad API has no events for input — only for a pad arriving and
 * leaving — so a pad is polled, and in Chromium every `getGamepads()` returns
 * fresh snapshots that are never updated in place: a pad object kept from an
 * earlier frame reads that frame forever. So nothing here holds one. Each poll
 * reads the list, shapes the sticks (`padShape.ts`), and turns what moved into
 * the two calls the store takes: `padHold` for a held action's magnitude and
 * `padPress` for a press. Contexts, mutes and arbitration are the store's, so
 * a control means in a mode exactly what a key in the same place would.
 *
 * Every pad attached is read and merged, the larger value winning per
 * control, because a second pad is somebody handing over a controller rather
 * than a second player — the game has one pilot.
 */

/** The parts of a `Gamepad` this reads. A test hands over plain objects. */
export interface PadReading {
  readonly id: string
  readonly index: number
  readonly connected: boolean
  readonly mapping: string
  readonly timestamp: number
  readonly axes: readonly number[]
  readonly buttons: readonly { readonly value: number }[]
  readonly vibrationActuator?: {
    playEffect?: (
      type: 'dual-rumble',
      params: {
        readonly startDelay: number
        readonly duration: number
        readonly strongMagnitude: number
        readonly weakMagnitude: number
      },
    ) => Promise<unknown>
  } | null
}

/** What the interface layer is asked to do when it has the focus. */
export interface PadNavigator {
  /**
   * Whether a control in the interface has the focus, so the d-pad, the left
   * stick and the two face buttons move it rather than fly anything.
   *
   * The pad's half of `yieldsToFocus`: a focused Radix slider owns the arrow
   * keys, and a focused control owns the d-pad for the same reason.
   */
  owns(): boolean
  move(direction: 'up' | 'down' | 'left' | 'right'): void
  /** The bottom face button: press the focused control. */
  activate(): void
  /**
   * Whether the right face button backs out of something here. When it does
   * not, the button falls through to the keymap — where a dialog's Close is
   * bound to it, so a dialog is closed by the keymap and not by this.
   */
  canBack(): boolean
  /** The right face button: back out. */
  back(): void
  /** The right stick, while the interface has the focus: scroll, px/s. */
  scroll(pixels: number): void
}

/** The navigation controls, which the interface takes when it has the focus. */
const NAV_DIRECTIONS: Readonly<
  Partial<Record<PadControl, 'up' | 'down' | 'left' | 'right'>>
> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  'ls.up': 'up',
  'ls.down': 'down',
  'ls.left': 'left',
  'ls.right': 'right',
}

/** How fast a full right stick scrolls a page the interface has the focus in. */
const SCROLL_PIXELS_PER_SECOND = 1400

/** Past this a stick is somebody's hand rather than drift, for the device switch. */
const ACTIVITY = 0.25

/** What the controls page draws: the pad as the driver last read it. */
export interface PadState {
  readonly id: string
  readonly family: PadFamily
  readonly mapping: string
  /** Every button's value, 0..1, by standard-mapping index. */
  readonly buttons: readonly number[]
  readonly raw: { readonly left: StickValue; readonly right: StickValue }
  readonly shaped: { readonly left: StickValue; readonly right: StickValue }
  readonly vibration: boolean
}

interface Latch {
  /**
   * Who the press belongs to: an action id, `UNBOUND`, or null for the
   * interface's navigation.
   */
  readonly action: ActionId | null
  held: number
  fired: number
  /** Whether the press began under another owner, and so never fires here. */
  readonly carried: boolean
}

/** The owner of a press on a control that means nothing where it was pressed. */
const UNBOUND = ''

export class PadDriver {
  readonly #store: KeymapStore
  readonly #read: () => readonly (PadReading | null)[]
  readonly #navigator: PadNavigator | null
  #tuning: PadTuning = DEFAULT_TUNING
  readonly #values = new Map<PadControl, number>()
  readonly #latched = new Map<PadControl, Latch>()
  /** The held actions the pad reported last poll. */
  #holding = new Set<ActionId>()
  /** The pad that moved last: whose glyphs, and whose motors. */
  #active: PadReading | null = null
  #state: PadState | null = null
  #capture: ((control: PadControl) => void) | null = null
  /** Each control's value when the capture began, or last poll during it. */
  #captureFrom = new Map<PadControl, number>()
  /**
   * The last-seen input timestamp of each pad, by index.
   *
   * A pad whose timestamp has not moved has had no input since the last poll,
   * which is how a pad lying on the desk avoids claiming the prompts from the
   * one in somebody's hands.
   */
  readonly #stamps = new Map<number, number>()

  constructor(
    store: KeymapStore,
    read: () => readonly (PadReading | null)[],
    navigator: PadNavigator | null = null,
  ) {
    this.#store = store
    this.#read = read
    this.#navigator = navigator
  }

  setTuning(tuning: PadTuning): void {
    this.#tuning = tuning
  }

  /** The pad as last read, for the controls page. Null with none attached. */
  get state(): PadState | null {
    return this.#state
  }

  /**
   * Hand the next fresh press to `take`, and nothing else, until it comes.
   *
   * The controls page's rebinding. Fresh is the whole subtlety: the press that
   * started the capture — ✕ on the row's own button — is still down when the
   * capture begins, and taking it would bind every row to the button that
   * opened it. So a control counts only once it rises past its threshold from
   * below during the capture. While it waits, nothing navigates and nothing
   * flies: the press being listened for is not a command.
   */
  capture(take: ((control: PadControl) => void) | null): void {
    this.#capture = take
    this.#captureFrom = new Map(this.#values)
  }

  /** One poll. `seconds` since the last, for repeats; zero on the first. */
  poll(seconds: number): void {
    const pads = this.#read().filter(
      (pad): pad is PadReading => pad !== null && pad.connected,
    )
    this.#store.setPads(pads.length)
    if (pads.length === 0) {
      this.#releaseAll()
      this.#state = null
      this.#active = null
      return
    }
    // This poll's snapshot of the pad that moved last, or none once it has
    // gone: a snapshot kept from an earlier poll reads that poll forever, and
    // one kept after its pad left names, draws and rumbles a pad nobody holds.
    const last = this.#active?.index
    this.#active = pads.find((pad) => pad.index === last) ?? null
    const shape = stickShapeOf(this.#tuning)
    const sticks = this.#merge(pads, shape)
    this.#noticeActivity(pads, sticks.shaped)
    if (this.#capture !== null) {
      this.#captured()
      return
    }
    const consumed = this.#navigate(seconds, sticks.shaped.right)
    this.#dispatch(seconds, consumed)
  }

  /** Read every pad into `#values`, the larger value winning per control. */
  #merge(
    pads: readonly PadReading[],
    shape: ReturnType<typeof stickShapeOf>,
  ): PadState {
    this.#values.clear()
    let left = AT_REST
    let right = AT_REST
    let rawLeft = AT_REST
    let rawRight = AT_REST
    const buttons = PAD_BUTTONS.map(() => 0)
    for (const pad of pads) {
      PAD_BUTTONS.forEach((button, index) => {
        const raw = pad.buttons[index]?.value ?? 0
        const value =
          button === 'l2' || button === 'r2' ? shapeTrigger(raw) : raw
        buttons[index] = Math.max(buttons[index] ?? 0, raw)
        this.#values.set(button, Math.max(this.#values.get(button) ?? 0, value))
      })
      const padLeft = shapeStick(pad.axes[0] ?? 0, pad.axes[1] ?? 0, shape)
      const padRight = shapeStick(pad.axes[2] ?? 0, pad.axes[3] ?? 0, shape)
      if (length(padLeft) > length(left)) {
        left = padLeft
        rawLeft = { x: pad.axes[0] ?? 0, y: pad.axes[1] ?? 0 }
      }
      if (length(padRight) > length(right)) {
        right = padRight
        rawRight = { x: pad.axes[2] ?? 0, y: pad.axes[3] ?? 0 }
      }
    }
    if (rawLeft === AT_REST && pads[0] !== undefined)
      rawLeft = { x: pads[0].axes[0] ?? 0, y: pads[0].axes[1] ?? 0 }
    if (rawRight === AT_REST && pads[0] !== undefined)
      rawRight = { x: pads[0].axes[2] ?? 0, y: pads[0].axes[3] ?? 0 }
    setStick(this.#values, 'ls', left)
    setStick(this.#values, 'rs', right)
    const shown = this.#active ?? pads[0]
    this.#state = {
      id: shown?.id ?? '',
      family: promptFamily(this.#tuning.prompts, padFamily(shown?.id ?? '')),
      mapping: shown?.mapping ?? '',
      buttons,
      raw: { left: rawLeft, right: rawRight },
      shaped: { left, right },
      vibration: typeof shown?.vibrationActuator?.playEffect === 'function',
    }
    return this.#state
  }

  /**
   * Hand the prompts to the pad when somebody uses it.
   *
   * A pad's timestamp moves whenever any of its inputs does, including the
   * noise of a stick at rest on some hardware, so the timestamp alone is not
   * a hand; a button down or a stick past the activity line is.
   */
  #noticeActivity(
    pads: readonly PadReading[],
    shaped: PadState['shaped'],
  ): void {
    let mover: PadReading | null = null
    for (const pad of pads) {
      const moved = this.#stamps.get(pad.index) !== pad.timestamp
      this.#stamps.set(pad.index, pad.timestamp)
      if (moved && active(pad, this.#tuning)) mover = pad
    }
    const anything =
      [...PAD_BUTTONS].some(
        (button) => (this.#values.get(button) ?? 0) > 0.5,
      ) ||
      length(shaped.left) > ACTIVITY ||
      length(shaped.right) > ACTIVITY
    if (mover !== null) this.#active = mover
    if (!anything) return
    const id = (mover ?? this.#active ?? pads[0])?.id ?? ''
    this.#store.useDevice(
      'pad',
      promptFamily(this.#tuning.prompts, padFamily(id)),
    )
    this.#store.padActivity()
  }

  /** One poll of a capture: the first control to rise, if any did. */
  #captured(): void {
    const take = this.#capture
    if (take === null) return
    // Everything held lets go first, so a capture begun mid-burn does not
    // leave the thruster on for as long as the capture waits. The latches
    // stay: a control still down when the capture ends is the press it was,
    // not a fresh one for whatever it means then.
    if (this.#holding.size > 0) this.#store.releasePad()
    this.#holding.clear()
    for (const control of PAD_CONTROLS) {
      if (!isPadBindable(control)) continue
      const value = this.#values.get(control) ?? 0
      const was = this.#captureFrom.get(control) ?? 0
      const threshold = thresholdsFor(control)
      if (value >= threshold.press && was < threshold.press) {
        this.#capture = null
        // Latched as pressed and carried, so the press that was bound does
        // not also fire its new action the moment the capture lets go.
        this.#latched.set(control, {
          action: UNBOUND,
          held: 0,
          fired: 0,
          carried: true,
        })
        take(control)
        return
      }
    }
    this.#captureFrom = new Map(this.#values)
  }

  /**
   * The interface's turn: if it has the focus, the navigation controls are
   * its, and the controls it took are returned so nothing else reads them.
   */
  #navigate(seconds: number, right: StickValue): ReadonlySet<PadControl> {
    const navigator = this.#navigator
    if (navigator === null || !navigator.owns()) return NONE
    const consumed = new Set<PadControl>()
    for (const [control, direction] of Object.entries(NAV_DIRECTIONS) as [
      PadControl,
      'up' | 'down' | 'left' | 'right',
    ][]) {
      consumed.add(control)
      this.#press(control, null, seconds, true, () => navigator.move(direction))
    }
    consumed.add('south')
    this.#press('south', null, seconds, false, () => navigator.activate())
    if (navigator.canBack()) {
      consumed.add('east')
      this.#press('east', null, seconds, false, () => navigator.back())
    }
    for (const control of ['rs.up', 'rs.down', 'rs.left', 'rs.right'] as const)
      consumed.add(control)
    if (right.y !== 0)
      navigator.scroll(right.y * SCROLL_PIXELS_PER_SECOND * seconds)
    return consumed
  }

  /** Everything the interface did not take, through the keymap. */
  #dispatch(seconds: number, consumed: ReadonlySet<PadControl>): void {
    const map = this.#store.padMap()
    const next = new Map<ActionId, number>()
    for (const control of PAD_CONTROLS) {
      if (consumed.has(control)) continue
      const found = map.get(control)
      const action =
        found !== undefined && this.#store.claimed(found.id) ? found : null
      if (action === null || action.held !== true) {
        // A press — or a control that means nothing here, which is still
        // latched, so that it does not fire whatever it comes to mean while
        // it is still held down.
        const store = this.#store
        this.#press(
          control,
          action?.id ?? UNBOUND,
          seconds,
          action?.repeats === true,
          (repeat) => {
            if (action !== null) store.padPress(action.id, repeat)
          },
        )
        continue
      }
      if (this.#carried(control, action.id)) continue
      const value = this.#valueFor(control, action)
      if (value > 0)
        next.set(action.id, Math.max(next.get(action.id) ?? 0, value))
    }
    for (const id of this.#holding)
      if (!next.has(id)) this.#store.padHold(id, 0)
    for (const [id, value] of next) this.#store.padHold(id, value)
    this.#holding = new Set(next.keys())
  }

  /**
   * Whether a button bound to a held action is still down from a press that
   * meant something else.
   *
   * ✕ pressed on a dialog's Close is the case: the dialog goes, the mode's
   * bindings come back on the next poll, and ✕ is still down — so without
   * this the walker jumps as the dialog closes. A stick is exempt: a stick
   * held across a mode change is a hand still asking for motion, and the
   * motion it asks for is the new mode's.
   *
   * A button that is holding an action is latched under it, for the same
   * reason in the other direction: ✕ held for a jump while Options opens
   * Settings is not a press of whatever the dialog focused first, and ○ held
   * for a crouch is not the dialog's Close.
   */
  #carried(control: PadControl, action: ActionId): boolean {
    if (isPadStick(control)) {
      this.#latched.delete(control)
      return false
    }
    const held = this.#latched.get(control)
    const value = this.#values.get(control) ?? 0
    if (!latch(value, held !== undefined, thresholdsFor(control))) {
      this.#latched.delete(control)
      return false
    }
    if (held === undefined) {
      this.#latched.set(control, { action, held: 0, fired: 0, carried: false })
      return false
    }
    return held.action !== action
  }

  /**
   * A control's value for an action, with the invert preferences applied.
   *
   * An invert swaps which half of the stick drives the action rather than
   * negating anything downstream, so every consumer — the ship, the
   * observatory, the walker — is inverted by one rule in one place.
   */
  #valueFor(control: PadControl, action: ActionDefinition): number {
    const inverted =
      (action.invert === 'look' && this.#tuning.invertLook) ||
      (action.invert === 'pitch' && this.#tuning.invertPitch)
    if (!inverted || !isPadStick(control)) return this.#values.get(control) ?? 0
    return this.#values.get(opposite(control)) ?? 0
  }

  /**
   * One control as a button: latch the edge with hysteresis, fire on the way
   * down, and repeat while held when asked to.
   *
   * A press is fired by the owner it began under and by no other. When the
   * owner changes under a held button — the interface letting go of the
   * focus, a context arriving — the latch moves to the new owner without
   * firing, so one press is one decision: ✕ on a dialog's Close does not also
   * pick a body in the sky the dialog was hiding.
   */
  #press(
    control: PadControl,
    action: ActionId | null,
    seconds: number,
    repeats: boolean,
    fire: (repeat: boolean) => void,
  ): void {
    const value = this.#values.get(control) ?? 0
    const held = this.#latched.get(control)
    if (!latch(value, held !== undefined, thresholdsFor(control))) {
      this.#latched.delete(control)
      return
    }
    if (held === undefined) {
      this.#latched.set(control, { action, held: 0, fired: 0, carried: false })
      fire(false)
      return
    }
    if (held.action !== action) {
      this.#latched.set(control, { action, held: 0, fired: 0, carried: true })
      return
    }
    held.held += seconds
    if (!repeats || held.carried) return
    const due = repeatsDue(held.held, held.fired)
    for (let index = 0; index < due; index++) fire(true)
    held.fired += due
  }

  #releaseAll(): void {
    this.#latched.clear()
    if (this.#holding.size > 0) this.#store.releasePad()
    this.#holding.clear()
  }

  /**
   * Rumble the pad that moved last. Both motors, 0..1, for `milliseconds`.
   *
   * Fire and forget: `playEffect` resolves when the effect ends or is
   * preempted, and an effect a newer one preempted is not an error anybody
   * can act on.
   */
  rumble(strong: number, weak: number, milliseconds: number): void {
    if (!this.#tuning.vibration) return
    const actuator = this.#active?.vibrationActuator
    if (typeof actuator?.playEffect !== 'function') return
    void actuator
      .playEffect('dual-rumble', {
        startDelay: 0,
        duration: milliseconds,
        strongMagnitude: clamp01(strong),
        weakMagnitude: clamp01(weak),
      })
      .catch(() => {})
  }
}

const NONE: ReadonlySet<PadControl> = new Set()

const length = (stick: StickValue): number => Math.hypot(stick.x, stick.y)

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0

function setStick(
  values: Map<PadControl, number>,
  side: 'ls' | 'rs',
  stick: StickValue,
): void {
  values.set(`${side}.left`, Math.max(-stick.x, 0))
  values.set(`${side}.right`, Math.max(stick.x, 0))
  values.set(`${side}.up`, Math.max(-stick.y, 0))
  values.set(`${side}.down`, Math.max(stick.y, 0))
}

function opposite(control: PadStick): PadStick {
  const side = control.slice(0, 2)
  const direction = control.slice(3)
  const flipped =
    direction === 'up'
      ? 'down'
      : direction === 'down'
        ? 'up'
        : direction === 'left'
          ? 'right'
          : 'left'
  return `${side}.${flipped}` as PadStick
}

function thresholdsFor(control: PadControl): Hysteresis {
  if (isPadStick(control)) return FLICK_PRESS
  return TRIGGER_PRESS
}

/** Whether one pad, alone, shows a hand on it. */
function active(pad: PadReading, tuning: PadTuning): boolean {
  if (pad.buttons.some((button) => button.value > 0.5)) return true
  const shape = stickShapeOf(tuning)
  return (
    length(shapeStick(pad.axes[0] ?? 0, pad.axes[1] ?? 0, shape)) > ACTIVITY ||
    length(shapeStick(pad.axes[2] ?? 0, pad.axes[3] ?? 0, shape)) > ACTIVITY
  )
}
