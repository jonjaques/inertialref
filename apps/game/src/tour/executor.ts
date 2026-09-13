import {
  createTourContext,
  tourSubjectId,
  type GameHarness,
  type ObserverMotionRecipe,
} from '@inertialref/devtools'
import {
  decodeToolRequest,
  TOUR_LIMITS,
  type TourAction,
  type TourCameraMotion,
  type TourContext,
  type ToolReceipt,
  type ToolRequest,
} from '@inertialref/protocol'
import type { WorldQuery } from '@inertialref/universe'

export interface TourExecutorOptions {
  readonly sessionId: string
  /** Unix milliseconds for server-issued expiry. */
  readonly now: () => number
  readonly onReceipt: (receipt: ToolReceipt) => void
  readonly onTakeover?: () => void
  readonly active?: () => boolean
  readonly ready?: () => boolean
}
interface Operation {
  readonly fingerprint: string
  receipt: ToolReceipt
}

function motionRecipe(
  kind: TourCameraMotion,
  durationSeconds: number,
): ObserverMotionRecipe | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    throw new Error('Choose a finite camera motion duration.')
  const duration = Math.min(90, Math.max(12, durationSeconds))
  switch (kind) {
    case 'hold':
      return null
    case 'orbit':
      return {
        durationSeconds: duration,
        azimuthDelta: Math.PI / 6,
        elevationDelta: 0,
        distanceFactor: 1,
      }
    case 'push-in':
      return {
        durationSeconds: duration,
        azimuthDelta: 0,
        elevationDelta: 0,
        distanceFactor: 0.8,
      }
    case 'pull-back':
      return {
        durationSeconds: duration,
        azimuthDelta: 0,
        elevationDelta: 0,
        distanceFactor: 1.25,
      }
    case 'reveal':
      return {
        durationSeconds: duration,
        azimuthDelta: Math.PI / 4,
        elevationDelta: Math.PI / 24,
        distanceFactor: 1.15,
      }
    default:
      throw new Error('Unknown guide camera motion.')
  }
}

interface QueuedMotion {
  readonly recipe: ObserverMotionRecipe | null
}

export class TourExecutor {
  readonly #harness: GameHarness
  readonly #options: TourExecutorOptions
  readonly #operations = new Map<string, Operation>()
  readonly #initialTime: { held: number | null; paused: boolean; scale: number }
  #context: TourContext
  #pending: ToolRequest | null = null
  #requestRevision = 0
  #revokedRevision = -1
  #seenRevision: number
  #count = 0
  #disposed = false
  #timeOwned = false
  #motionOwned = false
  #queuedMotion: QueuedMotion | null = null
  #pendingMotion: QueuedMotion | null = null
  #query = ''
  #extraAddresses: readonly string[] = []
  #search: { request: ToolRequest; cancel: () => void } | null = null
  #searchDone: Promise<void> = Promise.resolve()
  #searchStatus = { systems: 0, progress: 0, total: 0, running: false }

  constructor(harness: GameHarness, options: TourExecutorOptions) {
    this.#harness = harness
    this.#options = options
    this.#context = createTourContext(harness)
    this.#seenRevision = this.viewRevision
    const eye = harness.observatory
    this.#initialTime = {
      held: eye.heldTime,
      paused: eye.timePaused,
      scale: eye.timeScale,
    }
  }
  get viewRevision(): number {
    return this.#harness.observatory.mutationRevision
  }
  get requestRevision(): number {
    return this.#requestRevision
  }

  /** Call after supersede and before execute; covers immediate arrivals too. */
  queueMotion(kind: TourCameraMotion, durationSeconds: number): void {
    const recipe = motionRecipe(kind, durationSeconds)
    this.poll()
    if (this.#pending !== null)
      throw new Error('Queue motion before starting a view operation.')
    if (this.#disposed || this.#requestRevision === this.#revokedRevision)
      return
    this.#queuedMotion = { recipe }
  }

  /** Start on an already-ready view; use the returned revision for narration. */
  startMotion(kind: TourCameraMotion, durationSeconds: number): number {
    const recipe = motionRecipe(kind, durationSeconds)
    this.poll()
    if (
      this.#disposed ||
      this.#options.active?.() === false ||
      this.#requestRevision === this.#revokedRevision ||
      this.#pending !== null ||
      this.#search !== null ||
      this.#harness.observatory.status().traveling ||
      this.#options.ready?.() === false
    )
      return this.viewRevision
    this.#beginMotion({ recipe })
    return this.viewRevision
  }

  /** Freeze only our finite gesture, including after its arrival was published. */
  stopMotion(): void {
    if (this.#motionOwned && this.viewRevision === this.#seenRevision) {
      this.#harness.observatory.stopMotion()
      this.#seenRevision = this.viewRevision
    }
    this.#motionOwned = false
  }

  #beginMotion(motion: QueuedMotion | null): void {
    if (motion === null) return
    this.stopMotion()
    if (motion.recipe !== null)
      this.#motionOwned = this.#harness.observatory.startMotion(motion.recipe)
    this.#seenRevision = this.viewRevision
  }

  get searchStatus(): Readonly<{
    systems: number
    progress: number
    total: number
    running: boolean
  }> {
    return this.#searchStatus
  }
  get searchDone(): Promise<void> {
    return this.#searchDone
  }
  context(query?: string): TourContext {
    this.poll()
    if (query !== undefined) this.#query = query
    this.#context = createTourContext(
      this.#harness,
      this.#query,
      this.#extraAddresses,
    )
    return this.#context
  }
  supersede(requestRevision: number): void {
    if (
      !Number.isSafeInteger(requestRevision) ||
      requestRevision <= this.#requestRevision
    )
      return
    this.poll()
    this.cancel('The request changed.')
    this.#requestRevision = requestRevision
    this.#count = 0
  }
  #receipt(
    request: ToolRequest,
    status: ToolReceipt['status'],
    reason: string | null,
  ): ToolReceipt {
    const eye = this.#harness.observatory
    return {
      operationId: request.operationId,
      requestRevision: request.requestRevision,
      status,
      viewRevision: this.viewRevision,
      pictureTime: eye.time,
      subjectId: eye.target === null ? null : tourSubjectId(eye.target.address),
      reason,
    }
  }
  #publish(receipt: ToolReceipt): ToolReceipt {
    const operation = this.#operations.get(receipt.operationId)
    if (operation !== undefined) operation.receipt = receipt
    this.#options.onReceipt(receipt)
    return receipt
  }
  execute(input: ToolRequest): ToolReceipt {
    this.poll()
    const parsed = decodeToolRequest(input, 'request')
    if (!parsed.ok)
      return this.#optionsReceipt(input, 'Invalid guide operation.')
    const request = parsed.value
    const fingerprint = JSON.stringify(request)
    const existing = this.#operations.get(request.operationId)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint)
        return this.#optionsReceipt(
          request,
          'Operation ID was reused with different arguments.',
        )
      this.#options.onReceipt(existing.receipt)
      return existing.receipt
    }
    const reject = (reason: string): ToolReceipt => {
      const receipt = this.#receipt(request, 'rejected', reason)
      if (this.#operations.size < 512)
        this.#operations.set(request.operationId, { fingerprint, receipt })
      return this.#publish(receipt)
    }
    if (this.#disposed || this.#options.active?.() === false)
      return reject('The guide is not active in this mode.')
    if (request.sessionId !== this.#options.sessionId)
      return reject('The operation belongs to another session.')
    if (request.requestRevision !== this.#requestRevision)
      return reject('The request has been superseded.')
    if (request.requestRevision === this.#revokedRevision)
      return reject('The request has been canceled.')
    if (request.expectedViewRevision !== this.viewRevision)
      return reject('The view has changed.')
    if (request.expiresAt <= this.#options.now())
      return reject('The operation expired.')
    if (request.expiresAt > this.#options.now() + 60_000)
      return reject('The operation lease is too long.')
    if (this.#operations.size >= 512 || this.#count >= TOUR_LIMITS.operations)
      return reject('The operation budget is exhausted.')
    if (
      (this.#pending !== null || this.#search !== null) &&
      request.action.tool !== 'read_subject' &&
      request.action.tool !== 'resolve_subject'
    )
      return reject('Another view operation is in progress.')
    const action = request.action
    if ('subjectId' in action) {
      const candidate = this.#context.candidates.find(
        (item) => item.id === action.subjectId,
      )
      if (candidate === undefined)
        return reject('The subject was not returned by this view.')
      if (
        action.tool === 'compose_view' &&
        !candidate.framings.includes(action.framingId)
      )
        return reject('The framing is not available for this subject.')
      if (
        action.tool === 'stand_at_site' &&
        !candidate.sites.some((site) => site.id === action.siteId)
      )
        return reject('The site is not available for this subject.')
    }
    this.#count += 1
    try {
      if (action.tool === 'find_worlds')
        return this.#startSearch(request, action, fingerprint)
      this.#apply(action)
      this.#seenRevision = this.viewRevision
      const status =
        action.tool === 'read_subject' ||
        action.tool === 'resolve_subject' ||
        (!this.#harness.observatory.status().traveling &&
          this.#options.ready?.() !== false)
          ? 'arrived'
          : 'accepted'
      if (
        action.tool === 'show_subject' ||
        action.tool === 'compose_view' ||
        action.tool === 'stand_at_site'
      ) {
        const motion = this.#queuedMotion
        this.#queuedMotion = null
        if (status === 'arrived') this.#beginMotion(motion)
        else this.#pendingMotion = motion
      }
      const receipt = this.#receipt(request, status, null)
      this.#operations.set(request.operationId, { fingerprint, receipt })
      if (status === 'accepted') this.#pending = request
      return this.#publish(receipt)
    } catch {
      this.#seenRevision = this.viewRevision
      return reject('The observatory could not execute this operation.')
    }
  }
  #optionsReceipt(request: ToolRequest, reason: string): ToolReceipt {
    const safe = {
      operationId:
        typeof request?.operationId === 'string'
          ? request.operationId.slice(0, 160)
          : 'invalid',
      requestRevision: Number.isSafeInteger(request?.requestRevision)
        ? request.requestRevision
        : this.#requestRevision,
    }
    const eye = this.#harness.observatory
    const receipt: ToolReceipt = {
      ...safe,
      status: 'rejected',
      reason,
      viewRevision: this.viewRevision,
      pictureTime: eye.time,
      subjectId: eye.target === null ? null : tourSubjectId(eye.target.address),
    }
    this.#options.onReceipt(receipt)
    return receipt
  }
  #apply(action: TourAction): void {
    const eye = this.#harness.observatory
    if (action.tool === 'find_worlds') return
    if (action.tool === 'resolve_subject') {
      this.#query = action.query
      this.#extraAddresses = this.#harness
        .searchEntries()
        .filter(
          (entry) =>
            entry.text.toLowerCase() === action.query.trim().toLowerCase(),
        )
        .map((entry) => entry.address)
        .slice(0, TOUR_LIMITS.candidates)
      this.#context = createTourContext(
        this.#harness,
        action.query,
        this.#extraAddresses,
      )
      return
    }
    if (action.tool === 'set_picture_time') {
      this.#timeOwned = true
      if (action.mode === 'live') {
        eye.setTime(null)
        return
      }
      if (action.mode === 'set') {
        eye.setTime(action.value!)
        return
      }
      // Rate and pause operate on a photograph, never the live simulation branch.
      eye.setTime(eye.time)
      if (action.mode === 'rate') {
        eye.setTimeScale(action.value!)
        eye.setTimePaused(false)
      } else if (action.mode === 'resume') eye.setTimePaused(false)
      return
    }
    const candidate = this.#context.candidates.find(
      (item) => item.id === action.subjectId,
    )!
    if (action.tool === 'read_subject') {
      this.#extraAddresses = [
        candidate.address,
        ...this.#extraAddresses.filter(
          (address) => address !== candidate.address,
        ),
      ].slice(0, TOUR_LIMITS.candidates)
      this.#context = createTourContext(
        this.#harness,
        this.#query,
        this.#extraAddresses,
      )
      return
    }
    if (action.tool === 'show_subject') {
      eye.focus(candidate.address)
      return
    }
    if (action.tool === 'stand_at_site') {
      eye.stand(candidate.address, { site: action.siteId })
      return
    }
    if (action.framingId.startsWith('preset:')) {
      this.#harness.preset(action.framingId.slice(7))
      this.#timeOwned = true
      return
    }
    if (eye.target?.address !== candidate.address) eye.focus(candidate.address)
    eye.compose(action.framingId)
  }
  #startSearch(
    request: ToolRequest,
    action: Extract<TourAction, { tool: 'find_worlds' }>,
    fingerprint: string,
  ): ToolReceipt {
    const held = { request, cancel: () => {} }
    this.#search = held
    this.#extraAddresses = []
    const query: WorldQuery = {
      kinds: action.query.kinds,
      starClasses: action.query.starClasses,
      ...Object.fromEntries(
        Object.entries(action.query).filter(
          ([key, value]) =>
            key !== 'kinds' && key !== 'starClasses' && value !== null,
        ),
      ),
    }
    const search = this.#harness.findWorlds(query, {
      lightYears: action.radiusLightYears,
      limit: action.limit,
      onBatch: (_found, progress, total) => {
        if (this.#search !== held) return
        this.#searchStatus = { ...this.#searchStatus, progress, total }
      },
    })
    held.cancel = search.cancel
    this.#searchStatus = {
      systems: search.systems,
      progress: 0,
      total: 0,
      running: true,
    }
    const receipt = this.#receipt(request, 'accepted', null)
    this.#operations.set(request.operationId, { fingerprint, receipt })
    this.#searchDone = search.done
      .then((found) => {
        this.poll()
        if (this.#search !== held) return
        this.#search = null
        this.#searchStatus = {
          ...this.#searchStatus,
          progress: 1,
          running: false,
        }
        this.#extraAddresses = found
          .map((match) => match.address)
          .slice(0, action.limit)
        this.#context = createTourContext(
          this.#harness,
          this.#query,
          this.#extraAddresses,
        )
        this.#publish(this.#receipt(request, 'arrived', null))
      })
      .catch(() => {
        if (this.#search !== held) return
        this.#search = null
        this.#searchStatus = { ...this.#searchStatus, running: false }
        this.#publish(
          this.#receipt(
            request,
            'rejected',
            'The bounded search could not finish.',
          ),
        )
      })
    return this.#publish(receipt)
  }
  poll(): void {
    if (this.#disposed) return
    if (this.viewRevision !== this.#seenRevision) {
      this.#seenRevision = this.viewRevision
      this.#timeOwned = false
      this.#cancel('The visitor changed the view.', false)
      this.#options.onTakeover?.()
      return
    }
    if (this.#motionOwned && this.#options.active?.() === false) {
      this.cancel('The guide left the Planetarium.')
      return
    }
    if (
      this.#search !== null &&
      (this.#search.request.expiresAt <= this.#options.now() ||
        this.#search.request.requestRevision !== this.#requestRevision ||
        this.#options.active?.() === false)
    ) {
      this.cancel('The search lease ended.')
      return
    }
    const pending = this.#pending
    if (pending === null) return
    if (this.#options.active?.() === false) {
      this.cancel('The guide left the Planetarium.')
      return
    }
    if (pending.expiresAt <= this.#options.now()) {
      this.cancel('The operation expired before arrival.')
      return
    }
    if (pending.requestRevision !== this.#requestRevision) {
      this.cancel('The request changed.')
      return
    }
    const subject =
      'subjectId' in pending.action ? pending.action.subjectId : null
    const target = this.#harness.observatory.target
    if (
      subject !== null &&
      (target === null || tourSubjectId(target.address) !== subject)
    ) {
      this.cancel('The destination changed.')
      return
    }
    if (
      !this.#harness.observatory.status().traveling &&
      this.#options.ready?.() !== false
    ) {
      this.#pending = null
      const motion = this.#pendingMotion
      this.#pendingMotion = null
      this.#beginMotion(motion)
      this.#publish(this.#receipt(pending, 'arrived', null))
    }
  }
  cancel(reason = 'The guide stopped.'): void {
    this.#cancel(reason, true)
  }
  #cancel(reason: string, hold: boolean): void {
    this.#revokedRevision = this.#requestRevision
    this.#queuedMotion = null
    this.#pendingMotion = null
    if (hold) this.stopMotion()
    else this.#motionOwned = false
    const search = this.#search
    this.#search = null
    if (search !== null) {
      search.cancel()
      this.#searchStatus = { ...this.#searchStatus, running: false }
      this.#publish(this.#receipt(search.request, 'canceled', reason))
    }
    const pending = this.#pending
    this.#pending = null
    if (pending === null) return
    if (hold && this.viewRevision === this.#seenRevision) {
      this.#harness.observatory.hold()
      this.#seenRevision = this.viewRevision
    }
    this.#publish(this.#receipt(pending, 'canceled', reason))
  }
  dispose(): void {
    if (this.#disposed) return
    this.cancel()
    if (this.#timeOwned && this.viewRevision === this.#seenRevision) {
      const eye = this.#harness.observatory
      eye.setTime(this.#initialTime.held)
      eye.setTimeScale(this.#initialTime.scale)
      eye.setTimePaused(this.#initialTime.paused)
    }
    this.#disposed = true
    this.#operations.clear()
  }
}
