import { useState } from 'react'
import { Action } from '../hud/Action.tsx'
import { FOCUS_RING } from '../hud/focus.ts'
import { SearchField } from '../hud/SearchField.tsx'
import { SettingRow } from '../hud/SettingRow.tsx'
import {
  chordFromEvent,
  chordLabel,
  formatChord,
  isBindable,
  isModifierCode,
  REFUSED_CODES,
} from '../input/chord.ts'
import {
  ACTIONS,
  type ActionDefinition,
  collisions,
  findAction,
  groupsOf,
  type KeyContext,
  resolveBindings,
} from '../input/keymap.ts'
import { useKeymap } from '../input/useKeymap.ts'
import { CONTROLS_KEYMAP, usePersistentState } from '../state/preferences.ts'
import { defaultChord, keyChanged } from './settingsDefaults.ts'

/*
 * Rebinding, which `docs/design/ux.md` promises.
 *
 * Every act is a row, pressing the row's key captures the next chord, and a
 * conflict is named where it happens rather than discovered later in a mode
 * where a key stopped working. A page that printed the bindings as prose could
 * not do the last part at all: prose cannot know what the keys are now.
 *
 * The rows are drawn in the groups the keymap already declares, under a
 * heading that says where the group's keys work. A flat list of a hundred
 * acts with " · global" appended to each one put the one fact that differs
 * between groups at the end of every line, where the eye stops reading — and
 * "which key is Fit" is a question asked of a heading, not of a suffix. The
 * filter answers the other question, "what does F do", from the key's side.
 *
 * The stored value is overrides only, so an action whose default moves keeps
 * tracking it for everybody who has not deliberately rebound it — and `null`
 * is a deliberate unbinding, which the row's × writes.
 */

/** How the capture reads while it is armed. */
const LISTENING = 'press a key…'

/** Where a group's keys work, in the reader's words rather than the table's. */
const WHERE: Readonly<Record<KeyContext, string>> = {
  global: 'everywhere',
  menu: 'on the menu',
  flight: 'in flight',
  'flight-look': 'in flight',
  planetarium: 'in the planetarium',
  standing: 'standing on a surface',
  'character-entry': 'on foot',
  character: 'on foot',
  cinema: 'in the cinema',
  docs: 'in the documentation',
  dialog: 'in a dialog',
  cutscene: 'during a scene',
}

export function ControlsSection() {
  const store = useKeymap()
  const [overrides, setOverrides] = usePersistentState(CONTROLS_KEYMAP)
  /** The row currently capturing, or null. */
  const [capturing, setCapturing] = useState<string | null>(null)
  /** What the last capture did or refused, and why, for `aria-live`. */
  const [said, setSaid] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const bindings = resolveBindings(overrides)
  const clashes = clashesIn(bindings)
  const keyOf = (action: ActionDefinition): string | null => {
    const bound = bindings.get(action.id) ?? null
    return bound === null ? null : chordLabel(bound, store.layout)
  }

  const needle = query.trim().toLowerCase()
  const matches = (action: ActionDefinition): boolean =>
    needle === '' ||
    [action.label, action.group, action.hint ?? '', keyOf(action) ?? '']
      .join(' ')
      .toLowerCase()
      .includes(needle)
  const shown = ACTIONS.filter(matches)

  const capture = (
    action: ActionDefinition,
    event: React.KeyboardEvent,
    released = false,
  ) => {
    const pressed = chordFromEvent(event.nativeEvent)
    /*
     * A modifier on its own is the first half of a chord, so keep listening.
     *
     * `Shift+H` arrives as two `keydown`s and the modifier's comes first. A
     * capture that took it would store `Shift+ShiftLeft` — a binding on the
     * bare modifier, which then fires on every Shift press — and the editor
     * could never express one of its own defaults.
     */
    if (pressed !== null && isModifierCode(pressed.code) && !released) {
      event.preventDefault()
      return
    }
    /*
     * Escape cancels the capture and goes no further.
     *
     * Armed, the row is the innermost thing on screen, so Escape means "not
     * that key" rather than "close the dialog" — and consuming it is what makes
     * a row escapable at all. A second Escape, with nothing armed, reaches
     * `overlay.close` and closes the dialog as it always does.
     */
    if (pressed !== null && pressed.code === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setCapturing(null)
      setSaid(null)
      return
    }
    if (pressed === null || !isBindable(pressed)) {
      /*
       * The browser's keys, refused by name — and deliberately *not*
       * prevented.
       *
       * `Tab` is how focus moves and a `preventDefault` at the window always
       * wins, so a mode that binds it owns focus navigation whether it means to
       * or not; swallowing it here would leave an armed row with no keyboard
       * way out of it. `Ctrl` and `Meta` are the platform's. Saying which
       * rather than doing nothing is the difference between a control that
       * refused and one that appears broken.
       */
      setCapturing(null)
      setSaid(
        `${REFUSED_CODES.join(', ')} and anything with Ctrl or Cmd belong to the browser`,
      )
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const chord = formatChord(pressed)
    /*
     * A press of the act's own default is a return to it, so the override goes
     * rather than a copy of the default being stored: a copy is a row marked
     * changed with nothing changed, and a binding frozen at today's default
     * when the default later moves.
     */
    const home = chord === defaultChord(action.id)
    const next = home
      ? withoutOverride(overrides, action.id)
      : { ...overrides, [action.id]: chord }
    setOverrides((held) =>
      home ? withoutOverride(held, action.id) : { ...held, [action.id]: chord },
    )
    setCapturing(null)
    const taken = clashesIn(resolveBindings(next)).get(action.id) ?? null
    setSaid(
      taken === null
        ? `${action.label} is now ${chordLabel(pressed, store.layout)}`
        : `${chordLabel(pressed, store.layout)} also means ${taken.label}`,
    )
  }

  const reset = (id: string): void => {
    setOverrides((held) => withoutOverride(held, id))
    setCapturing(null)
  }

  /** `null` is "deliberately nothing" — unless nothing is the default. */
  const unbind = (action: ActionDefinition): void => {
    setOverrides((held) =>
      defaultChord(action.id) === null
        ? withoutOverride(held, action.id)
        : { ...held, [action.id]: null },
    )
    setCapturing(null)
    setSaid(`${action.label} has no key`)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <SearchField
          value={query}
          onChange={setQuery}
          label="Find an act or a key"
          placeholder="Find an act or a key"
          className="flex-1 basis-56"
        />
        {/* The capture announces here rather than only changing a button's
            text: a control that reports its result in a label a screen reader
            has already read past is a control that reported nothing. */}
        <p
          aria-live="polite"
          className="type-ui min-h-4 basis-full text-sky-300/90"
        >
          {said}
        </p>
      </div>

      {shown.length === 0 && (
        <p className="type-ui py-6 text-center text-slate-400">
          No act is called that, and no key reads that way.
        </p>
      )}

      {groupsOf(shown).map((group) => {
        const rows = shown.filter((action) => action.group === group)
        const where = [...new Set(rows.map((action) => WHERE[action.context]))]
        return (
          <section key={group} aria-label={group}>
            {/* Sticky under the scroll, so a key three screens into Flight
                still says which group it belongs to. The ground is the
                dialog's own, opaque enough that rows sliding under the
                heading do not show through it. */}
            <h3 className="type-label sticky top-0 z-10 flex items-baseline justify-between gap-3 border-b border-slate-800 bg-slate-950/95 py-1.5 text-sky-400/80">
              {group}
              <span className="type-micro normal-case text-slate-400">
                {where.join(' · ')}
              </span>
            </h3>
            {rows.map((action) => {
              const bound = keyOf(action)
              const clash = clashes.get(action.id) ?? null
              const listening = capturing === action.id
              const changed = keyChanged(action.id, overrides[action.id])
              const key = `key-${action.id}`
              return (
                <SettingRow
                  key={action.id}
                  label={action.label}
                  changed={changed}
                  detail={
                    action.hint === undefined && clash === null ? undefined : (
                      <>
                        {/* The hints are written as the keys sheet reads
                            them, after a dash; standing alone they open a
                            sentence, and the case is the stylesheet's. */}
                        {action.hint !== undefined && (
                          <span className="block first-letter:uppercase">
                            {action.hint}
                          </span>
                        )}
                        {clash !== null && (
                          <span
                            id={`${key}-clash`}
                            className="block text-amber-300"
                          >
                            Shares its key with {clash.label}.
                          </span>
                        )}
                      </>
                    )
                  }
                >
                  <button
                    type="button"
                    id={key}
                    // The binding is in the name, because the name is all a
                    // screen reader tabbing down the column hears — "Rebind
                    // Pause" said what the button does and not what the key
                    // is. The clash, when there is one, describes it.
                    aria-label={
                      listening
                        ? `Press a key for ${action.label}`
                        : `${action.label}: ${bound ?? 'unbound'}. Press to rebind`
                    }
                    aria-describedby={
                      clash === null ? undefined : `${key}-clash`
                    }
                    onClick={() => {
                      setCapturing(action.id)
                      setSaid(
                        `Press a key for ${action.label}. Escape keeps ${bound ?? 'it unbound'}.`,
                      )
                    }}
                    onKeyDown={(event) =>
                      listening ? capture(action, event) : undefined
                    }
                    onKeyUp={(event) => {
                      if (
                        listening &&
                        (event.code === 'ShiftLeft' ||
                          event.code === 'ShiftRight')
                      )
                        capture(action, event, true)
                    }}
                    onBlur={() =>
                      setCapturing((current) =>
                        current === action.id ? null : current,
                      )
                    }
                    className={`type-readout h-7 min-w-28 rounded border px-2 tabular-nums transition-colors ${
                      listening
                        ? 'border-sky-400 bg-sky-500/15 text-sky-200'
                        : clash !== null
                          ? 'border-amber-400/60 text-amber-200 hover:border-amber-300'
                          : bound === null
                            ? 'border-slate-800 text-slate-400 hover:border-sky-500/60'
                            : 'border-slate-700 bg-slate-900/60 text-sky-200 hover:border-sky-500/60'
                    } ${FOCUS_RING}`}
                  >
                    {listening ? LISTENING : (bound ?? 'unbound')}
                  </button>
                  {/*
                   * Two verbs beside the key, in fixed slots so the key column
                   * never moves, and words, because every control in a body is
                   * a word here. Unbind writes the `null` a deliberate
                   * "nothing" needs; it shows under the pointer and the
                   * keyboard rather than on every row at rest, where a hundred
                   * of them down the edge read as a column of deletes — and
                   * always on a touch screen, which has no hover to ask with.
                   * Reset is there only when there is a default to go back to.
                   * Both hand a keyboard back to the key, since each takes
                   * itself away.
                   */}
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="flex w-14 justify-end">
                      <Action
                        label="Unbind"
                        name={`Unbind ${action.label}`}
                        title={`Take the key off ${action.label}`}
                        disabled={bound === null}
                        then={() => document.getElementById(key)}
                        onClick={() => unbind(action)}
                        className="opacity-0 transition-[color,border-color,background-color,opacity,scale] group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 disabled:invisible pointer-coarse:opacity-100"
                      />
                    </span>
                    <span className="flex w-12 justify-end">
                      <Action
                        label="Reset"
                        name={`Reset ${action.label}`}
                        title={`${action.label} back to its default`}
                        disabled={!changed}
                        then={() => document.getElementById(key)}
                        onClick={() => reset(action.id)}
                        className="disabled:invisible"
                      />
                    </span>
                  </span>
                </SettingRow>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

/**
 * Which row clashes with which, by id.
 *
 * `collisions` rather than a second detector, and *ambiguous* ones rather than
 * every winner: a shadow is an inner context deliberately taking a chord an
 * outer one also holds, which three of the shipped defaults do — `Space` is
 * pause and the cinema's transport, `/` is the catalog's search and the reading
 * room's. Reporting those paints the editor amber on a profile where nobody has
 * rebound anything, and a warning that is always on is a warning nobody reads.
 * An *ambiguity* is two actions of equal claim inside one live set, where
 * nothing decides and the dispatcher's answer is whichever the table lists
 * first — that is a defect, and it is the only thing a rebind can introduce
 * that the design does not already say is fine.
 *
 * Built once per binding table rather than per row: the per-row form was a
 * `LIVE_SETS × ACTIONS` scan inside a `.map` over every row, re-run on every
 * keystroke of a capture, on the same thread as the scene behind the dialog.
 */
function clashesIn(
  bindings: ReturnType<typeof resolveBindings>,
): ReadonlyMap<string, ActionDefinition> {
  const found = new Map<string, ActionDefinition>()
  for (const collision of collisions(bindings)) {
    if (collision.kind !== 'ambiguous') continue
    for (const id of collision.ids) {
      const other = collision.ids.find((one) => one !== id)
      const definition = other === undefined ? undefined : findAction(other)
      if (definition !== undefined && !found.has(id)) found.set(id, definition)
    }
  }
  return found
}

/** A binding table without one act's override, which is "the default". */
function withoutOverride(
  held: Readonly<Record<string, string | null>>,
  id: string,
): Readonly<Record<string, string | null>> {
  const { [id]: _dropped, ...rest } = held
  return rest
}
