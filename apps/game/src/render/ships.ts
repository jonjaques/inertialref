import manifest from '../../../../data/models/manifest.json'

/*
 * The ship manifest, as data — no renderer, no Three.js.
 *
 * `shipModels.ts` is the loader and it imports `three/webgpu`, the
 * `GLTFLoader`, and an `import.meta.glob` of the `.glb` files: none of that can
 * be pulled into a Node test. `state/preferences.ts` needs the *set of ship
 * ids* to guard the stored selection, and it is imported by the preferences
 * suite that runs in Node. So the manifest lives here, where it is a leaf that
 * carries only JSON, and both the loader and the registry import it.
 */

export interface ShipModelSpec {
  readonly id: string
  readonly name: string
  /** The short name a chooser puts on a chip — `name` is too long for one. */
  readonly label: string
  readonly file: string
  /** True overall length, which is also the model's extent along its nose axis. */
  readonly lengthMetres: number
  /** Which way the artist pointed the bow. The game's forward is −Z. */
  readonly nose: '+z' | '-z'
  readonly author: string
  readonly source: string
  readonly license: string
}

export const SHIP_SPECS = manifest.models as readonly ShipModelSpec[]

/** Every id a stored ship preference may take. */
export const SHIP_IDS: readonly string[] = SHIP_SPECS.map((spec) => spec.id)

/** Id → the short chip label, for a chooser. */
export const SHIP_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  SHIP_SPECS.map((spec) => [spec.id, spec.label]),
)

/**
 * The hull a new session flies until somebody chooses another.
 *
 * The Enterprise-D, because it is what every screenshot and the reference
 * cutscene are framed against — changing the default would move the ship in
 * pictures the rest of the repository is measured on.
 */
export const DEFAULT_SHIP = 'enterprise-d'

/** The spec for one id, or undefined if this build has no such hull. */
export const shipSpec = (id: string): ShipModelSpec | undefined =>
  SHIP_SPECS.find((spec) => spec.id === id)

/** Every attribution the shipped hulls require, for the credits screen. */
export const MODEL_ATTRIBUTION = manifest.attribution as readonly string[]
