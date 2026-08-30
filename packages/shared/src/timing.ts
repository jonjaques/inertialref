/*
 * Timing spans, for a host that has a timeline to put them on.
 *
 * Modeled on `log.ts` down to the module-global hub whose default does nothing,
 * because the property that file establishes is the one that matters most here:
 * *importing a package never causes output*. A sink is attached by the process's
 * entry point; until then every call below is a property read and a return.
 *
 * The reason this is a port rather than three `performance.mark` calls is the
 * layering rule. `performance` and `console.timeStamp` are host globals whose
 * types are not even in scope under `packages/`, and Node's `console.timeStamp`
 * is not Chrome's — so the interface is declared here and the host implements
 * it, exactly as `WorkerPort`, `SaveStore` and `PoolOptions.now` already do.
 *
 * ## Why `Span.end` returns `void`
 *
 * AGENTS.md rule 2 forbids canonical code from *depending on* the wall clock.
 * It does not forbid canonical code from *emitting* to it, and the check that
 * keeps the two apart is this type: a span hands nothing back, so there is no
 * expression a caller can write that observes how long anything took, and no
 * canonical value can be a function of wall time. The invariant survives by
 * construction rather than by discipline. `end(): number` would look helpful
 * and would be the whole defect.
 */

/**
 * Chrome's documented palette for a custom track entry.
 *
 * Written out as a union so a call site is checked here, where there is no
 * DevTools to check it. A host that does not understand the value ignores it.
 */
export type TimingColor =
  | 'primary'
  | 'primary-light'
  | 'primary-dark'
  | 'secondary'
  | 'secondary-light'
  | 'secondary-dark'
  | 'tertiary'
  | 'tertiary-light'
  | 'tertiary-dark'
  | 'error'

/**
 * Where an entry is drawn and what it says about itself.
 *
 * **`properties` and `tooltip` are User-Timing-only fields and this type cannot
 * say so.** They reach DevTools through a `performance.measure` detail payload;
 * `console.timeStamp(label, start, end, track, group, color)` is the entire
 * signature and has no channel for them. A sink emitting through `timeStamp`
 * drops them rather than failing, because the alternative is a call site that
 * has to know which level the host is running at.
 *
 * The pairs are `[string, string]` because that is what the panel renders, and
 * the conversion happens at the call site — `['patches', String(built)]`. That
 * conversion is the reason `properties` never appears on a per-frame entry:
 * formatting a number allocates a string sixty times a second to fill a table
 * the cheap path discards anyway.
 */
export interface TimingDetail {
  readonly track?: string
  readonly group?: string
  readonly color?: TimingColor
  readonly properties?: readonly (readonly [string, string])[]
  readonly tooltip?: string
}

/**
 * An open interval. `end()` returns void, and that is load-bearing — see the
 * header.
 */
export interface Span {
  end(): void
}

/**
 * What a record is: an instant or a closed interval.
 *
 * The sink needs it and cannot infer it. A zero-length `measure` is a legitimate
 * thing to emit, and the two kinds are retained and cleared through different
 * calls — `performance.clearMarks` does not touch a measure — so a sink that
 * guessed from `startMs === endMs` would leave half of what it emitted behind.
 */
export type TimingKind = 'mark' | 'measure'

export interface TimingRecord {
  readonly kind: TimingKind
  readonly scope: string
  readonly name: string
  readonly startMs: number
  readonly endMs: number
  readonly detail: TimingDetail | undefined
}

export interface TimingSink {
  write(record: TimingRecord): void
}

export interface AttachOptions {
  /**
   * The host's clock. `span()` has to timestamp itself and nothing under
   * `packages/` may reach for `performance.now()`, so the clock arrives the way
   * `PoolOptions.now` and `ServeOptions.now` already do.
   *
   * **No zero default.** Those two default to `() => 0` and it is harmless
   * there — a stat reads 0 ms and is obviously untimed. Here it would stack
   * every entry at t=0 on the timeline, which looks like a recording rather
   * than like a missing argument. Attaching without a clock throws.
   */
  readonly now: () => number
}

export interface Timer {
  /**
   * Cheap enough to read in a per-frame branch. False until a sink attaches.
   *
   * **A getter over the live hub, never a captured boolean.** A module-scope
   * `const timer = getTimer('game.engine')` is constructed while the hub still
   * has no sink — ES modules evaluate every static import to completion before
   * the importing module's first statement runs, and the entry point attaches
   * the sink in its own body. A snapshot taken at that moment is `false` for
   * the life of the process, the instrumentation records nothing, and nothing
   * fails. A getter that reads one boolean off the hub costs the same at the
   * call site — a property read on a monomorphic object, no allocation — and
   * cannot go stale.
   */
  readonly on: boolean
  /** An instant. `detail` is only built when `on`. */
  mark(name: string, detail?: TimingDetail): void
  /** A closed interval from numbers the caller already has. */
  measure(
    name: string,
    startMs: number,
    endMs: number,
    detail?: TimingDetail,
  ): void
  /** An open interval, closed by `end()`. */
  span(name: string, detail?: TimingDetail): Span
  child(scope: string): Timer
}

/**
 * The one span every disabled `span()` returns.
 *
 * A fresh object per call would allocate at frame rate with the whole thing
 * switched off, which is the failure mode a performance tool must not have.
 * Nesting is meaningless on a no-op, so sharing costs nothing and the identity
 * is what the test asserts.
 */
const NO_SPAN: Span = Object.freeze({
  end: () => {
    /* nothing is being timed */
  },
})

/** A timing root: owns the clock and the sink list. */
export class TimingHub {
  #now: (() => number) | null = null
  readonly #sinks = new Set<TimingSink>()

  /** Whether anything is listening. The one boolean every hot path reads. */
  get on(): boolean {
    return this.#sinks.size > 0
  }

  attach(sink: TimingSink, options: AttachOptions): () => void {
    if (typeof options.now !== 'function') {
      throw new TypeError('A timing sink needs a clock; see AttachOptions.now')
    }
    this.#now = options.now
    this.#sinks.add(sink)
    return () => this.detach(sink)
  }

  detach(sink: TimingSink): void {
    this.#sinks.delete(sink)
    // The clock belongs to whoever attached; with nobody attached there is no
    // host to ask, and a stale closure over a torn-down page is worse than
    // zero. Every emit path is behind `on`, so the zero is unreachable from a
    // record.
    if (this.#sinks.size === 0) this.#now = null
  }

  now(): number {
    return this.#now === null ? 0 : this.#now()
  }

  emit(record: TimingRecord): void {
    for (const sink of this.#sinks) sink.write(record)
  }

  timer(scope: string): Timer {
    return makeTimer(this, scope)
  }
}

/**
 * A `Timer` bound to a hub and a scope.
 *
 * A free function rather than a method body, because every member has to reach
 * the hub and an object literal's `get on()` establishes its own `this` — so a
 * method would need `const hub = this` above the literal, which is a shape a
 * reader has to check twice and the linter flags on sight.
 */
function makeTimer(hub: TimingHub, scope: string): Timer {
  return {
    get on() {
      return hub.on
    },
    mark(name, detail) {
      if (!hub.on) return
      const at = hub.now()
      hub.emit({ kind: 'mark', scope, name, startMs: at, endMs: at, detail })
    },
    measure(name, startMs, endMs, detail) {
      if (!hub.on) return
      hub.emit({ kind: 'measure', scope, name, startMs, endMs, detail })
    },
    span(name, detail) {
      if (!hub.on) return NO_SPAN
      const startMs = hub.now()
      // Guarded because the two places a span is closed — the success path and
      // a `finally` — are both correct on their own and produce two entries
      // together. One boolean is cheaper than a duplicated interval that reads
      // as the work having happened twice.
      let ended = false
      return {
        end() {
          if (ended) return
          ended = true
          hub.emit({
            kind: 'measure',
            scope,
            name,
            startMs,
            endMs: hub.now(),
            detail,
          })
        },
      }
    },
    child: (childScope) => makeTimer(hub, `${scope}.${childScope}`),
  }
}

/**
 * Process-wide hub. The sink is attached by the host, so importing a package
 * never puts anything on a timeline.
 */
export const timingHub = new TimingHub()

export function getTimer(scope: string): Timer {
  return timingHub.timer(scope)
}
