import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  findAction,
  padCollisions,
  resolvePadBindings,
} from './keymap.ts'
import { type ActionEvent, KeymapStore } from './keymapStore.ts'
import { buttonIndex, type PadButton } from './pad.ts'
import { type PadNavigator, PadDriver, type PadReading } from './padDriver.ts'
import { PAD_REPEAT } from './padShape.ts'
import { DEFAULT_TUNING } from './padTuning.ts'

/*
 * The pad, from a scripted controller to the handlers a mode registers.
 *
 * No browser: a pad is a plain object with the fields the driver reads, and
 * a frame is a call to `poll`. What is worth asserting is the dispatch — that
 * a stick is a magnitude, that a press is one decision, that the keymap's
 * contexts mean the same for a pad as for a key.
 */

const DUALSENSE = 'DualSense Wireless Controller (STANDARD GAMEPAD)'

/** A pad at rest, with the named buttons pressed and the axes given. */
function pad(
  pressed: Partial<Record<PadButton, number>> = {},
  axes: readonly number[] = [0, 0, 0, 0],
  timestamp = 0,
): PadReading {
  const buttons = Array.from({ length: 18 }, () => ({ value: 0 }))
  for (const [button, value] of Object.entries(pressed))
    buttons[buttonIndex(button as PadButton)] = { value }
  return {
    id: DUALSENSE,
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp,
    axes,
    buttons,
  }
}

function rig(navigator: PadNavigator | null = null) {
  const store = new KeymapStore()
  let pads: (PadReading | null)[] = []
  let stamp = 0
  const driver = new PadDriver(store, () => pads, navigator)
  const events: [string, ActionEvent['phase'], number][] = []
  const listen = (...ids: string[]) => {
    for (const id of ids)
      store.register(id, (event) =>
        events.push([id, event.phase, Number(event.value.toFixed(3))]),
      )
  }
  return {
    store,
    driver,
    events,
    listen,
    /** One frame with this pad state. */
    frame(next: PadReading | null, seconds = 1 / 60) {
      stamp += 1
      pads = next === null ? [] : [{ ...next, timestamp: stamp }]
      driver.poll(seconds)
    },
  }
}

describe('a stick is a magnitude', () => {
  it('holds a held action at the shaped throw, and says when it moves and when it lets go', () => {
    const r = rig()
    r.store.claim({ context: 'flight' })
    r.listen('flight.fore')
    r.frame(pad({}, [0, -1, 0, 0]))
    r.frame(pad({}, [0, -0.6, 0, 0]))
    r.frame(pad({}, [0, 0, 0, 0]))
    expect(r.events.map(([, phase]) => phase)).toEqual(['down', 'change', 'up'])
    expect(r.events[0]?.[2]).toBe(1)
    const half = r.events[1]?.[2] ?? 0
    expect(half).toBeGreaterThan(0)
    expect(half).toBeLessThan(0.6)
  })

  it('merges a key and a stick on one action as the larger, not the sum', () => {
    const r = rig()
    r.store.claim({ context: 'flight' })
    r.listen('flight.fore')
    r.frame(pad({}, [0, -0.6, 0, 0]))
    const key = {
      code: 'KeyW',
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      repeat: false,
      preventDefault: () => {},
      target: null,
    } as unknown as KeyboardEvent
    r.store.handleKeyDown(key)
    r.store.handleKeyUp(key)
    // The key let go while the stick still holds the thruster: a change back
    // to the stick's throw, never an `up` that stops a thruster still pushed.
    expect(r.events.map(([, phase]) => phase)).toEqual([
      'down',
      'change',
      'change',
    ])
    expect(r.store.value('flight.fore')).toBeGreaterThan(0)
    expect(r.store.value('flight.fore')).toBeLessThan(1)
  })

  it('reads the right stick as the head inside the free-look layer, and the hull outside it', () => {
    const r = rig()
    r.store.claim({ context: 'flight' })
    r.listen('flight.pitchUp', 'flight.lookUp')
    r.frame(pad({}, [0, 0, 0, -1]))
    const release = r.store.claim({ context: 'flight-look' })
    r.frame(pad({}, [0, 0, 0, -1]))
    release()
    r.frame(pad({}, [0, 0, 0, -1]))
    expect(r.events).toEqual([
      ['flight.pitchUp', 'down', 1],
      ['flight.pitchUp', 'up', 0],
      ['flight.lookUp', 'down', 1],
      ['flight.lookUp', 'up', 0],
      ['flight.pitchUp', 'down', 1],
    ])
  })

  it('inverts by swapping the half of the stick, per preference', () => {
    const r = rig()
    r.store.claim({ context: 'flight' })
    r.listen('flight.pitchUp', 'flight.pitchDown')
    r.driver.setTuning({ ...DEFAULT_TUNING, invertPitch: true })
    r.frame(pad({}, [0, 0, 0, 1]))
    expect(r.events[0]).toEqual(['flight.pitchUp', 'down', 1])
  })
})

describe('a press is one decision', () => {
  it('fires once per press, however long the button is held', () => {
    const r = rig()
    r.store.claim({ context: 'flight' })
    r.listen('flight.kill')
    for (let index = 0; index < 90; index++) r.frame(pad({ south: 1 }))
    r.frame(pad())
    r.frame(pad({ south: 1 }))
    expect(r.events.filter(([id]) => id === 'flight.kill')).toHaveLength(2)
  })

  it('repeats an act that asks for it, after the delay', () => {
    const r = rig()
    r.store.claim({ context: 'flight' })
    r.listen('flight.throttleUp')
    const seconds = 0.02
    const frames = Math.round(
      (PAD_REPEAT.delay + PAD_REPEAT.interval * 4) / seconds,
    )
    for (let index = 0; index <= frames; index++)
      r.frame(pad({ up: 1 }), seconds)
    // The press, then one at the delay and one per interval after it.
    expect(r.events).toHaveLength(1 + 1 + 4)
  })

  it('latches a trigger with hysteresis, so a finger on the threshold does not chatter', () => {
    const r = rig()
    r.store.claim({ context: 'cinema' })
    r.listen('cinema.play')
    // Rebind play to a trigger, the case a threshold exists for.
    r.store.setPadBindings(resolvePadBindings({ 'cinema.play': 'r2' }))
    for (const value of [0.6, 0.45, 0.55, 0.4, 0.52, 0.2, 0.6])
      r.frame(pad({ r2: value }))
    expect(r.events).toHaveLength(2)
  })

  it('means what the live context says: ✕ kills rotation in flight and picks in the planetarium', () => {
    const r = rig()
    r.listen('flight.kill', 'observe.pick')
    const flight = r.store.claim({ context: 'flight' })
    r.frame(pad({ south: 1 }))
    r.frame(pad())
    flight()
    r.store.claim({ context: 'planetarium' })
    r.frame(pad({ south: 1 }))
    expect(r.events.map(([id]) => id)).toEqual(['flight.kill', 'observe.pick'])
  })

  it('leaves alone a control whose action nobody is listening for', () => {
    const r = rig()
    r.store.claim({ context: 'flight' })
    r.listen('flight.assist')
    r.frame(pad({ south: 1 }))
    expect(r.events).toEqual([])
  })
})

describe('the interface takes the pad when it has the focus', () => {
  function navigator(owns: { value: boolean }) {
    const log: string[] = []
    const nav: PadNavigator = {
      owns: () => owns.value,
      move: (direction) => log.push(direction),
      activate: () => log.push('activate'),
      canBack: () => owns.value,
      back: () => log.push('back'),
      scroll: () => {},
    }
    return { nav, log }
  }

  it('moves and presses in the interface, and flies nothing', () => {
    const owns = { value: true }
    const { nav, log } = navigator(owns)
    const r = rig(nav)
    r.store.claim({ context: 'flight' })
    r.listen('flight.kill', 'flight.throttleUp')
    r.frame(pad({ down: 1 }))
    r.frame(pad({ south: 1 }))
    expect(log).toEqual(['down', 'activate'])
    expect(r.events).toEqual([])
  })

  it('does not fire the mode’s act for a press the interface already took', () => {
    // ✕ on a dialog's Close: the dialog goes, the mode's bindings return, and
    // ✕ is still down. That press was a decision about the dialog.
    const owns = { value: true }
    const { nav, log } = navigator(owns)
    const r = rig(nav)
    r.store.claim({ context: 'flight' })
    r.listen('flight.kill')
    r.frame(pad({ south: 1 }))
    owns.value = false
    r.frame(pad({ south: 1 }))
    r.frame(pad({ south: 1 }))
    expect(log).toEqual(['activate'])
    expect(r.events).toEqual([])
    r.frame(pad())
    r.frame(pad({ south: 1 }))
    expect(r.events.map(([id]) => id)).toEqual(['flight.kill'])
  })
})

describe('the hand in use', () => {
  it('moves to the pad on a press, not on a pad merely connected', () => {
    const r = rig()
    r.frame(pad())
    expect(r.store.device).toBe('keyboard')
    expect(r.store.pads).toBe(1)
    r.frame(pad({ west: 1 }))
    expect(r.store.device).toBe('pad')
    expect(r.store.family).toBe('dualsense')
  })

  it('lets go of everything a pad held when the pad goes away', () => {
    const r = rig()
    r.store.claim({ context: 'flight' })
    r.listen('flight.fore', 'flight.up')
    r.frame(pad({ r2: 1 }, [0, -1, 0, 0]))
    r.frame(null)
    expect(r.store.value('flight.fore')).toBe(0)
    expect(r.store.value('flight.up')).toBe(0)
    expect(r.store.pads).toBe(0)
    expect(r.events.filter(([, phase]) => phase === 'up')).toHaveLength(2)
  })
})

describe('the default pad table', () => {
  it('leaves no control ambiguous in any set of contexts that coexist', () => {
    const found = padCollisions(resolvePadBindings())
    expect(
      found
        .filter((one) => one.kind === 'ambiguous')
        .map((one) => `${one.control}: ${one.ids.join(' + ')}`),
    ).toEqual([])
  })

  it('binds the axes of every mode a pad can fly', () => {
    // Every held action a mode needs to move is on the pad out of the box;
    // a mode a pad could enter and not move in would be a dead end.
    for (const id of [
      'flight.fore',
      'flight.pitchUp',
      'flight.rollLeft',
      'flight.up',
      'observe.swingLeft',
      'observe.approach',
      'stand.forward',
      'character.forward',
      'character.lookLeft',
    ])
      expect(findAction(id)?.pad, id).not.toBeNull()
  })

  it('never binds the system button', () => {
    expect(ACTIONS.filter((action) => action.pad === 'home')).toEqual([])
  })

  it('gives every look a direction an invert can flip', () => {
    for (const action of ACTIONS) {
      if (action.pad === 'rs.up' || action.pad === 'ls.up')
        if (action.id.includes('look') || action.id.includes('swing'))
          expect(action.invert, action.id).toBe('look')
    }
  })
})
