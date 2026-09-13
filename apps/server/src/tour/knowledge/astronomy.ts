import type {
  SubjectBrief,
  TourContext,
  TourFact,
  TourSource,
} from '@inertialref/protocol'

export interface AstronomyNote {
  readonly id: string
  readonly object: string
  readonly title: string
  readonly speech: string
  readonly url: string
  readonly retrieved: string
  readonly freshness: 'timeless' | 'refresh-required'
}

/** The collection covers historical findings, not current mission schedules. */
export const ASTRONOMY_NOTES: readonly AstronomyNote[] = [
  {
    id: 'saturn-overview',
    object: 'Saturn',
    title: 'Saturn spin and density',
    speech:
      "Saturn's a giant with a surprisingly short day. It spins around in under eleven hours, and most of that enormous planet is hydrogen and helium. Here's the bit I love: its average density is lower than water's. That's the average for the whole planet, even though deep inside, pressure squeezes hydrogen into liquid.",
    url: 'https://science.nasa.gov/saturn/facts/',
    retrieved: '2026-09-13',
    freshness: 'timeless',
  },
  {
    id: 'saturn-rings',
    object: 'Saturn',
    title: 'Saturn rings',
    speech:
      "Saturn's rings can look like one smooth band, but they're a swarm of separate pieces of ice and rock. Some are tiny grains, and others are as big as houses. Different parts circle Saturn at different speeds. The part that catches me is how thin they are: the main rings are typically only about ten meters thick.",
    url: 'https://science.nasa.gov/saturn/facts/',
    retrieved: '2026-09-13',
    freshness: 'timeless',
  },
  {
    id: 'saturn-no-surface',
    object: 'Saturn',
    title: 'Saturn structure',
    speech:
      "Saturn isn't a world you can set a lander down on. The clouds lead into deeper gas and liquid layers, where pressure and heat would eventually destroy a spacecraft. There's no solid surface for our landing gear. So this is a place to explore from above, with the clouds themselves doing the job of scenery.",
    url: 'https://science.nasa.gov/saturn/facts/',
    retrieved: '2026-09-13',
    freshness: 'timeless',
  },
  {
    id: 'titan-weather',
    object: 'Titan',
    title: 'Titan atmosphere and weather',
    speech:
      "Titan has rain, rivers, and lakes, which sounds almost reassuring. Then you find out the rain is methane, and the lakes contain methane and ethane. It's so cold here that water ice behaves like rock. I love that combination: a familiar weather cycle, with the rain and the ground made of things we'd expect to behave very differently.",
    url: 'https://science.nasa.gov/saturn/moons/titan/facts/',
    retrieved: '2026-09-13',
    freshness: 'timeless',
  },
  {
    id: 'titan-huygens',
    object: 'Titan',
    title: 'Huygens landing',
    speech:
      "We've actually landed a probe beneath Titan's haze. In two thousand five, Europe's Huygens descended on parachutes and kept sending measurements after touchdown. Cassini listened from space and relayed those observations to Earth. After carrying Huygens all the way to Saturn, it had one more job to do: help its little passenger phone home.",
    url: 'https://www.esa.int/Science_Exploration/Space_Science/Cassini-Huygens/Europe_reaches_new_frontier_Huygens_lands_on_Titan',
    retrieved: '2026-09-13',
    freshness: 'timeless',
  },
  {
    id: 'enceladus-ocean',
    object: 'Enceladus',
    title: 'Enceladus ocean',
    speech:
      'Enceladus gave away its hidden ocean by wobbling. Cassini watched the moon rock slightly as it orbited Saturn, and the motion was too large for an ice shell frozen solid to the core. A global layer of liquid water lets the shell move more freely. Meanwhile, cracks near the south pole spray water vapor and ice into space.',
    url: 'https://www.jpl.nasa.gov/news/cassini-finds-global-ocean-in-saturns-moon-enceladus/',
    retrieved: '2026-09-13',
    freshness: 'timeless',
  },
]

export function readAstronomyNote(id: string): AstronomyNote | null {
  return ASTRONOMY_NOTES.find((note) => note.id === id) ?? null
}

export function astronomySource(note: AstronomyNote): TourSource {
  return {
    id: `curated:${note.id}`,
    title: note.title,
    url: note.url,
    origin: 'curated',
  }
}

function enrichBrief(brief: SubjectBrief): SubjectBrief {
  if (brief.provenance !== 'observed') return brief
  const notes = ASTRONOMY_NOTES.filter(
    (note) => note.object === brief.name && note.freshness === 'timeless',
  )
  if (notes.length === 0) return brief
  const facts: TourFact[] = notes.map((note) => ({
    id: `${brief.subjectId}:note:${note.id}`,
    label: note.title,
    quantity: null,
    unit: null,
    display: note.speech,
    speech: note.speech,
    reason: null,
    provenance: 'observed',
    sourceIds: [`curated:${note.id}`],
  }))
  const retained = brief.facts
    .filter((fact) => !facts.some((added) => added.id === fact.id))
    .slice(0, 12 - facts.length)
  return {
    ...brief,
    facts: [...facts, ...retained],
    sources: [
      ...brief.sources
        .filter((source) => !source.id.startsWith('curated:'))
        .slice(0, 8 - notes.length),
      ...notes.map(astronomySource),
    ],
  }
}

/** Projected records never inherit measured-world mission history by name. */
export function withAstronomyNotes(context: TourContext): TourContext {
  const briefs = context.briefs.map(enrichBrief)
  return {
    ...context,
    briefs,
    brief: context.brief === null ? null : enrichBrief(context.brief),
    candidates: context.candidates.map((candidate) => ({
      ...candidate,
      factIds:
        briefs
          .find((brief) => brief.subjectId === candidate.id)
          ?.facts.map((fact) => fact.id) ?? candidate.factIds,
    })),
  }
}
