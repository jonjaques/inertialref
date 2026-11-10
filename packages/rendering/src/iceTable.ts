import { ICE_AGGREGATE } from './iceAggregate.generated.ts'
import { halfFloatsFromBase64 } from './mieTable.ts'

/*
 * The ice crystals' phase table: its type, and the decoder of the generated
 * file. One habit, a row an effective diameter, on the droplet table's own
 * angular axis and bands, so the phase atlas holds both classes in one
 * texture and a row of either is read by one lookup.
 */

export interface IceTable {
  /** θ_i = (π/2)(1 − cos(π·i/(angles − 1))), as the droplets' table. */
  readonly angles: number
  /** Rows: effective diameters, `diameterMin + j·diameterStep` µm. */
  readonly diameters: number
  readonly diameterMin: number
  readonly diameterStep: number
  /** nm: the air's three bands. */
  readonly bands: readonly [number, number, number]
  /** sr⁻¹, normalized to ∫p dΩ = 1, laid out [row][angle][band]: diameters × angles × 3. */
  readonly phase: Float32Array
  /** Per row: Q_ext, single-scattering albedo and asymmetry, band-averaged. */
  readonly bulk: readonly {
    readonly extinction: number
    readonly albedo: number
    readonly asymmetry: number
  }[]
}

/** The generated file's form: the table, its phase as base64 little-endian float16, and where it came from. */
export interface IceTableSource {
  readonly format: 'inertialref/ice'
  readonly version: 1
  /** The crystal habit and its roughness, as its source names it. */
  readonly habit: string
  /** The source's citation, its license statement in its own words, and the date it carries. */
  readonly citation: string
  readonly license: string
  readonly sourceDate: string
  readonly angles: number
  readonly diameters: number
  readonly diameterMin: number
  readonly diameterStep: number
  readonly bands: readonly [number, number, number]
  readonly phase: string
  /** Per row: [Q_ext, albedo, asymmetry]. */
  readonly bulk: readonly (readonly [number, number, number])[]
}

/**
 * The table a source describes. Throws on a file that is not one: committed
 * data that does not decode is a broken build, not a table to draw with.
 */
export function decodeIceTable(source: IceTableSource): IceTable {
  if (source.format !== 'inertialref/ice' || source.version !== 1)
    throw new Error('iceTable: not an inertialref/ice table, version 1')
  if (source.bulk.length !== source.diameters)
    throw new Error('iceTable: one bulk entry a row')
  const count = source.diameters * source.angles * 3
  return {
    angles: source.angles,
    diameters: source.diameters,
    diameterMin: source.diameterMin,
    diameterStep: source.diameterStep,
    bands: source.bands,
    phase: halfFloatsFromBase64(
      source.phase,
      count,
      `iceTable (${source.diameters} × ${source.angles} × 3)`,
    ),
    bulk: source.bulk.map(([extinction, albedo, asymmetry]) => ({
      extinction,
      albedo,
      asymmetry,
    })),
  }
}

/** The committed ice table, decoded afresh: a caller owns what it gets. */
export function iceAggregate(): IceTable {
  return decodeIceTable(ICE_AGGREGATE)
}

/** The continuous row of an effective radius, µm: ice maps a radius to a row linearly in diameter. */
export function iceRowIndex(table: IceTable, radius: number): number {
  return (2 * radius - table.diameterMin) / table.diameterStep
}
