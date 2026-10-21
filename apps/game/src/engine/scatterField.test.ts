import { describe, expect, it } from 'vitest'
import { Quaternion as Q, Vec, vec3, type Vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import {
  type Body,
  type BodyFixedDirection,
  drawnElevation,
  systemId,
  TEST_CATALOG,
  walkBodies,
} from '@inertialref/universe'
import { DEFAULT_LENS, DEFAULT_VIEWPORT } from '@inertialref/rendering'
import {
  type DrawnGround,
  ScatterField,
  type ScatterState,
} from './scatterField.ts'

/*
 * A rock stands on the ground drawn under it.
 *
 * The rock is generated from the field and the ground is a triangulation of
 * it at whatever level is selected there, so the two differ by the mesh's own
 * interpolation error — 79 cm at the floor on Miranda, 1.9 m two levels
 * coarser. These hold the field to the ground it is handed: a rock follows the
 * drawn surface wherever that surface is, and the field is only what it falls
 * back to where nothing is drawn.
 */

const LUNA = ((): Body => {
  const world = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
  for (const body of walkBodies(world.loadSystem(systemId('SOL')))) {
    if (body.name === 'Luna') return body
  }
  throw new Error('no Luna')
})()

const DIRECTION = Vec.normalize(vec3(0.3, 0.42, 0.86)) as BodyFixedDirection
const EYE = Vec.scale(
  DIRECTION,
  LUNA.radius + drawnElevation(LUNA.surface, DIRECTION) + 2,
)
const POSE = { position: vec3(0, 0, 0), orientation: Q.IDENTITY, scale: 1 }
const LENS = { lens: DEFAULT_LENS, viewport: DEFAULT_VIEWPORT }

/** The field itself, offset by `lift`, with its own epoch. */
const fieldGround = (lift: number, epoch: number): DrawnGround => ({
  epoch,
  radius: (direction) =>
    LUNA.radius + drawnElevation(LUNA.surface, direction) + lift,
})

/**
 * Resolve every wanted region, then return the laid-out state: a region is
 * only held once the budget reaches it, so "nothing resolving" is settled
 * only once it has held for a while.
 */
function settle(field: ScatterField, ground: DrawnGround): ScatterState {
  let quiet = 0
  for (let frame = 0; frame < 2_000 && quiet < 30; frame += 1) {
    field.update(LUNA, 'luna', EYE, DIRECTION, POSE, LENS, ground)
    quiet = field.summary().resolving === 0 ? quiet + 1 : 0
  }
  return field.state()
}

/**
 * Every instance's center as a radius from the body's center, keyed by its
 * direction to a centimeter of ground — the two layouts below cut a different
 * rock or two at the range's edge, so they are compared rock by rock.
 */
function radii(state: ScatterState): Map<string, number> {
  const anchor = state.anchor as Vec3
  const out = new Map<string, number>()
  for (const batch of state.batches) {
    for (let i = 0; i < batch.count; i += 1) {
      const m = batch.matrices
      const center = vec3(
        anchor.x + (m[i * 16 + 12] as number),
        anchor.y + (m[i * 16 + 13] as number),
        anchor.z + (m[i * 16 + 14] as number),
      )
      const d = Vec.scale(Vec.normalize(center), LUNA.radius * 100)
      out.set(
        `${Math.round(d.x)},${Math.round(d.y)},${Math.round(d.z)}`,
        Vec.length(center),
      )
    }
  }
  return out
}

describe('a rock is seated on the drawn ground', () => {
  it('follows the drawn surface rather than the field', () => {
    const field = new ScatterField()
    const level = radii(settle(field, fieldGround(0, 1)))
    const lifted = radii(settle(field, fieldGround(0.5, 2)))
    let matched = 0
    for (const [key, radius] of level) {
      const moved = lifted.get(key)
      if (moved === undefined) continue
      // Float32 offsets of up to the range from the anchor resolve to a few
      // hundredths of a millimeter; the lift is half a meter.
      expect(moved - radius).toBeCloseTo(0.5, 3)
      matched += 1
    }
    expect(matched).toBeGreaterThan(level.size * 0.95)
  })

  it('falls back to the field where nothing is drawn', () => {
    const drawn = radii(settle(new ScatterField(), fieldGround(0, 1)))
    const bare = radii(
      settle(new ScatterField(), { epoch: 1, radius: () => null }),
    )
    expect(bare).toEqual(drawn)
  })

  /*
   * The epoch is the drawn set's identity for the layout: a ground that has
   * not changed is not asked again, and one that has is, even with the eye
   * and the regions standing still.
   */
  it('lays the rocks out again only when the drawn ground changes', () => {
    const field = new ScatterField()
    const ground = fieldGround(0, 7)
    const first = settle(field, ground).batches
    field.update(LUNA, 'luna', EYE, DIRECTION, POSE, LENS, ground)
    expect(field.state().batches).toBe(first)
    field.update(LUNA, 'luna', EYE, DIRECTION, POSE, LENS, fieldGround(0, 8))
    expect(field.state().batches).not.toBe(first)
  })
})
