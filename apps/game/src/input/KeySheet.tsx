import type { KeyContext } from './keymap.ts'
import { PadGlyph } from './PadGlyph.tsx'
import { useInputDevice, useKeyRows } from './useKeymap.ts'

/**
 * What the keys do, right now.
 *
 * One renderer for every place that answers the question — the `?` sheet, the
 * telemetry panel's own section, the reference on the settings page — because
 * they were three hand-maintained tables of prose with the key names written
 * out as string literals, and keeping three tables in step by hand is the
 * failure this whole phase is about. Every row here is derived from `ACTIONS`
 * and every chord is the live one, so a rebind changes the sheet in the same
 * commit that changes the binding.
 *
 * An unbound action still gets a row, with an em dash where the key would be. A
 * sheet that silently omitted it would make "this act has no key" and "this act
 * does not exist" the same thing on screen, and only one of them is true.
 */
export function KeySheet({
  contexts,
  columns = 1,
}: {
  readonly contexts: readonly KeyContext[]
  /** Two on a wide dialog, one in a dock panel. */
  readonly columns?: 1 | 2
}) {
  const groups = useKeyRows(contexts)
  /*
   * The pad's column, when there is a pad: attached, or used this session.
   * A keyboard-only profile reads the sheet it always did, and a second
   * column of glyphs for hardware nobody has would only make it longer.
   */
  const { device, family, pads } = useInputDevice()
  const padded = pads > 0 || device === 'pad'
  return (
    <div
      className={
        columns === 2
          ? 'grid gap-x-6 gap-y-3 sm:grid-cols-2'
          : 'flex flex-col gap-3'
      }
    >
      {groups.map(({ group, rows }) => (
        <section key={group} className="break-inside-avoid">
          <h3 className="type-label mb-1 text-sky-400/80">{group}</h3>
          <dl
            className={`grid gap-x-3 gap-y-0.5 ${
              padded ? 'grid-cols-[auto_auto_1fr]' : 'grid-cols-[auto_1fr]'
            }`}
          >
            {rows.map(({ action, label, pad }) => (
              <div
                key={action.id}
                className={`grid grid-cols-subgrid ${padded ? 'col-span-3' : 'col-span-2'}`}
              >
                <dt className="type-readout text-sky-300/80 tabular-nums">
                  {label ?? '—'}
                </dt>
                {padded && (
                  <dt className="type-readout text-sky-300/80">
                    {pad === null ? (
                      '—'
                    ) : (
                      <PadGlyph control={pad} family={family} />
                    )}
                  </dt>
                )}
                <dd className="text-pretty text-slate-400">
                  {action.label}
                  {action.hint !== undefined && (
                    <span className="text-slate-400"> — {action.hint}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}
