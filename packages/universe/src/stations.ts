import type { Kilograms, Meters } from '@inertialref/shared'
import type { OrbitalElements } from '@inertialref/physics'
import type { Quat, Vec3 } from '@inertialref/spatial'
import type { EntityId, UniverseAddress } from './address.ts'
import type { SupportFeature } from './structures.ts'
import type { BodyProvenance } from './system.ts'

/*
 * Orbital placements: something built that goes round a body or a star.
 *
 * Neither a body nor an entity, and the difference is the whole design. A
 * `Body` carries mass that pulls, a sphere of influence a ship is reframed
 * into, terrain a streamer reads and an appearance the planet shader draws,
 * and every path that walks bodies — the patched-conic transitions, the terrain
 * candidates, the census — would need an exception for a thing with none of
 * them. An entity is integrated, interpolated, hashed and saved, and a station
 * on a Kepler orbit is a closed-form function of time as a moon is: exact at
 * any warp, with nothing to integrate, save or replicate.
 *
 * One record shape whatever produced it — Sol's catalog now, a generator and
 * a builder later — so every consumer reads the placement and never asks where
 * it came from. ADR-0059.
 */

/**
 * What a placement is. A closed union, widened as kinds arrive, so a reader
 * that switches on it stops compiling when a new kind needs a decision.
 */
export type OrbitalKind = 'station'

/**
 * How a placement moves about its parent.
 *
 * A discriminated union of one: a libration orbit about a Lagrange point is
 * the next member when something needs one, and each member is analytic, so a
 * placement's frame is always a pure function of time.
 */
export type OrbitLaw = {
  readonly kind: 'kepler'
  /**
   * Measured from the parent's equator, the moons' convention, and moved
   * by `G(M + m)` of the pair: the frame erects the equator from the parent's
   * axial tilt exactly as a moon's does.
   */
  readonly elements: OrbitalElements
}

/**
 * How a placement turns.
 *
 * `nadir` is local vertical, local horizontal: forward along the orbital
 * motion, the keel toward the parent, the right side opposite the orbit
 * normal. The ISS flies that way (`+XVV`). An inertially fixed telescope and a
 * spinning station are the next members; each is analytic, as an orbit is.
 */
export type Attitude = { readonly kind: 'nadir' }

export interface OrbitalPlacement {
  /**
   * `@<address>` for a derived placement. A built one will carry an id its
   * authority mints, never an `a:` ordinal: two issuers in one ordinal space
   * collide the first time the catalog appends.
   */
  readonly id: EntityId
  /** The address it derives from; null for a built placement. */
  readonly address: UniverseAddress | null
  readonly name: string
  /** Every string it can be searched by: `ISS`, `1998-067A`, `25544`. */
  readonly designations: readonly string[]
  readonly kind: OrbitalKind
  /** A key into `ORBITAL_ASSETS`; the host maps it to a model. */
  readonly asset: string
  /** The body or the system it goes round. */
  readonly parent: UniverseAddress
  /**
   * In the orbit law's `G(M + m)`, which is the moons' convention and what
   * makes the in-game period the published one. Nothing feels it pull.
   */
  readonly mass: Kilograms
  readonly orbit: OrbitLaw
  readonly attitude: Attitude
  /** A sphere about the placement's origin that holds all of it, at any joint angle. */
  readonly radius: Meters
  /**
   * The ISS is `observed`. What a generated or a built station reads as is
   * the content ADR's to decide with the first of them: both words are claims
   * about real astronomy, and a station in the setting is neither.
   */
  readonly provenance: BodyProvenance
}

/**
 * A pad a ship can set down on: a pose in the station's own axes, +Y the
 * pad's up, and the walkable tops a Mars pad already describes, in pad axes.
 *
 * Declared now so the asset record does not assume a station has none; the
 * contact test against them, and the frame each hangs, come with landing.
 */
export interface StationPad {
  readonly id: string
  readonly position: Vec3
  readonly orientation: Quat
  readonly support: readonly SupportFeature[]
}

/** Physical facts about reusable orbital hardware; the host chooses its artwork. */
export interface OrbitalAssetDefinition {
  readonly id: string
  readonly name: string
  /**
   * A sphere about the asset's origin that holds every vertex at every
   * angle its joints can reach. The asset test measures it from the shipped
   * mesh, so this is the mesh's own figure rather than a published span.
   */
  readonly radius: Meters
  readonly pads: readonly StationPad[]
}

export const ORBITAL_ASSETS: readonly OrbitalAssetDefinition[] = Object.freeze([
  Object.freeze({
    id: 'iss',
    name: 'International Space Station',
    /*
     * About the center of the S0 truss, which is on the alpha joints' axis:
     * turning an alpha joint moves no vertex nearer or farther, and the reach
     * is set by the outboard wings sweeping round their masts. 61.4 m with the
     * arrays as the model leaves them.
     */
    radius: 65.3,
    pads: Object.freeze([]),
  }),
])

export const orbitalAsset = (id: string): OrbitalAssetDefinition | undefined =>
  ORBITAL_ASSETS.find((asset) => asset.id === id)
