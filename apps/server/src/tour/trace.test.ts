import { describe, expect, it } from 'vitest'
import { createTourTrace } from './trace.ts'

describe('explicit guide tracing', () => {
  it('is silent by default', () => {
    const lines: string[] = []
    createTourTrace({}, undefined, (line) => lines.push(line))({
      event: 'provider.request',
      model: 'gpt-6-astra',
      data: { input: 'Saturn' },
    })
    expect(lines).toEqual([])
  })

  it('preserves model messages while removing secrets, SDP, and audio', () => {
    const lines: string[] = []
    const trace = createTourTrace(
      {
        TOUR_GUIDE_TRACE: 'true',
        OPENAI_API_KEY: 'test-secret-key',
        TOUR_GUIDE_PASSWORD: 'test-secret-password',
      },
      () => ({ sessionId: 's1' }),
      (line) => lines.push(line),
    )
    trace({
      event: 'provider.request',
      model: 'gpt-6-astra',
      data: {
        input: 'Show Saturn',
        nested: {
          authorization: 'Bearer test-secret-key',
          password: 'test-secret-password',
          sdp: 'private',
        },
        text: 'accidental test-secret-key test-secret-password',
      },
    })
    trace({
      event: 'live.receive',
      model: 'gpt-live-1',
      data: { type: 'session.output_audio.delta', audio: 'private-audio' },
    })
    const joined = lines.join('\n')
    expect(joined).toContain('Show Saturn')
    expect(joined).toContain('gpt-6-astra')
    expect(joined).toContain('s1')
    expect(joined).not.toContain('test-secret')
    expect(joined).not.toContain('private')
    expect(JSON.parse(lines[1]!).sequence).toBe(2)
  })

  it('bounds pathological payloads and cannot fail the operation', () => {
    const lines: string[] = []
    const trace = createTourTrace(
      { TOUR_GUIDE_TRACE: 'true' },
      undefined,
      (line) => lines.push(line),
    )
    trace({
      event: 'application.receive',
      model: 'application',
      data: Array.from({ length: 100 }, () => 'λ'.repeat(10000)),
    })
    expect(new TextEncoder().encode(lines[0]).byteLength).toBeLessThanOrEqual(
      65536,
    )
    expect(JSON.parse(lines[0]!).data.truncated).toBe(true)
    expect(() =>
      createTourTrace({ TOUR_GUIDE_TRACE: 'true' }, undefined, () => {
        throw new Error('sink failed')
      })({ event: 'test', model: 'application', data: null }),
    ).not.toThrow()
  })
})
