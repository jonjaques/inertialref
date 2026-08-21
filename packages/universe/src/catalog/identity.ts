import { type SystemId, systemId } from '../address.ts'

/*
 * Cross-catalogue identity resolution.
 *
 * The step where an ingest silently corrupts itself. HIP 71683, HD 128620,
 * HR 5459 and GJ 559 A are one star; α¹ Cen and α² Cen are two stars in one
 * system; and a save file written last year has to keep pointing at whichever of
 * those the player actually visited. Getting this wrong does not throw — it
 * quietly renames a place, and every address that referred to it is now wrong.
 *
 * Two decisions, and they are separate:
 *
 *   **Which rows are one system.** HYG links multiple stars through
 *   `comp_primary`, so the grouping is the source's, not ours. Deriving it from
 *   proximity instead was considered and rejected: two unrelated stars 0.1 ly
 *   apart on the sky are common, and a positional rule would merge them
 *   permanently.
 *
 *   **What that system is called, forever.** The rule below, in order. It is a
 *   *priority*, not a preference: once a star has an id, later catalogue
 *   versions must produce the same one, so the ladder is ordered by how stable
 *   each designation is rather than by how well-known it is.
 */

export interface IdentitySource {
  /** Hipparcos number, or 0. */
  readonly hip: number
  /** Gliese designation exactly as the catalogue writes it, or `''`. */
  readonly gliese: string
  /** Henry Draper number, or 0. */
  readonly hd: number
  /** Harvard Revised number, or 0. */
  readonly hr: number
  /** The source catalogue's own row key. The last resort. */
  readonly sourceKey: string
  /** IAU proper name, or `''`. */
  readonly proper: string
}

/**
 * Fold a Gliese designation into an id fragment: `Gl 559A` → `GJ559A`.
 *
 * `Gl` and `GJ` are the same catalogue written two ways and must not produce two
 * different ids for one star — which they did, until a star that gained a `GJ`
 * spelling in HYG v4.4 came back as a new system.
 */
export function normaliseGliese(gliese: string): string | null {
  const text = gliese.trim().replace(/\s+/g, '')
  if (text === '') return null
  const folded = text.replace(/^Gl/i, 'GJ').toUpperCase()
  // The character set an address may contain; a designation with a dot or a
  // slash in it is not usable as an id and falls through to the next rung.
  return /^[A-Z][A-Z0-9]*$/.test(folded) ? folded : null
}

/**
 * The canonical id for a system, from its primary component's designations.
 *
 * Order, most stable first:
 *
 *   1. `SOL` — the one hard-coded identity, because the Sun has no catalogue
 *      number in any of these and every other rule would give it an id that
 *      changes when the source does.
 *   2. `HIP…` — Hipparcos. Assigned once in 1997, never reissued, and the
 *      widest coverage of the four (78% within 150 ly).
 *   3. `GJ…` — Gliese. Stable, and the fallback that covers most of what
 *      Hipparcos missed, because the nearby-star catalogue is exactly where the
 *      faint red dwarfs are.
 *   4. `HD…`, then `HR…` — older and brighter-biased, so they only ever catch
 *      stars the first three missed.
 *   5. The source row key, as `HYG…`. Reported by the ingest as a count, because
 *      these are the ids that a catalogue rebuild can change, and a change here
 *      is a save file pointing at nothing.
 */
export function canonicalSystemId(source: IdentitySource): SystemId {
  if (source.proper.trim() === 'Sol') return systemId('SOL')
  if (source.hip > 0) return systemId(`HIP${source.hip}`)
  const gliese = normaliseGliese(source.gliese)
  if (gliese !== null) return systemId(gliese)
  if (source.hd > 0) return systemId(`HD${source.hd}`)
  if (source.hr > 0) return systemId(`HR${source.hr}`)
  return systemId(`HYG${source.sourceKey.replace(/[^A-Za-z0-9]/g, '')}`)
}

/** True for ids that only a catalogue rebuild's row numbering guarantees. */
export const isUnstableId = (id: SystemId): boolean => id.startsWith('HYG')
