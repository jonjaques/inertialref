import type { Meters } from '@inertialref/shared'
import { type Vec3, vec3 } from '@inertialref/spatial'
import type { Nozzle, NozzleKind, ThrusterLayout } from '@inertialref/rendering'

/*
 * Where each hull's valves are, measured off the shipped glTF.
 *
 * Every number here is a reading from `scripts/nozzles.mjs` over the model in
 * `data/models/`, in the game's hull axes — recentred, scaled to the
 * manifest's length, bow turned to −Z — so it can be checked against the
 * artwork by running the script again. Nothing is estimated from a drawing
 * of the ship. The one liberty is symmetry: where the artist modeled one
 * side of a pair, or one of four corners, the mirror is written out here,
 * and `thrusterLayouts.test.ts` holds the table to it.
 *
 * As data with no Three.js, like `ships.ts` and for the same reason: the
 * test runs in Node, and the loader is the only module that should pull the
 * renderer.
 */

/** A nozzle on the centreline, or its measured position as given. */
const nozzle = (
  kind: NozzleKind,
  radius: Meters,
  position: Vec3,
  exhaust: Vec3,
): Nozzle => ({ position, exhaust, radius, kind })

/** The measured nozzle and its mirror through the centreline plane. */
const pair = (
  kind: NozzleKind,
  radius: Meters,
  position: Vec3,
  exhaust: Vec3,
): readonly Nozzle[] => [
  nozzle(kind, radius, position, exhaust),
  nozzle(
    kind,
    radius,
    vec3(-position.x, position.y, position.z),
    vec3(-exhaust.x, exhaust.y, exhaust.z),
  ),
]

/** One measured corner and the other three, mirrored across both planes. */
const corners = (
  kind: NozzleKind,
  radius: Meters,
  position: Vec3,
  exhaust: Vec3,
): readonly Nozzle[] =>
  [1, -1].flatMap((sy) =>
    pair(
      kind,
      radius,
      vec3(position.x, sy * position.y, position.z),
      vec3(exhaust.x, sy * exhaust.y, exhaust.z),
    ),
  )

/**
 * The Rocinante. 46 m; the reading is of `rocinante.glb`.
 *
 * Three groups of valves, and the artist named the first. The bow carries a
 * cluster of ten `thruster_N` shells — fourteen mouths, four of them modeled
 * as mirrored pairs in one mesh — each a 20 cm capped bump whose open loop is
 * its attachment to the hull, so the exhaust axis is the shell's mean face
 * normal, which leans away from the hull; the loop's own normal points into
 * it. The belly carries six `engines_secondary` pods, hexagonal housings with
 * a round lip at the tip, and the lip's centre and normal are what is used.
 * The stern has one pod modeled at its bottom-starboard corner and holes in
 * `hull_rear` at all four, 0.3 m from where the pod's ring sits, so the four
 * corners are the one ring mirrored twice.
 *
 * Read and left out: eight hexagonal ports at the aft sides
 * (`hull_rear_sides_accessory_6.003`), which could be vents as easily as
 * valves, and the dorsal loops under the mast and the sensor mounts, which
 * face into the hull.
 *
 * The drive: the skirt's mouth is 3.70 m at z 21.44 and its inner ring 3.65 m
 * at 21.26; the throat piece on the axis reaches 21.13. The exit plane sits
 * just aft of the throat and just inside the ring, so the rim stands in front
 * of it from any angle but dead astern and nothing on the axis pokes through
 * it — at 21.0 the throat came through the disk as a dark ring.
 */
const ROCINANTE: ThrusterLayout = {
  nozzles: [
    // The bow cluster — `thruster_1` to `thruster_10`.
    nozzle('rcs', 0.1, vec3(0, 1.737, -15.049), vec3(0, 1, 0)),
    nozzle('rcs', 0.1, vec3(0, 1.493, -15.831), vec3(0, 0.829, -0.559)),
    ...pair(
      'rcs',
      0.1,
      vec3(0.674, 1.526, -15.388),
      vec3(0.536, 0.772, -0.342),
    ),
    ...pair('rcs', 0.1, vec3(0.342, 1.06, -16.466), vec3(0, 0.829, -0.559)),
    nozzle('rcs', 0.1, vec3(0, 0.367, -17.547), vec3(0, 0.994, -0.113)),
    // The retro jet at the very tip, blowing straight ahead.
    nozzle('rcs', 0.1, vec3(0, -0.05, -17.717), vec3(0, -0.054, -0.999)),
    ...pair(
      'rcs',
      0.1,
      vec3(2.092, -0.026, -16.018),
      vec3(0.939, 0.062, -0.337),
    ),
    ...pair(
      'rcs',
      0.1,
      vec3(1.542, 0.009, -17.056),
      vec3(0.483, 0.388, -0.785),
    ),
    nozzle('rcs', 0.1, vec3(0, -0.937, -17.112), vec3(0, -0.667, -0.745)),
    // The one large bow valve, under the chin, blowing straight down.
    nozzle('rcs', 0.2, vec3(0, -1.139, -16.125), vec3(0, -1, 0)),
    // The belly pods — `engines_secondary_front` and `_middle`.
    ...pair(
      'pod',
      0.49,
      vec3(2.725, -2.131, -8.005),
      vec3(0.449, -0.888, -0.102),
    ),
    ...pair('pod', 0.69, vec3(4.106, -2.64, 1.422), vec3(0.54, -0.842, 0)),
    ...pair('pod', 0.69, vec3(4.106, -2.64, 3.597), vec3(0.54, -0.842, 0)),
    // The stern corners — `engines_secondary_rear`, mirrored to four.
    ...corners(
      'pod',
      0.49,
      vec3(3.272, -3.163, 12.022),
      vec3(0.689, -0.681, 0.246),
    ),
  ],
  drive: { position: vec3(0, 0.011, 21.2), radius: 3.6 },
}

const LAYOUTS: Readonly<Record<string, ThrusterLayout>> = {
  rocinante: ROCINANTE,
}

/** Every hull id with a measured layout, for the test that holds them. */
export const LAID_OUT_SHIPS: readonly string[] = Object.keys(LAYOUTS)

/**
 * The layout for a hull id; empty for one nobody has measured.
 *
 * The Enterprise is the notable absence: its impulse engines are grilles
 * rather than nozzles and its reaction control is not modeled, so it flies
 * with nothing drawn, which is at least honest. The debug cone is not here
 * at all — `ThrusterFx` draws nothing until a hull has loaded.
 */
export function thrusterLayoutFor(id: string): ThrusterLayout {
  return LAYOUTS[id] ?? EMPTY
}

const EMPTY: ThrusterLayout = { nozzles: [], drive: null }
