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
    id: 'saturn-rings',
    object: 'Saturn',
    title: 'Saturn rings',
    speech:
      'Saturn’s rings contain many separate pieces of ice and rock. They orbit the planet rather than forming a solid sheet.',
    url: 'https://science.nasa.gov/saturn/facts/',
    retrieved: '2026-09-13',
    freshness: 'timeless',
  },
  {
    id: 'saturn-no-surface',
    object: 'Saturn',
    title: 'Saturn structure',
    speech:
      'Saturn is a gas giant without a solid surface where a visitor could stand. Its atmosphere grows denser with depth.',
    url: 'https://science.nasa.gov/saturn/facts/',
    retrieved: '2026-09-13',
    freshness: 'timeless',
  },
  {
    id: 'titan-weather',
    object: 'Titan',
    title: 'Titan atmosphere and weather',
    speech:
      'Titan has a dense atmosphere rich in nitrogen. Methane and ethane form a cycle of clouds, rain, rivers, and lakes on this cold moon.',
    url: 'https://science.nasa.gov/saturn/moons/titan/facts/',
    retrieved: '2026-09-13',
    freshness: 'timeless',
  },
  {
    id: 'titan-huygens',
    object: 'Titan',
    title: 'Huygens landing',
    speech:
      'The European Space Agency’s Huygens probe landed on Titan on January fourteenth, two thousand five. Cassini carried the probe to Saturn and relayed its observations.',
    url: 'https://www.esa.int/Science_Exploration/Space_Science/Cassini-Huygens/Europe_reaches_new_frontier_Huygens_lands_on_Titan',
    retrieved: '2026-09-13',
    freshness: 'timeless',
  },
  {
    id: 'enceladus-ocean',
    object: 'Enceladus',
    title: 'Enceladus ocean',
    speech:
      'Cassini’s measurements of Enceladus’s wobble support a global ocean beneath its icy crust. Water vapor and icy particles escape through fractures near the south pole.',
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
