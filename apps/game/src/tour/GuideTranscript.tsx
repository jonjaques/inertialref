import type { TourTranscript } from '@inertialref/protocol'
import { transcriptRows } from './transcript.ts'

export function GuideTranscript({
  transcripts,
}: {
  transcripts: readonly TourTranscript[]
}) {
  if (transcripts.length === 0) return null
  return (
    <div
      className="flex max-h-64 flex-col gap-2 overflow-y-auto"
      role="log"
      aria-label="Guide captions"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {transcriptRows(transcripts).map((item) => (
        <p key={item.eventId} className="type-ui text-pretty text-slate-300">
          <span className="text-slate-400">
            {item.speaker === 'guide' ? 'Guide' : 'You'}:{' '}
          </span>
          {item.text}
        </p>
      ))}
    </div>
  )
}
