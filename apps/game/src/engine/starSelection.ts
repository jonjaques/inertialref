import { PARSEC } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import {
  populationApparentMagnitude,
  type ResolvedPopulationSelection,
} from '@inertialref/universe'

/*
 * Which stars the sky is drawn from.
 *
 * Three selections feed the star field and none of them knows about the
 * others. The **survey** is the catalog's stars in the cells around the
 * player, read off the local index. The **fill** is the procedural stars of
 * the same cells, invented in a worker. The **sky** is the catalog's distant
 * bright stars — Betelgeuse, Rigel, Deneb — which no survey reaches, because a
 * survey is a cube a hundred light-years across and Deneb is 1,400 out.
 *
 * This is where they meet, and the two things that happen here are the two
 * things a union of independent selections has to do: say the same star once,
 * and stop at the buffer. The result is a pure function of its inputs, so a
 * survey that lands a frame late produces the same sky as one that lands on
 * time.
 */

/**
 * How many stars the instanced sprite buffer has room for.
 *
 * The survey around Sol is a few thousand and the sky asset seven and a half
 * thousand, so the union sits under this with room to spare; the ceiling is
 * what decides which stars go when a denser region does not.
 */
export const STAR_SPRITE_CEILING = 20_000

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
 * Join the survey, the fill and the sky into one field, at most `ceiling`
 * stars, brightest-from-here first when the ceiling binds.
 *
 * **One record per id.** The survey and the sky are disjoint by construction
 * — the sky asset holds only what lies beyond the volume the survey reads —
 * but the field is what the eye sees, and a star said twice is a star drawn
 * at twice its light. The rule is stated here, once, rather than trusted to
 * the two assets agreeing forever. The first selection to name an id keeps
 * it, and the selections are passed in the order they are trusted.
 *
 * **Brightness from the survey's centre.** When the union exceeds the buffer
 * the stars kept are the ones that would look brightest from where the survey
 * was taken — luminosity over distance squared — with the id breaking ties,
 * so two selections that arrive in either order pick the same stars. A first
 * choice was to keep the survey and truncate the sky, which drops Sirius
 * when a player crosses into a dense cell and keeps a hundred stars too faint
 * to draw; brightness is the only ranking that reads the same from inside the
 * field as from the buffer.
 *
 * Nothing is sorted unless the ceiling binds. The common case is well under
 * it, and the draw does not care about order.
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
      // The one-light-year floor is the same one the draw applies: a star the
      // camera is inside has no meaningful flux and must not divide by zero.
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
