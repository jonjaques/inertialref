import type {
  LogFields,
  LogLevel,
  LogRecord,
  LogSink,
} from '@inertialref/shared'

/*
 * The browser's `logHub` as PostHog Logs.
 *
 * Warnings and errors are sent as they are written. Everything quieter is
 * kept in a short ring and sent only when a failure is reported, because the
 * twenty records before a crash are the ones that explain it and the other
 * ten thousand a session writes explain nothing. Sending every info record
 * would cost more than the rest of the product's telemetry together.
 *
 * A record's fields are flattened to scalars. `LogRecord` already carries
 * no wall time, no credentials and no visitor text by the logger's own
 * contract (`packages/shared/src/log.ts`); the attribute filter is what keeps
 * an object somebody passed as a field from arriving as `[object Object]`.
 */

type Send = (
  level: LogLevel,
  body: string,
  attributes: Record<string, string | number | boolean>,
) => void

/** Records kept for the moment something fails. */
export const CONTEXT_RECORDS = 20

const MAX_ATTRIBUTE_LENGTH = 200

export function logAttributes(
  record: LogRecord,
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    'log.scope': record.scope,
    'log.seq': record.seq,
  }
  const fields: LogFields = record.fields
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'number' || typeof value === 'boolean')
      attributes[key] = value
    else if (typeof value === 'string')
      attributes[key] = value.slice(0, MAX_ATTRIBUTE_LENGTH)
  }
  return attributes
}

export interface TelemetrySink extends LogSink {
  /** Send the quiet records that came before a failure, once each. */
  flushContext(): void
}

export function createTelemetrySink(send: Send): TelemetrySink {
  const ring: LogRecord[] = []
  return {
    write(record) {
      if (record.level === 'warn' || record.level === 'error') {
        send(record.level, record.message, logAttributes(record))
        return
      }
      if (record.level === 'trace') return
      ring.push(record)
      if (ring.length > CONTEXT_RECORDS) ring.shift()
    },
    flushContext() {
      for (const record of ring.splice(0))
        send(record.level, record.message, {
          ...logAttributes(record),
          'log.context': 'before failure',
        })
    },
  }
}
