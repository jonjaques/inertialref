import type { Connection } from '../net/health.ts'
import { CONNECTION_LABEL, connectionTone } from './connection.ts'

/**
 * The dot in the dock's header — the entire network readout when the dock is
 * collapsed, which is why it carries its explanation in a title rather than a
 * label.
 */
export function ConnectionPip({ connection }: { connection: Connection }) {
  const { state, detail } = connection
  return (
    <span
      role="img"
      // The glyph carries the whole readout when the dock is collapsed, and a
      // screen reader announcing "black circle" carries none of it.
      aria-label={`server ${CONNECTION_LABEL[state]}`}
      className={`shrink-0 ${connectionTone(state)}`}
      title={`${CONNECTION_LABEL[state]}${detail === null ? '' : ` — ${detail}`}`}
    >
      ●
    </span>
  )
}
