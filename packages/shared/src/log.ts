/*
 * Structured logging.
 *
 * Records carry fields, not interpolated prose, so devtools can filter and diff
 * them. Two runs of the same seed must produce byte-identical logs, which is why
 * a record has a sequence number and (where the caller knows it) a simulation
 * tick, but no wall-clock timestamp — wall time is the one field guaranteed to
 * differ between two runs that are otherwise identical. The console sink adds
 * elapsed wall time for humans; the ring buffer, which is what gets diffed and
 * dumped into a bug report, does not.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
}

export type LogFields = Readonly<Record<string, unknown>>

export interface LogRecord {
  readonly seq: number
  readonly level: LogLevel
  readonly scope: string
  readonly message: string
  readonly fields: LogFields
}

export interface LogSink {
  write(record: LogRecord): void
}

export interface Logger {
  readonly scope: string
  trace(message: string, fields?: LogFields): void
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** Derive a logger with a narrower scope and additional bound fields. */
  child(scope: string, fields?: LogFields): Logger
}

/** Keeps the last `capacity` records for the debug overlay and bug reports. */
export class RingBufferSink implements LogSink {
  readonly #records: LogRecord[] = []
  readonly #capacity: number

  constructor(capacity = 512) {
    this.#capacity = capacity
  }

  write(record: LogRecord): void {
    this.#records.push(record)
    if (this.#records.length > this.#capacity) this.#records.shift()
  }

  /** Newest last. Copied, so callers cannot mutate the buffer. */
  records(): readonly LogRecord[] {
    return this.#records.slice()
  }

  clear(): void {
    this.#records.length = 0
  }
}

export interface ConsoleLike {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export function createConsoleSink(
  target: ConsoleLike,
  minLevel: LogLevel = 'info',
): LogSink {
  return {
    write(record) {
      if (LEVEL_ORDER[record.level] < LEVEL_ORDER[minLevel]) return
      const head = `[${record.scope}] ${record.message}`
      const args: unknown[] =
        Object.keys(record.fields).length > 0 ? [head, record.fields] : [head]
      switch (record.level) {
        case 'trace':
        case 'debug':
          target.debug(...args)
          return
        case 'info':
          target.info(...args)
          return
        case 'warn':
          target.warn(...args)
          return
        case 'error':
          target.error(...args)
          return
      }
    },
  }
}

/** A logging root: owns the sequence counter and the sink list. */
export class LogHub {
  #seq = 0
  #minLevel: LogLevel = 'debug'
  readonly #sinks = new Set<LogSink>()

  addSink(sink: LogSink): () => void {
    this.#sinks.add(sink)
    return () => this.#sinks.delete(sink)
  }

  setMinLevel(level: LogLevel): void {
    this.#minLevel = level
  }

  get minLevel(): LogLevel {
    return this.#minLevel
  }

  emit(
    level: LogLevel,
    scope: string,
    message: string,
    fields: LogFields,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#minLevel]) return
    const record: LogRecord = {
      seq: this.#seq++,
      level,
      scope,
      message,
      fields,
    }
    for (const sink of this.#sinks) sink.write(record)
  }

  logger(scope: string, bound: LogFields = {}): Logger {
    const emit = (
      level: LogLevel,
      message: string,
      fields?: LogFields,
    ): void => {
      this.emit(level, scope, message, fields ? { ...bound, ...fields } : bound)
    }
    return {
      scope,
      trace: (m, f) => emit('trace', m, f),
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (childScope, childFields) =>
        this.logger(`${scope}.${childScope}`, { ...bound, ...childFields }),
    }
  }
}

/**
 * Process-wide hub. Sinks are attached by the host (the browser app attaches a
 * console sink and the devtools ring buffer; tests attach nothing), so importing
 * a package never causes output on its own.
 */
export const logHub = new LogHub()

export function getLogger(scope: string, fields?: LogFields): Logger {
  return logHub.logger(scope, fields)
}
