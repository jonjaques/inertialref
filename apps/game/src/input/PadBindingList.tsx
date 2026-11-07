import { Action } from '../hud/Action.tsx'
import { FOCUS_RING } from '../hud/focus.ts'
import { SettingRow } from '../hud/SettingRow.tsx'
import { padChanged } from '../pages/settingsDefaults.ts'
import {
  ACTIONS,
  groupsOf,
  type KeyContext,
  type PadBindings,
} from './keymap.ts'
import type { Callout } from './controllerLayout.ts'
import { calloutOf } from './controllerLabels.ts'
import { type PadFamily, padLabel } from './padFamily.ts'
import { PadGlyph } from './PadGlyph.tsx'

/**
 * Every act of one mode, with what the pad has for it.
 *
 * The keyboard editor's shape, on purpose — a row per act, its control, an
 * unbind and a reset in the same two slots — so somebody who has rebound a
 * key already knows how to rebind a button. Pressing a row's control listens
 * for the next one pressed on the pad or clicked on the picture above;
 * hovering a row outlines its control there, which is the picture answering
 * "where is that".
 */
export function PadBindingList({
  contexts,
  bindings,
  overrides,
  family,
  clashes,
  capturing,
  onCapture,
  onUnbind,
  onReset,
  onHover,
}: {
  readonly contexts: readonly KeyContext[]
  readonly bindings: PadBindings
  readonly overrides: Readonly<Record<string, string | null>>
  readonly family: PadFamily
  /** Which rows share a control with an act of equal claim, by id. */
  readonly clashes: ReadonlyMap<string, string>
  readonly capturing: string | null
  readonly onCapture: (id: string | null) => void
  /** Take the control off this act: the deliberate `null` an override holds. */
  readonly onUnbind: (id: string) => void
  readonly onReset: (id: string) => void
  readonly onHover: (callout: Callout | null) => void
}) {
  const actions = ACTIONS.filter((action) => contexts.includes(action.context))
  return (
    <div className="flex flex-col gap-2">
      {groupsOf(actions).map((group) => (
        <section key={group} aria-label={group}>
          <h3 className="type-label border-b border-slate-800 py-1.5 text-sky-400/80">
            {group}
          </h3>
          {actions
            .filter((action) => action.group === group)
            .map((action) => {
              const bound = bindings.get(action.id) ?? null
              const listening = capturing === action.id
              const clash = clashes.get(action.id)
              const changed = padChanged(action.id, overrides[action.id])
              const key = `pad-${action.id}`
              return (
                <SettingRow
                  key={action.id}
                  label={action.label}
                  changed={changed}
                  onHover={(over) =>
                    onHover(over && bound !== null ? calloutOf(bound) : null)
                  }
                  detail={
                    clash === undefined ? undefined : (
                      <span id={`${key}-clash`} className="text-amber-300">
                        Shares its control with {clash}.
                      </span>
                    )
                  }
                >
                  <button
                    type="button"
                    id={key}
                    // The control is in the name — the name is what a screen
                    // reader tabbing down the column hears — and the clash,
                    // when there is one, describes it.
                    aria-label={
                      listening
                        ? `Press a control for ${action.label}`
                        : `${action.label}: ${bound === null ? 'unbound' : padLabel(bound, family)}. Press to rebind`
                    }
                    aria-describedby={
                      clash === undefined ? undefined : `${key}-clash`
                    }
                    aria-pressed={listening}
                    onClick={() => onCapture(listening ? null : action.id)}
                    onFocus={() =>
                      onHover(bound === null ? null : calloutOf(bound))
                    }
                    onKeyDown={(event) => {
                      // Escape cancels a listening row and goes no further, as
                      // it does in the keyboard editor; a second one closes
                      // the dialog.
                      if (!listening || event.key !== 'Escape') return
                      event.preventDefault()
                      event.stopPropagation()
                      onCapture(null)
                    }}
                    className={`type-readout flex h-7 min-w-28 items-center justify-center rounded border px-2 transition-colors ${
                      listening
                        ? 'border-sky-400 bg-sky-500/15 text-sky-200'
                        : clash !== undefined
                          ? 'border-amber-400/60 text-amber-200 hover:border-amber-300'
                          : bound === null
                            ? 'border-slate-800 text-slate-400 hover:border-sky-500/60'
                            : 'border-slate-700 bg-slate-900/60 text-sky-200 hover:border-sky-500/60'
                    } ${FOCUS_RING}`}
                  >
                    {listening ? (
                      'press a control…'
                    ) : bound === null ? (
                      'unbound'
                    ) : (
                      <PadGlyph control={bound} family={family} />
                    )}
                  </button>
                  {/* The keyboard editor's two verbs, in the same slots and
                      on the same rules — see `ControlsSection`. */}
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="flex w-14 justify-end">
                      <Action
                        label="Unbind"
                        name={`Unbind ${action.label}`}
                        title={`Take the control off ${action.label}`}
                        disabled={bound === null}
                        then={() => document.getElementById(key)}
                        onClick={() => onUnbind(action.id)}
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
                        onClick={() => onReset(action.id)}
                        className="disabled:invisible"
                      />
                    </span>
                  </span>
                </SettingRow>
              )
            })}
        </section>
      ))}
    </div>
  )
}
