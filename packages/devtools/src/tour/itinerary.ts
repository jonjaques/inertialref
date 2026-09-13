import {
  validateTourPlan,
  type NarrationBrief,
  type TourContext,
  type TourPlan,
  type TourStop,
} from '@inertialref/protocol'

export function deterministicTour(
  context: TourContext,
  kind: 'saturn' | 'system' = 'system',
): TourPlan | null {
  const stops: TourStop[] = []
  const add = (
    subjectId: string,
    framingId: string | null,
    objective: string,
    id = `stop-${stops.length + 1}`,
  ): void => {
    const candidate = context.candidates.find((item) => item.id === subjectId)
    const brief = context.briefs.find((item) => item.subjectId === subjectId)
    if (candidate === undefined || brief === undefined) return
    stops.push({
      id,
      subjectId,
      framingId:
        framingId !== null && candidate.framings.includes(framingId)
          ? framingId
          : null,
      siteId: null,
      objective,
      factIds: brief.facts
        .filter((fact) => fact.speech !== null)
        .slice(0, 3)
        .map((fact) => fact.id),
      minimumViewSeconds: 20,
    })
  }
  if (kind === 'saturn') {
    const saturn = context.candidates.find((item) => item.name === 'Saturn')
    const titan = context.candidates.find((item) => item.name === 'Titan')
    if (saturn === undefined || titan === undefined) return null
    add(
      saturn.id,
      'portrait',
      'How does a giant like Saturn have such a short day?',
      'saturn-overview',
    )
    add(
      saturn.id,
      'preset:the-rings',
      'How do countless orbiting particles look like a solid disc?',
      'saturn-rings',
    )
    add(
      titan.id,
      'crescent',
      'What happens when a moon’s rain is made of methane?',
      'titan-weather',
    )
  } else {
    const star = context.candidates.find((item) => item.kind === 'star')
    if (star !== undefined) add(star.id, null, `Meet ${star.name}.`)
    for (const candidate of context.candidates
      .filter((item) => item.parentId === star?.id)
      .slice(0, 7))
      add(candidate.id, 'portrait', `Explore ${candidate.name}.`)
  }
  if (stops.length === 0) return null
  const plan: TourPlan = {
    id: `tour-${kind}-${context.viewRevision}`,
    goal:
      kind === 'saturn'
        ? 'A short tour of Saturn, its rings, and Titan.'
        : 'A short tour of the current system.',
    durationSeconds: stops.length * 40,
    stops,
  }
  return validateTourPlan(plan, context).ok ? plan : null
}

/** Speech comes from selected record facts; a teaching objective is not evidence. */
export function groundedNarration(
  context: TourContext,
  stop: TourStop | null,
  requestRevision: number,
  id: string,
): NarrationBrief {
  const subjectId = stop?.subjectId ?? context.subjectId
  const brief = context.briefs.find((item) => item.subjectId === subjectId)
  const facts =
    brief?.facts
      .filter(
        (fact) =>
          fact.speech !== null &&
          (stop === null || stop.factIds.includes(fact.id)),
      )
      .slice(0, 5) ?? []
  const sourceIds = [...new Set(facts.flatMap((fact) => fact.sourceIds))]
  const prefix =
    brief?.provenance === 'projected'
      ? 'This world is a projection, not a confirmed observation. '
      : ''
  const narration = {
    id,
    requestRevision,
    stopId: stop?.id ?? null,
    viewRevision: context.viewRevision,
    subjectId,
    text:
      brief === undefined
        ? 'Choose an object so I can read its record.'
        : `${prefix}${brief.name}. ${facts.map((fact) => fact.speech).join(' ')}`,
    factIds: facts.map((fact) => fact.id),
    sourceIds,
    sources:
      brief?.sources.filter((source) => sourceIds.includes(source.id)) ?? [],
  }
  return narration
}
