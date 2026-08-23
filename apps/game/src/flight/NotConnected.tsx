import { CloudOff } from 'lucide-react'

/**
 * Solo online, honestly.
 *
 * The mode runs — it is the same complete game — and what is missing is the
 * half that needs a server: shared discovery credit, sync and commissions. It
 * says so once, at the top, rather than pretending or refusing to load.
 */
export function NotConnected() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
      {/* A floating surface takes the floating radius; the system has no pill. */}
      <p className="pointer-events-auto flex items-center gap-2 rounded-lg border border-amber-500/30 bg-slate-950/85 px-3 py-1 type-micro text-amber-200/90 backdrop-blur">
        <CloudOff aria-hidden className="size-3.5" />
        playing offline — discovery credit and sync are designed, not built
      </p>
    </div>
  )
}
