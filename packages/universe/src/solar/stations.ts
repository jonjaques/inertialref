import {
  GRAVITATIONAL_CONSTANT,
  type Kilograms,
  type Radians,
  SECONDS_PER_DAY,
} from '@inertialref/shared'
import { derivePath, Rng, type Seed } from '@inertialref/procedural'
import type { OrbitalElements } from '@inertialref/physics'
import {
  addressLabels,
  bodyAddress,
  entityIdForAddress,
  type GalaxyId,
  satelliteOf,
  type SystemId,
  systemAddress,
} from '../address.ts'
import { orbitalAsset, type OrbitalPlacement } from '../stations.ts'

/*
 * Sol's stations, from published element sets.
 *
 * The same split `solar/system.ts` makes for the moons. The orbit's shape is
 * published and used verbatim: mean motion, eccentricity, inclination to the
 * parent's equator, argument of perigee. Where the station is along it is not
 * a fact the game can honor — the ascending node and the mean anomaly are
 * measured against the real equinox and the real Earth's place in its year,
 * and the game's Earth is not on the real ephemeris — so both are drawn from
 * the station's own seed, as a moon's are.
 *
 * GP elements are SGP4 mean elements, not osculating ones, so read as Kepler
 * elements they do not put the station where SGP4 would. Nothing here asks
 * them to: with the node and the anomaly drawn from the seed, what is kept is
 * the orbit's size, shape and tilt.
 */

export interface SolarStation {
  readonly name: string
  readonly designations: readonly string[]
  /** The body it goes round, as an issue path in Sol; empty for the Sun. */
  readonly parent: readonly number[]
  /**
   * Issue ordinal in the parent's satellite manifest (ADR-0009): never reused
   * and never reordered, and a retired station keeps its tombstone.
   */
  readonly ordinal: number
  readonly asset: string
  readonly mass: Kilograms
  /** Revolutions per day. The semi-major axis is derived from it. */
  readonly meanMotion: number
  readonly eccentricity: number
  /** To the parent's equator. */
  readonly inclination: Radians
  readonly argumentOfPeriapsis: Radians
}

const DEG = Math.PI / 180

/**
 * The International Space Station.
 *
 * CelesTrak GP, NORAD 25544, `ISS (ZARYA)`, `1998-067A`, element set epoch
 * 2026-11-06 11:57:30 UTC, read on 6 November 2026. The mass is NASA's
 * "Space Station Facts and Figures" on the same day.
 */
export const ISS: SolarStation = Object.freeze({
  name: 'International Space Station',
  designations: Object.freeze(['ISS', '1998-067A', '25544']),
  parent: Object.freeze([2]),
  ordinal: 0,
  asset: 'iss',
  mass: 419_725,
  meanMotion: 15.492_142_28,
  eccentricity: 0.000_722_5,
  inclination: 51.632_2 * DEG,
  argumentOfPeriapsis: 355.059_4 * DEG,
})

/** In the order they were issued. Append; never reorder. */
export const SOLAR_STATIONS: readonly SolarStation[] = Object.freeze([ISS])

/**
 * One station, as a placement.
 *
 * `parentMu` is the body's `mu` — or the star's, for a station going round
 * it — because the semi-major axis comes from the published mean motion
 * against `G(M + m)` of the pair: the moons' convention. Summed exactly as
 * `placementMu` sums it, so the axis is solved against the parameter the frame
 * runs on; from the parent's mass instead, the two agree only while every
 * parent's `mu` is its mass times G. The period in the game is then one over
 * the element set's mean motion by construction, which is that number and not
 * the real station's anomalistic or nodal period.
 */
export function solarStation(
  systemSeed: Seed,
  galaxy: GalaxyId,
  system: SystemId,
  station: SolarStation,
  parentMu: number,
): OrbitalPlacement {
  const parent =
    station.parent.length === 0
      ? systemAddress(galaxy, system)
      : bodyAddress(galaxy, system, station.parent)
  const address = satelliteOf(parent, station.ordinal)
  /*
   * The address is the seed path below the system, one `deriveSeed` per
   * label as every generator chains them, so building a station moves nothing
   * its parent draws.
   *
   * Both draws happen, and in this order, whatever is published: the rule
   * `buildBody` follows, so a later draw for this station cannot depend on
   * which elements a source happens to carry.
   */
  const rng = new Rng(derivePath(systemSeed, addressLabels(address).slice(2)))
  const node = rng.range(0, 2 * Math.PI)
  const anomaly = rng.range(0, 2 * Math.PI)

  const mu = parentMu + GRAVITATIONAL_CONSTANT * station.mass
  const meanMotion = (station.meanMotion * 2 * Math.PI) / SECONDS_PER_DAY
  const elements: OrbitalElements = {
    semiMajorAxis: Math.cbrt(mu / (meanMotion * meanMotion)),
    eccentricity: station.eccentricity,
    inclination: station.inclination,
    longitudeOfAscendingNode: node,
    argumentOfPeriapsis: station.argumentOfPeriapsis,
    meanAnomalyAtEpoch: anomaly,
    epoch: 0,
  }
  const asset = orbitalAsset(station.asset)
  if (asset === undefined)
    throw new Error(`${station.name} names no orbital asset ${station.asset}`)
  return Object.freeze({
    id: entityIdForAddress(address),
    address,
    name: station.name,
    designations: station.designations,
    kind: 'station',
    asset: asset.id,
    parent,
    mass: station.mass,
    orbit: Object.freeze({ kind: 'kepler', elements: Object.freeze(elements) }),
    attitude: Object.freeze({ kind: 'nadir' }),
    radius: asset.radius,
    provenance: 'observed',
  })
}
