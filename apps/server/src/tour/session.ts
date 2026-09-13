import { DurableObject } from 'cloudflare:workers'
import {
  decodeTourClientMessage,
  decodeTourMessage,
  type TourClientMessage,
  type TourServerMessage,
} from '@inertialref/protocol'
import {
  TourCoordinator,
  newSessionRecord,
  type SessionRecord,
} from './coordinator.ts'
import { interpretTourRequest } from './director.ts'
import {
  boundedString,
  readJson,
  record,
  tourJson,
  TourHttpError,
} from './http.ts'
import { withAstronomyNotes } from './knowledge/astronomy.ts'
import {
  attachLiveSession,
  createLiveSession,
  hangupLiveSession,
  TranscriptAssembler,
  type LiveEvent,
  type LiveSideband,
} from './openaiLive.ts'
import { synthesizeSpeech } from './openaiResponses.ts'
import { TOUR_POLICY } from './policy.ts'
import type { TourCreation } from './routes.ts'

export class TourSession extends DurableObject<Env> {
  #coordinator: TourCoordinator | null = null
  #socket: WebSocket | null = null
  #sideband: LiveSideband | null = null
  #transcripts = new TranscriptAssembler()
  #transcriptIds = new Set<string>()
  #startup: Extract<TourClientMessage, { type: 'live-startup' }> | null = null
  #sdp: string | null = null
  #starting: Promise<Response> | null = null
  #finishing: Promise<void> | null = null
  #messages = 0
  #messageWindow = 0
  #creationFailed = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<SessionRecord>('session')
      if (stored) {
        this.#coordinator = this.#makeCoordinator(stored, null)
        this.#creationFailed = stored.state === 'creating'
      }
    })
  }

  begin(
    creation: TourCreation,
    user: string,
    sessionId: string,
    fingerprint: string,
  ): Promise<Response> {
    const held = this.#coordinator?.record
    if (
      held &&
      (held.user !== user ||
        held.tabId !== creation.tabId ||
        held.fingerprint !== fingerprint)
    )
      return Promise.resolve(
        tourJson(
          { error: 'This creation key belongs to another request.' },
          409,
        ),
      )
    if (this.#starting)
      return this.#starting.then((response) => response.clone())
    if (held) {
      if (
        held.state !== 'open' ||
        held.expiresAt <= Date.now() ||
        (held.transport === 'live' && this.#sdp === null)
      )
        return Promise.resolve(
          tourJson(
            {
              error:
                'This session cannot be created again. End it before starting another.',
            },
            409,
          ),
        )
      return Promise.resolve(this.#created())
    }
    this.#starting = this.#begin(
      creation,
      user,
      sessionId,
      fingerprint,
    ).finally(() => {
      this.#starting = null
    })
    return this.#starting.then((response) => response.clone())
  }

  async #begin(
    creation: TourCreation,
    user: string,
    sessionId: string,
    fingerprint: string,
  ): Promise<Response> {
    const now = Date.now()
    const initial = {
      ...newSessionRecord({
        sessionId,
        user,
        tabId: creation.tabId,
        now,
        transport: creation.transport,
        manifest: creation.manifest,
        fingerprint,
      }),
      state: 'creating' as const,
      disconnectAt: now,
    }
    await this.ctx.storage.put('session', initial)
    await this.ctx.storage.setAlarm(now + TOUR_POLICY.reconnectMs)
    this.#coordinator = this.#makeCoordinator(
      { ...initial, state: 'open' },
      withAstronomyNotes(creation.context),
    )
    try {
      if (creation.transport === 'live' && creation.sdp !== null) {
        const live = await createLiveSession({
          apiKey: this.env.OPENAI_API_KEY,
          sdp: creation.sdp,
          voice: creation.voice,
        })
        await this.#coordinator.setProvider(live.id)
        this.#sideband = await attachLiveSession({
          apiKey: this.env.OPENAI_API_KEY,
          id: live.id,
          onEvent: (event) => this.#onLive(event),
        })
        this.#sdp = live.sdp
      }
      await this.ctx.storage.put('session', this.#coordinator.record)
      return this.#created()
    } catch {
      this.#creationFailed = true
      await this.#coordinator.end()
      return tourJson(
        {
          error:
            'The guide could not connect. Use a local tour or start a text session.',
        },
        503,
      )
    }
  }

  #created(): Response {
    const held = this.#coordinator!.record
    return tourJson(
      {
        sessionId: held.sessionId,
        expiresAt: held.expiresAt,
        transport: held.transport,
        sdp: this.#sdp,
      },
      201,
    )
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const coordinator = this.#coordinator
      if (
        !coordinator ||
        request.headers.get('x-tour-owner') !== coordinator.record.user
      )
        return tourJson({ error: 'No such guide session.' }, 404)
      const url = new URL(request.url)
      if (url.pathname.endsWith('/close') && request.method === 'POST') {
        record(await readJson(request, 128), [])
        await coordinator.end()
        return tourJson({
          closed: coordinator.record.state === 'closed',
          finalized: coordinator.record.finalized,
        })
      }
      if (
        coordinator.record.expiresAt <= Date.now() ||
        coordinator.record.state !== 'open'
      )
        return tourJson({ error: 'The guide session has ended.' }, 410)
      if (url.pathname.endsWith('/status') && request.method === 'GET') {
        const held = coordinator.record
        return tourJson({
          state: held.state,
          expiresAt: held.expiresAt,
          requestRevision: held.requestRevision,
          operations: held.operations.map((row) => ({
            operationId: row.request.operationId,
            status: row.receipt?.status ?? 'pending',
          })),
          budget: held.budget,
          liveSeconds: held.liveSeconds,
          finalized: held.finalized,
        })
      }
      if (
        url.pathname.endsWith('/events') &&
        request.method === 'GET' &&
        request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ) {
        if (
          url.searchParams.get('tabId') !== coordinator.record.tabId ||
          this.#socket
        )
          return tourJson(
            { error: 'This session already has a controlling tab.' },
            409,
          )
        if (coordinator.record.transport === 'live' && !this.#sideband) {
          if (!coordinator.record.providerId)
            return tourJson({ error: 'Voice connection is unavailable.' }, 503)
          this.#sideband = await attachLiveSession({
            apiKey: this.env.OPENAI_API_KEY,
            id: coordinator.record.providerId,
            onEvent: (event) => this.#onLive(event),
          })
        }
        const pair = new WebSocketPair()
        const socket = pair[1]
        this.#socket = socket
        socket.addEventListener('message', (event) => {
          if (this.#socket !== socket) return
          const now = Date.now()
          if (now - this.#messageWindow >= 60_000) {
            this.#messages = 0
            this.#messageWindow = now
          }
          if (++this.#messages > 180 || typeof event.data !== 'string') {
            socket.close(1008, 'Message limit')
            return
          }
          const parsed = decodeTourMessage(decodeTourClientMessage, event.data)
          if (!parsed.ok) {
            socket.close(1008, 'Invalid tour message')
            return
          }
          this.ctx.waitUntil(
            this.#receive(parsed.value).catch(() => this.#fail()),
          )
        })
        const lost = () => {
          if (this.#socket !== socket) return
          this.#socket = null
          this.ctx.waitUntil(
            coordinator
              .setConnection(false)
              .then(() =>
                this.ctx.storage.setAlarm(
                  Math.min(
                    coordinator.record.expiresAt,
                    Date.now() + TOUR_POLICY.reconnectMs,
                  ),
                ),
              ),
          )
        }
        socket.addEventListener('close', lost)
        socket.addEventListener('error', lost)
        socket.accept()
        await coordinator.setConnection(true)
        await this.ctx.storage.setAlarm(coordinator.record.expiresAt)
        this.#send({
          type: 'ready',
          sessionId: coordinator.record.sessionId,
          requestRevision: coordinator.record.requestRevision,
        })
        return new Response(null, {
          status: 101,
          webSocket: pair[0],
          headers: { 'cache-control': 'no-store' },
        })
      }
      if (url.pathname.endsWith('/speech') && request.method === 'POST') {
        const data = record(await readJson(request, 1024), ['narrationId'])
        const brief = await coordinator.reserveSpeech(
          boundedString(data.narrationId, 160),
        )
        if (!brief)
          return tourJson(
            {
              error:
                'This narration is stale, already played, or outside the allowance.',
            },
            409,
          )
        try {
          const bytes = await synthesizeSpeech({
            apiKey: this.env.OPENAI_API_KEY,
            text: brief.text,
          })
          if (
            coordinator.record.state !== 'open' ||
            coordinator.record.requestRevision !== brief.requestRevision ||
            coordinator.context?.viewRevision !== brief.viewRevision
          )
            return tourJson(
              { error: 'The view changed during narration.' },
              409,
            )
          return new Response(bytes, {
            headers: {
              'content-type': 'audio/mpeg',
              'cache-control': 'no-store',
            },
          })
        } finally {
          await coordinator.speechFinished()
        }
      }
      return tourJson({ error: 'No such guide operation.' }, 405)
    } catch (error) {
      return tourJson(
        {
          error:
            error instanceof TourHttpError
              ? error.message
              : 'The guide connection failed.',
        },
        error instanceof TourHttpError ? error.status : 503,
      )
    }
  }

  async #receive(message: TourClientMessage): Promise<void> {
    if (message.type === 'context')
      message = { ...message, context: withAstronomyNotes(message.context) }
    if (message.type === 'live-startup') {
      if (this.#startup || this.#coordinator?.record.transport !== 'live')
        return
      this.#startup = message
      for (const event of message.events)
        this.#transcripts.add({
          type: 'transcript',
          id: event.eventId,
          speaker: event.speaker === 'visitor' ? 'user' : 'guide',
          delta: event.text,
          startMs: event.startMs,
          endMs: event.endMs,
        })
      return
    }
    await this.#coordinator?.receive(message)
  }

  #makeCoordinator(
    held: SessionRecord,
    context: Parameters<typeof withAstronomyNotes>[0] | null,
  ): TourCoordinator {
    return new TourCoordinator(held, context, {
      now: Date.now,
      id: () => crypto.randomUUID(),
      send: (message) => this.#send(message),
      persist: (snapshot) => this.ctx.storage.put('session', snapshot),
      director: async (text, view, signal, maxRounds) => {
        const result = await interpretTourRequest({
          apiKey: this.env.OPENAI_API_KEY,
          text,
          context: view,
          signal,
          maxRounds,
        })
        return result
      },
      narrate: async (brief, delegationId) => {
        this.#sideband?.append('commentary', brief.text, delegationId)
      },
      close: () => this.#finish(),
    })
  }

  #send(message: TourServerMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN)
      this.#socket.send(JSON.stringify(message))
  }

  #onLive(event: LiveEvent): void {
    if (event.type === 'transcript') {
      this.#transcripts.add(event)
      if (this.#transcriptIds.has(event.id)) return
      this.#transcriptIds.add(event.id)
      if (this.#transcriptIds.size > 256)
        this.#transcriptIds.delete(this.#transcriptIds.values().next().value!)
      if (event.speaker === 'user') this.#coordinator?.pauseForSpeech()
      this.#send({
        type: 'transcript',
        eventId: event.id,
        speaker: event.speaker === 'user' ? 'visitor' : 'guide',
        text: event.delta,
        startMs: event.startMs,
        endMs: event.endMs,
      })
    } else if (event.type === 'delegation') {
      this.ctx.waitUntil(
        this.#transcripts
          .request(event)
          .then(async (request) => {
            if (request?.text.trim())
              await this.#coordinator?.delegate(request.id, request.text)
            else
              this.#sideband?.append(
                'commentary',
                'Please repeat or type the request so I can be sure what you mean.',
                event.id,
              )
          })
          .catch(() => this.#fail()),
      )
    } else if (event.type === 'usage' || event.type === 'closed') {
      this.ctx.waitUntil(
        this.#coordinator?.usage(event.seconds) ?? Promise.resolve(),
      )
      if (event.type === 'closed' && this.#coordinator?.record.state === 'open')
        this.ctx.waitUntil(this.#coordinator.end())
    } else if (
      event.type === 'error' &&
      this.#coordinator?.record.state === 'open'
    )
      this.ctx.waitUntil(this.#coordinator.end())
  }

  #finish(): Promise<void> {
    this.#finishing ??= this.#finalize()
    return this.#finishing
  }
  async #finalize(): Promise<void> {
    const coordinator = this.#coordinator
    if (!coordinator) return
    const socket = this.#socket
    this.#socket = null
    socket?.close(1000, 'Guide ended')
    let complete = coordinator.record.transport === 'text'
    let seconds = coordinator.record.liveSeconds
    let revoked = coordinator.record.transport === 'text'
    if (!this.#sideband && coordinator.record.providerId) {
      try {
        this.#sideband = await attachLiveSession({
          apiKey: this.env.OPENAI_API_KEY,
          id: coordinator.record.providerId,
          onEvent: (event) => this.#onLive(event),
        })
      } catch {
        /* The lease alarm retries uncertain finalization. */
      }
    }
    if (this.#sideband) {
      const final = await this.#sideband.close(TOUR_POLICY.finalizeMs)
      complete = final.finalized
      revoked = complete
      seconds = Math.max(seconds, final.seconds)
      this.#sideband.disconnect()
      this.#sideband = null
    }
    if (!revoked && coordinator.record.providerId) {
      try {
        await hangupLiveSession({
          apiKey: this.env.OPENAI_API_KEY,
          id: coordinator.record.providerId,
        })
        revoked = true
      } catch {
        /* Retry from the stored provider identity. */
      }
    }
    await this.ctx.storage.put('provider-revoked', revoked)
    await coordinator.finalized(complete, seconds)
    const cost =
      complete && !this.#creationFailed
        ? coordinator.record.budget.spent + coordinator.record.budget.reserved
        : TOUR_POLICY.sessionLimit
    await this.env.TOUR_ADMISSION.getByName('private-alpha').settle(
      coordinator.record.sessionId,
      cost,
    )
    if (!revoked && coordinator.record.providerId)
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
    else await this.ctx.storage.deleteAlarm()
    this.#startup = null
    this.#transcripts = new TranscriptAssembler()
    this.#transcriptIds.clear()
  }
  async #fail(): Promise<void> {
    await this.#coordinator?.end()
  }

  async expire(): Promise<void> {
    await this.#coordinator?.end()
  }

  override async alarm(): Promise<void> {
    const coordinator = this.#coordinator
    if (!coordinator) return
    if (coordinator.record.state === 'closed') {
      if (
        !coordinator.record.finalized &&
        coordinator.record.providerId &&
        !(await this.ctx.storage.get<boolean>('provider-revoked'))
      ) {
        this.#finishing = null
        await this.#finish()
      }
      return
    }
    if (
      this.#creationFailed ||
      Date.now() >= coordinator.record.expiresAt ||
      (coordinator.record.disconnectAt !== null &&
        Date.now() >= coordinator.record.disconnectAt + TOUR_POLICY.reconnectMs)
    )
      await coordinator.end()
    else await this.ctx.storage.setAlarm(coordinator.record.expiresAt)
  }
}
