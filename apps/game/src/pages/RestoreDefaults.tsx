import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Action } from '../hud/Action.tsx'

/**
 * A settings page's "restore defaults", asked twice.
 *
 * Confirmed in place, as the data page's reset is, and for its reason: this
 * is already a dialog, and a dialog over a dialog is a scrim over a scrim. The
 * question names the count, so what is about to change is a number the reader
 * can check against the marks in the gutter rather than a page they have to
 * remember. Disabled rather than hidden at zero — a page with nothing to
 * restore says so, and the button does not appear and vanish as rows change.
 *
 * The parent keys this by page, so a question half-asked on one page is not
 * still standing when the next one opens.
 */
export function RestoreDefaults({
  changed,
  onRestore,
}: {
  changed: number
  onRestore: () => void
}) {
  const [asking, setAsking] = useState(false)
  const settings = `${changed} ${changed === 1 ? 'setting' : 'settings'}`
  if (asking && changed > 0)
    return (
      <span className="flex items-center gap-1.5" role="group">
        <span className="type-ui text-slate-300" aria-live="polite">
          Restore {settings}?
        </span>
        <Action
          label="Restore"
          tone="primary"
          title={`Put ${settings} back to their defaults`}
          onClick={() => {
            onRestore()
            setAsking(false)
          }}
        />
        <Action
          label="Keep"
          title="Leave everything as it is"
          onClick={() => setAsking(false)}
        />
      </span>
    )
  return (
    <Action
      label="Restore defaults"
      icon={RotateCcw}
      disabled={changed === 0}
      title={
        changed === 0
          ? 'Everything on this page is at its default'
          : `Put ${settings} back to their defaults`
      }
      onClick={() => setAsking(true)}
    />
  )
}
