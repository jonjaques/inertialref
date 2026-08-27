import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  faceToDirection,
  regionDirection,
  regionForDirection,
} from '@inertialref/universe'
import { terrainLevelFor, terrainOpacity } from './lod.ts'
import {
  TERRAIN_WINDOW_RADIUS,
  terrainPatchKey,
  terrainWindow,
} from './terrainWindow.ts'

/*
 * The streamer's selection rule, asked questions no browser has to answer.
 *
 * This is the extraction's whole payoff, and the tests are written against the
 * rule *as it is* rather than as Phase 1 will leave it — a window three patches
 * wide at one level, with the patches that fall off a cube face dropped. Both
 * limits are asserted here, so the phase that fixes them has to change a test
 * on purpose rather than watch one keep passing for the wrong reason.
 */

const EARTH = 6_371_000
const radii = fc.double({ min: 1e5, max: 2e7, noNaN: true })
/** Anywhere between standing on it and being far enough away to see nothing. */
const distances = fc.double({ min: 1.000_001, max: 1e4, noNaN: true })

/** A direction, produced the only way the brand permits. */
const directions = fc
  .tuple(
    fc.integer({ min: 0, max: 5 }),
    fc.double({ min: -0.999, max: 0.999, noNaN: true }),
    fc.double({ min: -0.999, max: 0.999, noNaN: true }),
  )
  .map(([face, u, v]) => faceToDirection(face, u, v))

describe('the terrain window', () => {
  it('reports exactly the level and opacity the LOD rule chooses', () => {
    // Not a restatement of the implementation: the point is that pulling the
    // rule out of the streamer did not change it, so the baseline this measures
    // describes the build that shipped.
    fc.assert(
      fc.property(
        radii,
        distances,
        directions,
        (radius, multiple, direction) => {
          const distance = radius * multiple
          const window = terrainWindow(radius, distance, direction)
          expect(window.level).toBe(terrainLevelFor(radius, distance))
          expect(window.opacity).toBe(terrainOpacity(radius, distance))
        },
      ),
    )
  })

  it('asks for a full ring where the ground is, and never a duplicate', () => {
    const side = 2 * TERRAIN_WINDOW_RADIUS + 1
    fc.assert(
      fc.property(radii, distances, directions, (radius, multiple, d) => {
        const window = terrainWindow(radius, radius * multiple, d)
        expect(window.regions.length + window.clipped).toBe(side * side)
        const keys = new Set(
          window.regions.map((region) => terrainPatchKey('b', region)),
        )
        expect(keys.size).toBe(window.regions.length)
      }),
    )
  })

  it('contains the region the camera is actually over', () => {
    fc.assert(
      fc.property(radii, distances, directions, (radius, multiple, d) => {
        const window = terrainWindow(radius, radius * multiple, d)
        expect(window.centre).toEqual(regionForDirection(d, window.level))
        expect(
          window.regions.some(
            (region) =>
              region.face === window.centre.face &&
              region.i === window.centre.i &&
              region.j === window.centre.j,
          ),
        ).toBe(true)
      }),
    )
  })

  it('loses patches at a cube-face corner, and says how many', () => {
    /*
     * The hole the survey's `corner` site exists to stand in.
     *
     * Three faces meet at each of the cube's eight corners, and a window
     * centered on one has five of its nine neighbors on other faces. Today they
     * are dropped rather than wrapped — stitching across a face boundary is
     * Phase 1's cross-face adjacency — so the visible ground there is four
     * patches out of nine. Asserting the number rather than "some are missing"
     * is what makes the fix visible as a diff.
     */
    const corner = faceToDirection(0, 0.9999, 0.9999)
    const window = terrainWindow(EARTH, EARTH * 1.0002, corner)
    expect(window.clipped).toBe(5)
    expect(window.regions).toHaveLength(4)

    // And in the middle of a face nothing is lost at all.
    const middle = faceToDirection(0, 0, 0)
    expect(terrainWindow(EARTH, EARTH * 1.0002, middle).clipped).toBe(0)
  })

  it('is a pure function of its arguments', () => {
    // Order-independence, in the form this rule can have it: the same camera
    // asked twice, with a different camera in between, gets the same answer.
    fc.assert(
      fc.property(
        radii,
        distances,
        directions,
        directions,
        (radius, multiple, a, b) => {
          const first = terrainWindow(radius, radius * multiple, a)
          terrainWindow(radius, radius * 3, b)
          expect(terrainWindow(radius, radius * multiple, a)).toEqual(first)
        },
      ),
    )
  })

  it('descends monotonically: closer is never a coarser level', () => {
    fc.assert(
      fc.property(radii, directions, (radius, direction) => {
        let previous = -1
        for (const multiple of [4, 2, 1.5, 1.1, 1.01, 1.0001]) {
          const level = terrainWindow(
            radius,
            radius * multiple,
            direction,
          ).level
          expect(level).toBeGreaterThanOrEqual(previous)
          previous = level
        }
      }),
    )
  })

  it('keys a patch by body and address, and nothing else', () => {
    const region = regionForDirection(
      regionDirection({ face: 3, level: 7, i: 11, j: 42 }, 0.5, 0.5),
      7,
    )
    expect(terrainPatchKey('s:SOL/b:2', region)).toBe('s:SOL/b:2|3.7.11.42')
  })
})
