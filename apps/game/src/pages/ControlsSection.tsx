import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Action } from '../hud/Action.tsx'
import { FOCUS_RING } from '../hud/focus.ts'
import {
  chordFromEvent,
  chordLabel,
  formatChord,
  isBindable,
  REFUSED_CODES,
} from '../input/chord.ts'
import {
  ACTIONS,
  actionFor,
  type ActionDefinition,
  LIVE_SETS,
  resolveBindings,
} from '../input/keymap.ts'
import { useKeymap } from '../input/useKeymap.ts'
import { CONTROLS_KEYMAP, usePersistentState } from '../state/preferences.ts'

/*
 * Rebinding, which `docs/design/ux.md` has promised since before there was a
 * keymap to bind.
 *
 * This page printed a table of prose and said rebinding was not built, which
 * was honest and is no longer true: every act is a row, pressing the row's
 * button captures the next chord, and a conflict is named where it happens
 * rather than discovered later in a mode where a key stopped working.
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

  const bindings = resolveBindings(overrides)

  const capture = (action: ActionDefinition, event: React.KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const pressed = chordFromEvent(event.nativeEvent)
    if (pressed === null || !isBindable(pressed)) {
      /*
       * The browser's keys, refused by name.
       *
       * `Tab` is how focus moves and a `preventDefault` at the window always
       * wins, so a mode that binds it owns focus navigation whether it means to
       * or not. `Escape` is how a dialog closes. `Ctrl` and `Meta` are the
       * platform's. Saying which rather than doing nothing is the difference
       * between a control that refused and one that appears broken.
       */
      setRefusal(
        `${REFUSED_CODES.join(', ')} and anything with Ctrl or Cmd belong to the browser`,
      )
      return
    }
    const next = { ...overrides, [action.id]: formatChord(pressed) }
    setOverrides(next)
    setCapturing(null)
    const taken = conflictFor(action, resolveBindings(next))
    setRefusal(
      taken === null
        ? `${action.label} is now ${chordLabel(pressed, store.layout)}`
        : `${chordLabel(pressed, store.layout)} also means ${taken.label}`,
    )
  }

  const reset = (id: string): void => {
    const { [id]: _dropped, ...rest } = overrides
    setOverrides(rest)
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
          const clash = conflictFor(action, bindings)
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
 * The action this one would collide with, if any.
 *
 * Asked per row so the answer sits beside the binding that caused it. A more
 * specific context taking the chord is not reported — that is the design, and
 * `Space` meaning the transport in the cinema is the shipped example — but an
 * action being *shadowed* is, because losing the pause key in one mode is
 * exactly the kind of thing a rebind does quietly.
 */
function conflictFor(
  action: ActionDefinition,
  bindings: ReturnType<typeof resolveBindings>,
): ActionDefinition | null {
  const bound = bindings.get(action.id) ?? null
  if (bound === null) return null
  for (const live of LIVE_SETS) {
    if (!live.includes(action.context)) continue
    const winner = actionFor(bindings, live, bound)
    if (winner !== null && winner.id !== action.id) return winner
  }
  return null
}
