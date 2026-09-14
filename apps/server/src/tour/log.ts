/*
 * The Worker's half of structured logging.
 *
 * Workers Logs indexes the fields of a single object passed to a console
 * method and takes the level from the method, so a record is one object with
 * the same `scope` / `message` / fields shape `packages/shared` uses in the
 * browser, and the level is which console method is called. There is no level
 * setting on the platform side: every record is captured and the query builder
 * filters, which is why nothing here is gated. Console output inside an active
 * span is attributed to that span, so a record written while the provider
 * call is open lands on the request's trace beside the subrequest.
 *
 * Nothing that passes through here may be a credential, a cookie, an SDP or a
 * scene line. Callers log a status, a code, a length or an id — the answer to
 * "what went wrong", never the material it went wrong with.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Readonly<Record<string, unknown>>

const SCOPE = 'server.tour'

export function log(level: LogLevel, message: string, fields?: LogFields) {
  console[level]({ scope: SCOPE, message, ...fields })
}

/**
 * Run `callback` inside a named span when the request has tracing, and bare
 * when it does not. Tests run under Node with no `ExecutionContext`, and a
 * local runtime may predate the API, so the absence is ordinary rather than
 * an error. Runtime spans for `fetch` opened inside the callback become its
 * children, which is what puts the provider round trip under the route.
 */
export function span<T>(
  tracing: Tracing | undefined,
  name: string,
  callback: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  return tracing?.enterSpan
    ? tracing.enterSpan(name, callback)
    : callback(undefined)
}
