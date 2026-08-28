import { type Chord, chord, chordEquals, parseChord } from './chord.ts'

/*
 * Every key this build binds, in one table.
 *
 * There were six window-level `keydown` listeners — the ship axes, the
 * workspace keys, the observer input, the console key, the cinema transport and
 * two `Escape` handlers — and two key models between them: two read `event.key`
 * and four read `event.code`, which is why `+` carried a comment about `Shift`.
 * Six string literals named keys in five files, and two hand-maintained help
 * tables described them. Nothing could answer "what is `F` bound to", which is
 * also why `docs/design/ux.md` could promise that everything is rebindable
 * while `/settings/controls` printed a list and said rebinding was not built.
 *
 * So: an action has an id, and a chord is a *binding* to it. A mode registers a
 * handler for an id (`useAction`) and never sees a key; the editor rebinds a
 * chord and never sees a handler; a label prints the live chord for an id and
 * never contains a key name. The three things that used to be one string
 * literal in three files are three views of this table.
 *
 * **A chord is a physical key.** `event.code`, always — see `chord.ts` for why
 * the alternative cannot survive a keyboard change.
 *
 * **A context is when an action is live**, and two contexts that cannot be live
 * together may share a chord: `F` translates down in flight and frames in the
 * planetarium, which is not a conflict because nobody is in both. What *is* a
 * conflict is two actions sharing a chord inside one of the live sets below,
 * and that is the check the editor runs and the defaults are held to.
 */

export type KeyContext =
  'global' | 'flight' | 'planetarium' | 'standing' | 'cinema' | 'docs'

/**
 * Every set of contexts that can be live at one moment.
 *
 * The app's shape, written down. `global` is in all of them; `standing` only
 * ever appears beside `planetarium`, because the surface arm is the
 * planetarium's second arm rather than a mode; and flight, cinema and docs are
 * mutually exclusive with everything else. Conflict detection is exactly
 * "two actions with one chord in one of these", which is a stronger and simpler
 * claim than any pairwise rule about which contexts are disjoint.
 */
export const LIVE_SETS: readonly (readonly KeyContext[])[] = [
  ['global', 'flight'],
  ['global', 'planetarium'],
  ['global', 'planetarium', 'standing'],
  ['global', 'cinema'],
  ['global', 'docs'],
]

/**
 * How specific a context is, for deciding which of two live actions wins.
 *
 * Only reachable through a rebind — the defaults are collision-free, and a test
 * holds them to it — but a dispatcher needs a total order whatever the bindings
 * say, and "the innermost thing you are doing wins" is the only one that reads
 * like an answer. It is also what the six listeners were doing by accident:
 * `Space` is the pause key and the cinema player's transport, and both handlers
 * ran, so one press flipped `clock.paused` twice and the documented control did
 * nothing at all with nothing to see in the console.
 */
const SPECIFICITY: Readonly<Record<KeyContext, number>> = {
  global: 0,
  docs: 1,
  cinema: 1,
  flight: 1,
  planetarium: 1,
  standing: 2,
}

export interface ActionDefinition {
  /** Stable across a rename of the label — this is what a binding stores. */
  readonly id: string
  readonly label: string
  /** The run this action is drawn in, on the editor and the keys sheet. */
  readonly group: string
  readonly context: KeyContext
  /** What it is bound to out of the box. `null` is deliberately unbound. */
  readonly chord: Chord | null
  /**
   * Whether the action fires for the whole time the key is down.
   *
   * The flight axes, and nothing else. A held action gets both edges and a
   * blur; a pressed one gets the down edge alone. They are the same table
   * because they are the same question — "what is `W` bound to" has one answer
   * — and because the axes were the largest of the six listeners.
   */
  readonly held?: boolean
  /**
   * Whether Shift is a magnitude rather than part of the chord.
   *
   * Fine control near a surface and coarse control between stars are the same
   * gesture, so the arrows take Shift as "more" instead of as a second binding.
   * Read as part of the chord it would be eight orbit actions where there are
   * four, and the editor would offer both halves of one control.
   */
  readonly shiftScales?: boolean
  /**
   * Whether a focused control may take the key instead.
   *
   * `Space` is the pause key *and* how a keyboard activates a focused button,
   * so a button in the overlay has the better claim on it. `F5` and `F9`
   * deliberately do not ask: nothing in the overlay responds to either, so
   * declining them would not activate anything — it would hand the key back to
   * the browser, and F5 is Reload. Losing a session because focus happened to
   * be on a dock button is worse than the thing that would fix.
   *
   * Every arrow binding asks too, and for the same conflict one step out: a
   * focused Radix slider or toggle group owns the arrows for stepping and for
   * roving focus, so a dock somebody is tabbing through would otherwise orbit
   * the camera instead of moving between its controls.
   */
  readonly yieldsToFocus?: boolean
  /** One line, for the keys sheet and the editor's row. */
  readonly hint?: string
}

const press = (
  id: string,
  label: string,
  group: string,
  context: KeyContext,
  binding: Chord | null,
  extra: Partial<ActionDefinition> = {},
): ActionDefinition => ({ id, label, group, context, chord: binding, ...extra })

/**
 * The default table — every core act, on a key, in one place.
 *
 * Ordered by context and then by how a keys sheet reads, because this list is
 * what the sheet and the editor are drawn from and a table sorted for the
 * dispatcher would be a sheet sorted for nobody.
 */
export const ACTIONS: readonly ActionDefinition[] = [
  /* ------------------------------- global ------------------------------- */
  press('time.pause', 'Pause', 'Time', 'global', chord('Space'), {
    yieldsToFocus: true,
    hint: 'stop and start the simulated clock',
  }),
  press('time.slower', 'Slower', 'Time', 'global', chord('BracketLeft')),
  press('time.faster', 'Faster', 'Time', 'global', chord('BracketRight')),
  press('time.normal', 'Real Time', 'Time', 'global', chord('Backslash'), {
    hint: 'back to one second per second',
  }),

  press('session.save', 'Save', 'Session', 'global', chord('F5')),
  press('session.load', 'Load', 'Session', 'global', chord('F9')),

  press('nav.goTo', 'Go To', 'Session', 'global', chord('Slash'), {
    hint: 'focus the catalog’s search, which takes anything an address does',
  }),

  press('chrome.panes', 'Both Panes', 'Screen', 'global', chord('KeyH'), {
    hint: 'clear both panes, or bring them back',
  }),
  press(
    'chrome.all',
    'All Chrome',
    'Screen',
    'global',
    chord('KeyH', { shift: true }),
    {
      hint: 'panes, menu, reticle and notices — the state a plate is taken in',
    },
  ),
  press(
    'chrome.instruments',
    'The Instruments',
    'Screen',
    'global',
    chord('Backquote'),
    { hint: 'disclose the author’s panels' },
  ),
  press(
    'chrome.keys',
    'The Keys',
    'Screen',
    'global',
    chord('Slash', { shift: true }),
    { hint: 'this sheet, from any mode' },
  ),
  press('chrome.settings', 'Settings', 'Screen', 'global', chord('Comma')),

  press('panel.1', 'First Panel', 'Panels', 'global', chord('Digit1')),
  press('panel.2', 'Second Panel', 'Panels', 'global', chord('Digit2')),
  press('panel.3', 'Third Panel', 'Panels', 'global', chord('Digit3')),
  press('panel.4', 'Fourth Panel', 'Panels', 'global', chord('Digit4')),
  press('panel.5', 'Fifth Panel', 'Panels', 'global', chord('Digit5')),
  press('panel.6', 'Sixth Panel', 'Panels', 'global', chord('Digit6')),
  press('panel.7', 'Seventh Panel', 'Panels', 'global', chord('Digit7')),
  press('panel.perf', 'Perf', 'Panels', 'global', chord('KeyP')),

  /* ------------------------------- flight ------------------------------- */
  press('flight.fore', 'Main Drive', 'Flight', 'flight', chord('KeyW'), {
    held: true,
  }),
  press('flight.aft', 'Retro', 'Flight', 'flight', chord('KeyS'), {
    held: true,
  }),
  press('flight.left', 'Translate Left', 'Flight', 'flight', chord('KeyA'), {
    held: true,
  }),
  press('flight.right', 'Translate Right', 'Flight', 'flight', chord('KeyD'), {
    held: true,
  }),
  press('flight.up', 'Translate Up', 'Flight', 'flight', chord('KeyR'), {
    held: true,
  }),
  press('flight.down', 'Translate Down', 'Flight', 'flight', chord('KeyF'), {
    held: true,
  }),
  press('flight.pitchUp', 'Pitch Up', 'Flight', 'flight', chord('ArrowUp'), {
    held: true,
    yieldsToFocus: true,
  }),
  press(
    'flight.pitchDown',
    'Pitch Down',
    'Flight',
    'flight',
    chord('ArrowDown'),
    { held: true, yieldsToFocus: true },
  ),
  press('flight.yawLeft', 'Yaw Left', 'Flight', 'flight', chord('ArrowLeft'), {
    held: true,
    yieldsToFocus: true,
  }),
  press(
    'flight.yawRight',
    'Yaw Right',
    'Flight',
    'flight',
    chord('ArrowRight'),
    { held: true, yieldsToFocus: true },
  ),
  press('flight.rollLeft', 'Roll Left', 'Flight', 'flight', chord('KeyQ'), {
    held: true,
  }),
  press('flight.rollRight', 'Roll Right', 'Flight', 'flight', chord('KeyE'), {
    held: true,
  }),
  press('flight.assist', 'Flight Assist', 'Flight', 'flight', chord('KeyZ')),
  press('flight.kill', 'Kill Rotation', 'Flight', 'flight', chord('KeyX')),

  /* ---------------------------- planetarium ----------------------------- */
  press(
    'observe.left',
    'Orbit Left',
    'Planetarium',
    'planetarium',
    chord('ArrowLeft'),
    { shiftScales: true, yieldsToFocus: true, hint: 'hold Shift for coarse' },
  ),
  press(
    'observe.right',
    'Orbit Right',
    'Planetarium',
    'planetarium',
    chord('ArrowRight'),
    { shiftScales: true, yieldsToFocus: true },
  ),
  press(
    'observe.up',
    'Orbit Up',
    'Planetarium',
    'planetarium',
    chord('ArrowUp'),
    { shiftScales: true, yieldsToFocus: true },
  ),
  press(
    'observe.down',
    'Orbit Down',
    'Planetarium',
    'planetarium',
    chord('ArrowDown'),
    { shiftScales: true, yieldsToFocus: true },
  ),
  press(
    'observe.in',
    'Dolly In',
    'Planetarium',
    'planetarium',
    chord('Equal'),
    {
      // Shift is deliberately not read: `+` *is* Shift-`=` on every layout this
      // ships to, so the modifier carries no information here. Read as a
      // magnitude it made the two keys the help names differ by a factor of
      // four, and pressing one then the other did not return the camera to
      // where it started — which is the one thing a zoom pair has to do.
      shiftScales: true,
      hint: 'move the camera toward the subject',
    },
  ),
  press(
    'observe.out',
    'Dolly Out',
    'Planetarium',
    'planetarium',
    chord('Minus'),
    { shiftScales: true },
  ),
  press('observe.frame', 'Frame', 'Planetarium', 'planetarium', chord('KeyF'), {
    hint: 'solve the distance that fills the frame at this lens',
  }),
  press('observe.home', 'Home', 'Planetarium', 'planetarium', chord('Home'), {
    hint: 'back to where the session opened',
  }),
  press(
    'observe.freeLook',
    'Free Look',
    'Planetarium',
    'planetarium',
    chord('KeyL'),
    { hint: 'make the drag and the arrows look instead of orbit' },
  ),

  /* ------------------------------ standing ------------------------------ */
  press('stand.up', 'Rise', 'Standing', 'standing', chord('PageUp'), {
    held: true,
    hint: 'climb, from two meters to the orbit floor',
  }),
  press('stand.down', 'Descend', 'Standing', 'standing', chord('PageDown'), {
    held: true,
  }),
  press(
    'stand.leave',
    'Back to Orbit',
    'Standing',
    'standing',
    chord('Backspace'),
  ),

  /* ------------------------------- cinema ------------------------------- */
  press('cinema.play', 'Play', 'Cinema', 'cinema', chord('Space'), {
    yieldsToFocus: true,
  }),
  press('cinema.back', 'Step Back', 'Cinema', 'cinema', chord('ArrowLeft'), {
    shiftScales: true,
    yieldsToFocus: true,
    hint: 'one frame, or a second with Shift',
  }),
  press(
    'cinema.forward',
    'Step Forward',
    'Cinema',
    'cinema',
    chord('ArrowRight'),
    { shiftScales: true, yieldsToFocus: true },
  ),
  press('cinema.library', 'The Library', 'Cinema', 'cinema', chord('Escape')),
]

export type ActionId = string

const BY_ID = new Map(ACTIONS.map((action) => [action.id, action]))

export const findAction = (id: ActionId): ActionDefinition | undefined =>
  BY_ID.get(id)

/** The live chord for every action, defaults with the overrides laid over. */
export type Bindings = ReadonlyMap<ActionId, Chord | null>

/**
 * Resolve the stored overrides against the defaults.
 *
 * Overrides only, never the whole table: a stored copy of every binding stops
 * tracking the defaults, so an action whose default moves is frozen at the old
 * one for everybody who has ever opened the editor. An entry naming an id this
 * build does not have is dropped, and so is a chord it would not have written —
 * `localStorage` outlives the code that wrote it, and this is the same argument
 * every other guard here makes.
 */
export function resolveBindings(
  overrides: Readonly<Record<string, string | null>> = {},
): Bindings {
  const resolved = new Map<ActionId, Chord | null>()
  for (const action of ACTIONS) resolved.set(action.id, action.chord)
  for (const [id, stored] of Object.entries(overrides)) {
    if (!BY_ID.has(id)) continue
    if (stored === null) {
      resolved.set(id, null)
      continue
    }
    const parsed = parseChord(stored)
    if (parsed !== null) resolved.set(id, parsed)
  }
  return resolved
}

/**
 * Whether a chord matches an action's binding.
 *
 * `shiftScales` is the whole of the subtlety: an action that reads Shift as a
 * magnitude is bound to the bare key and answers to both, and the handler is
 * told which. Anything else compares all three fields, so `Shift+H` and `H` are
 * two bindings rather than one with a modifier nobody reads.
 */
export function matches(
  action: ActionDefinition,
  bound: Chord | null,
  pressed: Chord,
): boolean {
  if (bound === null) return false
  if (action.shiftScales === true) {
    return bound.code === pressed.code && bound.alt === pressed.alt
  }
  return chordEquals(bound, pressed)
}

/** Which action a chord means, given what is live. Null when nothing binds it. */
export function actionFor(
  bindings: Bindings,
  live: readonly KeyContext[],
  pressed: Chord,
  muted: readonly ActionId[] = [],
): ActionDefinition | null {
  let best: ActionDefinition | null = null
  for (const action of ACTIONS) {
    if (!live.includes(action.context)) continue
    if (muted.includes(action.id)) continue
    if (!matches(action, bindings.get(action.id) ?? null, pressed)) continue
    if (
      best === null ||
      SPECIFICITY[action.context] > SPECIFICITY[best.context]
    ) {
      best = action
    }
  }
  return best
}

/** Two actions that would answer to one chord at one moment. */
export interface Collision {
  readonly chord: Chord
  /** Most specific context first, which is dispatch order. */
  readonly ids: readonly ActionId[]
  readonly live: readonly KeyContext[]
  /**
   * Whether the two are genuinely ambiguous, or one deliberately covers the
   * other.
   *
   * `ambiguous` is two actions in the same context, where nothing decides and
   * the dispatcher's answer is whichever the table lists first — a defect.
   * `shadowed` is an inner context taking a chord an outer one also holds, and
   * that is the design: `Space` is pause everywhere and the transport in the
   * cinema, and the cinema's claim is the better one while you are in it. The
   * editor still says so, because a rebind that silently costs somebody the
   * pause key in one mode is worth a sentence.
   */
  readonly kind: 'ambiguous' | 'shadowed'
}

/**
 * Every collision a set of bindings would produce, in every live set.
 *
 * Checked per live set rather than per context, because `global` is live
 * alongside every other context and a rule phrased as "conflicts within a
 * context" would miss exactly the ones that matter — `Space` for pause and
 * `Space` for the cinema transport being the pair that shipped as a bug: both
 * handlers ran, `clock.paused` flipped twice, and the documented control did
 * nothing at all with nothing to see in the console.
 */
export function collisions(bindings: Bindings): readonly Collision[] {
  const found: Collision[] = []
  for (const live of LIVE_SETS) {
    const seen = new Map<string, ActionDefinition[]>()
    for (const action of ACTIONS) {
      if (!live.includes(action.context)) continue
      const bound = bindings.get(action.id) ?? null
      if (bound === null) continue
      // Keyed by what the dispatcher compares: an action reading Shift as a
      // magnitude answers to the bare key, so `Shift` is not part of its key
      // here either.
      const key =
        action.shiftScales === true
          ? `${bound.alt ? 'Alt+' : ''}${bound.code}`
          : `${bound.alt ? 'Alt+' : ''}${bound.shift ? 'Shift+' : ''}${bound.code}`
      const held = seen.get(key) ?? []
      held.push(action)
      seen.set(key, held)
    }
    for (const [, actions] of seen) {
      if (actions.length < 2) continue
      const ordered = [...actions].sort(
        (a, b) => SPECIFICITY[b.context] - SPECIFICITY[a.context],
      )
      const first = ordered[0]
      const second = ordered[1]
      if (first === undefined || second === undefined) continue
      const bound = bindings.get(first.id) ?? null
      if (bound === null) continue
      found.push({
        chord: bound,
        ids: ordered.map((action) => action.id),
        live,
        kind:
          SPECIFICITY[second.context] === SPECIFICITY[first.context]
            ? 'ambiguous'
            : 'shadowed',
      })
    }
  }
  return found
}

/** The actions of one context, in table order. The editor's rows. */
export const actionsIn = (context: KeyContext): readonly ActionDefinition[] =>
  ACTIONS.filter((action) => action.context === context)

/** Every group name in table order, for the sheet's headings. */
export function groupsOf(
  actions: readonly ActionDefinition[],
): readonly string[] {
  const seen: string[] = []
  for (const action of actions) {
    if (!seen.includes(action.group)) seen.push(action.group)
  }
  return seen
}
