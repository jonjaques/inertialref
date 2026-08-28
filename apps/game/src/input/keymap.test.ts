import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  chord,
  chordFromEvent,
  chordLabel,
  formatChord,
  isBindable,
  parseChord,
  REFUSED_CODES,
} from './chord.ts'
import {
  ACTIONS,
  actionFor,
  collisions,
  findAction,
  LIVE_SETS,
  resolveBindings,
} from './keymap.ts'
import { KeymapStore } from './keymapStore.ts'

/*
 * The dispatcher, as arithmetic.
 *
 * Everything worth asserting here is a decision rather than a DOM event: which
 * action a chord means given what is live, whether a table is collision-free,
 * and whether a chord survives being written to storage and read back. The
 * listener itself is four lines of `addEventListener`; the judgement is above.
 */

describe('the default table', () => {
  it('leaves no chord ambiguous in any set of contexts that coexist', () => {
    // Two actions in one context answering to one chord is a defect: nothing
    // decides between them and the dispatcher's answer is whichever the table
    // happens to list first.
    const found = collisions(resolveBindings())
    expect(
      found
        .filter((one) => one.kind === 'ambiguous')
        .map((one) => `${formatChord(one.chord)}: ${one.ids.join(' + ')}`),
    ).toEqual([])
  })

  it('shadows exactly one global act, and it is the one it means to', () => {
    /*
     * `Space` is pause everywhere and the cinema player's transport, and the
     * cinema's claim is the better one while you are in it. That is the bug the
     * six listeners had — both handlers ran, `clock.paused` flipped twice, and
     * the documented control did nothing at all with nothing in the console —
     * expressed as an ordering instead of as two handlers hoping not to meet.
     *
     * Pinned to the exact list, so a second shadow has to be argued for here
     * rather than discovered in a mode where a key quietly stopped working.
     */
    expect(
      collisions(resolveBindings())
        .filter((one) => one.kind === 'shadowed')
        .map((one) => `${formatChord(one.chord)}: ${one.ids.join(' over ')}`),
    ).toEqual(['Space: cinema.play over time.pause'])
  })

  it('gives every action a unique id and a group', () => {
    const ids = ACTIONS.map((action) => action.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const action of ACTIONS) {
      expect(action.label.length).toBeGreaterThan(0)
      expect(action.group.length).toBeGreaterThan(0)
      expect(findAction(action.id)).toBe(action)
    }
  })

  it('names every context in a live set', () => {
    // An action in a context no live set contains is an action that can never
    // fire, which is a binding the editor offers and the dispatcher ignores.
    const reachable = new Set(LIVE_SETS.flat())
    for (const action of ACTIONS) {
      expect(reachable, action.id).toContain(action.context)
    }
  })

  it('binds no chord the editor would refuse, except Escape', () => {
    /*
     * `Escape` is the one exception and it is deliberate: it closes a dialog and
     * skips a cutscene, which is what it means in the cinema, and the refusal is
     * about rebinding *away* from it rather than about naming it. Everything
     * else the browser owns must not appear in a default at all — a `Tab`
     * binding takes focus navigation whether it means to or not.
     */
    for (const action of ACTIONS) {
      if (action.chord === null) continue
      if (action.chord.code === 'Escape') continue
      expect(isBindable(action.chord), action.id).toBe(true)
    }
  })
})

describe('a chord', () => {
  it('round-trips through its stored form (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'KeyW',
          'BracketLeft',
          'ArrowUp',
          'F5',
          'Slash',
          'Backquote',
          'Digit3',
          'PageDown',
        ),
        fc.boolean(),
        fc.boolean(),
        (code, shift, alt) => {
          const one = chord(code, { shift, alt })
          expect(parseChord(formatChord(one))).toEqual(one)
        },
      ),
    )
  })

  it('refuses a stored form this build would not have written', () => {
    for (const code of REFUSED_CODES) expect(parseChord(code)).toBeNull()
    // The modifiers the shape deliberately cannot hold, and the shapes a hand
    // edit produces.
    expect(parseChord('Ctrl+KeyR')).toBeNull()
    expect(parseChord('Meta+KeyW')).toBeNull()
    expect(parseChord('')).toBeNull()
    expect(parseChord('Shift+')).toBeNull()
  })

  it('reads Escape from an event even though the editor will not bind it', () => {
    // Two different claims, and conflating them leaves the cinema's default
    // binding with nothing to fire it.
    const pressed = chordFromEvent({
      code: 'Escape',
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    })
    expect(pressed).toEqual(chord('Escape'))
    expect(isBindable(chord('Escape'))).toBe(false)
  })

  it('hands a modified key back to the browser', () => {
    for (const modifier of ['ctrlKey', 'metaKey'] as const) {
      expect(
        chordFromEvent({
          code: 'KeyR',
          shiftKey: false,
          altKey: false,
          ctrlKey: modifier === 'ctrlKey',
          metaKey: modifier === 'metaKey',
        }),
      ).toBeNull()
    }
  })

  it('labels a shifted punctuation key by what it produces', () => {
    // `?` is what the help is called everywhere, and "Shift + /" is a
    // description of the gesture rather than the name of the key.
    expect(chordLabel(chord('Slash', { shift: true }))).toBe('?')
    expect(chordLabel(chord('KeyH', { shift: true }))).toBe('Shift + H')
    expect(chordLabel(chord('BracketLeft'))).toBe('[')
    expect(chordLabel(chord('ArrowUp'))).toBe('↑')
  })
})

describe('resolving the bindings', () => {
  it('lays overrides over the defaults and keeps tracking the rest', () => {
    const bindings = resolveBindings({ 'observe.frame': 'KeyG' })
    expect(bindings.get('observe.frame')).toEqual(chord('KeyG'))
    // Everything else still reads the table, which is why only the overrides
    // are stored: a full copy freezes an action whose default later moves.
    expect(bindings.get('observe.home')).toEqual(
      findAction('observe.home')?.chord,
    )
  })

  it('drops an id this build does not have, and a chord it would refuse', () => {
    const bindings = resolveBindings({
      'observe.warpDrive': 'KeyG',
      'observe.frame': 'Tab',
    })
    expect(bindings.has('observe.warpDrive')).toBe(false)
    expect(bindings.get('observe.frame')).toEqual(
      findAction('observe.frame')?.chord,
    )
  })

  it('takes null for a deliberate unbind', () => {
    expect(
      resolveBindings({ 'observe.frame': null }).get('observe.frame'),
    ).toBe(null)
  })
})

describe('which action a chord means', () => {
  const bindings = resolveBindings()

  it('is the context one, not the global one, when both answer', () => {
    // The `Space` case, as a claim rather than as a special case in a listener.
    expect(actionFor(bindings, ['global', 'cinema'], chord('Space'))?.id).toBe(
      'cinema.play',
    )
    expect(actionFor(bindings, ['global', 'flight'], chord('Space'))?.id).toBe(
      'time.pause',
    )
  })

  it('means different things in contexts that cannot coexist', () => {
    expect(actionFor(bindings, ['global', 'flight'], chord('KeyF'))?.id).toBe(
      'flight.down',
    )
    expect(
      actionFor(bindings, ['global', 'planetarium'], chord('KeyF'))?.id,
    ).toBe('observe.frame')
  })

  it('lets standing beat the planetarium underneath it', () => {
    // The one nested pair. Nothing in the defaults collides here, so the check
    // is that the order exists at all — a rebind is what makes it matter.
    const rebound = resolveBindings({ 'stand.leave': 'KeyF' })
    expect(
      actionFor(rebound, ['global', 'planetarium', 'standing'], chord('KeyF'))
        ?.id,
    ).toBe('stand.leave')
  })

  it('takes Shift as a magnitude where the action says so', () => {
    const shifted = chord('ArrowLeft', { shift: true })
    expect(actionFor(bindings, ['global', 'planetarium'], shifted)?.id).toBe(
      'observe.left',
    )
    // And not where it does not: `Shift+H` is its own binding.
    expect(
      actionFor(
        bindings,
        ['global', 'planetarium'],
        chord('KeyH', { shift: true }),
      )?.id,
    ).toBe('chrome.all')
    expect(
      actionFor(bindings, ['global', 'planetarium'], chord('KeyH'))?.id,
    ).toBe('chrome.panes')
  })

  it('is nothing for a chord nobody binds', () => {
    expect(actionFor(bindings, ['global', 'flight'], chord('Tab'))).toBeNull()
  })
})

describe('the store', () => {
  it('mutes a global action for a context that has the better claim', () => {
    /*
     * The reading room. `docs` is the one mode that is a scrolling document,
     * where `Space` is page down — bound globally it is neither, because
     * `preventDefault` takes the scroll and the press pauses the simulation
     * behind the words instead.
     */
    const store = new KeymapStore()
    expect(store.resolve(chord('Space'))?.id).toBe('time.pause')
    const release = store.claim({ context: 'docs', mutes: ['time.pause'] })
    expect(store.resolve(chord('Space'))).toBeNull()
    release()
    expect(store.resolve(chord('Space'))?.id).toBe('time.pause')
  })

  it('dispatches to whoever registered for the id', () => {
    const store = new KeymapStore()
    const seen: string[] = []
    const release = store.register('time.pause', (event) =>
      seen.push(event.phase),
    )
    store.invoke('time.pause', { phase: 'down', shift: false, repeat: false })
    release()
    store.invoke('time.pause', { phase: 'down', shift: false, repeat: false })
    expect(seen).toEqual(['down'])
  })

  it('releases every held action when a context goes away', () => {
    /*
     * Leaving a mode with keys held would otherwise leave the drive burning for
     * the rest of the session, with nothing on screen still listening for the
     * key-up that would stop it. The old hook had this as a teardown branch; it
     * is the store's now, because the store is the thing that knows what is
     * held.
     */
    const store = new KeymapStore()
    const phases: string[] = []
    store.register('flight.fore', (event) => phases.push(event.phase))
    const release = store.claim({ context: 'flight' })
    store.handleKeyDown(keyEvent('KeyW'))
    expect(phases).toEqual(['down'])
    release()
    expect(phases).toEqual(['down', 'up'])
  })

  it('ends a held action on the physical key, whatever the modifiers did', () => {
    /*
     * Shift can go down or up between the press and the release, so a key-up
     * compared as a whole chord misses its own key-down half the time — and for
     * an axis, "misses" means the thruster never stops.
     */
    const store = new KeymapStore()
    const phases: string[] = []
    store.register('flight.fore', (event) => phases.push(event.phase))
    store.claim({ context: 'flight' })
    store.handleKeyDown(keyEvent('KeyW'))
    store.handleKeyUp(keyEvent('KeyW', { shiftKey: true }))
    expect(phases).toEqual(['down', 'up'])
  })

  it('drops the auto-repeat of a held key', () => {
    // The control vector it feeds does not change, so re-applying it at the
    // operating system's repeat rate is work for no effect.
    const store = new KeymapStore()
    let downs = 0
    store.register('flight.fore', (event) => {
      if (event.phase === 'down') downs += 1
    })
    store.claim({ context: 'flight' })
    store.handleKeyDown(keyEvent('KeyW'))
    store.handleKeyDown(keyEvent('KeyW', { repeat: true }))
    expect(downs).toBe(1)
  })

  it('tells a shift-scaling action whether Shift was down', () => {
    const store = new KeymapStore()
    const shifts: boolean[] = []
    store.register('observe.left', (event) => shifts.push(event.shift))
    store.claim({ context: 'planetarium' })
    store.handleKeyDown(keyEvent('ArrowLeft'))
    store.handleKeyDown(keyEvent('ArrowLeft', { shiftKey: true }))
    expect(shifts).toEqual([false, true])
  })
})

/** A keyboard event, as much of one as the store reads. */
function keyEvent(
  code: string,
  options: {
    shiftKey?: boolean
    altKey?: boolean
    ctrlKey?: boolean
    metaKey?: boolean
    repeat?: boolean
  } = {},
): KeyboardEvent {
  return {
    code,
    shiftKey: options.shiftKey === true,
    altKey: options.altKey === true,
    ctrlKey: options.ctrlKey === true,
    metaKey: options.metaKey === true,
    repeat: options.repeat === true,
    // `isTyping` and `isOverlayControl` both start from the target, and in Node
    // there is no `HTMLElement` for one to be — which is exactly the "focus is
    // on the canvas" case, where nothing declines.
    target: null,
    preventDefault: () => {},
  } as unknown as KeyboardEvent
}
