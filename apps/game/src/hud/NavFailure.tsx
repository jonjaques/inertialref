import { Action } from './Action.tsx'

/** What went wrong, and which verb it went wrong for. */
export interface Failure {
  readonly action: string
  readonly message: string
}

/**
 * Where every verb in the navigation panel reports a refusal.
 *
 * Above the sections rather than inside one. It used to live inside `nav.go`,
 * whose open state is remembered — so a collapsed section swallowed the only
 * report a failed `land`, `burn` or scenario ever made, and the button read as
 * having done nothing.
 */
export function NavFailure({
  failure,
  onDismiss,
}: {
  failure: Failure
  onDismiss: () => void
}) {
  return (
    <div
      /* A failed `land` or `goTo` is the one thing in the dock nobody should
         have to go looking for. `assertive`, unlike the transient notice: this
         one means the thing you asked for did not happen. */
      role="alert"
      className="mb-2 rounded border border-rose-400/40 bg-slate-950/60 px-2 py-1"
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-rose-300">
          {failure.action} failed
        </span>
        <Action
          label="dismiss"
          title="Clear this. The next action that succeeds clears it too."
          onClick={onDismiss}
        />
      </div>
      <div className="mt-0.5 max-h-24 overflow-auto break-words text-slate-400">
        {failure.message}
      </div>
    </div>
  )
}
