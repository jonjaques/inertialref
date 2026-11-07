import { RotateCcw } from 'lucide-react'
import { ConfirmAction } from './ConfirmAction.tsx'

/**
 * A settings page's "restore defaults": `ConfirmAction`, with the count in the
 * question, so what is about to change is a number the reader can check
 * against the marks in the gutter rather than a page they have to remember.
 * Disabled rather than hidden at zero — a page with nothing to restore says
 * so, and the button does not appear and vanish as rows change.
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
  const settings = `${changed} ${changed === 1 ? 'setting' : 'settings'}`
  return (
    <ConfirmAction
      label="Restore defaults"
      icon={RotateCcw}
      title={
        changed === 0
          ? 'Everything on this page is at its default'
          : `Put ${settings} back to their defaults`
      }
      disabled={changed === 0}
      question={`Restore ${settings}?`}
      act="Restore"
      actTitle={`Put ${settings} back to their defaults`}
      onAct={onRestore}
    />
  )
}
