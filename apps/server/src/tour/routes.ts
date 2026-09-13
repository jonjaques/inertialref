import {
  decodeTourContext,
  decodeTourManifest,
  TOUR_PROTOCOL_VERSION,
  versionDrift,
  type TourContext,
  type TourManifest,
} from '@inertialref/protocol'
import { GENERATION_VERSIONS } from '@inertialref/universe'
import catalogManifest from '../../../../data/catalog/manifest.json' with { type: 'json' }
import {
  authenticate,
  allowedOrigin,
  digest,
  loginCookie,
  passwordMatches,
} from './auth.ts'
import { sameManifest } from './coordinator.ts'
import {
  boundedString,
  readJson,
  record,
  TourHttpError,
  tourJson,
} from './http.ts'
import { LIVE_VOICES, type LiveVoice } from './openaiLive.ts'

export interface TourCreation {
  readonly protocolVersion: number
  readonly manifest: TourManifest
  readonly context: TourContext
  readonly transport: 'text' | 'live'
  readonly voice: LiveVoice
  readonly sdp: string | null
  readonly idempotencyKey: string
  readonly tabId: string
}

export function decodeCreation(value: unknown): TourCreation {
  const data = record(value, [
    'protocolVersion',
    'manifest',
    'context',
    'transport',
    'voice',
    'sdp',
    'idempotencyKey',
    'tabId',
  ])
  const context = decodeTourContext(data.context, 'context')
  const manifest = decodeTourManifest(data.manifest, 'manifest')
  if (
    !context.ok ||
    !manifest.ok ||
    data.protocolVersion !== TOUR_PROTOCOL_VERSION ||
    !sameManifest(context.value.manifest, manifest.value)
  )
    throw new TourHttpError('The guide and scene versions do not agree.', 409)
  const drift = versionDrift(
    { generation: GENERATION_VERSIONS, catalog: catalogManifest.version },
    {
      generation: manifest.value.generation,
      catalog: manifest.value.catalogVersion,
    },
  )
  if (drift.length)
    throw new TourHttpError('Reload to use the current universe catalog.', 409)
  if (data.transport !== 'text' && data.transport !== 'live')
    throw new TourHttpError('Unknown tour transport.')
  if (!LIVE_VOICES.some((voice) => voice === data.voice))
    throw new TourHttpError('Choose an available voice.')
  const sdp = data.sdp === null ? null : boundedString(data.sdp, 65_536)
  if ((data.transport === 'live') !== (sdp !== null))
    throw new TourHttpError('The transport and audio offer do not agree.')
  return {
    protocolVersion: TOUR_PROTOCOL_VERSION,
    manifest: manifest.value,
    context: context.value,
    transport: data.transport,
    voice: data.voice as LiveVoice,
    sdp,
    idempotencyKey: boundedString(data.idempotencyKey, 128, 8),
    tabId: boundedString(data.tabId, 128, 8),
  }
}

export async function serveTour(request: Request, env: Env): Promise<Response> {
  try {
    const path = new URL(request.url).pathname
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
    if (path === '/api/tour/capabilities' && request.method === 'GET') {
      const features =
        configured && user
          ? await env.TOUR_ADMISSION.getByName('private-alpha').availability()
          : { text: configured, live: configured, controlledSpeech: configured }
      const available = configured && features.text
      return tourJson({
        available,
        authenticated: user !== null,
        voices: LIVE_VOICES,
        durationSeconds: 600,
        features: {
          text: features.text,
          live: features.live,
          controlledSpeech: features.controlledSpeech,
          images: false,
        },
        reason: available
          ? null
          : 'Cloud guide is unavailable. Local tours remain available.',
      })
    }
    if (!allowedOrigin(request))
      throw new TourHttpError('Use the guide from this site.', 403)
    if (!configured) throw new TourHttpError('Cloud guide is unavailable.', 503)
    const admission = env.TOUR_ADMISSION.getByName('private-alpha')
    if (path === '/api/tour/login' && request.method === 'POST') {
      const input = record(await readJson(request, 2048), ['password'])
      const identity = await digest(
        `${env.TOUR_GUIDE_PASSWORD}:${request.headers.get('cf-connecting-ip') ?? 'development'}`,
      )
      if (!(await admission.loginAttempt(identity)))
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
    if (path === '/api/tour/usage' && request.method === 'GET')
      return tourJson(await admission.report(user))
    if (path === '/api/tour/sessions' && request.method === 'POST') {
      const creation = decodeCreation(await readJson(request, 140_000))
      const reserved = await admission.reserve(
        user,
        creation.idempotencyKey,
        creation.tabId,
      )
      if (!reserved.ok)
        throw new TourHttpError(
          reserved.reason === 'concurrency'
            ? 'A guide is already open. End it before starting another.'
            : 'The guide allowance is unavailable. Use local tours or try again later.',
          429,
        )
      const fingerprint = await digest(JSON.stringify(creation))
      return env.TOUR_SESSIONS.getByName(reserved.reservation.sessionId).begin(
        creation,
        user,
        reserved.reservation.sessionId,
        fingerprint,
      )
    }
    const match =
      /^\/api\/tour\/sessions\/([a-f0-9-]{36})\/(events|close|speech|status)$/.exec(
        path,
      )
    if (!match) throw new TourHttpError('No such guide endpoint.', 404)
    const session = env.TOUR_SESSIONS.getByName(match[1]!)
    const headers = new Headers(request.headers)
    headers.set('x-tour-owner', user)
    return session.fetch(new Request(request, { headers }))
  } catch (error) {
    if (error instanceof TourHttpError)
      return tourJson({ error: error.message }, error.status)
    return tourJson(
      { error: 'The guide could not complete this request.' },
      503,
    )
  }
}
