import { useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
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
    const next = { ...overrides, [action.id]: chord }
    setOverrides((held) => ({ ...held, [action.id]: chord }))
    setCapturing(null)
    const taken = clashesIn(resolveBindings(next)).get(action.id) ?? null
    setSaid(
      taken === null
        ? `${action.label} is now ${chordLabel(pressed, store.layout)}`
        : `${chordLabel(pressed, store.layout)} also means ${taken.label}`,
    )
  }

  const reset = (id: string): void => {
    setOverrides(({ [id]: _dropped, ...rest }) => rest)
    setCapturing(null)
  }

  const unbind = (action: ActionDefinition): void => {
    setOverrides((held) => ({ ...held, [action.id]: null }))
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
              const changed = overrides[action.id] !== undefined
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
                          <span className="block text-amber-300">
                            Shares its key with {clash.label}.
                          </span>
                        )}
                      </>
                    )
                  }
                >
                  <button
                    type="button"
                    aria-label={`Rebind ${action.label}`}
                    onClick={() => {
                      setCapturing(action.id)
                      setSaid(null)
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
                   * Two quiet verbs beside the key, in fixed slots so the key
                   * column never moves: unbind, which writes the `null` a
                   * deliberate "nothing" needs, and back to the default,
                   * present only when there is a default to go back to.
                   * Unbind shows under the pointer or the keyboard, not on
                   * every row at rest — a hundred ×s down the edge of the
                   * page read as a column of deletes.
                   */}
                  <span className="flex shrink-0 items-center">
                    <button
                      type="button"
                      aria-label={`Unbind ${action.label}`}
                      title="Take the key off this act"
                      disabled={bound === null}
                      onClick={(event) => {
                        releaseFocus(event)
                        unbind(action)
                      }}
                      className={`flex size-7 items-center justify-center rounded text-slate-400 opacity-0 transition-[color,opacity] group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:text-sky-200 focus-visible:opacity-100 disabled:invisible ${FOCUS_RING}`}
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Reset ${action.label} to its default`}
                      title="Back to the default"
                      disabled={!changed}
                      onClick={(event) => {
                        releaseFocus(event)
                        reset(action.id)
                      }}
                      className={`flex size-7 items-center justify-center rounded text-slate-400 transition-colors hover:text-sky-200 disabled:invisible ${FOCUS_RING}`}
                    >
                      <RotateCcw aria-hidden className="size-3.5" />
                    </button>
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
