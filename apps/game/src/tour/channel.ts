import type { GuideClientEvent, GuideToolOutput } from '@inertialref/protocol'
import type { LiveServerEvent } from './media.ts'

/*
 * The provider's vocabulary, spoken in verbs.
 *
 * Everything the guide sends over the data channel goes out through here, and
 * the runtime and the loop say what they mean — note this, answer that call,
 * mute both directions — rather than which provider event carries it. The
 * transport's `send` is typed on the protocol's `GuideClientEvent`, so a
 * misspelled event fails `tsc`; the transport also refuses anything off the
 * allow list at run time (`media.ts`, and the fake in `liveFake.ts`), because
 * a cast reaches the wire as surely as a typo does.
 *
 * Three files make the adapter: this one, `loop.ts` (the tool loop over the
 * provider's response events) and `media.ts` (the peer connection). No other
 * file in `tour/` names a provider event, and `channel.test.ts` holds it.
 */

/** The transport the verbs speak over: `LiveConnection`, and the fake. */
export interface LiveTransport {
  /** Send one client event; returns the event id the transport stamped on it. */
  send(event: GuideClientEvent): string
  muteMicrophone(muted: boolean): Promise<void>
  muteGuide(muted: boolean): void
}

export class GuideChannel {
  readonly #transport: LiveTransport
  readonly #record: (event: GuideClientEvent, id: string) => void

  constructor(
    transport: LiveTransport,
    record: (event: GuideClientEvent, id: string) => void = () => {},
  ) {
    this.#transport = transport
    this.#record = record
  }

  #send(event: GuideClientEvent): string {
    const id = this.#transport.send(event)
    this.#record(event, id)
    return id
  }

  /* -- The conversation, which the backend reads ------------------------- */

  /** State the next response reads: a scene, an arrival, a takeover. */
  note(text: string): void {
    this.#send({
      type: 'response.item.create',
      item: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text }],
      },
    })
  }

  /** The visitor's own words, typed: the documented text-input path. */
  ask(text: string): void {
    this.#send({
      type: 'response.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    })
  }

  /** A tool's answer to one call. */
  answer(callId: string, output: GuideToolOutput): void {
    this.#send({
      type: 'response.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output),
      },
    })
  }

  /** Run the backend on everything queued. */
  respond(): void {
    this.#send({ type: 'response.create' })
  }

  /* -- The voice, which speaks ------------------------------------------- */

  /**
   * An instruction to the voice for the rest of the session. Returns the
   * event id, which the loop can wait on for the acknowledgment.
   */
  instruct(content: string): string {
    return this.#send({
      type: 'session.instructions.append',
      delegation_id: null,
      content,
    })
  }

  /** A cue the voice acts on now: the greeting's "begin". */
  comment(content: string): string {
    return this.#send({
      type: 'session.commentary.append',
      delegation_id: null,
      content,
    })
  }

  /**
   * Context the voice keeps in mind without saying it. Advisory, so a
   * connection that cannot carry it is not an error here: the transport's
   * failure handler reports a connection that has gone.
   */
  think(content: string): void {
    try {
      this.#send({
        type: 'session.thinking.append',
        delegation_id: null,
        content,
      })
    } catch {
      /* Reported by the failure handler if the connection is gone. */
    }
  }

  /**
   * Mute or unmute both directions: the microphone track, the guide's audio,
   * and the provider's input, which keeps it from hearing the room through a
   * track the browser has not yet replaced. The promise is the microphone's,
   * which is the one half that can fail on the visitor's side.
   */
  mute(muted: boolean): Promise<void> {
    const microphone = this.#transport.muteMicrophone(muted)
    this.#transport.muteGuide(muted)
    try {
      this.#send({
        type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute',
      })
    } catch {
      /* A connection that cannot carry the mute is one the failure handler is about to report. */
    }
    return microphone
  }

  /** Ask the provider to end the session; best effort, for a page going away. */
  close(): void {
    try {
      this.#send({ type: 'session.close' })
    } catch {
      /* The peer connection closing is the fallback the provider honors. */
    }
  }
}

/**
 * Output transcript deltas arrive per word and say nothing the trace needs;
 * every other server event is worth recording.
 */
export const isOutputTranscript = (event: LiveServerEvent): boolean =>
  event.type === 'session.output_transcript.delta'
