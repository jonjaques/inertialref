import { describe, expect, it } from 'vitest'
import {
  type ConsoleLike,
  createConsoleSink,
  type LogRecord,
  LogHub,
  RingBufferSink,
} from './log.ts'

/*
 * `log.ts` had no tests, and its header states a determinism invariant — "two
 * runs of the same seed must produce byte-identical logs" — in a repository
 * whose whole discipline is determinism. That claim is the reason a record has
 * a sequence number and no wall-clock timestamp, so it is worth asserting.
 */

const collect = (): {
  sink: { write(r: LogRecord): void }
  records: LogRecord[]
} => {
  const records: LogRecord[] = []
  return { sink: { write: (r) => records.push(r) }, records }
}

describe('the log hub', () => {
  it('produces byte-identical records for two identical runs', () => {
    const run = (): string => {
      const hub = new LogHub()
      const { sink, records } = collect()
      hub.addSink(sink)
      const log = hub.logger('sim.world')
      log.info('system loaded', { system: 'SOL', planets: 4 })
      log.child('flight', { entity: 'e:1' }).warn('touchdown', { speed: 3.5 })
      return JSON.stringify(records)
    }
    // No wall clock anywhere in a record, so this is exact rather than close.
    expect(run()).toBe(run())
  })

  it('numbers records from the hub, not the logger', () => {
    const hub = new LogHub()
    const { sink, records } = collect()
    hub.addSink(sink)
    hub.logger('a').info('one')
    hub.logger('b').info('two')
    hub.logger('a').info('three')
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2])
  })

  it('merges a child scope and its bound fields', () => {
    const hub = new LogHub()
    const { sink, records } = collect()
    hub.addSink(sink)
    hub
      .logger('game', { build: 'dev' })
      .child('terrain', { body: 'b:0' })
      .info('patch', { level: 6 })
    const record = records[0]
    expect(record?.scope).toBe('game.terrain')
    expect(record?.fields).toEqual({ build: 'dev', body: 'b:0', level: 6 })
  })

  it('drops records below the minimum level', () => {
    const hub = new LogHub()
    const { sink, records } = collect()
    hub.addSink(sink)
    hub.setMinLevel('warn')
    const log = hub.logger('x')
    log.debug('no')
    log.info('no')
    log.warn('yes')
    log.error('yes')
    expect(records.map((r) => r.level)).toEqual(['warn', 'error'])
  })

  it('stops writing to a sink once it is removed', () => {
    const hub = new LogHub()
    const { sink, records } = collect()
    const remove = hub.addSink(sink)
    hub.logger('x').info('before')
    remove()
    hub.logger('x').info('after')
    expect(records.map((r) => r.message)).toEqual(['before'])
  })
})

describe('the ring buffer sink', () => {
  it('keeps the newest records and evicts the oldest', () => {
    const buffer = new RingBufferSink(3)
    const hub = new LogHub()
    hub.addSink(buffer)
    for (const message of ['a', 'b', 'c', 'd', 'e'])
      hub.logger('x').info(message)
    expect(buffer.records().map((r) => r.message)).toEqual(['c', 'd', 'e'])
  })

  it('hands out a copy, so a caller cannot mutate the buffer', () => {
    const buffer = new RingBufferSink()
    const hub = new LogHub()
    hub.addSink(buffer)
    hub.logger('x').info('one')
    const taken = buffer.records() as LogRecord[]
    taken.length = 0
    expect(buffer.records()).toHaveLength(1)
    buffer.clear()
    expect(buffer.records()).toHaveLength(0)
  })
})

describe('the console sink', () => {
  it('routes each level to the matching console method', () => {
    const calls: string[] = []
    const target: ConsoleLike = {
      debug: () => calls.push('debug'),
      info: () => calls.push('info'),
      warn: () => calls.push('warn'),
      error: () => calls.push('error'),
    }
    const hub = new LogHub()
    // The hub filters before the sink does, and its own default is 'debug'.
    hub.setMinLevel('trace')
    hub.addSink(createConsoleSink(target, 'trace'))
    const log = hub.logger('x')
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    // trace and debug share console.debug — there is no console.trace here.
    expect(calls).toEqual(['debug', 'debug', 'info', 'warn', 'error'])
  })

  it('passes fields as a second argument only when there are any', () => {
    const args: unknown[][] = []
    const record = (...a: unknown[]): void => {
      args.push(a)
    }
    const target: ConsoleLike = {
      debug: record,
      info: record,
      warn: record,
      error: record,
    }
    const hub = new LogHub()
    hub.addSink(createConsoleSink(target, 'info'))
    hub.logger('sim').info('bare')
    hub.logger('sim').info('with fields', { tick: 12 })
    expect(args[0]).toEqual(['[sim] bare'])
    expect(args[1]).toEqual(['[sim] with fields', { tick: 12 }])
  })
})
