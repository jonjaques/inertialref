import { err, ok } from '@inertialref/shared'
import {
  decodeArray,
  decodeNumber,
  decodeObject,
  decodeString,
  type Decoder,
  refine,
} from './codec.ts'
import { type GuideVoice, isGuideVoice } from './guideTools.ts'

/*
 * The guide's wire: what the browser and the Worker say to each other about
 * the guide, and nothing the provider says to either.
 *
 * Two routes. The verdict answers "may whoever is asking use the guide, and in
 * which voices", and the session route turns the browser's offer into a live
 * session. Both sides read them through the decoders here, so a field renamed
 * on the Worker fails the Worker's own tests rather than a visitor's first
 * click — three tests each building their own copy of the shape passed
 * through exactly that rename.
 *
 * Nothing vendor-specific enters this file (rule 20): the provider's SDP is a
 * string with a bound, and the session id is whatever the Worker hands back.
 */

/** The guide's routes, under `API_PREFIX`. */
export const GUIDE_PREFIX = '/api/tour'
export const GUIDE_VERDICT_PATH = `${GUIDE_PREFIX}/capabilities`
export const GUIDE_SESSIONS_PATH = `${GUIDE_PREFIX}/sessions`

/**
 * Why the guide is refused. A code rather than a sentence, so the Worker's
 * refusal and the panel's line are one entry in `GUIDE_REFUSAL_SENTENCES`
 * rather than the same words typed in three files.
 */
export const GUIDE_REFUSALS = [
  /** The deployment has no provider key, no accounts, or the guide off. */
  'unavailable',
  /** Nobody is signed in. */
  'signed-out',
  /** The account is signed in and has no grant. */
  'not-granted',
] as const
export type GuideRefusal = (typeof GUIDE_REFUSALS)[number]

export const GUIDE_REFUSAL_SENTENCES: Readonly<Record<GuideRefusal, string>> = {
  unavailable: 'The guide is unavailable.',
  'signed-out': 'Sign in to use the guide.',
  'not-granted': 'This account does not have the guide.',
}

/**
 * The Worker's answer at `GUIDE_VERDICT_PATH`, for whoever asked: granted with
 * the voices it may speak in, or refused with a reason.
 *
 * The Worker's verdict is the only one that counts: the grant lives in the
 * account's private metadata, which the browser cannot read.
 */
export type GuideVerdict =
  | { readonly granted: true; readonly voices: readonly GuideVoice[] }
  | { readonly granted: false; readonly reason: GuideRefusal }

const decodeVoice: Decoder<GuideVoice> = refine(
  decodeString,
  isGuideVoice,
  'a guide voice',
)

const decodeRefusal: Decoder<GuideRefusal> = refine(
  decodeString,
  (value): value is GuideRefusal =>
    (GUIDE_REFUSALS as readonly string[]).includes(value),
  `one of ${GUIDE_REFUSALS.join(' | ')}`,
)

/** The verdict, if it is one; a proxy's error page or a stale shape is not. */
export const decodeGuideVerdict: Decoder<GuideVerdict> = (value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return err(`${path || 'value'}: expected an object`)
  const granted = (value as { granted?: unknown }).granted
  if (granted === true) {
    const decoded = decodeObject({ voices: decodeArray(decodeVoice) })(
      value,
      path,
    )
    return decoded.ok
      ? ok({ granted: true, voices: decoded.value.voices })
      : decoded
  }
  if (granted === false) {
    const decoded = decodeObject({ reason: decodeRefusal })(value, path)
    return decoded.ok
      ? ok({ granted: false, reason: decoded.value.reason })
      : decoded
  }
  return err(`${path ? `${path}.` : ''}granted: expected a boolean`)
}

/**
 * The bounds of a session request, both in UTF-8 bytes — the unit the
 * provider counts in. The Worker refuses past them before it spends a provider
 * call, and the browser's opening line is written to fit under them.
 */
export const GUIDE_SESSION_LIMITS = {
  /** The browser's SDP offer, and the provider's answer. */
  sdpBytes: 65_536,
  /** The opening scene line: what is on screen, and the local time. */
  sceneBytes: 1500,
} as const

/**
 * A string's length in UTF-8 bytes, without `TextEncoder`, which this package
 * cannot name: no DOM lib and no Node lib.
 */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (const character of text) {
    const point = character.codePointAt(0)!
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
  }
  return bytes
}

const bytesWithin = (max: number): Decoder<string> =>
  refine(
    decodeString,
    (value): value is string => value.length > 0 && utf8Bytes(value) <= max,
    `a non-empty string of at most ${max} bytes`,
  )

/** What the browser posts to `GUIDE_SESSIONS_PATH`. */
export interface GuideSessionRequest {
  readonly voice: GuideVoice
  readonly sdp: string
  readonly scene: string
}

export const decodeGuideSessionRequest: Decoder<GuideSessionRequest> =
  decodeObject({
    voice: decodeVoice,
    sdp: bytesWithin(GUIDE_SESSION_LIMITS.sdpBytes),
    scene: bytesWithin(GUIDE_SESSION_LIMITS.sceneBytes),
  })

/** What the Worker answers with a session created. */
export interface GuideSessionCreated {
  readonly sessionId: string
  /** Milliseconds since the epoch; 0 when the provider stated none. */
  readonly expiresAt: number
  /** The provider's SDP answer, for the browser's peer connection. */
  readonly sdp: string
}

export const decodeGuideSessionCreated: Decoder<GuideSessionCreated> =
  decodeObject({
    sessionId: refine(
      decodeString,
      (value): value is string => value.length > 0,
      'a session id',
    ),
    expiresAt: decodeNumber,
    sdp: bytesWithin(GUIDE_SESSION_LIMITS.sdpBytes),
  })

/** Every refused or failed guide request answers with one sentence. */
export interface GuideError {
  readonly error: string
}

export const decodeGuideError: Decoder<GuideError> = decodeObject({
  error: decodeString,
})
