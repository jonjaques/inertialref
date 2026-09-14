import { GUIDE_VOICES, isGuideVoice } from '@inertialref/protocol'
import {
  allowedOrigin,
  authenticate,
  digest,
  loginCookie,
  passwordMatches,
} from './auth.ts'
import {
  boundedString,
  readJson,
  record,
  TourHttpError,
  tourJson,
} from './http.ts'
import { log, span } from './log.ts'
import { createLiveSession, GuideProviderError } from './openaiLive.ts'

/*
 * The guide's Worker: two stateless routes and a capability report.
 *
 * The Worker holds the alpha password and the provider key, and nothing else.
 * It does not see the conversation, the scene, a tool call, or a usage event:
 * the browser owns the session through its own peer connection, executes
 * every tool against the observatory it already has, and reads the provider's
 * usage off the data channel. Without a sideband the Worker cannot meter a
 * session, so there is no per-user ledger — a browser's report of its own
 * spend would be advisory. The spending bound is the OpenAI project's limit
 * and the duration bound is the provider's own session expiry.
 *
 * What a tampered browser can abuse is therefore two things, and both are
 * enforced here: only a request carrying the signed cookie can create a
 * session, and the session's configuration — prompts, tools, model, the
 * data-channel allow list — is authored at creation and cannot be changed
 * afterward.
 */

/** Sign-in attempts per source per minute, when the binding is present. */
const LOGIN_LIMIT_KEY = 'tour-login'

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
    const configured = Boolean(
      env.OPENAI_API_KEY &&
      env.TOUR_GUIDE_PASSWORD &&
      String(env.TOUR_GUIDE_ENABLED) !== 'false',
    )
    const user = await authenticate(
      request,
      env.TOUR_GUIDE_PASSWORD ?? '',
      Date.now(),
    )
    if (path === '/api/tour/capabilities' && request.method === 'GET')
      return tourJson({
        available: configured,
        authenticated: user !== null,
        voices: GUIDE_VOICES,
        reason: configured ? null : 'The guide is unavailable.',
      })
    if (!allowedOrigin(request))
      throw new TourHttpError('Use the guide from this site.', 403)
    if (!configured) throw new TourHttpError('The guide is unavailable.', 503)
    if (path === '/api/tour/login' && request.method === 'POST') {
      const input = record(await readJson(request, 2048), ['password'])
      const source = await digest(
        `${LOGIN_LIMIT_KEY}:${request.headers.get('cf-connecting-ip') ?? 'development'}`,
      )
      const limit = await env.TOUR_LOGIN_LIMIT?.limit({ key: source })
      if (limit !== undefined && !limit.success)
        throw new TourHttpError(
          'Too many sign-in attempts. Try again later.',
          429,
        )
      if (
        !(await passwordMatches(
          boundedString(input.password, 1024),
          env.TOUR_GUIDE_PASSWORD,
        ))
      )
        throw new TourHttpError('The guide password is incorrect.', 401)
      return tourJson({ authenticated: true }, 200, {
        'set-cookie': await loginCookie(
          env.TOUR_GUIDE_PASSWORD,
          new URL(request.url).origin,
          Date.now(),
        ),
      })
    }
    if (!user) throw new TourHttpError('Enter the guide password first.', 401)
    if (path === '/api/tour/sessions' && request.method === 'POST') {
      const input = record(await readJson(request, 80_000), [
        'voice',
        'sdp',
        'scene',
      ])
      if (!isGuideVoice(input.voice))
        throw new TourHttpError('Choose an available voice.')
      const created = await createLiveSession({
        apiKey: env.OPENAI_API_KEY,
        sdp: boundedString(input.sdp, 65_536),
        voice: input.voice,
        scene: boundedString(input.scene, 1500),
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
      })
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
      return tourJson({ error: error.message }, error.status)
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
