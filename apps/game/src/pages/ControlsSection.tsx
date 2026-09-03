import { useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Action } from '../hud/Action.tsx'
import { FOCUS_RING } from '../hud/focus.ts'
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
  resolveBindings,
} from '../input/keymap.ts'
import { useKeymap } from '../input/useKeymap.ts'
import { CONTROLS_KEYMAP, usePersistentState } from '../state/preferences.ts'

/*
 * Rebinding, which `docs/design/ux.md` promises.
 *
 * Every act is a row, pressing the row's button captures the next chord, and a
 * conflict is named where it happens rather than discovered later in a mode
 * where a key stopped working. A page that printed the bindings as prose could
 * not do the last part at all: prose cannot know what the keys are now.
 *
 * The stored value is overrides only, so an action whose default moves keeps
 * tracking it for everybody who has not deliberately rebound it.
 */

/** How the capture reads while it is armed. */
const LISTENING = 'press a key…'

export function ControlsSection() {
  const store = useKeymap()
  const [overrides, setOverrides] = usePersistentState(CONTROLS_KEYMAP)
  /** The row currently capturing, or null. */
  const [capturing, setCapturing] = useState<string | null>(null)
  /** What the last capture refused, and why, for `aria-live`. */
  const [refusal, setRefusal] = useState<string | null>(null)

  const bindings = useMemo(() => resolveBindings(overrides), [overrides])
  const clashes = useMemo(() => clashesIn(bindings), [bindings])

  const capture = (action: ActionDefinition, event: React.KeyboardEvent) => {
    const pressed = chordFromEvent(event.nativeEvent)
    /*
     * A modifier on its own is the first half of a chord, so keep listening.
     *
     * `Shift+H` arrives as two `keydown`s and the modifier's comes first. A
     * capture that took it would store `Shift+ShiftLeft` — a binding on the
     * bare modifier, which then fires on every Shift press — and the editor
     * could never express one of its own defaults.
     */
    if (pressed !== null && isModifierCode(pressed.code)) {
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
      setRefusal(null)
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
      setRefusal(
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
    setRefusal(
      taken === null
        ? `${action.label} is now ${chordLabel(pressed, store.layout)}`
        : `${chordLabel(pressed, store.layout)} also means ${taken.label}`,
    )
  }

  const reset = (id: string): void => {
    setOverrides(({ [id]: _dropped, ...rest }) => rest)
    setCapturing(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-pretty text-slate-400">
          Press a row’s key to capture the next one. A chord is the physical
          key, so a binding survives a change of keyboard layout.
        </p>
        <Action
          label="Reset All"
          title="Every binding back to its default"
          disabled={Object.keys(overrides).length === 0}
          onClick={() => setOverrides({})}
        />
      </div>

      {/* The capture announces here rather than only changing a button's text:
          a control that reports its result in a label a screen reader has
          already read past is a control that reported nothing. */}
      <p aria-live="polite" className="min-h-4 text-sky-300/80">
        {refusal}
      </p>

      <dl className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-1">
        {ACTIONS.map((action) => {
          const bound = bindings.get(action.id) ?? null
          const clash = clashes.get(action.id) ?? null
          return (
            <div
              key={action.id}
              className="col-span-3 grid grid-cols-subgrid items-center"
            >
              <dt className="text-pretty text-slate-400">
                {action.label}
                <span className="text-slate-400"> · {action.context}</span>
                {clash !== null && (
                  <span className="text-amber-400/90">
                    {' '}
                    — also {clash.label}
                  </span>
                )}
              </dt>
              <dd>
                <button
                  type="button"
                  aria-label={`Rebind ${action.label}`}
                  onClick={() => {
                    setCapturing(action.id)
                    setRefusal(null)
                  }}
                  onKeyDown={(event) =>
                    capturing === action.id ? capture(action, event) : undefined
                  }
                  onBlur={() =>
                    setCapturing((current) =>
                      current === action.id ? null : current,
                    )
                  }
                  className={`type-readout min-w-24 rounded border px-2 py-0.5 tabular-nums ${
                    capturing === action.id
                      ? 'border-sky-400 text-sky-300'
                      : 'border-slate-800 text-sky-300/80'
                  } ${FOCUS_RING}`}
                >
                  {capturing === action.id
                    ? LISTENING
                    : bound === null
                      ? 'unbound'
                      : chordLabel(bound, store.layout)}
                </button>
              </dd>
              <dd>
                <button
                  type="button"
                  aria-label={`Reset ${action.label} to its default`}
                  title="Back to the default"
                  disabled={overrides[action.id] === undefined}
                  onClick={() => reset(action.id)}
                  className={`rounded p-1 text-slate-400 hover:text-sky-300 disabled:opacity-30 ${FOCUS_RING}`}
                >
                  <RotateCcw aria-hidden className="size-3" />
                </button>
              </dd>
            </div>
          )
        })}
      </dl>
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
 * `LIVE_SETS × ACTIONS` scan inside a `.map` over all 53 rows, re-run on every
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
