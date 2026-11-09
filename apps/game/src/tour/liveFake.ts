import type { GuideMeter } from '@inertialref/devtools'
import {
  type GuideClientEvent,
  type GuideConversationItem,
  isGuideClientEvent,
} from '@inertialref/protocol'
import type { LiveServerEvent, TransportNotice } from './media.ts'
import type { LiveConnectionPort } from './runtime.ts'

/*
 * The provider, in memory, for the guide's tests: the one fake of the Live
 * connection, and the server events it speaks in.
 *
 * It refuses an event off the data-channel allow list exactly as
 * `LiveConnection` does, so a test that sends one fails here rather than
 * passing and failing as `event_not_allowed` in a live, billed session. It
 * acknowledges what the provider acknowledges — every append and every mute,
 * by the client's event id — starts the session on the answer, and ends it on
 * `session.close` with its final usage. The event shapes are the ones the
 * probe sessions behind ADR-0042 recorded (`scripts/tour/live-probe/lib.mjs`
 * reads the same fields), built once here rather than once per test file.
 */

export type SentEvent = GuideClientEvent & { readonly event_id: string }

export interface LiveFake {
  /** The connection, for `GuideHost.live` or a `GuideChannel`. */
  readonly live: LiveConnectionPort
  /** Every event sent, stamped, in order. */
  readonly sent: readonly SentEvent[]
  /** Where server events and transport notices go: the runtime's handlers, set by `listen`. */
  listen(
    onEvent: (event: LiveServerEvent) => void,
    onNotice?: (notice: TransportNotice) => void,
  ): void
  /** What the transport would report about itself: a lost path, a path regained, a microphone gone. */
  notify(notice: TransportNotice): void
  /** Make every later unmute's capture fail with this message; `null` lifts it. */
  captureFailure(message: string | null): void
  /** Deliver one server event, as the data channel would. */
  emit(event: LiveServerEvent): void
  /** The answers `accept` was given, and the mutes asked for, in order. */
  readonly accepted: readonly string[]
  readonly microphone: readonly boolean[]
  readonly guideAudio: readonly boolean[]
  readonly closes: () => number
  /** The output level the clock samples, 0 to 1. */
  speak(level: number): void
  /** What the meter says of itself; `ok` until a test says otherwise. */
  measure(health: GuideMeter): void
  /**
   * Refuse every later event of one type the way the provider does: accepted
   * on the wire, then an `error` naming the client event's id. `null` lifts
   * it. A rate limit on `response.create` and a `responses_validation_failed`
   * are both this shape.
   */
  refuse(type: GuideClientEvent['type'], code: string | null): void
}

export function liveFake(): LiveFake {
  const sent: SentEvent[] = []
  const accepted: string[] = []
  const microphone: boolean[] = []
  const guideAudio: boolean[] = []
  let onEvent: (event: LiveServerEvent) => void = () => {}
  let onNotice: (notice: TransportNotice) => void = () => {}
  let captureFails: string | null = null
  let sequence = 0
  let level = 0
  let health: GuideMeter = 'ok'
  let closes = 0
  let stopped = false
  const refused = new Map<GuideClientEvent['type'], string>()
  const emit = (event: LiveServerEvent) => onEvent(event)
  const later = (event: LiveServerEvent) => queueMicrotask(() => emit(event))

  const live: LiveConnectionPort = {
    prepare: async () => 'offer',
    accept: async (sdp) => {
      accepted.push(sdp)
      emit(provider.started())
    },
    send(event) {
      // Checked at run time, as the real connection does: a cast reaches the
      // wire as surely as a typo.
      const type: unknown = event.type
      if (!isGuideClientEvent(type))
        throw new Error(`The guide may not send ${String(type)}.`)
      if (stopped) throw new Error('The voice connection is not open.')
      const id = `guide-${++sequence}`
      sent.push({ ...event, event_id: id })
      const refusal = refused.get(type)
      if (refusal !== undefined) {
        later(provider.error(refusal, `Refused: ${type}.`, id))
        return id
      }
      if (type.endsWith('.append')) later(provider.ack(`${type}ed`, id))
      if (type.endsWith('.mute') || type.endsWith('.unmute'))
        later(provider.ack(`${type}d`, id))
      if (type === 'session.close')
        later(provider.closed('close_requested', 42))
      return id
    },
    level: () => level,
    meter: () => health,
    // An unmute settles a tick later, as a capture does, so a test can see
    // what the runtime says of itself while the microphone is still coming.
    muteMicrophone: async (muted) => {
      microphone.push(muted)
      if (muted) return
      await Promise.resolve()
      if (captureFails !== null) throw new Error(captureFails)
    },
    muteGuide: (muted) => {
      guideAudio.push(muted)
    },
    // As `LiveConnection.close`: a stopped connection answers without
    // sending, a send that fails is not a throw, and the connection is
    // stopped once it returns.
    close: async () => {
      closes++
      if (stopped) return { closed: false }
      let sent = true
      try {
        live.send({ type: 'session.close' })
      } catch {
        sent = false
      }
      await Promise.resolve()
      stopped = true
      return { closed: sent }
    },
    stop: () => {
      stopped = true
    },
  }

  return {
    live,
    sent,
    listen: (handler, notices) => {
      onEvent = handler
      onNotice = notices ?? (() => {})
      stopped = false
    },
    notify: (notice) => onNotice(notice),
    captureFailure: (message) => {
      captureFails = message
    },
    emit,
    accepted,
    microphone,
    guideAudio,
    closes: () => closes,
    speak: (value) => {
      level = value
    },
    measure: (value) => {
      health = value
    },
    refuse: (type, code) => {
      if (code === null) refused.delete(type)
      else refused.set(type, code)
    },
  }
}

/* ------------------------------------------------------------------------- */
/* The server's events                                                         */
/* ------------------------------------------------------------------------- */

type Usage = Readonly<Record<string, unknown>> | null

/** One response event, inside the envelope delegation wraps it in. */
const delegated = (
  event: Readonly<Record<string, unknown>>,
  delegation: string,
): LiveServerEvent => ({
  type: 'response.event',
  delegation_id: delegation,
  event,
})

export const provider = {
  started: (id = 'live_1'): LiveServerEvent => ({
    type: 'session.started',
    session: { id },
  }),
  /** The acknowledgment of a client event, by the id the browser stamped. */
  ack: (type: string, clientEventId: string): LiveServerEvent => ({
    type,
    client_event_id: clientEventId,
  }),
  closed: (reason: string, seconds?: number): LiveServerEvent => ({
    type: 'session.closed',
    reason,
    ...(seconds === undefined ? {} : { usage: { seconds } }),
  }),
  usage: (seconds: number): LiveServerEvent => ({
    type: 'session.usage.updated',
    usage: { seconds },
  }),
  visitorSaid: (delta: string): LiveServerEvent => ({
    type: 'session.input_transcript.delta',
    delta,
  }),
  guideSaid: (delta: string): LiveServerEvent => ({
    type: 'session.output_transcript.delta',
    delta,
  }),
  delegation: (id = 'item_2'): LiveServerEvent => ({
    type: 'session.delegation.created',
    delegation: { id, target: 'responses' },
  }),
  responseCreated: (id: string, delegation = 'item_1'): LiveServerEvent =>
    delegated({ type: 'response.created', response: { id } }, delegation),
  functionCall: (
    callId: string,
    name: string,
    args: string,
    delegation = 'item_1',
  ): LiveServerEvent =>
    delegated(
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: callId, name, arguments: args },
      },
      delegation,
    ),
  message: (text: string, delegation = 'item_1'): LiveServerEvent =>
    delegated(
      {
        type: 'response.output_item.done',
        item: { type: 'message', content: [{ type: 'output_text', text }] },
      },
      delegation,
    ),
  responseCompleted: (
    id: string,
    usage: Usage = null,
    delegation = 'item_1',
  ): LiveServerEvent =>
    delegated(
      { type: 'response.completed', response: { id, usage } },
      delegation,
    ),
  /** The backend failed the response: a server error, a refused tool output. */
  responseFailed: (
    id: string,
    code = 'server_error',
    delegation = 'item_1',
  ): LiveServerEvent =>
    delegated(
      {
        type: 'response.failed',
        response: {
          id,
          status: 'failed',
          error: { code, message: `The response failed: ${code}.` },
          usage: null,
        },
      },
      delegation,
    ),
  /** The backend stopped early: at the token cap, or a content filter. */
  responseIncomplete: (
    id: string,
    reason: 'max_output_tokens' | 'content_filter' = 'max_output_tokens',
    delegation = 'item_1',
  ): LiveServerEvent =>
    delegated(
      {
        type: 'response.incomplete',
        response: {
          id,
          status: 'incomplete',
          incomplete_details: { reason },
          usage: null,
        },
      },
      delegation,
    ),
  /**
   * A session error. With a client event id it is the provider refusing that
   * command (`client_event_id` is the Live spelling); without one it is a
   * session-level failure such as `responses_validation_failed`.
   */
  error: (
    code: string,
    message = `Error: ${code}.`,
    clientEventId?: string,
  ): LiveServerEvent => ({
    type: 'error',
    ...(clientEventId === undefined ? {} : { client_event_id: clientEventId }),
    error: { type: 'invalid_request_error', code, message },
  }),
} as const

/* ------------------------------------------------------------------------- */
/* Reading what was sent                                                       */
/* ------------------------------------------------------------------------- */

const items = (sent: readonly SentEvent[]): GuideConversationItem[] =>
  sent.flatMap((event) =>
    event.type === 'response.item.create' ? [event.item] : [],
  )

export const read = {
  /** The developer messages: scenes, arrivals, takeovers, in order. */
  developer: (sent: readonly SentEvent[]): string[] =>
    items(sent).flatMap((item) =>
      item.type === 'message' && item.role === 'developer'
        ? [item.content[0].text]
        : [],
    ),
  /** Each tool's answer, parsed. */
  outputs: (
    sent: readonly SentEvent[],
  ): { callId: string; output: Record<string, unknown> }[] =>
    items(sent).flatMap((item) =>
      item.type === 'function_call_output'
        ? [{ callId: item.call_id, output: JSON.parse(item.output) }]
        : [],
    ),
  /** How many times the backend was run. */
  creates: (sent: readonly SentEvent[]): number =>
    sent.filter((event) => event.type === 'response.create').length,
  /** What was appended to the voice of one kind, in order. */
  appends: (
    sent: readonly SentEvent[],
    kind: 'thinking' | 'instructions' | 'commentary',
  ): string[] =>
    sent.flatMap((event) =>
      event.type === `session.${kind}.append` && 'content' in event
        ? [event.content]
        : [],
    ),
  /** The position of the first event of a type, or -1. */
  indexOf: (
    sent: readonly SentEvent[],
    type: GuideClientEvent['type'],
  ): number => sent.findIndex((event) => event.type === type),
} as const
