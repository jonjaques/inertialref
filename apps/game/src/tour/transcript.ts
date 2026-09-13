import type { TourTranscript } from '@inertialref/protocol'

/** Group adjacent deltas without reordering overlapping speakers or rewriting evidence. */
export function transcriptRows(
  events: readonly TourTranscript[],
): readonly TourTranscript[] {
  const rows: TourTranscript[] = []
  for (const event of events) {
    const last = rows.at(-1)
    if (
      last &&
      last.speaker === event.speaker &&
      event.startMs <= last.endMs + 1500
    ) {
      rows[rows.length - 1] = {
        ...last,
        text: last.text + event.text,
        endMs: Math.max(last.endMs, event.endMs),
      }
    } else rows.push(event)
  }
  return rows
}
