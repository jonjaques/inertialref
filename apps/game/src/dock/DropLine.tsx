import { isColumn, type DockZone } from './layout.ts'

/** The insertion marker. A line, in the accent, on the stack's own axis. */
export function DropLine({ zone }: { zone: DockZone }) {
  return (
    <div
      aria-hidden
      className={
        isColumn(zone)
          ? 'h-0.5 w-full shrink-0 rounded-full bg-sky-400'
          : 'h-full w-0.5 shrink-0 rounded-full bg-sky-400'
      }
    />
  )
}
