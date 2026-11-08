import { describe, expect, it } from 'vitest'
import {
  describeFailure,
  FailureReporter,
  GRAPHICS_HOLD_MS,
  normalizeMessage,
  PAGE_CAP,
  type FailureReport,
  TourError,
} from './failures.ts'

const named = (name: string, message: string, extra = {}): Error =>
  Object.assign(new Error(message), { name }, extra)

/** A reporter whose clock is a list of pending callbacks run by hand. */
function rig() {
  const sent: FailureReport[] = []
  const timers: { run: () => void; ms: number }[] = []
  const reporter = new FailureReporter(
    (report) => sent.push(report),
    (run, ms) => timers.push({ run, ms }),
  )
  const elapse = (): void => {
    for (const timer of timers.splice(0)) timer.run()
  }
  return { reporter, sent, timers, elapse }
}

describe('how a failure groups', () => {
  it('fingerprints a shader defect by its message, not by three.js’s frames', () => {
    const a = describeFailure(
      'graphics',
      named(
        'GPUValidationError',
        '[RenderPipeline "atmosphere 3"] is invalid at 0x1f',
      ),
    )
    const b = describeFailure(
      'graphics',
      named(
        'GPUValidationError',
        '[RenderPipeline "atmosphere 7"] is invalid at 0x2a',
      ),
    )
    const other = describeFailure(
      'graphics',
      named('GPUValidationError', 'Binding size 16 is smaller than 64'),
    )
    const print = (r: FailureReport | null) =>
      r?.properties['$exception_fingerprint']
    expect(print(a)).toBe(print(b))
    expect(print(a)).not.toBe(print(other))
    expect(String(print(a))).toMatch(/^gpu-validation:/)
  })

  it('fingerprints a device loss by its reason, and ignores our own release', () => {
    const lost = describeFailure(
      'graphics',
      named('GPUDeviceLost', '', { reason: 'unknown' }),
    )
    expect(lost?.properties['$exception_fingerprint']).toBe(
      'gpu-device-lost:unknown',
    )
    expect(lost?.properties['$exception_level']).toBe('fatal')
    expect(
      describeFailure(
        'graphics',
        named('GPUDeviceLost', '', { reason: 'destroyed' }),
      ),
    ).toBeNull()
  })

  it('groups a guide failure by the provider’s code alone', () => {
    const report = describeFailure('tour', new TourError('rate_limit_exceeded'))
    expect(report?.properties['$exception_fingerprint']).toBe(
      'tour:rate_limit_exceeded',
    )
    expect(report?.error.message).not.toContain('said')
  })

  it('leaves an ordinary error to automatic grouping', () => {
    const report = describeFailure('runtime', new TypeError('x is undefined'), {
      boundary: 'interactive view',
    })
    expect(report?.properties).toEqual({
      boundary: 'interactive view',
      failure_kind: 'runtime',
      $exception_level: 'fatal',
    })
  })

  it('normalizes what varies and keeps what does not', () => {
    expect(normalizeMessage('Buffer "terrain 12" size 4096\nat line 3')).toBe(
      'Buffer … size #',
    )
  })
})

describe('how many failures a page sends', () => {
  it('sends one error object once, however many funnels see it', () => {
    const { reporter, sent } = rig()
    const error = new Error('render threw')
    reporter.report('runtime', error, { boundary: 'interactive view' })
    reporter.report('runtime', error)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.properties['boundary']).toBe('interactive view')
  })

  it('stops at the page cap', () => {
    const { reporter, sent } = rig()
    for (let i = 0; i < PAGE_CAP + 3; i += 1)
      reporter.report('boundary', new Error(`panel ${i}`))
    expect(sent).toHaveLength(PAGE_CAP)
  })

  it('sends the device loss that arrives behind the validation error it caused', () => {
    const { reporter, sent, timers, elapse } = rig()
    reporter.report('graphics', named('GPUValidationError', 'pipeline invalid'))
    expect(sent).toHaveLength(0)
    expect(timers[0]!.ms).toBe(GRAPHICS_HOLD_MS)
    reporter.report(
      'graphics',
      named('GPUDeviceLost', '', { reason: 'unknown' }),
    )
    elapse()
    expect(sent.map((r) => r.error.name)).toEqual(['GPUDeviceLost'])
  })

  it('sends the held validation error when no loss follows', () => {
    const { reporter, sent, elapse } = rig()
    reporter.report('graphics', named('GPUValidationError', 'pipeline invalid'))
    elapse()
    expect(sent.map((r) => r.error.name)).toEqual(['GPUValidationError'])
  })
})
