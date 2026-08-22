import type { LucideIcon } from 'lucide-react'

/**
 * Where to read more — a record, and shaped like one.
 *
 * It used to be a bordered chip carrying `FOCUS_RING`, which was wrong twice: a
 * `<span>` has no tab stop, so the focus style could never draw, and the chip
 * was the most clickable-looking thing on a page where none of these three is
 * reachable by clicking. Two are repository paths and one is a console verb.
 * So the costume comes off and they read as what they are — the same label and
 * value pairing the facts above them use.
 */
export function Reference({
  icon: Icon,
  label,
  detail,
}: {
  icon: LucideIcon
  label: string
  detail: string
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon aria-hidden className="size-3.5 text-sky-400/70" />
      <span className="text-slate-300">{label}</span>
      <span className="text-slate-400">{detail}</span>
    </span>
  )
}
