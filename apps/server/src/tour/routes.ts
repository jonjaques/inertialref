import {
  decode,
  decodeGuideSessionRequest,
  GUIDE_REFUSAL_SENTENCES,
  GUIDE_SESSIONS_PATH,
  GUIDE_VERDICT_PATH,
  GUIDE_VOICES,
  type GuideError,
  type GuideSessionCreated,
  type GuideVerdict,
  isGuideVoice,
} from '@inertialref/protocol'
import { accountKeys, AccountUnavailableError } from '../account.ts'
import { allowed, RETRY_AFTER } from '../limits.ts'
import { logger, span } from '../log.ts'
import { allowedOrigin } from '../origins.ts'
import { guideAccess } from './access.ts'
import { readJson, record, TourHttpError, tourJson } from './http.ts'
import { createLiveSession, GuideProviderError } from './openaiLive.ts'

const log = logger('server.tour')

/*
 * The guide's Worker: one stateless route and a capability report.
 *
 * The Worker holds the provider key, and nothing else of the guide's. It does
 * not see the conversation, the scene, a tool call, or a usage event: the
 * browser owns the session through its own peer connection, executes every
 * tool against the observatory it already has, and reads the provider's usage
 * off the data channel. Without a sideband the Worker cannot meter a session,
 * so there is no per-user ledger — a browser's report of its own spend would
 * be advisory. The spending bound is the OpenAI project's limit and the
 * duration bound is the provider's own session expiry.
 *
 * What a tampered browser can abuse is therefore two things, and both are
 * enforced here: only an account the guide is granted to can create a session
 * (`access.ts`, from the session token the browser presents), and the
 * session's configuration — prompts, tools, model, the data-channel allow
 * list — is authored at creation and cannot be changed afterward.
 */

/*
 * Every route runs inside one span named for it, with the provider round trip
 * as a child, and every answer that is not a plain success writes a record
 * saying why. The invocation log already carries the method, the path, the
 * status, the colo and the ray id, so the records here carry only what it
 * cannot: which check refused the request, and what the provider said.
 */
export async function serveTour(
  request: Request,
  env: Env,
  tracing?: Tracing,
): Promise<Response> {
  const path = new URL(request.url).pathname
  return span(tracing, `tour ${request.method} ${path}`, async (span) => {
    span?.setAttributes({
      'http.request.method': request.method,
      'url.path': path,
    })
    const response = await handle(request, env, path)
    span?.setAttribute('http.response.status_code', response.status)
    return response
  })
}

async function handle(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  try {
    // The provider, and the accounts that decide who may use it.
    const keys = accountKeys(env, request)
    const configured = Boolean(
      env.OPENAI_API_KEY &&
      keys.secretKey &&
      String(env.TOUR_GUIDE_ENABLED) !== 'false',
    )
    if (path === GUIDE_VERDICT_PATH && request.method === 'GET') {
      const access = configured ? await guideAccess(request, keys) : null
      return tourJson(
        (access === null
          ? { granted: false, reason: 'unavailable' }
          : !access.signedIn
            ? { granted: false, reason: 'signed-out' }
            : !access.authorized
              ? { granted: false, reason: 'not-granted' }
              : { granted: true, voices: GUIDE_VOICES }) satisfies GuideVerdict,
      )
    }
    if (!allowedOrigin(request))
      throw new TourHttpError('Use the guide from this site.', 403)
    if (!configured)
      throw new TourHttpError(GUIDE_REFUSAL_SENTENCES.unavailable, 503)
    const access = await guideAccess(request, keys)
    if (!access.signedIn)
      throw new TourHttpError(GUIDE_REFUSAL_SENTENCES['signed-out'], 401)
    if (!access.authorized)
      throw new TourHttpError(GUIDE_REFUSAL_SENTENCES['not-granted'], 403)
    if (path === GUIDE_SESSIONS_PATH && request.method === 'POST') {
      /*
       * Per account, after the grant: a session is minutes of the OpenAI
       * project's budget, and a granted account's token in a script is the
       * one caller that clears every check above. A person starting, pausing
       * and restarting the guide stays far inside it.
       */
      if (
        access.userId !== null &&
        !(await allowed(env.GUIDE_SESSION_LIMIT, access.userId))
      )
        throw new TourHttpError(
          'Too many guide sessions. Try again in a minute.',
          429,
        )
      const input = record(await readJson(request, 80_000), [
        'voice',
        'sdp',
        'scene',
      ])
      if (!isGuideVoice(input.voice))
        throw new TourHttpError('Choose an available voice.')
      // The protocol's decoder, and its limits in bytes — the unit the
      // provider counts in, and the one the browser's opening line is held to.
      const decoded = decode(decodeGuideSessionRequest, input)
      if (!decoded.ok)
        throw new TourHttpError('A text field is outside its limits.')
      const created = await createLiveSession({
        apiKey: env.OPENAI_API_KEY,
        ...decoded.value,
      })
      log('info', 'session created', {
        sessionId: created.id,
        voice: input.voice,
        expiresAt: created.expiresAt,
      })
      return tourJson({
        sessionId: created.id,
        expiresAt: created.expiresAt,
        sdp: created.sdp,
      } satisfies GuideSessionCreated)
    }
    throw new TourHttpError('No such guide endpoint.', 404)
  } catch (error) {
    if (error instanceof TourHttpError) {
      // A refused request is the visitor's problem at 4xx and the
      // deployment's at 503, and the level says which.
      log(error.status >= 500 ? 'error' : 'warn', 'request refused', {
        path,
        status: error.status,
        reason: error.message,
      })
      return tourJson(
        { error: error.message } satisfies GuideError,
        error.status,
        error.status === 429 ? { 'retry-after': RETRY_AFTER } : undefined,
      )
    }
    if (error instanceof AccountUnavailableError) {
      // Logged with its reason by the account module.
      return tourJson(
        { error: GUIDE_REFUSAL_SENTENCES.unavailable } satisfies GuideError,
        503,
      )
    }
    if (error instanceof GuideProviderError) {
      log('error', 'provider refused the session', {
        path,
        code: error.code,
        ...error.detail,
      })
      return tourJson({ error: 'The guide could not start a session.' }, 503)
    }
    log('error', 'request failed', {
      path,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    return tourJson(
      { error: 'The guide could not complete this request.' },
      503,
    )
  }
}
