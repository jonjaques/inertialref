import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec } from '@inertialref/spatial'
import {
  HEIGHTFIELD_RESOLUTION,
  regionAddress,
  regionDirection,
  regionForDirection,
  regionNeighbor,
  regionParent,
} from '@inertialref/universe'
import {
  DEFAULT_CELL_PIXELS,
  DEFAULT_MAX_LEVEL,
  DEFAULT_VIEWPORT,
  MORPH_END,
  MORPH_START,
  NO_MORPH_DISTANCE,
  nodeDistance,
  pixelsPerRadian,
  regionCone,
  regionSpacing,
  type TerrainEye,
  selectTerrain,
  type SelectedPatch,
  terrainPatchKey,
} from './terrainSelect.ts'

/*
 * The quadtree, asked questions no browser has to answer.
 *
 * These replace the window's tests, and two of them replace an assertion with
 * its opposite on purpose: the window lost five of nine patches over a cube
 * corner and faded out entirely an octave above the ground, and both were
 * pinned so that fixing them would have to be deliberate. This is the deliberate
 * part.
 */

const EARTH = 6_371_000
/** Miranda: 4.8 km of Verona Rupes on a 235.8 km moon, which is 2% of it. */
const MIRANDA = { radius: 235_800, relief: 5_000 }

const directions = fc
  .tuple(
    fc.integer({ min: 0, max: 5 }),
    fc.double({ min: 0.001, max: 0.999, noNaN: true }),
    fc.double({ min: 0.001, max: 0.999, noNaN: true }),
  )
  .map(([face, s, t]) => regionDirection(regionAddress(face, 0, 0, 0), s, t))

const eyeAt = (
  radius: number,
  relief: number,
  height: number,
  direction: TerrainEye['direction'],
): TerrainEye => ({ radius, relief, distance: radius + height, direction })

const contains = (patch: SelectedPatch, direction: TerrainEye['direction']) => {
  const held = regionForDirection(direction, patch.region.level)
  return (
    held.face === patch.region.face &&
    held.i === patch.region.i &&
    held.j === patch.region.j
  )
}

describe('the terrain quadtree', () => {
  it('covers the visible disk exactly once, with no hole at a face corner', () => {
    /*
     * The window's own test asserted `clipped === 5` at a cube corner — five of
     * nine patches dropped because the neighborhood ran off the face. There is
     * no neighborhood any more: the traversal starts at all six faces, so
     * ground near an edge is reached from whichever face owns it. What replaces
     * "how many did we lose" is "every direction you can see is inside exactly
     * one patch", which is the property the hole was a violation of.
     */
    const corner = regionDirection(regionAddress(0, 0, 0, 0), 0.99995, 0.99995)
    const eye = eyeAt(EARTH, 8_000, 400_000, corner)
    const selection = selectTerrain(eye)
    expect(selection.patches.length).toBeGreaterThan(20)

    // Everything comfortably inside the horizon. The cull is conservative at
    // the boundary itself — a cone can straddle it — so the sweep stops short
    // of the edge rather than asserting where a conservative test lands.
    const horizon = Math.acos((EARTH - 8_000) / eye.distance)
    for (const fraction of [0, 0.2, 0.5, 0.8]) {
      for (let turn = 0; turn < 8; turn += 1) {
        const angle = horizon * fraction
        const spun = spin(corner, angle, (turn * Math.PI) / 4)
        const covering = selection.patches.filter((patch) =>
          contains(patch, spun),
        )
        expect(covering).toHaveLength(1)
      }
    }
  })

  it('never selects the far side of the body', () => {
    const eye = eyeAt(
      EARTH,
      8_000,
      400_000,
      regionDirection(regionAddress(4, 0, 0, 0), 0.5, 0.5),
    )
    const selection = selectTerrain(eye)
    expect(selection.culled).toBeGreaterThan(0)
    const antipode = Vec.scale(eye.direction, -1)
    for (const patch of selection.patches) {
      const cone = regionCone(patch.region)
      const separation = Math.acos(
        Math.min(1, Math.max(-1, Vec.dot(antipode, cone.axis))),
      )
      // Nothing selected reaches the point directly opposite the camera.
      expect(separation).toBeGreaterThan(cone.halfAngle)
    }
  })

  it('measures altitude to the ground, not to the datum', () => {
    /*
     * Phase 0's headline defect, as a test. Standing two meters over Miranda's
     * highest ground the old rules were handed `distance − radius`, which there
     * is 4,802 m — a level coarse at best, and above `radius · 2^(5.5 − 12)`
     * the terrain faded out entirely, so the summit could not be looked at from
     * any altitude including zero. Here the node is a cone crossed with the
     * shell the ground occupies, so an eye inside that shell is at zero.
     */
    const direction = regionDirection(regionAddress(2, 0, 0, 0), 0.4, 0.6)
    const summit = MIRANDA.radius + 4_826 + 2
    const selection = selectTerrain({
      radius: MIRANDA.radius,
      relief: MIRANDA.relief,
      distance: summit,
      direction,
    })
    expect(selection.deepestLevel).toBe(DEFAULT_MAX_LEVEL)
    const under = selection.patches.filter((patch) =>
      contains(patch, direction),
    )
    expect(under).toHaveLength(1)
    expect((under[0] as SelectedPatch).region.level).toBe(DEFAULT_MAX_LEVEL)

    // And the same height over the deepest basin asks for the same level. Same
    // body, same height above the ground: Phase 0 measured 11 against 12.
    const basin = MIRANDA.radius - 4_826 + 2
    const low = selectTerrain({
      radius: MIRANDA.radius,
      relief: MIRANDA.relief,
      distance: basin,
      direction,
    })
    expect(low.deepestLevel).toBe(selection.deepestLevel)
  })

  it('refines monotonically on the way down (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e5, max: 2e7, noNaN: true }),
        directions,
        (radius, direction) => {
          let previous = -1
          for (const height of [
            radius,
            radius / 8,
            radius / 64,
            radius / 1024,
            2,
          ]) {
            const { deepestLevel } = selectTerrain(
              eyeAt(radius, radius * 0.002, height, direction),
            )
            expect(deepestLevel).toBeGreaterThanOrEqual(previous)
            previous = deepestLevel
          }
        },
      ),
    )
  })

  it('is a pure function of the eye and the body (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e5, max: 2e7, noNaN: true }),
        fc.double({ min: 1.0001, max: 100, noNaN: true }),
        directions,
        directions,
        (radius, multiple, a, b) => {
          const eye = eyeAt(radius, radius * 0.01, radius * (multiple - 1), a)
          const first = selectTerrain(eye)
          selectTerrain(eyeAt(radius, radius * 0.01, radius * 3, b))
          expect(selectTerrain(eye)).toEqual(first)
        },
      ),
    )
  })

  it('stops at the parent rather than leaving a hole', () => {
    const direction = regionDirection(regionAddress(1, 0, 0, 0), 0.3, 0.7)
    const eye = eyeAt(EARTH, 8_000, 2, direction)
    const nothing = selectTerrain(eye, { ready: () => false })
    // Six cube faces, minus whatever the horizon takes.
    expect(nothing.patches.length).toBeLessThanOrEqual(6)
    expect(nothing.deepestLevel).toBe(0)
    expect(nothing.starved.length).toBeGreaterThan(0)

    // And with everything ready it reaches the floor. The point of the pair is
    // that a missing heightfield costs detail, never coverage: both selections
    // still cover the ground under the eye exactly once.
    const all = selectTerrain(eye)
    expect(all.deepestLevel).toBe(DEFAULT_MAX_LEVEL)
    for (const selection of [nothing, all]) {
      expect(
        selection.patches.filter((patch) => contains(patch, direction)),
      ).toHaveLength(1)
    }
  })

  it('spends a budget a level at a time rather than a face at a time', () => {
    const direction = regionDirection(regionAddress(3, 0, 0, 0), 0.5, 0.5)
    const eye = eyeAt(EARTH, 8_000, 5_000, direction)
    const full = selectTerrain(eye)
    const capped = selectTerrain(eye, { maxPatches: 24 })
    expect(capped.saturated).toBe(true)
    expect(capped.patches.length).toBeLessThanOrEqual(24)
    expect(capped.deepestLevel).toBeLessThan(full.deepestLevel)
    /*
     * The whole disk degrades together. A budget spent depth-first would leave
     * one cube face at the floor and the rest at level 1, with a seam down the
     * middle; breadth-first stops the frontier where it is, so what the cap
     * takes is the *deepest* level from everybody at once. The check is that no
     * cube face kept detail the others lost.
     */
    const deepestPerFace = new Map<number, number>()
    for (const patch of capped.patches) {
      const face = patch.region.face
      deepestPerFace.set(
        face,
        Math.max(deepestPerFace.get(face) ?? 0, patch.region.level),
      )
    }
    const deepest = [...deepestPerFace.values()]
    expect(Math.max(...deepest) - Math.min(...deepest)).toBeLessThanOrEqual(1)
    // Still no hole under the camera.
    expect(
      capped.patches.filter((patch) => contains(patch, direction)),
    ).toHaveLength(1)
  })

  it('is fully morphed wherever a coarser patch abuts it (property)', () => {
    /*
     * The crack-free claim, in the form that can be checked without a GPU.
     *
     * A vertex slides onto its parent's grid over `[morphStart, morphEnd]` of
     * distance, so a patch is exactly its parent's tessellation everywhere past
     * `morphEnd`. The condition for the two levels to meet without a gap is
     * therefore: for every pair of neighboring patches, the finer one's
     * `morphEnd` is no farther than the coarser one's *nearest* point — because
     * the shared edge is a point of the coarser patch and so is at least that
     * far away, which puts the finer patch's edge vertices at a morph of
     * exactly one.
     *
     * That is a statement about the whole selection rather than about a patch,
     * which is the point: a patch's parent is not who it has to agree with. Its
     * neighbor is, and its neighbor is somewhere else on a cube face whose scale
     * differs from its own.
     */
    const scale = pixelsPerRadian(DEFAULT_VIEWPORT) / DEFAULT_CELL_PIXELS
    fc.assert(
      fc.property(
        fc.double({ min: 1e5, max: 2e7, noNaN: true }),
        fc.double({ min: 0, max: 20, noNaN: true }),
        directions,
        (radius, exponent, direction) => {
          const eye = eyeAt(
            radius,
            radius * 0.002,
            Math.max(2, radius * 2 ** -exponent),
            direction,
          )
          const selection = selectTerrain(eye)
          const byKey = new Map(
            selection.patches.map((patch) => [
              terrainPatchKey('b', patch.region),
              patch,
            ]),
          )
          for (const patch of selection.patches) {
            if (
              patch.region.level < DEFAULT_MAX_LEVEL &&
              !selection.saturated
            ) {
              // It did not refine, so the eye is outside its own range. Unless
              // the budget stopped it — which does not break the handover,
              // because a frontier halted by the cap is all at one level.
              expect(patch.distance).toBeGreaterThanOrEqual(
                patch.spacing * scale * (1 - 1e-9),
              )
            }
            if (patch.region.level === 0) {
              // The no-morph sentinel is finite on purpose: Infinity reaches
              // the shader's `Inf − Inf` denominator as a NaN.
              expect(patch.morphEnd).toBe(NO_MORPH_DISTANCE)
              continue
            }
            expect(patch.morphEnd / (patch.spacing * scale)).toBeCloseTo(
              MORPH_END,
              6,
            )
            expect(patch.morphStart / (patch.spacing * scale)).toBeCloseTo(
              MORPH_START,
              6,
            )
            /*
             * A coarser neighbor is the parent of one of this patch's own
             * four edge-neighbors — which is where `regionNeighbor` earns its
             * place, because across a cube-face edge that parent is on another
             * face and its (i, j) are rotated.
             */
            for (const [di, dj] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ] as const) {
              const parent = regionParent(regionNeighbor(patch.region, di, dj))
              if (parent === null) continue
              const coarse = byKey.get(terrainPatchKey('b', parent))
              if (coarse === undefined) continue
              // A rounding step, because the two sides of this comparison
              // reach the same distance through different arithmetic.
              expect(patch.morphEnd).toBeLessThanOrEqual(
                coarse.distance * (1 + 1e-9),
              )
            }
          }
        },
      ),
    )
  })

  it('never puts a patch beside a neighbor more than one level away', () => {
    /*
     * The 2:1 restriction, asked directly — the morph can close a one-level
     * gap and nothing wider, so this is the invariant the balance pass exists
     * to enforce. The crack property above cannot ask it: it finds a coarser
     * neighbor by its *parent* key and skips the pair when the neighbor is two
     * levels down, which is exactly the violation. Here the drawn patch
     * covering each edge-neighbor is found by walking its ancestors, so a
     * mismatch of two fails rather than being skipped.
     *
     * A deterministic case and then the property, because the violations live
     * in pockets a hundred random draws routinely miss: with `balance()`
     * deleted, this eye — Miranda's radius, a sixteenth of it up, aimed
     * inside face 0 — yields a gap of two, and the property alone stays
     * green. The pinned case is what makes removing the pass a red test.
     */
    const twoToOne = (eye: TerrainEye): void => {
      const selection = selectTerrain(eye)
      const byKey = new Map(
        selection.patches.map((patch) => [
          terrainPatchKey('b', patch.region),
          patch,
        ]),
      )
      for (const patch of selection.patches) {
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          // The drawn patch covering the neighbor's ground, at whatever
          // level the selection drew it. Nothing found means the ground is
          // beyond the horizon (or held finer, which the finer patch's own
          // iteration checks from its side).
          let cover = regionNeighbor(patch.region, di, dj) as ReturnType<
            typeof regionNeighbor
          > | null
          let held
          while (
            cover !== null &&
            (held = byKey.get(terrainPatchKey('b', cover))) === undefined
          ) {
            cover = regionParent(cover)
          }
          if (held === undefined) continue
          expect(patch.region.level - held.region.level).toBeLessThanOrEqual(1)
        }
      }
    }

    twoToOne(
      eyeAt(
        MIRANDA.radius,
        MIRANDA.radius * 0.002,
        MIRANDA.radius / 16,
        regionDirection(regionAddress(0, 0, 0, 0), 0.25, 0.75),
      ),
    )
    fc.assert(
      fc.property(
        fc.double({ min: 1e5, max: 2e7, noNaN: true }),
        fc.double({ min: 0, max: 20, noNaN: true }),
        directions,
        (radius, exponent, direction) => {
          twoToOne(
            eyeAt(
              radius,
              radius * 0.002,
              Math.max(2, radius * 2 ** -exponent),
              direction,
            ),
          )
        },
      ),
    )
  })

  it('measures a node to the shell of ground it can hold', () => {
    const direction = regionDirection(regionAddress(0, 0, 0, 0), 0.5, 0.5)
    const cone = regionCone(regionForDirection(direction, 8))
    // Directly overhead in orbit: the altitude above the highest thing in it.
    expect(
      nodeDistance(
        { radius: EARTH, relief: 9_000, distance: EARTH + 400_000, direction },
        cone,
      ),
    ).toBeCloseTo(400_000 - 9_000, 3)
    // Inside the shell — standing on it — is zero, whatever the datum says.
    expect(
      nodeDistance(
        { radius: EARTH, relief: 9_000, distance: EARTH - 4_000, direction },
        cone,
      ),
    ).toBe(1)
  })

  it('keys a patch by body and address, and nothing else', () => {
    const region = regionForDirection(
      regionDirection({ face: 3, level: 7, i: 11, j: 42 }, 0.5, 0.5),
      7,
    )
    expect(terrainPatchKey('s:SOL/b:2', region)).toBe('s:SOL/b:2|3.7.11.42')
  })

  it('sizes a patch by its level, and knows what that costs', () => {
    /*
     * The gnomonic map is not equal-area, and this is the one place where the
     * better-looking answer is the wrong one.
     *
     * A cell at the middle of a cube face really does cover more ground than one
     * at a corner of the same face — the cones below differ by more than two to
     * one — so measuring each region describes a patch's size better than its
     * level does, and correcting for it is what Zucker & Higashi is about. But
     * the crack-free handover needs a finer patch and its coarser neighbor to
     * agree on one number, and those two are at different points on the face.
     * A measured metric makes them disagree by up to 22%, which is a patch 15%
     * short of its neighbor's grid: a lit gap.
     *
     * So the metric is nominal per level, identical for every region at that
     * level, and what the distortion costs is over-tessellation near the cube's
     * eight corners rather than a seam.
     */
    const level = 6
    const span = 2 ** level
    const middle = regionAddress(0, level, span / 2, span / 2)
    const corner = regionAddress(0, level, 0, 0)
    expect(regionSpacing(EARTH, middle, HEIGHTFIELD_RESOLUTION)).toBe(
      regionSpacing(EARTH, corner, HEIGHTFIELD_RESOLUTION),
    )
    const ratio = regionCone(middle).halfAngle / regionCone(corner).halfAngle
    expect(ratio).toBeGreaterThan(1.5)
    expect(ratio).toBeLessThan(2.5)
  })
})

/** Rotate `axis` by `angle` about a perpendicular chosen by `roll`. */
function spin(
  axis: TerrainEye['direction'],
  angle: number,
  roll: number,
): TerrainEye['direction'] {
  const seed =
    Math.abs(axis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  const u = Vec.normalize(Vec.cross(axis, seed))
  const v = Vec.cross(axis, u)
  const perpendicular = Vec.add(
    Vec.scale(u, Math.cos(roll)),
    Vec.scale(v, Math.sin(roll)),
  )
  return Vec.normalize(
    Vec.add(
      Vec.scale(axis, Math.cos(angle)),
      Vec.scale(perpendicular, Math.sin(angle)),
    ),
  ) as TerrainEye['direction']
}
