import {
  validateTourPlan,
  versionDrift,
  type NarrationBrief,
  type ToolRequest,
  type ToolReceipt,
  type TourAction,
  type TourClientMessage,
  type TourCommand,
  type TourContext,
  type TourManifest,
  type TourPlan,
  type TourServerMessage,
} from '@inertialref/protocol'
import {
  commitSpend,
  reserveSpend,
  TOUR_POLICY,
  type SessionBudget,
} from './policy.ts'

export interface DirectorDecision {
  readonly kind: 'explanation' | 'clarification' | 'plan' | 'actions'
  readonly text: string
  readonly factIds: readonly string[]
  readonly plan: TourPlan | null
  readonly actions: readonly TourAction[]
  readonly rounds?: number
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
  }
}

export interface OperationRecord {
  readonly request: ToolRequest
  readonly receipt: ToolReceipt | null
}

export interface SessionRecord {
  readonly sessionId: string
  readonly user: string
  readonly tabId: string
  readonly manifest: TourManifest
  readonly fingerprint: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly requestRevision: number
  readonly state: 'creating' | 'open' | 'closing' | 'closed'
  readonly transport: 'text' | 'live'
  readonly providerId: string | null
  readonly budget: SessionBudget
  readonly operations: readonly OperationRecord[]
  readonly disconnectAt: number | null
  readonly liveSeconds: number
  readonly finalized: boolean
}

export function newSessionRecord(input: {
  sessionId: string
  user: string
  tabId: string
  now: number
  transport: 'text' | 'live'
  manifest: TourManifest
  fingerprint: string
}): SessionRecord {
  return {
    sessionId: input.sessionId,
    user: input.user,
    tabId: input.tabId,
    manifest: input.manifest,
    fingerprint: input.fingerprint,
    createdAt: input.now,
    expiresAt: input.now + TOUR_POLICY.sessionMs,
    requestRevision: 0,
    state: 'open',
    transport: input.transport,
    providerId: null,
    budget: {
      limit: TOUR_POLICY.sessionLimit,
      spent: 0,
      reserved: input.transport === 'live' ? TOUR_POLICY.liveReservation : 0,
      calls: 0,
    },
    operations: [],
    disconnectAt: null,
    liveSeconds: 0,
    finalized: false,
  }
}

export interface CoordinatorPorts {
  readonly now: () => number
  readonly id: () => string
  readonly send: (message: TourServerMessage) => void
  readonly persist: (record: SessionRecord) => Promise<void>
  readonly director: (
    text: string,
    context: TourContext,
    signal: AbortSignal,
    maxRounds: 1 | 2,
    priorGoal?: string,
  ) => Promise<DirectorDecision>
  readonly preset?: (text: string, context: TourContext) => TourPlan | null
  readonly narrate: (
    brief: NarrationBrief,
    delegationId: string | null,
  ) => Promise<void>
  readonly close: () => Promise<void>
}

/** One request revision owns model work; context and audio remain ephemeral. */
export class TourCoordinator {
  #record: SessionRecord
  #context: TourContext | null
  readonly #ports: CoordinatorPorts
  #abort: AbortController | null = null
  #queue: TourAction[] = []
  #facts: readonly string[] = []
  #answer = ''
  #narrations = new Map<string, NarrationBrief>()
  #spoken = new Set<string>()
  #narrated = new Set<string>()
  #delegations = new Set<string>()
  #delegationId: string | null = null
  #lastAsk = -1
  #writes: Promise<void> = Promise.resolve()
  #paused = false
  #requestStarted = 0
  #rounds = 0
  #tools = 0
  #lastText = ''
  #plan: TourPlan | null = null
  #currentStopId: string | null = null

  constructor(
    record: SessionRecord,
    context: TourContext | null,
    ports: CoordinatorPorts,
  ) {
    this.#record = record
    this.#context = context
    this.#ports = ports
  }
  get record(): SessionRecord {
    return this.#record
  }
  get context(): TourContext | null {
    return this.#context
  }

  async receive(message: TourClientMessage): Promise<void> {
    if (this.#record.state !== 'open') return
    if (this.#ports.now() >= this.#record.expiresAt) {
      await this.end()
      return
    }
    switch (message.type) {
      case 'context': {
        const next = message.context
        if (
          !sameManifest(this.#record.manifest, next.manifest) ||
          next.viewRevision < (this.#context?.viewRevision ?? 0)
        )
          return
        if (!validContext(next)) {
          this.#error('context', 'The scene context is inconsistent.')
          return
        }
        if (this.#context && this.#context.viewRevision !== next.viewRevision)
          this.#abort?.abort()
        this.#context = next
        return
      }
      case 'ask':
        if (
          message.requestRevision <= this.#lastAsk ||
          !this.#currentView(message.viewRevision) ||
          message.requestRevision < this.#record.requestRevision
        )
          return
        this.#lastAsk = message.requestRevision
        this.#supersede(message.requestRevision)
        this.#paused = false
        await this.#ask(message.text)
        return
      case 'command':
        if (message.requestRevision < this.#record.requestRevision) return
        this.#supersede(message.requestRevision)
        this.#paused = message.command === 'pause' || message.command === 'end'
        await this.#save()
        if (message.command === 'end') await this.end()
        return
      case 'receipt':
        await this.#receipt(message.receipt)
        return
      case 'narration-ready':
        if (
          message.requestRevision === this.#record.requestRevision &&
          this.#currentView(message.viewRevision) &&
          !this.#paused
        )
          await this.#narration(message.stopId)
        return
      case 'narration-ended':
      case 'live-startup':
        return
    }
  }

  async delegate(id: string, text: string): Promise<void> {
    if (
      this.#record.state !== 'open' ||
      this.#delegations.has(id) ||
      this.#delegations.size >= 32 ||
      !this.#context
    )
      return
    this.#delegations.add(id)
    this.#supersede(this.#record.requestRevision + 1)
    this.#delegationId = id
    this.#paused = false
    this.#ports.send({
      type: 'ready',
      sessionId: this.#record.sessionId,
      requestRevision: this.#record.requestRevision,
    })
    const command = spokenCommand(text)
    if (command !== null) {
      const requestRevision = this.#record.requestRevision
      this.#paused = command === 'pause' || command === 'end'
      await this.#save()
      if (
        requestRevision !== this.#record.requestRevision ||
        this.#record.state !== 'open'
      )
        return
      this.#ports.send({
        type: 'control',
        command,
        requestRevision,
      })
      return
    }
    this.pauseForSpeech()
    this.#ports.send({
      type: 'status',
      state: 'planning',
      message: 'The guide is considering your request.',
    })
    await this.#ask(text)
  }

  pauseForSpeech(): void {
    if (this.#record.state !== 'open') return
    this.#ports.send({
      type: 'status',
      state: 'paused',
      message: 'Listening. The tour is paused.',
    })
  }

  async reserveSpeech(id: string): Promise<NarrationBrief | null> {
    const brief = this.#narrations.get(id)
    if (
      !brief ||
      this.#spoken.has(id) ||
      this.#record.state !== 'open' ||
      this.#paused ||
      this.#ports.now() >= this.#record.expiresAt ||
      brief.requestRevision !== this.#record.requestRevision ||
      !this.#currentView(brief.viewRevision)
    )
      return null
    const budget = reserveSpend(
      this.#record.budget,
      TOUR_POLICY.speechReservation,
    )
    if (!budget) {
      this.#error('budget', 'The guide has reached its spending allowance.')
      return null
    }
    this.#spoken.add(id)
    this.#record = { ...this.#record, budget }
    await this.#save()
    return brief
  }

  async speechFinished(): Promise<void> {
    this.#record = {
      ...this.#record,
      budget: commitSpend(this.#record.budget, TOUR_POLICY.speechReservation),
    }
    await this.#save()
  }

  async setProvider(id: string): Promise<void> {
    this.#record = { ...this.#record, providerId: id }
    await this.#save()
  }
  async setConnection(connected: boolean): Promise<void> {
    if (!connected) {
      this.#supersede(this.#record.requestRevision + 1)
      this.#paused = true
    }
    this.#record = {
      ...this.#record,
      disconnectAt: connected ? null : this.#ports.now(),
    }
    await this.#save()
  }
  async usage(seconds: number): Promise<void> {
    if (Number.isFinite(seconds) && seconds >= this.#record.liveSeconds) {
      this.#record = { ...this.#record, liveSeconds: seconds }
      await this.#save()
    }
  }
  async finalized(complete: boolean, seconds: number): Promise<void> {
    if (this.#record.finalized) return
    const liveSeconds = Math.max(this.#record.liveSeconds, seconds)
    const budget =
      complete && this.#record.transport === 'live'
        ? commitSpend(
            this.#record.budget,
            TOUR_POLICY.liveReservation,
            Math.ceil(
              (liveSeconds * TOUR_POLICY.liveMicroDollarsPerMinute) / 60,
            ),
          )
        : this.#record.budget
    this.#record = {
      ...this.#record,
      state: 'closed',
      finalized: complete,
      liveSeconds,
      budget,
    }
    await this.#save()
  }
  async end(): Promise<void> {
    if (this.#record.state === 'closed' || this.#record.state === 'closing')
      return
    this.#supersede(this.#record.requestRevision + 1)
    this.#record = { ...this.#record, state: 'closing' }
    this.#context = null
    this.#narrations.clear()
    await this.#save()
    this.#ports.send({ type: 'closed', reason: 'The guide session has ended.' })
    await this.#ports.close()
  }

  #supersede(revision: number): void {
    this.#abort?.abort()
    this.#abort = null
    this.#queue = []
    this.#facts = []
    this.#answer = ''
    this.#delegationId = null
    this.#record = { ...this.#record, requestRevision: revision }
    this.#narrations.clear()
    this.#requestStarted = this.#ports.now()
    this.#rounds = 0
    this.#tools = 0
  }

  async #ask(text: string): Promise<void> {
    const context = this.#context
    if (!context || !text.trim()) return
    const requestRevision = this.#record.requestRevision
    this.#lastText = text
    const preset = this.#ports.preset?.(text, context)
    if (preset) {
      await this.#publishPlan(preset, context, requestRevision)
      return
    }
    const remainingMs =
      TOUR_POLICY.directorDeadlineMs -
      (this.#ports.now() - this.#requestStarted)
    if (this.#rounds >= 3 || remainingMs <= 0) {
      this.#error(
        'deadline',
        'The guide reached this request’s limit. The search results remain available for another request.',
      )
      return
    }
    const maxRounds = this.#rounds >= 2 ? 1 : 2
    const reservation = (TOUR_POLICY.directorReservation / 2) * maxRounds
    let actual = reservation
    const budget = reserveSpend(this.#record.budget, reservation)
    if (!budget) {
      this.#error('budget', 'The guide has reached its spending allowance.')
      return
    }
    this.#record = { ...this.#record, budget }
    const abort = new AbortController()
    this.#abort = abort
    await this.#save()
    const deadline = setTimeout(() => abort.abort(), remainingMs)
    this.#ports.send({
      type: 'status',
      state: 'planning',
      message: 'Considering your request.',
    })
    try {
      if (abort.signal.aborted || this.#record.state !== 'open') return
      const decision = await this.#ports.director(
        text,
        context,
        abort.signal,
        maxRounds,
        priorPlan(this.#plan, context, this.#currentStopId),
      )
      if (decision.usage)
        actual = Math.ceil(
          decision.usage.inputTokens *
            TOUR_POLICY.directorInputMicroDollarsPerToken +
            decision.usage.outputTokens *
              TOUR_POLICY.directorOutputMicroDollarsPerToken,
        )
      if (
        abort.signal.aborted ||
        requestRevision !== this.#record.requestRevision ||
        !this.#currentView(context.viewRevision) ||
        this.#record.state !== 'open'
      )
        return
      this.#rounds += decision.rounds ?? maxRounds
      if (!validDecision(decision, context)) {
        this.#error(
          'decision',
          'The guide could not produce a supported answer.',
        )
        return
      }
      this.#facts = decision.factIds
      this.#answer = decision.text.trim()
      if (decision.kind === 'plan' && decision.plan) {
        await this.#publishPlan(decision.plan, context, requestRevision)
      } else if (decision.kind === 'actions') {
        this.#queue = [...decision.actions]
        await this.#dispatch()
      } else if (decision.kind === 'clarification') {
        this.#ports.send({
          type: 'status',
          state: 'awaiting-next',
          message: decision.text,
        })
        await this.#ports.narrate(
          {
            id: this.#ports.id(),
            requestRevision,
            stopId: null,
            viewRevision: context.viewRevision,
            subjectId: context.subjectId,
            text: decision.text,
            factIds: [],
            sourceIds: [],
            sources: [],
            origin: 'model',
          },
          this.#delegationId,
        )
      } else await this.#narration(null)
    } catch {
      if (requestRevision === this.#record.requestRevision)
        this.#error(
          'director',
          abort.signal.aborted
            ? 'The guide reached the request deadline. Try a shorter request.'
            : 'The guide could not finish this request. Your view is unchanged.',
        )
    } finally {
      clearTimeout(deadline)
      if (this.#abort === abort) this.#abort = null
      this.#record = {
        ...this.#record,
        budget: commitSpend(this.#record.budget, reservation, actual),
      }
      await this.#save()
    }
  }

  async #publishPlan(
    plan: TourPlan,
    context: TourContext,
    requestRevision: number,
  ): Promise<void> {
    if (
      !validateTourPlan(plan, context).ok ||
      plan.stops.some(
        (stop) =>
          new TextEncoder().encode(stop.narration ?? '').byteLength > 2000,
      )
    ) {
      this.#error('plan', 'The guide could not prepare a supported tour.')
      return
    }
    this.#plan = plan
    this.#currentStopId = null
    await this.#save()
    if (
      requestRevision !== this.#record.requestRevision ||
      this.#record.state !== 'open'
    )
      return
    this.#ports.send({
      type: 'plan',
      plan: {
        ...plan,
        stops: plan.stops.map((stop) => ({
          ...stop,
          factIds: stop.factIds.filter((id) => !id.includes(':note:')),
        })),
      },
      requestRevision,
    })
  }

  async #dispatch(): Promise<void> {
    if (!this.#context || this.#paused || this.#record.state !== 'open') return
    const action = this.#queue.shift()
    if (!action) {
      await this.#narration(null)
      return
    }
    if (this.#record.operations.length >= 64 || this.#tools >= 6) {
      this.#error('operations', 'The guide has reached its action limit.')
      return
    }
    this.#tools++
    const request: ToolRequest = {
      sessionId: this.#record.sessionId,
      requestRevision: this.#record.requestRevision,
      operationId: this.#ports.id(),
      expectedViewRevision: this.#context.viewRevision,
      expiresAt: Math.min(this.#record.expiresAt, this.#ports.now() + 20_000),
      action,
    }
    this.#record = {
      ...this.#record,
      operations: [...this.#record.operations, { request, receipt: null }],
    }
    await this.#save()
    if (
      request.requestRevision === this.#record.requestRevision &&
      this.#record.state === 'open'
    )
      this.#ports.send({ type: 'tool', request })
  }

  async #receipt(receipt: ToolReceipt): Promise<void> {
    const entry = this.#record.operations.find(
      (operation) => operation.request.operationId === receipt.operationId,
    )
    if (
      !entry ||
      receipt.requestRevision !== this.#record.requestRevision ||
      entry.request.requestRevision !== receipt.requestRevision ||
      entry.request.expiresAt <= this.#ports.now()
    )
      return
    if (entry.receipt && entry.receipt.status !== 'accepted') return
    if (
      receipt.status === 'arrived' &&
      'subjectId' in entry.request.action &&
      entry.request.action.tool !== 'read_subject' &&
      receipt.subjectId !== entry.request.action.subjectId
    )
      return
    this.#record = {
      ...this.#record,
      operations: this.#record.operations.map((operation) =>
        operation === entry ? { ...entry, receipt } : operation,
      ),
    }
    await this.#save()
    if (receipt.status === 'arrived') {
      if (
        !this.#currentView(receipt.viewRevision) ||
        this.#context?.subjectId !== receipt.subjectId
      )
        return
      if (
        entry.request.action.tool === 'resolve_subject' ||
        entry.request.action.tool === 'find_worlds' ||
        entry.request.action.tool === 'read_subject'
      )
        await this.#ask(this.#lastText)
      else await this.#dispatch()
    } else if (receipt.status !== 'accepted') {
      this.#queue = []
      this.#error('action', receipt.reason ?? 'The view could not be reached.')
    }
  }

  async #narration(stopId: string | null): Promise<void> {
    const context = this.#context
    const brief = context?.brief
    const stop =
      stopId === null
        ? undefined
        : this.#plan?.stops.find((item) => item.id === stopId)
    if (
      !context ||
      !brief ||
      context.traveling ||
      !brief.observer.arrived ||
      brief.subjectId !== context.subjectId ||
      brief.observer.pictureTime !== context.pictureTime ||
      (stopId !== null && this.#plan !== null && !stop) ||
      (stop !== undefined && stop.subjectId !== context.subjectId)
    )
      return
    if (stop) this.#currentStopId = stop.id
    const key = `${this.#record.requestRevision}/${context.viewRevision}/${stopId ?? 'answer'}`
    if (this.#narrated.has(key)) return
    const selected = stopId === null ? this.#facts : (stop?.factIds ?? [])
    const prose = (
      stopId === null ? this.#answer : (stop?.narration ?? '')
    ).trim()
    const quiet = stop !== undefined && selected.length === 0 && !prose
    const recordBriefs =
      selected.length === 0
        ? [brief]
        : [
            brief,
            ...context.briefs.filter(
              (item) => item.subjectId !== brief.subjectId,
            ),
          ]
    const available =
      quiet || (prose && selected.length === 0)
        ? []
        : recordBriefs
            .flatMap((item) =>
              item.facts
                .filter(
                  (fact) =>
                    (selected.length === 0 || selected.includes(fact.id)) &&
                    (prose ||
                      (fact.quantity !== null &&
                        fact.sourceIds.every((id) =>
                          item.sources.some(
                            (source) =>
                              source.id === id &&
                              source.origin === 'application',
                          ),
                        ))),
                )
                .map((fact) => ({
                  fact,
                  subject: item.name,
                  subjectId: item.subjectId,
                  provenance: item.provenance,
                })),
            )
            .slice(0, prose ? 12 : selected.length === 0 ? 2 : 5)
    const first = available[0] ?? {
      subject: brief.name,
      subjectId: brief.subjectId,
      provenance: brief.provenance,
    }
    let description = [
      first.subject + '.',
      first.provenance === 'projected'
        ? 'This is a projected world. Its properties are inferred.'
        : '',
    ]
      .filter(Boolean)
      .join(' ')
    const facts = []
    let subjectId = first.subjectId
    for (const item of available) {
      const sentence = [
        item.subjectId === subjectId ? '' : `${item.subject}.`,
        item.subjectId !== subjectId && item.provenance === 'projected'
          ? 'This is a projected world. Its properties are inferred.'
          : '',
        item.fact.speech ??
          `${item.fact.label} is unknown. ${item.fact.reason ?? ''}`,
      ]
        .filter(Boolean)
        .join(' ')
      const next = `${description} ${sentence}`
      // Preserve complete factual sentences inside Live's conservative append
      // budget, and cite only the facts actually included in the narration.
      if (new TextEncoder().encode(next).byteLength > 2000) break
      description = next
      subjectId = item.subjectId
      facts.push(item.fact)
    }
    const usedFacts = prose ? available.map((item) => item.fact) : facts
    const sourceIds = [
      ...new Set([
        ...usedFacts.flatMap((fact) => fact.sourceIds),
        ...(prose ? (stop?.sources?.map((source) => source.id) ?? []) : []),
      ]),
    ]
    const narration: NarrationBrief = {
      id: this.#ports.id(),
      requestRevision: this.#record.requestRevision,
      stopId,
      viewRevision: context.viewRevision,
      subjectId: context.subjectId,
      text: prose || description,
      factIds: usedFacts.map((fact) => fact.id),
      sourceIds,
      sources: [
        ...new Map(
          [
            ...recordBriefs.flatMap((item) => item.sources),
            ...(prose ? (stop?.sources ?? []) : []),
          ]
            .filter((source) => sourceIds.includes(source.id))
            .map((source) => [source.id, source]),
        ).values(),
      ],
      origin: prose
        ? stop?.sources?.length
          ? 'authored'
          : 'model'
        : 'records',
      playback:
        stop !== undefined && this.#plan?.automatic ? 'controlled' : 'live',
    }
    this.#narrated.add(key)
    if (this.#narrated.size > 64)
      this.#narrated.delete(this.#narrated.values().next().value!)
    if (this.#narrations.size >= 16)
      this.#narrations.delete(this.#narrations.keys().next().value!)
    this.#narrations.set(narration.id, narration)
    this.#ports.send({ type: 'narration', brief: narration })
    await this.#ports.narrate(narration, this.#delegationId)
    if (stopId === null)
      this.#ports.send({ type: 'status', state: 'awaiting-next', message: '' })
  }

  #currentView(revision: number): boolean {
    return this.#context?.viewRevision === revision
  }
  #error(code: string, message: string): void {
    this.#ports.send({
      type: 'error',
      code,
      message,
      retryable: code !== 'budget',
    })
  }
  #save(): Promise<void> {
    const snapshot = this.#record
    this.#writes = this.#writes.then(() => this.#ports.persist(snapshot))
    return this.#writes
  }
}

export function sameManifest(a: TourManifest, b: TourManifest): boolean {
  return (
    a.seed === b.seed &&
    versionDrift(
      { catalog: a.catalogVersion, generation: a.generation },
      { catalog: b.catalogVersion, generation: b.generation },
    ).length === 0
  )
}

function validContext(context: TourContext): boolean {
  const ids = new Set(context.candidates.map((candidate) => candidate.id))
  if (ids.size !== context.candidates.length) return false
  return [context.brief, ...context.briefs].every(
    (brief) =>
      !brief ||
      (ids.has(brief.subjectId) &&
        context.candidates.some(
          (candidate) =>
            candidate.id === brief.subjectId &&
            candidate.address === brief.address,
        ) &&
        new Set(brief.facts.map((fact) => fact.id)).size ===
          brief.facts.length &&
        brief.sources.every(
          (source) => source.url === null || source.url.startsWith('https://'),
        )),
  )
}

function validDecision(
  decision: DirectorDecision,
  context: TourContext,
): boolean {
  if (
    decision.actions.length > 6 ||
    new TextEncoder().encode(decision.text).byteLength > 2000
  )
    return false
  const facts = new Set(
    [context.brief, ...context.briefs].flatMap(
      (brief) => brief?.facts.map((fact) => fact.id) ?? [],
    ),
  )
  if (!decision.factIds.every((id) => facts.has(id))) return false
  if (
    decision.kind === 'plan' &&
    (!decision.plan || !validateTourPlan(decision.plan, context).ok)
  )
    return false
  return decision.actions.every((action) => {
    if (
      action.tool === 'set_picture_time' ||
      action.tool === 'resolve_subject' ||
      action.tool === 'find_worlds'
    )
      return true
    const candidate = context.candidates.find(
      (one) => one.id === action.subjectId,
    )
    if (!candidate) return false
    if (action.tool === 'compose_view')
      return candidate.framings.includes(action.framingId)
    if (action.tool === 'stand_at_site')
      return candidate.sites.some((site) => site.id === action.siteId)
    return true
  })
}

function spokenCommand(text: string): TourCommand | null {
  const commands: Readonly<Record<string, TourCommand>> = {
    pause: 'pause',
    stop: 'pause',
    'pause tour': 'pause',
    resume: 'resume',
    'resume tour': 'resume',
    next: 'next',
    'next stop': 'next',
    back: 'back',
    'previous stop': 'back',
    end: 'end',
    'end tour': 'end',
  }
  return (
    commands[
      text
        .trim()
        .toLowerCase()
        .replace(/[.!?]+$/, '')
        .trim()
    ] ?? null
  )
}

function priorPlan(
  plan: TourPlan | null,
  context: TourContext,
  currentStopId: string | null,
): string | undefined {
  if (plan === null) return undefined
  return JSON.stringify({
    goal: plan.goal.slice(0, 240),
    durationSeconds: plan.durationSeconds,
    automatic: plan.automatic ?? false,
    currentStopId,
    stops: plan.stops.map((stop) => ({
      id: stop.id,
      subjectId: stop.subjectId,
      name: context.candidates.find((item) => item.id === stop.subjectId)?.name,
      objective: stop.objective.slice(0, 120),
      motion: stop.motion ?? 'hold',
      framingId: stop.framingId,
      siteId: stop.siteId,
    })),
  })
}
