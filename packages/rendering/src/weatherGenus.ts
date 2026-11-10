import {
  CLOUD_GENERA,
  type CloudGenus,
  genusProfile,
  SCENARIO_IDS,
  WEATHER_SCENARIOS,
} from './weatherScenario.ts'

/*
 * The genus table: what a cloud genus is, apart from where a weather puts
 * it. A phase class, how its water grows with height, its mean in-cloud
 * extinction, its droplets, its cell and its edge, and the thickness a layer
 * of it may have.
 *
 * Unscaled throughout: a genus's `sigma` is the extinction a retrieval
 * reports, at `Q_ext` near 2, and what a transmittance is formed from is
 * `scaledExtinction` of it (phase 1 design §5.1). Arithmetic alone, so the
 * frame's derivation, the profile table's bake and the calibration read one
 * table in Node.
 *
 * **The table is a stand-in.** Each genus carries the figures of its first
 * layer in `WEATHER_SCENARIOS`, with flat water and one radius through the
 * level, so a weather built from this table is the placeholder the passes
 * draw. The measured table, and the adiabatic growth, replace it whole.
 */

/** What scatters: the droplets' Mie rows of the phase atlas, or the ice rows. */
export type GenusClass = 'droplets' | 'ice'

/**
 * How a genus's water grows over its base: adiabatically, adiabatically to
 * its mean and flat above, or not at all.
 */
export type GenusWater = 'adiabatic' | 'capped' | 'flat'

export interface GenusSpec {
  readonly class: GenusClass
  readonly water: GenusWater
  /** A level of this genus is cumuliform: its climate's convective share is 1. */
  readonly cumuliform: boolean
  /** Mean in-cloud extinction, unscaled, 1/m. */
  readonly sigma: number
  /** Effective radius at the level's reference height, µm. */
  readonly radius: number
  /** The least and greatest thickness a regime may give a layer of it, meters. */
  readonly thickness: readonly [least: number, greatest: number]
  /** One Worley cell of the base noise, meters. */
  readonly cell: number
  /** How far the detail noise eats the edge, 0..1. */
  readonly erosion: number
}

function standIn(genus: CloudGenus): GenusSpec {
  for (const id of SCENARIO_IDS)
    for (const layer of WEATHER_SCENARIOS[id].layers)
      if (layer.genus === genus) {
        const thickness = layer.top - layer.base
        return {
          class: genus === 'cirrus' ? 'ice' : 'droplets',
          water: 'flat',
          cumuliform: genus === 'cumulus' || genus === 'cumulonimbus',
          sigma: layer.sigma,
          radius: layer.radius,
          thickness: [thickness, thickness],
          cell: layer.cellMeters,
          erosion: layer.erosion,
        }
      }
  throw new Error(`weatherGenus: no scenario holds a layer of ${genus}`)
}

export const GENUS_TABLE: Readonly<Record<CloudGenus, GenusSpec>> =
  /*@__PURE__*/ Object.freeze(
    Object.fromEntries(
      CLOUD_GENERA.map((genus) => [genus, standIn(genus)]),
    ) as Record<CloudGenus, GenusSpec>,
  )

/**
 * The water's growth over a level, `w(h)`, normalized to a mean of one:
 * `h01` is 0 at the base and 1 at the top. One through a flat genus.
 */
export function genusWater(genus: CloudGenus, _h01: number): number {
  const { water } = GENUS_TABLE[genus]
  // Every genus of the stand-in table is flat. A growth rule this cannot
  // draw is refused, not drawn flat: a table that names one needs its law.
  if (water !== 'flat')
    throw new Error(`weatherGenus: ${genus} grows ${water}, which is not drawn`)
  return 1
}

/**
 * The extinction's shape with height, `σ(h)/σ_ref`: the genus's edge, its
 * rise from the base and fall to the top, times `w(h)^⅔`. Zero outside the
 * level.
 */
export function genusExtinctionShape(genus: CloudGenus, h01: number): number {
  return genusProfile(genus, h01) * genusWater(genus, h01) ** (2 / 3)
}

/** The radius's shape with height, `r_e(h)/r_ref = w(h)^⅓`. */
export function genusRadiusShape(genus: CloudGenus, h01: number): number {
  return genusWater(genus, h01) ** (1 / 3)
}

/**
 * `σ′ = (1 − f_δ)·σ`: the extinction every transmittance is formed from,
 * with the droplets' diffraction half taken out as light that goes on.
 * `share` is `f_δ`, `diffractionShare` of the phase table at the radius.
 */
export function scaledExtinction(sigma: number, share: number): number {
  return (1 - share) * sigma
}
