import {
  createTourContext,
  describeView,
  subjectBrief,
  tourCandidate,
  withNotes,
  type GameHarness,
  type ObserverMotionRecipe,
  type ViewDescription,
} from '@inertialref/devtools'
import {
  GUIDE_LIMITS,
  isGuideCameraTool,
  type GuideCall,
  type GuideToolOutput,
  type SubjectBrief,
  type TourCandidate,
  type TourCameraMotion,
  type TourContext,
} from '@inertialref/protocol'
import type { Lens } from '@inertialref/rendering'
import type { WorldQuery } from '@inertialref/universe'
import { instantSeconds, pictureInstant } from './scene.ts'

/*
 * The tool executor: every call the model makes, run against the observatory.
 *
 * This is the one place a model's words become a camera movement, and the
 * rules here hold whatever either model says. The tool names and argument
 * shapes are the protocol's and are decoded before a call reaches this file;
 * names are resolved to addresses through the search index, so the model
 * never sees or produces one; arrival is a receipt from the observatory,
 * gated on the renderer's readiness, never a timer; and a change of view the
 * visitor makes cancels whatever the guide had pending. Time changes go
 * through the observatory's photographic instant and nothing else — no tool
 * here can reach the simulation clock, warp, or a teleport.
 *
 * No tool blocks on the camera. A move starts the travel, records what is
 * pending, and returns `moving` at once; `poll` publishes the arrival when
 * the observatory has stopped and the renderer has drawn it. The plan (§ 7)
 * measured why: a backend response that waits on a tool result is a response
 * the voice cannot speak and a delegation the provider queues behind, and a
 * correction spoken during a blocking move waited 22 seconds. A second move
 * replaces the first and its arrival is never published.
 */

export interface GuideArrival {
  readonly tool: 'go_to' | 'frame_pair' | 'stand_at' | 'leave_surface'
  readonly subject: string
  readonly framing: string | null
  readonly viewRevision: number
}

/** What the scene block says beyond the projection: names and choices. */
export interface SceneFacts {
  readonly framing: string | null
  readonly system: string | null
  readonly planets: readonly string[]
  readonly moons: readonly string[]
  readonly framings: readonly string[]
  readonly sites: readonly { readonly id: string; readonly name: string }[]
  readonly provenance: 'observed' | 'projected' | null
}

export interface GuideExecutorOptions {
  readonly now: () => number
  readonly onArrival: (arrival: GuideArrival) => void
  readonly onTakeover: () => void
  /** Whether the guide may move the camera: the planetarium is mounted. */
  readonly active?: () => boolean
  /** Whether the renderer has drawn the current view; headlessly, always. */
  readonly ready?: () => boolean
  readonly lens?: () => Lens
  readonly aspect?: () => number
}

interface Pending {
  readonly tool: GuideArrival['tool']
  readonly subject: string
  readonly address: string
  readonly framing: string | null
  readonly motion: ObserverMotionRecipe | null
}

/** Seconds a fly-to typically takes; the model hears it as an estimate. */
const ESTIMATED_TRAVEL_SECONDS = 3

const SITE_WORDS = ['summit', 'shore', 'basin', 'pole'] as const

function motionRecipe(
  kind: TourCameraMotion | null,
): ObserverMotionRecipe | null {
  const durationSeconds = 30
  switch (kind) {
    case null:
    case 'hold':
      return null
    case 'orbit':
      return {
        durationSeconds,
        azimuthDelta: Math.PI / 6,
        elevationDelta: 0,
        distanceFactor: 1,
      }
    case 'push-in':
      return {
        durationSeconds,
        azimuthDelta: 0,
        elevationDelta: 0,
        distanceFactor: 0.8,
      }
    case 'pull-back':
      return {
        durationSeconds,
        azimuthDelta: 0,
        elevationDelta: 0,
        distanceFactor: 1.25,
      }
    case 'reveal':
      return {
        durationSeconds,
        azimuthDelta: Math.PI / 4,
        elevationDelta: Math.PI / 24,
        distanceFactor: 1.15,
      }
  }
}

const degrees = (radians: number): number =>
  Math.round(((radians * 180) / Math.PI) * 10) / 10
const radians = (value: number): number => (value * Math.PI) / 180

export class GuideExecutor {
  readonly #harness: GameHarness
  readonly #options: GuideExecutorOptions
  readonly #initialTime: { held: number | null; paused: boolean; scale: number }
  #pending: Pending | null = null
  #seenRevision: number
  #framing: string | null = null
  #timeOwned = false
  #motionOwned = false
  #disposed = false
  #search: { cancel: () => void } | null = null
  #context: { revision: number; query: string; value: TourContext } | null =
    null

  constructor(harness: GameHarness, options: GuideExecutorOptions) {
    this.#harness = harness
    this.#options = options
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
  /** A move whose arrival has not been published. */
  get pending(): GuideArrival['tool'] | null {
    return this.#pending?.tool ?? null
  }
  get pendingSubject(): string | null {
    return this.#pending?.subject ?? null
  }
  get searching(): boolean {
    return this.#search !== null
  }

  view(): ViewDescription {
    return describeView(this.#harness, {
      lens: this.#options.lens?.(),
      aspect: this.#options.aspect?.(),
    })
  }

  /** The names around the subject, for the scene block. */
  facts(): SceneFacts {
    const eye = this.#harness.observatory
    const target = eye.target
    if (target === null)
      return {
        framing: null,
        system: null,
        planets: [],
        moons: [],
        framings: [],
        sites: [],
        provenance: null,
      }
    const page = this.#harness.dossier(target.address)
    const system =
      page === null ? null : this.#harness.world.system(page.system.id)
    const brief = subjectBrief(this.#harness, target.address)
    const candidate =
      brief === null ? null : tourCandidate(this.#harness, brief)
    return {
      framing: this.#framing,
      system: page?.system.name ?? null,
      planets:
        system === undefined || system === null
          ? []
          : system.planets.map((body) => body.name),
      moons: page?.satellites.map((moon) => moon.name) ?? [],
      framings: candidate?.framings ?? [],
      sites: candidate?.sites.map(({ id, name }) => ({ id, name })) ?? [],
      provenance: page?.provenance ?? null,
    }
  }

  async execute(call: GuideCall): Promise<GuideToolOutput> {
    const taken = this.#poll()
    if (this.#disposed || this.#options.active?.() === false)
      return reject('The guide is not active in this mode.')
    // The poll above is what notices the gesture, and a move decided before it
    // is a move the visitor has already overruled. Running it anyway takes the
    // camera back and publishes an arrival for a call the loop answered
    // canceled in the same turn. Queries are harmless and still answer.
    if (taken && isGuideCameraTool(call.name))
      return { status: 'canceled', reason: 'The visitor took the camera.' }
    try {
      switch (call.name) {
        case 'go_to':
          return this.#goTo(call)
        case 'adjust_view':
          return this.#adjustView(call)
        case 'frame_pair':
          return this.#framePair(call)
        case 'stand_at':
          return this.#standAt(call)
        case 'look_around':
          return this.#lookAround(call)
        case 'leave_surface':
          return this.#leaveSurface()
        case 'set_time':
          return this.#setTime(call)
        case 'hold_view':
          return this.#holdView()
        case 'linger':
          return { status: 'scheduled', seconds: call.seconds }
        case 'describe_view':
          return this.#describeView()
        case 'read_subject':
          return this.#readSubject(call)
        case 'list_subjects':
          return this.#listSubjects(call)
        case 'find_worlds':
          return await this.#findWorlds(call)
        case 'resolve_name':
          return this.#resolveName(call.query)
      }
    } catch (cause) {
      return reject(
        cause instanceof Error
          ? cause.message
          : 'The observatory could not execute this operation.',
      )
    }
  }

  /** Publish arrivals, notice takeovers, and keep the gesture honest. */
  poll(): void {
    this.#poll()
  }

  /** As `poll`, answering whether this pass handed the camera to the visitor. */
  #poll(): boolean {
    if (this.#disposed) return false
    if (this.viewRevision !== this.#seenRevision) {
      // Someone else moved the camera: a drag, a preset, a scrub. Whatever
      // the guide had pending is theirs now, and the framing it composed is
      // no longer the one on screen.
      this.#seenRevision = this.viewRevision
      this.#pending = null
      this.#motionOwned = false
      this.#timeOwned = false
      this.#framing = null
      this.#cancelSearch()
      this.#options.onTakeover()
      return true
    }
    if (this.#options.active?.() === false) {
      this.cancel()
      return false
    }
    const pending = this.#pending
    if (pending === null) return false
    const eye = this.#harness.observatory
    if (eye.target?.address !== pending.address) {
      this.#pending = null
      return false
    }
    if (eye.status().traveling || this.#options.ready?.() === false)
      return false
    this.#pending = null
    this.#beginMotion(pending.motion)
    this.#options.onArrival({
      tool: pending.tool,
      subject: pending.subject,
      framing: pending.framing,
      viewRevision: this.viewRevision,
    })
    return false
  }

  /** Stop what the guide started, and hold the camera where it is. */
  cancel(): void {
    this.#pending = null
    this.#cancelSearch()
    this.stopMotion()
    if (this.viewRevision === this.#seenRevision) {
      const eye = this.#harness.observatory
      if (eye.status().traveling) {
        eye.hold()
        this.#seenRevision = this.viewRevision
      }
    }
  }

  /** Freeze only the guide's own finite gesture. */
  stopMotion(): void {
    if (this.#motionOwned && this.viewRevision === this.#seenRevision) {
      this.#harness.observatory.stopMotion()
      this.#seenRevision = this.viewRevision
    }
    this.#motionOwned = false
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
  }

  /* ---------------------------------------------------------------------- */
  /* Names                                                                    */
  /* ---------------------------------------------------------------------- */

  #contextFor(query: string): TourContext {
    const cached = this.#context
    if (
      cached !== null &&
      cached.revision === this.viewRevision &&
      cached.query === query
    )
      return cached.value
    const value = createTourContext(this.#harness, query)
    this.#context = { revision: this.viewRevision, query, value }
    return value
  }

  #resolve(name: string):
    | {
        readonly ok: true
        readonly candidate: TourCandidate
        readonly brief: SubjectBrief
      }
    | { readonly ok: false; readonly output: GuideToolOutput } {
    const query = normalizeName(name)
    const context = this.#contextFor(query)
    const direct = context.candidates.find(
      (candidate) => candidate.name.toLowerCase() === query,
    )
    if (direct !== undefined) {
      const brief =
        context.briefs.find((item) => item.subjectId === direct.id) ??
        subjectBrief(this.#harness, direct.address)
      if (brief !== null) return { ok: true, candidate: direct, brief }
    }
    const matches = this.#harness
      .search(query, { origin: 'observer' })
      .slice(0, 8)
    const exact = matches.find((match) => match.name.toLowerCase() === query)
    if (exact !== undefined) {
      const brief = subjectBrief(this.#harness, exact.address)
      if (brief !== null)
        return {
          ok: true,
          candidate: tourCandidate(this.#harness, brief),
          brief,
        }
    }
    return {
      ok: false,
      output: {
        status: 'unknown',
        reason: `No object named "${name.trim()}" is in reach.`,
        candidates: matches.slice(0, 5).map((match) => ({
          name: match.name,
          kind: match.kind === 'system' ? 'star system' : match.detail,
          system: match.system,
        })),
      },
    }
  }

  #resolveName(query: string): GuideToolOutput {
    const found = this.#resolve(query)
    if (found.ok)
      return {
        status: 'ok',
        candidates: [
          {
            name: found.candidate.name,
            kind: found.candidate.kind,
            provenance: found.candidate.provenance,
          },
        ],
      }
    return { ...found.output, status: 'none' }
  }

  /* ---------------------------------------------------------------------- */
  /* Moving                                                                   */
  /* ---------------------------------------------------------------------- */

  #startMove(pending: Pending): GuideToolOutput {
    this.stopMotion()
    this.#pending = pending
    this.#seenRevision = this.viewRevision
    return {
      status: 'moving',
      subject: pending.subject,
      framing: pending.framing ?? 'default',
      estimated_seconds: ESTIMATED_TRAVEL_SECONDS,
    }
  }

  #goTo(call: Extract<GuideCall, { name: 'go_to' }>): GuideToolOutput {
    const found = this.#resolve(call.subject)
    if (!found.ok) return found.output
    const { candidate } = found
    const eye = this.#harness.observatory
    const framing = call.framing?.trim() || null
    if (framing !== null && !candidate.framings.includes(framing))
      return reject(
        `${candidate.name} has no framing "${framing}".`,
        candidate.framings.length === 0 ? {} : { framings: candidate.framings },
      )
    this.#cancelSearch()
    if (framing === null) {
      eye.focus(candidate.address)
    } else if (framing.startsWith('preset:')) {
      this.#harness.preset(framing.slice('preset:'.length))
      // A preset carries its own picture time; the guide owns it from here
      // and gives it back at the end.
      this.#timeOwned = true
    } else {
      if (eye.target?.address !== candidate.address)
        eye.focus(candidate.address)
      eye.compose(framing)
    }
    this.#framing = framing
    return this.#startMove({
      tool: 'go_to',
      subject: candidate.name,
      address: candidate.address,
      framing,
      motion: motionRecipe(call.motion),
    })
  }

  #framePair(
    call: Extract<GuideCall, { name: 'frame_pair' }>,
  ): GuideToolOutput {
    const subject = this.#resolve(call.subject)
    if (!subject.ok) return subject.output
    const companion = this.#resolve(call.companion)
    if (!companion.ok) return companion.output
    if (subject.candidate.address === companion.candidate.address)
      return reject('Choose two different bodies to frame together.')
    const eye = this.#harness.observatory
    // Every refusal comes before the focus commits. `track` raises the
    // observatory's revision and *then* throws — for a companion outside the
    // subject's system, or for any companion at all from a surface — by which
    // point the focus has started a fly-to nobody will receive an arrival for,
    // and the unclaimed revision reads to the next poll as the visitor taking
    // the camera. `Observatory.stand` learned the same lesson.
    if (eye.status().surface !== null)
      return reject('Leave the surface before framing a pair.')
    const systemOf = (address: string): string | null =>
      this.#harness.dossier(address)?.system.id ?? null
    if (
      systemOf(subject.candidate.address) !==
      systemOf(companion.candidate.address)
    )
      return reject(
        `${companion.candidate.name} is not in the same system as ${subject.candidate.name}.`,
      )
    this.#cancelSearch()
    if (eye.target?.address !== subject.candidate.address)
      eye.focus(subject.candidate.address)
    eye.track(companion.candidate.address)
    eye.framePair()
    this.#framing = `with ${companion.candidate.name}`
    return this.#startMove({
      tool: 'frame_pair',
      subject: subject.candidate.name,
      address: subject.candidate.address,
      framing: this.#framing,
      motion: null,
    })
  }

  #standAt(call: Extract<GuideCall, { name: 'stand_at' }>): GuideToolOutput {
    const found = this.#resolve(call.subject)
    if (!found.ok) return found.output
    const { candidate } = found
    const sites = this.#harness.sites(candidate.address)
    if (sites.length === 0)
      return reject(`${candidate.name} has no solid surface to stand on.`)
    const wanted = call.site.trim().toLowerCase()
    const named =
      sites.find((site) => site.id.toLowerCase() === wanted) ??
      sites.find((site) => site.name.toLowerCase() === wanted)
    const site = named ?? siteByWord(sites, wanted)
    if (site === undefined)
      return reject(`${candidate.name} has no site "${call.site.trim()}".`, {
        sites: sites.slice(0, 8).map(({ id, name }) => ({ id, name })),
        words: SITE_WORDS,
      })
    this.#cancelSearch()
    this.#harness.observatory.stand(candidate.address, { site: site.id })
    this.#framing = `standing at ${site.name}`
    return this.#startMove({
      tool: 'stand_at',
      subject: candidate.name,
      address: candidate.address,
      framing: this.#framing,
      motion: null,
    })
  }

  #leaveSurface(): GuideToolOutput {
    const eye = this.#harness.observatory
    const target = eye.target
    if (target === null || eye.status().surface === null)
      return reject('The camera is not on a surface.')
    eye.leaveSurface()
    this.#framing = null
    return this.#startMove({
      tool: 'leave_surface',
      subject: target.name,
      address: target.address,
      framing: null,
      motion: null,
    })
  }

  #adjustView(
    call: Extract<GuideCall, { name: 'adjust_view' }>,
  ): GuideToolOutput {
    const eye = this.#harness.observatory
    const target = eye.target
    if (target === null) return reject('Choose a subject first.')
    if (eye.status().surface !== null)
      return reject('Leave the surface before adjusting the orbit.')
    this.stopMotion()
    const desired = eye.status().desired
    if (call.azimuth_deg !== null || call.elevation_deg !== null)
      eye.setAngles(
        call.azimuth_deg === null ? desired.azimuth : radians(call.azimuth_deg),
        call.elevation_deg === null
          ? desired.elevation
          : radians(call.elevation_deg),
      )
    if (call.distance_radii !== null)
      eye.setDistance(call.distance_radii * target.radius)
    if (call.zoom_factor !== null) eye.zoom(call.zoom_factor)
    this.#seenRevision = this.viewRevision
    this.#framing = null
    const after = eye.status()
    return {
      status: 'ok',
      subject: target.name,
      azimuth_deg: degrees(after.desired.azimuth),
      elevation_deg: degrees(after.desired.elevation),
      distance_radii:
        Math.round((after.desired.distance / target.radius) * 100) / 100,
      estimated_seconds: ESTIMATED_TRAVEL_SECONDS,
    }
  }

  #lookAround(
    call: Extract<GuideCall, { name: 'look_around' }>,
  ): GuideToolOutput {
    const eye = this.#harness.observatory
    if (eye.status().surface === null)
      return reject('Stand on a surface before looking around.')
    eye.setHeading(radians(call.heading_deg))
    eye.setPitch(radians(call.pitch_deg))
    this.#seenRevision = this.viewRevision
    const view = this.view()
    return {
      status: 'ok',
      heading_deg: view.standing?.headingDeg ?? call.heading_deg,
      pitch_deg: view.standing?.pitchDeg ?? call.pitch_deg,
      daylight: view.standing?.daylight ?? 'unknown',
      on_screen: view.onScreen.map((item) => `${item.name} (${item.place})`),
    }
  }

  #holdView(): GuideToolOutput {
    const eye = this.#harness.observatory
    this.#pending = null
    this.stopMotion()
    eye.hold()
    this.#seenRevision = this.viewRevision
    const view = this.view()
    return {
      status: 'held',
      subject: view.subject?.name ?? null,
      distance_radii: view.distanceRadii,
    }
  }

  #beginMotion(recipe: ObserverMotionRecipe | null): void {
    if (recipe === null) return
    this.stopMotion()
    this.#motionOwned = this.#harness.observatory.startMotion(recipe)
    this.#seenRevision = this.viewRevision
  }

  /* ---------------------------------------------------------------------- */
  /* Time                                                                     */
  /* ---------------------------------------------------------------------- */

  #setTime(call: Extract<GuideCall, { name: 'set_time' }>): GuideToolOutput {
    const eye = this.#harness.observatory
    this.#timeOwned = true
    switch (call.mode) {
      case 'live':
        eye.setTime(null)
        break
      case 'hold':
        eye.setTime(eye.time)
        eye.setTimePaused(true)
        break
      case 'set': {
        const seconds = instantSeconds(call.instant!)
        if (seconds === null) return reject('The instant could not be read.')
        eye.setTime(seconds)
        eye.setTimePaused(true)
        break
      }
      case 'rate':
        if (eye.heldTime === null) eye.setTime(eye.time)
        eye.setTimeScale(call.rate!)
        eye.setTimePaused(false)
        break
    }
    this.#seenRevision = this.viewRevision
    const status = eye.status()
    return {
      status: 'ok',
      picture_time: pictureInstant(status.time),
      mode:
        status.heldTime === null ? 'live' : status.timePaused ? 'hold' : 'rate',
      rate:
        status.heldTime === null || status.timePaused ? null : status.timeScale,
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                  */
  /* ---------------------------------------------------------------------- */

  #describeView(): GuideToolOutput {
    const view = this.view()
    const facts = this.facts()
    return {
      status: 'ok',
      subject: view.subject === null ? null : view.subject.name,
      kind: view.subject?.kind ?? null,
      framing: facts.framing,
      traveling: view.traveling,
      standing: view.standing,
      distance_radii: view.distanceRadii,
      fill: view.fill,
      picture_time: pictureInstant(view.pictureTime),
      time_mode: view.timeMode,
      on_screen: view.onScreen.map((item) => ({
        name: item.name,
        kind: item.kind,
        place: item.place,
        x: item.x,
        y: item.y,
        extent: item.extent,
        lit: item.lit,
      })),
    }
  }

  #readSubject(
    call: Extract<GuideCall, { name: 'read_subject' }>,
  ): GuideToolOutput {
    const found = this.#resolve(call.subject)
    if (!found.ok) return found.output
    const brief = withNotes(found.brief)
    const wanted = call.fields?.map((field) => field.trim().toLowerCase())
    const facts = brief.facts.filter(
      (fact) =>
        wanted === undefined ||
        wanted.some((field) => fact.label.toLowerCase().includes(field)),
    )
    return {
      status: 'ok',
      name: brief.name,
      kind: found.candidate.kind,
      provenance: brief.provenance,
      classification: brief.classification,
      summary: brief.summary,
      facts: facts.map((fact) => ({
        label: fact.label,
        display: fact.display,
        speech: fact.speech,
        provenance: fact.provenance,
        missing_because: fact.reason,
      })),
      sources: brief.sources.map((source) => ({
        title: source.title,
        url: source.url,
      })),
    }
  }

  #listSubjects(
    call: Extract<GuideCall, { name: 'list_subjects' }>,
  ): GuideToolOutput {
    const limit = call.limit ?? GUIDE_LIMITS.results
    const eye = this.#harness.observatory
    if (call.scope === 'nearby_stars') {
      const stars = this.#harness
        .systemsNearby(GUIDE_LIMITS.searchLightYears)
        .slice(0, limit)
      return {
        status: 'ok',
        scope: 'nearby_stars',
        stars: stars.map((star) => ({
          name: star.name,
          light_years: Math.round(star.lightYears * 100) / 100,
        })),
      }
    }
    let address = eye.target?.address ?? null
    if (call.of !== null) {
      const found = this.#resolve(call.of)
      if (!found.ok) return found.output
      address = found.candidate.address
    }
    if (address === null) return reject('Choose a subject first.')
    const page = this.#harness.dossier(address)
    if (page === null) return reject('That object has no record.')
    if (call.scope === 'moons')
      return {
        status: 'ok',
        scope: 'moons',
        of: page.name,
        moons: page.satellites.slice(0, limit).map((moon) => ({
          name: moon.name,
          kind: moon.kind,
          summary: this.#harness.dossier(moon.address)?.summary ?? null,
        })),
      }
    const system = this.#harness.world.system(page.system.id)
    if (system === undefined) return reject('That system is not loaded.')
    return {
      status: 'ok',
      scope: 'system',
      system: system.name,
      star: {
        name: system.star.name,
        summary: this.#harness.dossier(page.system.id)?.summary ?? null,
      },
      bodies: system.planets.slice(0, limit).map((body) => ({
        name: body.name,
        kind: body.kind,
        provenance: body.provenance,
        moons: body.moons.length,
        summary:
          this.#harness.dossier(`${page.system.id}/${body.name}`)?.summary ??
          null,
      })),
    }
  }

  async #findWorlds(
    call: Extract<GuideCall, { name: 'find_worlds' }>,
  ): Promise<GuideToolOutput> {
    this.#cancelSearch()
    const query: WorldQuery = {
      kinds: call.query.kinds,
      starClasses: call.query.starClasses,
      ...Object.fromEntries(
        Object.entries(call.query).filter(
          ([key, value]) =>
            key !== 'kinds' && key !== 'starClasses' && value !== null,
        ),
      ),
    }
    const search = this.#harness.findWorlds(query, {
      lightYears: call.radius_light_years,
      limit: call.limit,
    })
    const held = { cancel: search.cancel }
    this.#search = held
    try {
      const found = await search.done
      if (this.#search !== held)
        return { status: 'canceled', reason: 'The search was interrupted.' }
      const matches = found.slice(0, call.limit).map((match) => {
        const page = this.#harness.dossier(match.address)
        return {
          name: page?.name ?? match.address,
          kind: page?.kind ?? 'body',
          system: page?.system.name ?? null,
          provenance: page?.provenance ?? null,
        }
      })
      return matches.length === 0
        ? {
            status: 'none',
            searched_light_years: call.radius_light_years,
            systems: search.systems,
          }
        : {
            status: 'ok',
            searched_light_years: call.radius_light_years,
            systems: search.systems,
            matches,
          }
    } catch {
      return reject('The bounded search could not finish.')
    } finally {
      if (this.#search === held) this.#search = null
    }
  }

  #cancelSearch(): void {
    const search = this.#search
    this.#search = null
    search?.cancel()
  }
}

function reject(
  reason: string,
  extra: Record<string, unknown> = {},
): GuideToolOutput {
  return { status: 'rejected', reason, ...extra }
}

/** What a visitor says versus what the index stores. */
function normalizeName(name: string): string {
  const query = name
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
  if (query === 'moon') return 'luna'
  if (query === 'sun') return 'sol'
  return query
}

interface Site {
  readonly id: string
  readonly name: string
  readonly detail: string
  readonly latitude: number
  readonly elevation: number
}

/** The four words the tool schema promises, each a ranking over the survey. */
function siteByWord(sites: readonly Site[], word: string): Site | undefined {
  const by = (score: (site: Site) => number): Site =>
    sites.reduce((best, site) => (score(site) > score(best) ? site : best))
  switch (word) {
    case 'summit':
      return by((site) => site.elevation)
    case 'basin':
      return by((site) => -site.elevation)
    case 'pole':
      return by((site) => Math.abs(site.latitude))
    case 'shore': {
      const named = sites.find((site) =>
        /shore|coast|beach|sea/i.test(`${site.name} ${site.detail}`),
      )
      return named ?? by((site) => -Math.abs(site.elevation))
    }
    default:
      return undefined
  }
}
