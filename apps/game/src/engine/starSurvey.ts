import { formatSeed } from '@inertialref/procedural'
import { encodeUniverseVector } from '@inertialref/protocol'
import { getLogger, getTimer, LIGHT_YEAR } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import {
  type CatalogStar,
  GALAXY_SOLAR_V_MAGNITUDE,
  populationCoverage,
} from '@inertialref/universe'
import type { World } from '@inertialref/simulation'
import type { SurveySkyRequest, SurveySkyResponse } from '@inertialref/workers'
import { ENGINE_PHASE } from './frameTiming.ts'
import {
  EMPTY_STAR_FIELD,
  selectStars,
  STAR_SPRITE_CEILING,
  type StarCandidate,
  type StarField,
} from './starSelection.ts'

/*
 * The sky's star sprites, surveyed around the eye and kept until it moves far
 * enough to need another.
 *
 * Everything it holds is derived from one world, so it is keyed on the
 * engine's world generation rather than cleared field by field: a field read
 * at a generation it was not surveyed in is the empty one, and an asynchronous
 * survey that lands after the world was replaced is discarded rather than
 * hung in the new world's sky. That guard is what kept a save loaded in
 * another system from briefly wearing the old system's stars; it was masked
 * for as long as terrain tasks queued ahead of the survey delayed it past
 * every observer.
 */

const log = getLogger('game.engine')
const timer = getTimer('game.engine')

const CELL_CEILING = 2000
const CANDIDATE_CEILING = 1000000
/** How far the eye must move before the starfield is surveyed again. */
const HYSTERESIS = 8 * LIGHT_YEAR

/** A catalog star as the star field's selection sees it. */
const asCandidate = (star: CatalogStar): StarCandidate => ({
  id: star.id,
  name: star.name,
  position: star.position,
  color: [star.physical.color.r, star.physical.color.g, star.physical.color.b],
  solarLuminosities: star.physical.solarLuminosities,
  visualLuminosities:
    star.physical.absoluteMagnitude === null
      ? undefined
      : 10 **
        ((GALAXY_SOLAR_V_MAGNITUDE - star.physical.absoluteMagnitude) / 2.5),
  cataloged: true,
})

/** The world a survey reads: its catalog and the galaxy it is drawn from. */
export type SurveyWorld = Pick<World, 'catalog' | 'galaxySeed'>

/** Runs one survey: on the pool when there is one, inline otherwise. */
export type SurveyRunner = (
  request: SurveySkyRequest,
) => SurveySkyResponse | Promise<SurveySkyResponse>

export interface StarSurveyStatus {
  readonly radiusCells: number
  readonly cellCeiling: number
  readonly candidateCeiling: number
  readonly resolved: StarField['resolved']
  readonly spriteCount: number
  readonly spriteCeiling: number
  readonly pending: boolean
  readonly center: UniverseVector | null
}

export class StarSurvey {
  readonly #run: SurveyRunner
  #generation = 0
  #field: StarField = EMPTY_STAR_FIELD
  #known: readonly StarCandidate[] | null = null
  #coverage: ReturnType<typeof populationCoverage> | null = null
  #center: UniverseVector | null = null
  #pending = false

  constructor(run: SurveyRunner) {
    this.#run = run
  }

  /** The sprites for this generation; empty until one has been surveyed in it. */
  field(generation: number): StarField {
    return generation === this.#generation ? this.#field : EMPTY_STAR_FIELD
  }

  status(generation: number): StarSurveyStatus {
    const field = this.field(generation)
    return {
      radiusCells: 2,
      cellCeiling: CELL_CEILING,
      candidateCeiling: CANDIDATE_CEILING,
      resolved: field.resolved,
      spriteCount: field.positions.length,
      spriteCeiling: STAR_SPRITE_CEILING,
      pending: this.#pending,
      center: generation === this.#generation ? this.#center : null,
    }
  }

  /**
   * Survey around `eye` if it has moved past the hysteresis since the last
   * one, and nothing is in flight. A bounded magnitude survey, independent of
   * the travel query's spatial radius.
   */
  update(generation: number, eye: UniverseVector, world: SurveyWorld): void {
    if (generation !== this.#generation) {
      this.#generation = generation
      this.#field = EMPTY_STAR_FIELD
      this.#known = null
      this.#coverage = null
      this.#center = null
    }
    // A survey from an earlier generation still blocks: its result is
    // discarded when it lands, and the next frame starts this one's.
    if (this.#pending) return
    if (this.#center !== null && UV.distance(this.#center, eye) <= HYSTERESIS)
      return
    this.#center = eye
    this.#pending = true
    const catalog = world.catalog
    const known = (this.#known ??= catalog.stars.map(asCandidate))
    const request: SurveySkyRequest = {
      seed: formatSeed(world.galaxySeed),
      origin: encodeUniverseVector(eye),
      coverage: (this.#coverage ??= populationCoverage(catalog)),
      spriteCeiling: STAR_SPRITE_CEILING,
      cellCeiling: CELL_CEILING,
      candidateCeiling: CANDIDATE_CEILING,
      apparentMagnitudeLimit: 8,
    }
    // The retained sources and their original selection envelope describe the
    // same light partition during travel. Publishing only the catalog between
    // replies removes procedural sources and resets their dust and sky history.
    if (this.#field.resolved === undefined)
      this.#field = selectStars(eye, [known])
    // Inline execution can throw before returning a promise. Start it inside
    // the chain so it has the same failure and pending-state lifetime as a
    // worker.
    void Promise.resolve()
      .then(() => this.#run(request))
      .then((selection) => {
        if (generation !== this.#generation) return
        const applying = timer.span('survey.apply', ENGINE_PHASE)
        const fill: StarCandidate[] = selection.stars.map((star) => ({
          id: star.id,
          name: star.name,
          position: UV.universeVector(...star.position),
          color: star.color,
          solarLuminosities: star.solarLuminosities,
          visualLuminosities: star.visualLuminosities,
          cataloged: false,
        }))
        this.#field = selectStars(eye, [known, fill], STAR_SPRITE_CEILING, {
          origin: eye,
          apparentMagnitudeLimit: selection.apparentMagnitudeLimit,
          levelMask: selection.levelMask,
        })
        applying.end()
        log.info('starfield surveyed', {
          stars: this.#field.positions.length,
          cataloged: known.length,
          fill: fill.length,
          cells: selection.cellsVisited,
          candidates: selection.candidateCount,
          resolved: this.#field.resolved,
        })
      })
      .catch((cause: unknown) => {
        log.warn('starfield survey failed', { cause: String(cause) })
        // A failed worker must not turn the next frame into another full
        // survey. Travel beyond the same hysteresis permits a fresh attempt.
      })
      .finally(() => {
        this.#pending = false
      })
  }
}
