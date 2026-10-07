import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Quaternion, fromMeters } from '@inertialref/spatial'
import type { EntityId } from '@inertialref/universe'
import { type FrameOwnerInput, resolveFrameOwner } from './frameOwner.ts'

const pose = (x: number) => ({
  position: fromMeters(x, 0, 0),
  orientation: Quaternion.IDENTITY,
})

const PLAYER = 'player' as EntityId
const SHIP = 'ship' as EntityId

describe('the frame owner', () => {
  it('is the first arm present, in the one precedence order', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (cutscene, observatory, walker, player) => {
          const input: FrameOwnerInput = {
            cutscene: cutscene ? pose(1) : null,
            observatory: observatory ? pose(2) : null,
            walker: walker ? pose(3) : null,
            player: player ? { id: PLAYER, ...pose(4) } : null,
            walkerShip: walker ? SHIP : null,
            walking: walker,
          }
          const expected = cutscene
            ? 'cutscene'
            : observatory
              ? 'observatory'
              : walker
                ? 'walker'
                : player
                  ? 'ship'
                  : null
          const owner = resolveFrameOwner(input)
          expect(owner?.arm ?? null).toBe(expected)
          // The scene's eye is the arm's own pose on every arm but the ship's,
          // where the entity is the eye and carries its altitude.
          if (owner !== null)
            expect(owner.eye).toBe(
              owner.arm === 'ship' ? undefined : owner.pose,
            )
        },
      ),
    )
  })

  it("names the walker's ship on foot, whatever arm holds the camera", () => {
    for (const arm of ['cutscene', 'observatory', 'walker'] as const) {
      const owner = resolveFrameOwner({
        cutscene: arm === 'cutscene' ? pose(1) : null,
        observatory: arm === 'observatory' ? pose(2) : null,
        walker: pose(3),
        player: { id: PLAYER, ...pose(4) },
        walkerShip: SHIP,
        walking: true,
      })
      expect(owner?.arm).toBe(arm)
      expect(owner?.ship).toBe(SHIP)
    }
  })

  it('names the player as its own ship when it is flying one', () => {
    const owner = resolveFrameOwner({
      cutscene: null,
      observatory: null,
      walker: null,
      player: { id: PLAYER, ...pose(4) },
      walkerShip: null,
      walking: false,
    })
    expect(owner?.ship).toBe(PLAYER)
    expect(owner?.pose.position).toEqual(pose(4).position)
  })

  it('draws a playerless observatory frame, and names no ship in it', () => {
    const owner = resolveFrameOwner({
      cutscene: null,
      observatory: pose(2),
      walker: null,
      player: null,
      walkerShip: null,
      walking: false,
    })
    expect(owner?.arm).toBe('observatory')
    expect(owner?.ship).toBeNull()
  })
})
