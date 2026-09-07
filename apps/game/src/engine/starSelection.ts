import { PARSEC } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import {
  populationApparentMagnitude,
  type ResolvedPopulationSelection,
} from '@inertialref/universe'

/** The worker's luminosity bands and measured catalog share one V-ranked draw. */
export const STAR_SPRITE_CEILING = 100_000

export interface StarField {
  readonly ids: readonly string[]
  readonly catalogued: readonly boolean[]
  readonly positions: readonly UniverseVector[]
  readonly names: readonly string[]
  /**
   * Linear sRGB per star, from the blackbody color of its temperature.
   *
   * Carried per star rather than picked in the shader because the temperature
   * comes from a published color index for the cataloged half of the sky and
   * from a mass for the rest, and neither is available to a vertex program.
   */
  readonly colours: readonly [number, number, number][]
  /**
   * Bolometric luminosity in solar units. The renderer turns this and the
   * distance into an apparent brightness; a star's size on screen is not a
   * constant.
   */
  readonly luminosities: readonly number[]
  readonly visualLuminosities: readonly number[]
  readonly resolved?: ResolvedPopulationSelection
}

/** One star as any of the three selections offers it. */
export interface StarCandidate {
  readonly id: string
  readonly name: string
  readonly position: UniverseVector
  readonly colour: readonly [number, number, number]
  readonly solarLuminosities: number
  readonly visualLuminosities?: number
  readonly catalogued?: boolean
}

export const EMPTY_STAR_FIELD: StarField = {
  ids: [],
  catalogued: [],
  positions: [],
  names: [],
  colours: [],
  luminosities: [],
  visualLuminosities: [],
}

/**
 * Earlier selections own duplicate ids. When the ceiling binds, the retained
 * V-magnitude cutoff also narrows the diffuse partition. A truncated arbitrary
 * order would leave missing sources subtracted from the haze.
 */
export function selectStars(
  centre: UniverseVector,
  selections: readonly (readonly StarCandidate[])[],
  ceiling: number = STAR_SPRITE_CEILING,
  resolved?: ResolvedPopulationSelection,
): StarField {
  const seen = new Set<string>()
  let chosen: StarCandidate[] = []
  for (const selection of selections) {
    for (const star of selection) {
      if (seen.has(star.id)) continue
      seen.add(star.id)
      chosen.push(star)
    }
  }

  const magnitude = (star: StarCandidate) =>
    populationApparentMagnitude(
      star.visualLuminosities ?? star.solarLuminosities,
      UV.distance(star.position, centre) / PARSEC,
    )
  const requestedMagnitude = resolved?.apparentMagnitudeLimit
  if (requestedMagnitude !== undefined)
    chosen = chosen.filter((star) => magnitude(star) <= requestedMagnitude)

  if (chosen.length > ceiling) {
    const flux = new Map<string, number>()
    for (const star of chosen) {
      // A coincident source has no finite point-source irradiance.
      const metres = Math.max(UV.distance(star.position, centre), 1)
      flux.set(
        star.id,
        (star.visualLuminosities ?? star.solarLuminosities) / (metres * metres),
      )
    }
    chosen = chosen.sort(
      (a, b) =>
        (flux.get(b.id) as number) - (flux.get(a.id) as number) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    if (resolved === undefined) chosen = chosen.slice(0, ceiling)
    else {
      resolved = {
        ...resolved,
        apparentMagnitudeLimit: Math.min(
          resolved.apparentMagnitudeLimit,
          magnitude(chosen[ceiling]!) - 1e-10,
        ),
      }
      chosen = chosen.filter(
        (star) => magnitude(star) <= resolved!.apparentMagnitudeLimit,
      )
    }
  }

  const positions: UniverseVector[] = new Array(chosen.length)
  const ids: string[] = new Array(chosen.length)
  const catalogued: boolean[] = new Array(chosen.length)
  const names: string[] = new Array(chosen.length)
  const colours: [number, number, number][] = new Array(chosen.length)
  const luminosities: number[] = new Array(chosen.length)
  const visualLuminosities: number[] = new Array(chosen.length)
  for (let i = 0; i < chosen.length; i += 1) {
    const star = chosen[i] as StarCandidate
    ids[i] = star.id
    catalogued[i] = star.catalogued ?? false
    positions[i] = star.position
    names[i] = star.name
    colours[i] = [star.colour[0], star.colour[1], star.colour[2]]
    luminosities[i] = star.solarLuminosities
    visualLuminosities[i] = star.visualLuminosities ?? star.solarLuminosities
  }
  return {
    ids,
    catalogued,
    positions,
    names,
    colours,
    luminosities,
    visualLuminosities,
    resolved,
  }
}
