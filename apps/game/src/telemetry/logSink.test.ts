import type { LogLevel, LogRecord } from '@inertialref/shared'
import { describe, expect, it } from 'vitest'
import { CONTEXT_RECORDS, createTelemetrySink } from './logSink.ts'

const record = (
  seq: number,
  level: LogLevel,
  fields: Record<string, unknown> = {},
): LogRecord => ({ seq, level, scope: 'game.test', message: `m${seq}`, fields })

function rig() {
  const sent: { level: string; body: string; attributes: object }[] = []
  const sink = createTelemetrySink((level, body, attributes) =>
    sent.push({ level, body, attributes }),
  )
  return { sink, sent }
}

describe('the log hub as PostHog Logs', () => {
  it('sends warnings and errors as they are written, with scalar fields only', () => {
    const { sink, sent } = rig()
    sink.write(record(1, 'warn', { tiles: 4, slow: true, scene: { a: 1 } }))
    expect(sent).toEqual([
      {
        level: 'warn',
        body: 'm1',
        attributes: {
          'log.scope': 'game.test',
          'log.seq': 1,
          tiles: 4,
          slow: true,
        },
      },
    ])
  })

  it('holds the quiet records until a failure, and sends the last ones once', () => {
    const { sink, sent } = rig()
    for (let seq = 1; seq <= CONTEXT_RECORDS + 5; seq += 1)
      sink.write(record(seq, 'info'))
    sink.write(record(99, 'trace'))
    expect(sent).toHaveLength(0)
    sink.flushContext()
    sink.flushContext()
    expect(sent.map((one) => one.body)).toEqual(
      Array.from({ length: CONTEXT_RECORDS }, (_, i) => `m${i + 6}`),
    )
    expect(sent[0]!.attributes).toMatchObject({
      'log.context': 'before failure',
    })
  })
})
