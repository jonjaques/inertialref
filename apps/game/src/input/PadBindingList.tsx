import { RotateCcw } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import {
  ACTIONS,
  groupsOf,
  type KeyContext,
  type PadBindings,
} from './keymap.ts'
import type { Callout } from './controllerLayout.ts'
import { calloutOf } from './controllerLabels.ts'
import type { PadFamily } from './padFamily.ts'
import { PadGlyph } from './PadGlyph.tsx'

/**
 * Every act of one mode, with what the pad has for it.
 *
 * The keyboard editor's shape, on purpose — a row per act, its control, a
 * reset — so somebody who has rebound a key already knows how to rebind a
 * button. Pressing a row's control listens for the next one pressed on the
 * pad or clicked on the picture above; hovering a row outlines its control
 * there, which is the picture answering "where is that".
 */
export function PadBindingList({
  contexts,
  bindings,
  overrides,
  family,
  clashes,
  capturing,
  onCapture,
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
  readonly onReset: (id: string) => void
  readonly onHover: (callout: Callout | null) => void
}) {
  const actions = ACTIONS.filter((action) => contexts.includes(action.context))
  return (
    <div className="flex flex-col gap-3">
      {groupsOf(actions).map((group) => (
        <section key={group}>
          <h3 className="type-label mb-1 text-sky-400/80">{group}</h3>
          <dl className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-1">
            {actions
              .filter((action) => action.group === group)
              .map((action) => {
                const bound = bindings.get(action.id) ?? null
                const listening = capturing === action.id
                const clash = clashes.get(action.id)
                return (
                  <div
                    key={action.id}
                    className="col-span-3 grid grid-cols-subgrid items-center"
                    onPointerEnter={() =>
                      onHover(bound === null ? null : calloutOf(bound))
                    }
                    onPointerLeave={() => onHover(null)}
                  >
                    <dt className="text-pretty text-slate-400">
                      {action.label}
                      {clash !== undefined && (
                        <span className="text-amber-400/90">
                          {' '}
                          — also {clash}
                        </span>
                      )}
                    </dt>
                    <dd>
                      <button
                        type="button"
                        aria-label={`Rebind ${action.label} on the controller`}
                        aria-pressed={listening}
                        onClick={() => onCapture(listening ? null : action.id)}
                        onFocus={() =>
                          onHover(bound === null ? null : calloutOf(bound))
                        }
                        onKeyDown={(event) => {
                          // Escape cancels a listening row and goes no
                          // further, as it does in the keyboard editor; a
                          // second one closes the dialog.
                          if (!listening || event.key !== 'Escape') return
                          event.preventDefault()
                          event.stopPropagation()
                          onCapture(null)
                        }}
                        className={`type-readout flex min-h-6 min-w-24 items-center justify-center rounded border px-2 py-0.5 ${
                          listening
                            ? 'border-sky-400 text-sky-300'
                            : 'border-slate-800 text-sky-300/80'
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
                    </dd>
                    <dd>
                      <button
                        type="button"
                        aria-label={`Reset ${action.label} on the controller to its default`}
                        title="Back to the default"
                        disabled={overrides[action.id] === undefined}
                        onClick={() => onReset(action.id)}
                        className={`rounded p-1 text-slate-400 hover:text-sky-300 disabled:opacity-30 ${FOCUS_RING}`}
                      >
                        <RotateCcw aria-hidden className="size-3" />
                      </button>
                    </dd>
                  </div>
                )
              })}
          </dl>
        </section>
      ))}
    </div>
  )
}
