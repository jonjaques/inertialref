/** The insertion marker: a line, in the accent, across the pane's own axis. */
export function DropLine() {
  return (
    <div
      aria-hidden
      className="h-0.5 w-full shrink-0 rounded-full bg-sky-400 shadow-[0_0_8px] shadow-sky-400/60"
    />
  )
}
