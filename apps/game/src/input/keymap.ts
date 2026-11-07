import { type Chord, chord, chordEquals, parseChord } from './chord.ts'
import { type PadControl, parsePad } from './pad.ts'

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
 * never contains a key name. The key, the label and the handler are three
 * views of this table rather than three string literals in three files.
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
  | 'global'
  | 'menu'
  | 'flight'
  | 'planetarium'
  | 'standing'
  /**
   * The ship's free look, while it is held. A layer over `flight` rather than
   * a mode: the pad's steering stick turns the head instead of the hull for as
   * long as the button is down, and the hull's axes come back on release.
   */
  | 'flight-look'
  | 'character-entry'
  | 'character'
  | 'cinema'
  | 'docs'
  /** A routed dialog, open over whatever mode is behind it. */
  | 'dialog'
  /** A scripted scene playing. Every routed page unmounts under one. */
  | 'cutscene'

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
const MODE_SETS: readonly (readonly KeyContext[])[] = [
  ['global', 'menu'],
  ['global', 'flight', 'character-entry'],
  ['global', 'flight', 'character-entry', 'flight-look'],
  ['global', 'character', 'character-entry'],
  ['global', 'planetarium'],
  ['global', 'planetarium', 'standing'],
  ['global', 'cinema'],
  ['global', 'docs'],
]

/**
 * The two layers that can sit over a mode, and never over each other.
 *
 * A routed dialog leaves the mode mounted behind it — that is what the
 * background location is for — so `dialog` genuinely coexists with every mode.
 * A cutscene does not: every routed page unmounts under one, along with the
 * rest of the chrome, so a dialog and a cutscene are not a state this app has.
 */
const MODAL_LAYERS: readonly (readonly KeyContext[])[] = [
  [],
  ['dialog'],
  ['cutscene'],
  /*
   * Both at once, which the cinema really does produce.
   *
   * `App` draws the dialog band whenever the mode is `cinema`, so a scene
   * playing in the player with Settings opened over it claims `cutscene` and
   * `dialog` together. Left out of this list the combination is a live set
   * `collisions` never checks, and Escape — which both layers bind — would be
   * arbitrated by nothing but the order of the table.
   */
  ['cutscene', 'dialog'],
]

export const LIVE_SETS: readonly (readonly KeyContext[])[] = MODE_SETS.flatMap(
  (mode) => MODAL_LAYERS.map((layer) => [...mode, ...layer]),
)

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
  menu: 1,
  docs: 1,
  cinema: 1,
  flight: 1,
  planetarium: 1,
  standing: 2,
  'flight-look': 2,
  'character-entry': 1,
  character: 2,
  cutscene: 3,
  /*
   * Above the cutscene, because the two can be live together and both bind
   * Escape. A dialog is the thing most recently asked for and the thing with a
   * scrim over everything else, so Escape dismisses it first and skips the
   * scene on the press after. Equal ranks would leave that to table order,
   * which is an accident rather than a rule.
   */
  dialog: 4,
}

/**
 * The rank at which a context stops sharing the keyboard and takes it.
 *
 * `dialog` and `cutscene` are layers over a mode rather than modes, and the
 * mode underneath stays mounted — which is the whole point of the background
 * location, and also the reason its bindings are still live and still wrong.
 * `/` focusing the reading room's search field from behind a Settings scrim is
 * the worked example: the dialogs deliberately have no focus trap, so the
 * keystroke lands in a field nobody can see.
 */
const MODAL_RANK = 3

/**
 * Which of the live contexts a chord may actually resolve against.
 *
 * A modal layer takes the keyboard from every *mode* under it and leaves
 * `global` alone. Both halves are deliberate: a mode's keys are about a picture
 * the reader has stopped looking at, while the global run is the shell's own —
 * the settings key, the keys sheet, the panel numbers — and those are as
 * meaningful over a dialog as under one.
 *
 * One rule, applied where the arbitration already happens, rather than a
 * `document.querySelector('[role="dialog"]')` in each listener that wants it.
 */
export function arbitrate(live: readonly KeyContext[]): readonly KeyContext[] {
  if (!live.some((context) => SPECIFICITY[context] >= MODAL_RANK)) return live
  return live.filter(
    (context) =>
      SPECIFICITY[context] === 0 || SPECIFICITY[context] >= MODAL_RANK,
  )
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
   * The axes — the ship's, the stance's, the walker's, and the analog
   * cameras'. A held action gets both edges, a magnitude, and a blur; a
   * pressed one gets the down edge alone. They are the same table because
   * they are the same question — "what is `W` bound to" has one answer — and
   * because a held action is exactly what a stick is: an axis with a
   * magnitude, of which a key is the case where the magnitude is one.
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
   * Whether the operating system's auto-repeat should fire it again.
   *
   * Off by default, and the default is the interesting half: a press action is
   * a *decision*, and a decision taken thirty times a second because a key was
   * leant on is not the same decision thirty times — held `Space` flips
   * `clock.paused` on every repeat and lands on whichever parity the release
   * happened to fall on, and held `]` walks the whole warp ladder before a hand
   * can come off it. The two listeners this table replaces both opened with
   * `if (event.repeat) return` for exactly that reason.
   *
   * The exceptions are the acts that are a *quantity* rather than a decision,
   * where leaning on the key is how somebody asks for more of it: the surface
   * climb and descent move a tenth of the travel per press, and ten discrete
   * presses to cross six decades of height is a control nobody would use twice.
   */
  readonly repeats?: boolean
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
  /**
   * What it is bound to on a gamepad out of the box, by position (`pad.ts`).
   * `null` is unbound, as for a chord.
   *
   * A second binding on the same action rather than a second table of pad
   * acts, and that is the decision the rest follows from: a mode registers a
   * handler for `flight.pitchUp` and is told when it fires, and whether a key
   * or a stick fired it is not its business. The keymap's contexts, mutes and
   * arbitration apply to the pad unchanged, so `Cross` can frame the subject
   * in the planetarium and jump on foot for the reason `F` can translate down
   * in flight and frame in the planetarium.
   */
  readonly pad: PadControl | null
  /**
   * Which of the two invert preferences flips this action's stick.
   *
   * Two, because they are two habits: a pilot who flies inverted pitch — stick
   * back is nose up, as in every aircraft — very often looks with the stick
   * the right way up. Applied to the pad alone; a key named Up means up.
   */
  readonly invert?: 'look' | 'pitch'
}

const press = (
  id: string,
  label: string,
  group: string,
  context: KeyContext,
  binding: Chord | null,
  extra: Partial<ActionDefinition> = {},
): ActionDefinition => ({
  id,
  label,
  group,
  context,
  chord: binding,
  pad: null,
  ...extra,
})

/**
 * Four held look actions on one stick, as a run: `<prefix>.lookLeft` and so on.
 *
 * Unbound on the keyboard, because the mouse is the keyboard's look and a key
 * held to turn a head is a worse version of a drag — but they are ordinary
 * rows, so somebody who wants one on a key can put it there.
 */
function look(
  prefix: string,
  context: KeyContext,
  group: string,
  stick: 'ls' | 'rs',
  hint: string,
): readonly ActionDefinition[] {
  return [
    press(`${prefix}.lookLeft`, 'Look left', group, context, null, {
      held: true,
      pad: `${stick}.left`,
      hint,
    }),
    press(`${prefix}.lookRight`, 'Look right', group, context, null, {
      held: true,
      pad: `${stick}.right`,
    }),
    press(`${prefix}.lookUp`, 'Look up', group, context, null, {
      held: true,
      pad: `${stick}.up`,
      invert: 'look',
    }),
    press(`${prefix}.lookDown`, 'Look down', group, context, null, {
      held: true,
      pad: `${stick}.down`,
      invert: 'look',
    }),
  ]
}

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
    pad: 'west',
  }),
  press('time.slower', 'Slower', 'Time', 'global', chord('BracketLeft'), {
    pad: 'left',
  }),
  press('time.faster', 'Faster', 'Time', 'global', chord('BracketRight'), {
    pad: 'right',
  }),
  press('time.normal', 'Real time', 'Time', 'global', chord('Backslash'), {
    hint: 'back to one second per second',
  }),

  press('session.save', 'Save', 'Session', 'global', chord('F5')),
  press('session.load', 'Load', 'Session', 'global', chord('F9')),

  press('nav.goTo', 'Go to', 'Session', 'global', chord('Slash'), {
    hint: 'focus the navigator’s search, which takes a name, a near miss of one, or anything an address does',
  }),

  press('chrome.panes', 'Both panes', 'Screen', 'global', chord('KeyH'), {
    hint: 'clear both panes, or bring them back',
  }),
  press(
    'chrome.all',
    'All chrome',
    'Screen',
    'global',
    chord('KeyH', { shift: true }),
    {
      hint: 'panes, menu, reticle and notices — the state a plate is taken in',
    },
  ),
  press(
    'chrome.instruments',
    'The instruments',
    'Screen',
    'global',
    chord('Backquote'),
    { hint: 'disclose the author’s panels' },
  ),
  press(
    'chrome.keys',
    'The keys',
    'Screen',
    'global',
    chord('Slash', { shift: true }),
    { hint: 'this sheet, from any mode', pad: 'touchpad' },
  ),
  press(
    'sensor.response',
    'Camera mode',
    'Screen',
    'global',
    chord('KeyV', { shift: true }),
  ),
  press('chrome.settings', 'Settings', 'Screen', 'global', chord('Comma'), {
    pad: 'start',
  }),
  /*
   * The pad's `Tab`: into the panels, so the d-pad and ✕ work them.
   *
   * A pad has no pointer and no Tab, and without a way in the dock is a wall
   * of controls a pad cannot reach. Unbound on the keyboard because the
   * keyboard has Tab, which is the platform's and is not rebindable.
   */
  press('chrome.focus', 'The panels', 'Screen', 'global', null, {
    pad: 'select',
    hint: 'move into the panels, so the d-pad and the bottom button work them; the right button comes back out',
  }),

  press('panel.1', 'First panel', 'Panels', 'global', chord('Digit1')),
  press('panel.2', 'Second panel', 'Panels', 'global', chord('Digit2')),
  press('panel.3', 'Third panel', 'Panels', 'global', chord('Digit3')),
  press('panel.4', 'Fourth panel', 'Panels', 'global', chord('Digit4')),
  press('panel.5', 'Fifth panel', 'Panels', 'global', chord('Digit5')),
  press('panel.6', 'Sixth panel', 'Panels', 'global', chord('Digit6')),
  press('panel.7', 'Seventh panel', 'Panels', 'global', chord('Digit7')),
  /*
   * An eighth, because the planetarium has eight panels when the guide is
   * granted, and a number key assigned by position runs out silently: the
   * last panel in the menu was the one panel no key reached.
   */
  press('panel.8', 'Eighth panel', 'Panels', 'global', chord('Digit8')),
  // Named for what it opens rather than by the panel's short title: the
  // editor's clash line reads "shares its key with …", and "Perf" there is a
  // word only the author knows.
  press('panel.perf', 'Performance panel', 'Panels', 'global', chord('KeyP')),

  /* ------------------------------- flight ------------------------------- */
  /*
   * The pad's flight layout is the one most six-axis games on a pad share —
   * Everspace 2, Star Citizen and Outer Wilds among them: translation on the
   * left stick, attitude on the right, vertical thrust on the triggers, and
   * roll on the bumpers. A pad has five analog axes for six degrees of
   * freedom, and roll is the one that goes digital, because a roll is the
   * axis a pilot holds at full rate rather than trims.
   */
  press('flight.fore', 'Thrust ahead', 'Flight', 'flight', chord('KeyW'), {
    held: true,
    pad: 'ls.up',
    hint: 'the thrusters, not the drive — a nudge, for docking and station-keeping',
  }),
  press('flight.aft', 'Thrust astern', 'Flight', 'flight', chord('KeyS'), {
    held: true,
    pad: 'ls.down',
  }),
  press('flight.left', 'Translate left', 'Flight', 'flight', chord('KeyA'), {
    held: true,
    pad: 'ls.left',
  }),
  press('flight.right', 'Translate right', 'Flight', 'flight', chord('KeyD'), {
    held: true,
    pad: 'ls.right',
  }),
  press('flight.up', 'Translate up', 'Flight', 'flight', chord('KeyR'), {
    held: true,
    pad: 'r2',
  }),
  press('flight.down', 'Translate down', 'Flight', 'flight', chord('KeyF'), {
    held: true,
    pad: 'l2',
  }),
  press('flight.pitchUp', 'Pitch up', 'Flight', 'flight', chord('ArrowUp'), {
    held: true,
    yieldsToFocus: true,
    pad: 'rs.up',
    invert: 'pitch',
  }),
  press(
    'flight.pitchDown',
    'Pitch down',
    'Flight',
    'flight',
    chord('ArrowDown'),
    { held: true, yieldsToFocus: true, pad: 'rs.down', invert: 'pitch' },
  ),
  press('flight.yawLeft', 'Yaw left', 'Flight', 'flight', chord('ArrowLeft'), {
    held: true,
    yieldsToFocus: true,
    pad: 'rs.left',
  }),
  press(
    'flight.yawRight',
    'Yaw right',
    'Flight',
    'flight',
    chord('ArrowRight'),
    { held: true, yieldsToFocus: true, pad: 'rs.right' },
  ),
  press('flight.rollLeft', 'Roll left', 'Flight', 'flight', chord('KeyQ'), {
    held: true,
    pad: 'l1',
  }),
  press('flight.rollRight', 'Roll right', 'Flight', 'flight', chord('KeyE'), {
    held: true,
    pad: 'r1',
  }),
  /*
   * The drive is a setting, not a held key, so its four acts are presses.
   *
   * The two that walk it repeat, on the argument the surface climb makes: a
   * throttle is a quantity, and leaning on the key is how somebody asks for
   * more of it. Two more slam it, because a pilot who wants the drive off
   * wants it off now and not in twenty presses.
   */
  press('flight.throttleUp', 'Throttle up', 'Flight', 'flight', chord('KeyT'), {
    repeats: true,
    // The d-pad, as in Kerbal Space Program's pad layout: the sticks and the
    // bumpers are already the six axes, and a setting that is walked rather
    // than held belongs on a control that is pressed rather than pushed.
    pad: 'up',
    hint: 'the main drive, a twentieth at a time; hold it to walk',
  }),
  press(
    'flight.throttleDown',
    'Throttle down',
    'Flight',
    'flight',
    chord('KeyG'),
    { repeats: true, pad: 'down' },
  ),
  press(
    'flight.throttleFull',
    'Full burn',
    'Flight',
    'flight',
    chord('KeyT', { shift: true }),
  ),
  press(
    'flight.throttleCut',
    'Cut the drive',
    'Flight',
    'flight',
    chord('KeyG', { shift: true }),
    { hint: 'the drive to nothing in one press, whatever the ship is doing' },
  ),
  // A stick press for the assist, as Star Citizen puts its decoupled toggle:
  // the face buttons are the acts taken often, and this is not one.
  press('flight.assist', 'Flight assist', 'Flight', 'flight', chord('KeyZ'), {
    pad: 'l3',
  }),
  press('flight.kill', 'Kill rotation', 'Flight', 'flight', chord('KeyX'), {
    pad: 'south',
  }),
  press('flight.view', 'Camera view', 'Flight', 'flight', chord('KeyV'), {
    pad: 'r3',
    hint: 'chase the ship, or stand off and orbit it — drag to look or orbit, wheel to dolly',
  }),
  press('flight.recenter', 'Recenter', 'Flight', 'flight', chord('Home'), {
    yieldsToFocus: true,
    hint: 'look where the view aims again',
  }),
  /*
   * Hold to look, tap to look ahead — Starfield's free look, on the button a
   * pad's thumb is already resting beside.
   *
   * Held, because the pad has no spare stick: both are flying the ship, so the
   * head borrows the right one for as long as the button is down
   * (`flight-look`) and gives it back on release. A press shorter than a
   * blink is a recenter, which is the act a pilot who has been looking around
   * wants next.
   */
  press('flight.freeLook', 'Free look', 'Flight', 'flight', null, {
    held: true,
    pad: 'east',
    hint: 'hold to turn the head with the steering stick; tap to look ahead again',
  }),
  ...look('flight', 'flight-look', 'Flight', 'rs', 'look where the head turns'),

  press(
    'guide.pause',
    'Pause or resume the guide',
    'Guide',
    'planetarium',
    null,
  ),
  press('guide.end', 'End the guide', 'Guide', 'planetarium', null),

  /* ---------------------------- planetarium ----------------------------- */
  press(
    'observe.left',
    'Orbit left',
    'Planetarium',
    'planetarium',
    chord('ArrowLeft'),
    { shiftScales: true, yieldsToFocus: true, hint: 'hold Shift for coarse' },
  ),
  press(
    'observe.right',
    'Orbit right',
    'Planetarium',
    'planetarium',
    chord('ArrowRight'),
    { shiftScales: true, yieldsToFocus: true },
  ),
  press(
    'observe.up',
    'Orbit up',
    'Planetarium',
    'planetarium',
    chord('ArrowUp'),
    { shiftScales: true, yieldsToFocus: true },
  ),
  press(
    'observe.down',
    'Orbit down',
    'Planetarium',
    'planetarium',
    chord('ArrowDown'),
    { shiftScales: true, yieldsToFocus: true },
  ),
  press(
    'observe.in',
    'Dolly in',
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
    'Dolly out',
    'Planetarium',
    'planetarium',
    chord('Minus'),
    { shiftScales: true },
  ),
  press('observe.frame', 'Frame', 'Planetarium', 'planetarium', chord('KeyF'), {
    pad: 'north',
    hint: 'solve the distance that fills the frame at this lens',
  }),
  press('observe.home', 'Home', 'Planetarium', 'planetarium', chord('Home'), {
    pad: 'l3',
    hint: 'back to where the session opened',
  }),
  /*
   * The pad's planetarium is a map view's: the right stick orbits, the
   * triggers close in and pull back, ✕ picks whatever is under the reticle
   * — the Elite galaxy map's, Starfield's star map's and SpaceEngine's
   * crosshair — and the bumpers and the d-pad walk the system as a tree.
   */
  press('observe.swingLeft', 'Swing left', 'Planetarium', 'planetarium', null, {
    held: true,
    pad: 'rs.left',
    hint: 'orbit for as long as it is held, at a rate the lens scales; standing, it looks',
  }),
  press(
    'observe.swingRight',
    'Swing right',
    'Planetarium',
    'planetarium',
    null,
    { held: true, pad: 'rs.right' },
  ),
  press('observe.swingUp', 'Swing up', 'Planetarium', 'planetarium', null, {
    held: true,
    pad: 'rs.up',
    invert: 'look',
  }),
  press('observe.swingDown', 'Swing down', 'Planetarium', 'planetarium', null, {
    held: true,
    pad: 'rs.down',
    invert: 'look',
  }),
  ...look(
    'observe',
    'planetarium',
    'Planetarium',
    'ls',
    'turn the head off the subject without moving the camera',
  ),
  press('observe.approach', 'Close in', 'Planetarium', 'planetarium', null, {
    held: true,
    pad: 'r2',
    hint: 'move toward the subject for as long as it is held — harder is faster',
  }),
  press('observe.retreat', 'Pull back', 'Planetarium', 'planetarium', null, {
    held: true,
    pad: 'l2',
  }),
  press(
    'observe.pick',
    'Choose the center',
    'Planetarium',
    'planetarium',
    null,
    {
      pad: 'south',
      hint: 'look at whatever is under the reticle — the pad’s click',
    },
  ),
  press('observe.center', 'Look ahead', 'Planetarium', 'planetarium', null, {
    pad: 'east',
    hint: 'turn the head back to the subject',
  }),
  press(
    'observe.previous',
    'Previous body',
    'Planetarium',
    'planetarium',
    null,
    {
      pad: 'l1',
      hint: 'the next one in, round the same primary',
    },
  ),
  press('observe.next', 'Next body', 'Planetarium', 'planetarium', null, {
    pad: 'r1',
    hint: 'the next one out, round the same primary',
  }),
  press('observe.parent', 'Its primary', 'Planetarium', 'planetarium', null, {
    pad: 'up',
    hint: 'from a moon to its planet, from a planet to its star',
  }),
  press('observe.child', 'Its satellites', 'Planetarium', 'planetarium', null, {
    pad: 'down',
    hint: 'from a star to its first planet, from a planet to its first moon',
  }),
  press(
    'observe.freeLook',
    'Free look',
    'Planetarium',
    'planetarium',
    chord('KeyL'),
    { hint: 'make the drag and the arrows look instead of orbit' },
  ),

  /* ------------------------------ standing ------------------------------ */
  /*
   * `repeats`, not `held`, and the distinction is the control's own.
   *
   * These move a tenth of the travel on the *down* edge and have nothing to do
   * on the up one, so `held` buys no second edge and actively costs the
   * repeats: the dispatcher drops a held action's auto-repeat because a control
   * vector does not change while a key stays down, which turned leaning on
   * PageUp into a single tenth of a climb. `held` is the flight axes, and
   * nothing else.
   */
  press('stand.up', 'Rise', 'Standing', 'standing', chord('PageUp'), {
    repeats: true,
    pad: 'up',
    hint: 'climb, from two meters to the orbit floor',
  }),
  press('stand.down', 'Descend', 'Standing', 'standing', chord('PageDown'), {
    repeats: true,
    pad: 'down',
  }),
  press(
    'stand.leave',
    'Back to orbit',
    'Standing',
    'standing',
    chord('Backspace'),
    { pad: 'east' },
  ),
  /*
   * Flying the stance. Held, like the flight axes, because a key that moves
   * the eye for as long as it is down is an axis. The letters are the ship's
   * translation keys, which is deliberate: a hand that knows the ship knows
   * the stance, and the two contexts are never live together.
   */
  press('stand.forward', 'Fly forward', 'Standing', 'standing', chord('KeyW'), {
    held: true,
    shiftScales: true,
    pad: 'ls.up',
    hint: 'along the heading; hold Shift for fast',
  }),
  press('stand.back', 'Fly back', 'Standing', 'standing', chord('KeyS'), {
    held: true,
    shiftScales: true,
    pad: 'ls.down',
  }),
  press('stand.left', 'Fly left', 'Standing', 'standing', chord('KeyA'), {
    held: true,
    shiftScales: true,
    pad: 'ls.left',
  }),
  press('stand.right', 'Fly right', 'Standing', 'standing', chord('KeyD'), {
    held: true,
    shiftScales: true,
    pad: 'ls.right',
  }),
  press('stand.rise', 'Fly up', 'Standing', 'standing', chord('KeyE'), {
    held: true,
    shiftScales: true,
    pad: 'r2',
  }),
  press('stand.lower', 'Fly down', 'Standing', 'standing', chord('KeyQ'), {
    held: true,
    shiftScales: true,
    pad: 'l2',
  }),
  /*
   * Shift, for a hand without one. The keyboard reads Shift as a magnitude on
   * the six keys above; a pad has no modifier to read, so fast is a held
   * action of its own on the stick press every free camera puts its sprint on.
   */
  press('stand.fast', 'Fly fast', 'Standing', 'standing', null, {
    held: true,
    pad: 'l3',
    hint: 'hold for fast, as Shift does on the keys',
  }),

  /* ------------------------------ character ----------------------------- */
  press(
    'character.lock',
    'Step out to walk',
    'Character',
    'character-entry',
    chord('KeyL', { shift: true }),
    {
      /*
       * On the button most games use to leave a vehicle, and live beside the
       * walk as well as beside flight, so one press steps out and the next
       * hands the walker back. A pad takes no pointer lock — it has no
       * pointer to lock — so from a pad this engages the walker directly.
       */
      pad: 'north',
    },
  ),
  press(
    'character.forward',
    'Walk forward',
    'Character',
    'character',
    chord('KeyW'),
    { held: true, shiftScales: true, pad: 'ls.up' },
  ),
  press(
    'character.back',
    'Walk backward',
    'Character',
    'character',
    chord('KeyS'),
    { held: true, shiftScales: true, pad: 'ls.down' },
  ),
  press(
    'character.left',
    'Strafe left',
    'Character',
    'character',
    chord('KeyA'),
    { held: true, shiftScales: true, pad: 'ls.left' },
  ),
  press(
    'character.right',
    'Strafe right',
    'Character',
    'character',
    chord('KeyD'),
    { held: true, shiftScales: true, pad: 'ls.right' },
  ),
  press(
    'character.sprint',
    'Sprint',
    'Character',
    'character',
    chord('Shift'),
    { held: true, pad: 'l3' },
  ),
  press(
    'character.crouch',
    'Crouch or fly down',
    'Character',
    'character',
    chord('KeyC'),
    { held: true, shiftScales: true, pad: 'east' },
  ),
  press(
    'character.jump',
    'Jump or fly up',
    'Character',
    'character',
    chord('Space'),
    {
      held: true,
      shiftScales: true,
      pad: 'south',
      hint: 'double-tap to toggle flight when permitted',
    },
  ),
  press(
    'character.view',
    'Character camera',
    'Character',
    'character',
    chord('KeyV'),
    { pad: 'r3', hint: 'switch between first and third person' },
  ),
  ...look(
    'character',
    'character',
    'Character',
    'rs',
    'turn the walker and the camera',
  ),
  press(
    'character.release',
    'Release pointer',
    'Character',
    'character',
    chord('Escape'),
  ),

  /* ------------------------------- cinema ------------------------------- */
  // A media player's pad: ✕ plays, the d-pad steps, ○ goes back.
  press('cinema.play', 'Play', 'Cinema', 'cinema', chord('Space'), {
    yieldsToFocus: true,
    pad: 'south',
  }),
  press('cinema.back', 'Step back', 'Cinema', 'cinema', chord('ArrowLeft'), {
    shiftScales: true,
    yieldsToFocus: true,
    pad: 'left',
    hint: 'one frame, or a second with Shift',
  }),
  press(
    'cinema.forward',
    'Step forward',
    'Cinema',
    'cinema',
    chord('ArrowRight'),
    { shiftScales: true, yieldsToFocus: true, pad: 'right' },
  ),
  press('cinema.library', 'The library', 'Cinema', 'cinema', chord('Escape'), {
    pad: 'east',
  }),

  /* -------------------------------- docs -------------------------------- */
  press('docs.search', 'Search the docs', 'Reading', 'docs', chord('Slash'), {
    hint: 'the reading room’s own search, in place of the catalog’s',
  }),

  /* ------------------------- over everything ---------------------------- */
  press('overlay.close', 'Close', 'Dialogs', 'dialog', chord('Escape'), {
    pad: 'east',
    hint: 'the platform’s gesture, and the reason Escape is not rebindable',
  }),
  press('cutscene.skip', 'Skip', 'Dialogs', 'cutscene', chord('Escape'), {
    pad: 'east',
    hint: 'stop the scene and put the ship back where it was',
  }),
]

export type ActionId = string

/** The front door offers navigation, while the scene remains decoration. */
export const MENU_KEYS = {
  context: 'menu' as const,
  mutes: ACTIONS.filter(
    (action) =>
      action.context === 'global' &&
      !['chrome.settings', 'chrome.keys'].includes(action.id),
  ).map((action) => action.id),
}

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
  const reachable = arbitrate(live)
  for (const action of ACTIONS) {
    if (!reachable.includes(action.context)) continue
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

/** The live pad control for every action, defaults with overrides laid over. */
export type PadBindings = ReadonlyMap<ActionId, PadControl | null>

/**
 * The pad's `resolveBindings`, with the same rule for the same reason:
 * overrides only, an unknown id dropped, a control this build would not have
 * written dropped.
 */
export function resolvePadBindings(
  overrides: Readonly<Record<string, string | null>> = {},
): PadBindings {
  const resolved = new Map<ActionId, PadControl | null>()
  for (const action of ACTIONS) resolved.set(action.id, action.pad)
  for (const [id, stored] of Object.entries(overrides)) {
    if (!BY_ID.has(id)) continue
    if (stored === null) {
      resolved.set(id, null)
      continue
    }
    const parsed = parsePad(stored)
    if (parsed !== null) resolved.set(id, parsed)
  }
  return resolved
}

/**
 * What every pad control means, given what is live.
 *
 * A map rather than one control at a time, because the pad is polled: every
 * control is asked every frame, and a scan of the table per control per frame
 * is a cost paid for an answer that changes only when a context or a binding
 * does. The caller caches it on exactly those two.
 */
export function padActions(
  bindings: PadBindings,
  live: readonly KeyContext[],
  muted: readonly ActionId[] = [],
): ReadonlyMap<PadControl, ActionDefinition> {
  const found = new Map<PadControl, ActionDefinition>()
  const reachable = arbitrate(live)
  for (const action of ACTIONS) {
    if (!reachable.includes(action.context)) continue
    if (muted.includes(action.id)) continue
    const control = bindings.get(action.id) ?? null
    if (control === null) continue
    const held = found.get(control)
    if (
      held === undefined ||
      SPECIFICITY[action.context] > SPECIFICITY[held.context]
    )
      found.set(control, action)
  }
  return found
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
  return collide(bindings, (action, bound) =>
    // Keyed by what the dispatcher compares: an action reading Shift as a
    // magnitude answers to the bare key, so `Shift` is not part of its key
    // here either.
    action.shiftScales === true
      ? `${bound.alt ? 'Alt+' : ''}${bound.code}`
      : `${bound.alt ? 'Alt+' : ''}${bound.shift ? 'Shift+' : ''}${bound.code}`,
  )
}

/** Two actions that would answer to one pad control at one moment. */
export interface PadCollision {
  readonly control: PadControl
  readonly ids: readonly ActionId[]
  readonly live: readonly KeyContext[]
  readonly kind: 'ambiguous' | 'shadowed'
}

/**
 * `collisions`, for the pad. The same live sets and the same two kinds,
 * because the pad is dispatched through the same arbitration — a control is
 * only ever as ambiguous as a key in the same place would be.
 */
export function padCollisions(bindings: PadBindings): readonly PadCollision[] {
  return collide(bindings, (_, bound) => bound).map(
    ({ chord: control, ...rest }) => ({ control, ...rest }),
  )
}

/** One detector for both devices, keyed by what each dispatcher compares. */
function collide<B>(
  bindings: ReadonlyMap<ActionId, B | null>,
  keyOf: (action: ActionDefinition, bound: B) => string,
): readonly {
  readonly chord: B
  readonly ids: readonly ActionId[]
  readonly live: readonly KeyContext[]
  readonly kind: 'ambiguous' | 'shadowed'
}[] {
  const found: {
    chord: B
    ids: ActionId[]
    live: readonly KeyContext[]
    kind: 'ambiguous' | 'shadowed'
  }[] = []
  for (const live of LIVE_SETS) {
    const reachable = arbitrate(live)
    const seen = new Map<string, ActionDefinition[]>()
    for (const action of ACTIONS) {
      if (!reachable.includes(action.context)) continue
      const bound = bindings.get(action.id) ?? null
      if (bound === null) continue
      const key = keyOf(action, bound)
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
