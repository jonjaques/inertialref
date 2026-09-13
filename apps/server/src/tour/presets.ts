import {
  validateTourPlan,
  type TourCameraMotion,
  type TourCandidate,
  type TourContext,
  type TourPlan,
  type TourStop,
} from '@inertialref/protocol'
import {
  parseAddress,
  SOLAR_PLANETS,
  type SolarBody,
} from '@inertialref/universe'
import solar from '../../../../design/narration/solar-system-tour.json' with { type: 'json' }
import saturn from '../../../../design/narration/saturn-tour.json' with { type: 'json' }
import demo from '../../../../design/narration/developer-demo.json' with { type: 'json' }

interface Story {
  readonly id: string
  readonly subject: string
  readonly objective: string
  readonly narration: string
  readonly minimumViewSeconds: number
  readonly cameraIdeas: readonly string[]
  readonly sources: readonly { readonly title: string; readonly url: string }[]
}

interface Script {
  readonly id: string
  readonly title: string
  readonly durationSeconds: number
  readonly introduction: string
  readonly stops: readonly Story[]
  readonly closing: string
}

interface Composition {
  readonly motion: TourCameraMotion
  readonly framings: readonly string[]
  readonly surface?: boolean
}

const solarViews: readonly Composition[] = [
  { motion: 'pull-back', framings: [] },
  { motion: 'orbit', framings: ['crescent', 'portrait'] },
  { motion: 'orbit', framings: ['terminator', 'portrait'] },
  { motion: 'push-in', framings: ['portrait'] },
  { motion: 'pull-back', framings: ['portrait', 'wide'] },
  { motion: 'reveal', framings: ['preset:the-rings', 'wide'] },
  { motion: 'orbit', framings: ['crescent', 'portrait'] },
  { motion: 'orbit', framings: ['portrait', 'wide'] },
]
const saturnViews: readonly Composition[] = [
  { motion: 'orbit', framings: ['portrait', 'wide'] },
  { motion: 'reveal', framings: ['preset:the-rings', 'wide'] },
  { motion: 'push-in', framings: ['crescent', 'portrait'] },
  { motion: 'orbit', framings: ['crescent', 'portrait'] },
]
const demoViews: readonly Composition[] = [
  { motion: 'reveal', framings: ['preset:the-rings', 'wide'] },
  { motion: 'push-in', framings: ['portrait', 'crescent'] },
  { motion: 'hold', framings: ['wide', 'portrait'], surface: true },
]

const canonicalName = (name: string): string =>
  name === 'Sun' ? 'Sol' : name === 'Moon' ? 'Luna' : name

/** A measured name also has to describe that exact issued Solar address. */
function observedIdentity(candidate: TourCandidate, name: string): boolean {
  if (
    candidate.provenance !== 'observed' ||
    canonicalName(candidate.name) !== name
  )
    return false
  try {
    const address = parseAddress(candidate.address)
    if (
      address.galaxy !== 'milky-way' ||
      address.kind === 'galaxy' ||
      address.system !== 'SOL'
    )
      return false
    if (address.kind === 'system')
      return name === 'Sol' && candidate.kind === 'star'
    if (address.kind !== 'body') return false
    let bodies: readonly SolarBody[] = SOLAR_PLANETS
    let body: SolarBody | undefined
    for (const index of address.body) {
      body = bodies[index]
      if (body === undefined) return false
      bodies = body.moons
    }
    return body?.name === name && body.kind === candidate.kind
  } catch {
    return false
  }
}

function sourceId(url: string): string {
  let hash = 2166136261
  for (let index = 0; index < url.length; index++)
    hash = Math.imul(hash ^ url.charCodeAt(index), 16777619)
  return `curated:story-${(hash >>> 0).toString(36)}`
}

function assemble(
  script: Script,
  views: readonly Composition[],
  context: TourContext,
): TourPlan | null {
  const stops: TourStop[] = []
  for (const [index, story] of script.stops.entries()) {
    const name = canonicalName(story.subject)
    const candidate = context.candidates.find((item) =>
      observedIdentity(item, name),
    )
    if (candidate === undefined) return null
    const brief = context.briefs.find((item) => item.subjectId === candidate.id)
    if (
      brief === undefined ||
      brief.address !== candidate.address ||
      brief.provenance !== 'observed' ||
      canonicalName(brief.name) !== name
    )
      return null
    const view = views[index]!
    const siteId = view.surface ? (candidate.sites[0]?.id ?? null) : null
    stops.push({
      id: story.id,
      subjectId: candidate.id,
      framingId:
        siteId === null
          ? (view.framings.find((id) => candidate.framings.includes(id)) ??
            null)
          : null,
      siteId,
      objective: story.objective,
      factIds: [],
      minimumViewSeconds: 2,
      lookSeconds: story.minimumViewSeconds,
      narration: [
        index === 0 ? script.introduction : '',
        story.narration,
        index === script.stops.length - 1 ? script.closing : '',
      ]
        .filter(Boolean)
        .join(' '),
      motion: view.motion,
      sources: story.sources.map((source) => ({
        ...source,
        id: sourceId(source.url),
        origin: 'curated',
      })),
    })
  }
  // Travel and spoken prose spend the same visit budget as its quiet looking.
  const speechSeconds = stops.reduce(
    (sum, stop) => sum + stop.narration!.split(/\s+/).length / 2.5,
    0,
  )
  const travelSeconds = stops.length * 4
  const quietSeconds = stops.reduce((sum, stop) => sum + stop.lookSeconds!, 0)
  const quietScale =
    quietSeconds === 0
      ? 1
      : Math.min(
          1,
          Math.max(0, script.durationSeconds - speechSeconds - travelSeconds) /
            quietSeconds,
        )
  const pacedStops = stops.map((stop) => ({
    ...stop,
    lookSeconds: Math.round(stop.lookSeconds! * quietScale),
  }))
  const plan: TourPlan = {
    id: `${script.id}-${context.viewRevision}`,
    goal: script.title,
    durationSeconds: Math.round(
      speechSeconds +
        travelSeconds +
        pacedStops.reduce((sum, stop) => sum + stop.lookSeconds, 0),
    ),
    automatic: true,
    rationale:
      script.id === 'developer-demo'
        ? 'A quick demonstration of camera moves, conversation, and a route you can change.'
        : script.id === 'saturn-tour'
          ? 'A closer look at Saturn’s rings and two moons, with a story and time to look at each stop.'
          : 'An unhurried trip out among the planets, with a few human stories and a return to Earth.',
    stops: pacedStops,
  }
  return validateTourPlan(plan, context).ok ? plan : null
}

/** Only complete standard visits match; edits remain a director decision. */
export function authoredTour(
  text: string,
  context: TourContext,
): TourPlan | null {
  const request = text.toLowerCase().replaceAll('’', "'")
  if (
    /\b(add|skip|remove|reorder|replace|instead|except|only|without|change|shorten|extend|exclude|include|don't|not)\b/.test(
      request,
    )
  )
    return null
  if (
    /\bdeveloper\b/.test(request) &&
    /\b(demo|demonstration|capabilities)\b/.test(request)
  )
    return assemble(demo, demoViews, context)
  if (!/\b(tour|visit|trip|journey)\b/.test(request)) return null
  const wantsSolar = /\bsolar\s+system\b/.test(request)
  const wantsSaturn = /\bsaturn\b/.test(request)
  if (wantsSolar === wantsSaturn) return null
  return wantsSolar
    ? assemble(solar, solarViews, context)
    : assemble(saturn, saturnViews, context)
}
