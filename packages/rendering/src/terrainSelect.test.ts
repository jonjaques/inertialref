import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec, type Vec3 } from '@inertialref/spatial'
import {
  HEIGHTFIELD_RESOLUTION,
  regionAddress,
  regionDirection,
  regionForDirection,
  regionNeighbor,
  regionParent,
} from '@inertialref/universe'
import {
  aspectRatio,
  type Lens,
  lensForFov,
  LENS_PRESETS,
  pixelAngle,
  pixelsPerRadian,
  verticalFov,
} from './lens.ts'
import { localTriad } from './surfaceStance.ts'
import {
  COARSEN_STEP,
  COARSEN_STEPS,
  DEFAULT_CELL_PIXELS,
  DEFAULT_LENS,
  DEFAULT_MAX_LEVEL,
  DEFAULT_MAX_PATCHES,
  DEFAULT_VIEWPORT,
  MORPH_END,
  MORPH_START,
  NO_MORPH_DISTANCE,
  nodeDistance,
  REFERENCE_LENS,
  regionCone,
  regionSpacing,
  type TerrainEye,
  type TerrainSelection,
  type TerrainSelectOptions,
  selectTerrain,
  type SelectedPatch,
  terrainPatchKey,
  VIEW_MARGIN_PIXELS,
  VIEW_TURN_PIXELS,
  viewTurned,
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
/** Mars, with the game's own relief bound — the body the landing measures. */
const MARS = { radius: 3_389_500, relief: 14_700 }

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

  it('loosens the tolerance before it cuts the tree, so the ground underfoot keeps the floor (property)', () => {
    /*
     * The Mars landing at 3200×1800 display pixels: the hover wants 1,583
     * patches against a cap of 1,280, and the breadth-first cut answered by
     * stopping the whole disk at level 13 with the camera a meter off ground
     * whose floor is 16 — eight times the cell, arriving in steps as the lens
     * narrowed. Loosened to 1.5× the same eye wants 1,011 and the ground
     * under the camera is still at the floor, because the node the eye is
     * inside is at distance zero and refines at any tolerance.
     *
     * So the claim: a cap that binds within the loosening ladder costs the
     * far field a fraction of a level and the patch underfoot nothing.
     *
     * Through the landing's own lens, because the ladder only bites where the
     * predicate is what binds. At the flight lens over this window the 2:1
     * grading sets the count and 3.4× the tolerance cuts under 5% — measured
     * across thirty-six eyes, corners included — where at 34° one step cuts
     * at least 20% of every one of them. The cap is set inside that step.
     */
    const landing = {
      lens: lensForFov(34),
      viewport: { width: 3200, height: 1800 },
      maxLevel: 16,
    }
    fc.assert(
      fc.property(
        directions,
        fc.double({ min: 0.85, max: 0.95, noNaN: true }),
        (direction, fraction) => {
          const eye = eyeAt(MARS.radius, MARS.relief, 1, direction)
          const full = selectTerrain(eye, { ...landing, maxPatches: 100_000 })
          const capped = selectTerrain(eye, {
            ...landing,
            maxPatches: Math.floor(full.patches.length * fraction),
          })
          expect(capped.saturated).toBe(false)
          expect(capped.coarsening).toBe(1.5)
          expect(capped.patches.length).toBeLessThan(full.patches.length)
          const underfoot = capped.patches.filter((patch) =>
            contains(patch, direction),
          )
          expect(underfoot).toHaveLength(1)
          expect(underfoot[0]!.region.level).toBe(full.deepestLevel)
          expect(capped.deepestLevel).toBe(full.deepestLevel)
        },
      ),
      { numRuns: 12 },
    )
  })

  it('starts from the tolerance it is handed and reports the one it used', () => {
    const direction = regionDirection(regionAddress(2, 0, 0, 0), 0.4, 0.6)
    const eye = eyeAt(MARS.radius, MARS.relief, 1, direction)
    const landing = {
      lens: lensForFov(34),
      viewport: { width: 3200, height: 1800 },
      maxLevel: 16,
    }
    const full = selectTerrain(eye, { ...landing, maxPatches: 100_000 })
    const cap = Math.floor(full.patches.length * 0.9)
    const cold = selectTerrain(eye, { ...landing, maxPatches: cap })
    expect(cold.coarsening).toBe(1.5)
    const warm = selectTerrain(eye, {
      ...landing,
      maxPatches: cap,
      coarsening: cold.coarsening,
    })
    expect(warm.coarsening).toBe(cold.coarsening)
    expect(warm.patches.length).toBe(cold.patches.length)
    // Handed a tolerance looser than it needs, it keeps it: coming back down
    // is the caller's decision, because only the caller has last frame's
    // count.
    const loose = selectTerrain(eye, {
      ...landing,
      maxPatches: cap,
      coarsening: 2.25,
    })
    expect(loose.coarsening).toBe(2.25)
    // And unbound, the tolerance is the one asked for.
    expect(full.coarsening).toBe(1)
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
    const scale =
      pixelsPerRadian(DEFAULT_LENS, DEFAULT_VIEWPORT) / DEFAULT_CELL_PIXELS
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

/*
 * A long lens refines what it can see.
 *
 * The questions a view adds, in the order a reader would doubt them: does it
 * change anything where it should not, does the frame keep the lens it is
 * taken through, is the ground behind the camera really let go, and does the
 * handover still hold where the two regimes meet.
 */

/** Where a stance at `heading` and `pitch` looks, in the eye's own axes. */
const aim = (up: Vec3, heading: number, pitch: number): Vec3 => {
  const triad = localTriad(up)
  const along = Vec.add(
    Vec.scale(triad.north, Math.cos(heading)),
    Vec.scale(triad.east, Math.sin(heading)),
  )
  return Vec.normalize(
    Vec.add(
      Vec.scale(along, Math.cos(pitch)),
      Vec.scale(triad.up, Math.sin(pitch)),
    ),
  )
}

/**
 * Datum points the frame shows: a `steps` × `steps` grid over the sensor, each
 * ray carried to the datum sphere, sky rays dropped. The datum is inside the
 * shell every node's ground is bounded by, so a node holding one of these
 * points holds ground the frame can see.
 */
function framedGround(
  eye: TerrainEye,
  forward: Vec3,
  lens: Lens,
  viewport = DEFAULT_VIEWPORT,
  steps = 5,
): Vec3[] {
  const vertical = Math.tan(verticalFov(lens) / 2)
  const horizontal = vertical * aspectRatio(viewport)
  const across = Vec.cross(forward, eye.direction)
  const right =
    Vec.length(across) > 1e-9
      ? Vec.normalize(across)
      : Vec.normalize(Vec.cross(forward, { x: 1, y: 0, z: 0 }))
  const up = Vec.cross(right, forward)
  const origin = Vec.scale(eye.direction, eye.distance)
  const out: Vec3[] = []
  const grid = Array.from(
    { length: steps },
    (_, n) => -0.98 + (1.96 * n) / (steps - 1),
  )
  for (const x of grid)
    for (const y of grid) {
      const ray = Vec.normalize(
        Vec.add(
          forward,
          Vec.add(
            Vec.scale(right, x * horizontal),
            Vec.scale(up, y * vertical),
          ),
        ),
      )
      const b = Vec.dot(origin, ray)
      const c = Vec.lengthSquared(origin) - eye.radius * eye.radius
      const disc = b * b - c
      if (disc < 0) continue
      const near = -b - Math.sqrt(disc)
      const t = near > 0 ? near : -b + Math.sqrt(disc)
      if (!(t > 0)) continue
      out.push(Vec.normalize(Vec.add(origin, Vec.scale(ray, t))))
    }
  return out
}

/** Where the picture looked, for the claims that depend on it. */
interface Looking {
  readonly eye: TerrainEye
  readonly forward: Vec3
  readonly lens: Lens
}

/** The shared edge's datum points, on `region`'s side `(di, dj)`. */
const edgePoints = (
  region: SelectedPatch['region'],
  di: number,
  dj: number,
): Vec3[] =>
  Array.from({ length: 17 }, (_, n) => {
    const along = n / 16
    return di !== 0
      ? regionDirection(region, di > 0 ? 1 : 0, along)
      : regionDirection(region, along, dj > 0 ? 1 : 0)
  })

/**
 * The crack-free and 2:1 claims, over a whole selection, whatever made it.
 *
 * And the claim between equals. Two patches of one level share every vertex
 * on their common edge, and each slides its odd ones by its own band; where
 * the bands differ, the factors on that edge differ — by up to the whole
 * morph — and the edge opens. So same-level neighbors carry one band, except
 * where the edge lies further from the frame than a turn the held selection
 * survives (`VIEW_TURN_PIXELS`), which only a selection with a view has.
 */
function holdsTogether(selection: TerrainSelection, looking?: Looking): void {
  const byKey = new Map(
    selection.patches.map((patch) => [
      terrainPatchKey('b', patch.region),
      patch,
    ]),
  )
  const reach =
    looking === undefined
      ? 0
      : Math.atan(
          Math.hypot(
            Math.tan(verticalFov(looking.lens) / 2),
            Math.tan(verticalFov(looking.lens) / 2) *
              aspectRatio(DEFAULT_VIEWPORT),
          ),
        ) +
        VIEW_TURN_PIXELS * pixelAngle(looking.lens, DEFAULT_VIEWPORT)
  for (const patch of selection.patches) {
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const beside = regionNeighbor(patch.region, di, dj)
      const equal = byKey.get(terrainPatchKey('b', beside))
      if (
        equal !== undefined &&
        patch.region.level > 0 &&
        (equal.morphStart !== patch.morphStart ||
          equal.morphEnd !== patch.morphEnd)
      ) {
        expect(looking).toBeDefined()
        const { eye, forward } = looking!
        const origin = Vec.scale(eye.direction, eye.distance)
        for (const point of edgePoints(patch.region, di, dj)) {
          const toward = Vec.sub(Vec.scale(point, eye.radius), origin)
          const off = Math.acos(
            Math.min(1, Vec.dot(toward, forward) / Vec.length(toward)),
          )
          expect(off).toBeGreaterThan(reach)
        }
      }
      // Crack-free: a finer patch has arrived on its grid before the
      // coarser neighbor's nearest point — across the regime boundary too.
      const parent = regionParent(beside)
      const coarse =
        parent === null ? undefined : byKey.get(terrainPatchKey('b', parent))
      if (coarse !== undefined && patch.region.level > 0)
        expect(patch.morphEnd).toBeLessThanOrEqual(coarse.distance * (1 + 1e-9))
      // 2:1: whatever covers the neighbor's ground is within a level.
      let cover: ReturnType<typeof regionParent> = beside
      let held
      while (
        cover !== null &&
        (held = byKey.get(terrainPatchKey('b', cover))) === undefined
      )
        cover = regionParent(cover)
      if (held !== undefined)
        expect(patch.region.level - held.region.level).toBeLessThanOrEqual(1)
    }
  }
}

/**
 * Every datum point the frame shows lies in one patch, refined at the lens:
 * in view, not refinable further at the lens's own scale unless the level
 * floor stopped it, and with its morph band at that scale. Ground the frame
 * cannot reach stopped at the reference's range. And crack-free, 2:1 and one
 * band between equals hold across the boundary.
 */
function keepsFrame(
  selection: TerrainSelection,
  looking: Looking,
  maxLevel: number,
  steps = 5,
): void {
  const { eye, forward, lens } = looking
  const atLens = pixelsPerRadian(lens, DEFAULT_VIEWPORT) / DEFAULT_CELL_PIXELS
  const atReference =
    pixelsPerRadian(REFERENCE_LENS, DEFAULT_VIEWPORT) / DEFAULT_CELL_PIXELS
  const byKey = new Map(
    selection.patches.map((patch) => [
      terrainPatchKey('b', patch.region),
      patch,
    ]),
  )
  for (const point of framedGround(
    eye,
    forward,
    lens,
    DEFAULT_VIEWPORT,
    steps,
  )) {
    const covering: SelectedPatch[] = []
    for (let level = 0; level <= maxLevel; level += 1) {
      const patch = byKey.get(
        terrainPatchKey(
          'b',
          regionForDirection(point as TerrainEye['direction'], level),
        ),
      )
      if (patch !== undefined) covering.push(patch)
    }
    expect(covering).toHaveLength(1)
    const patch = covering[0]!
    expect(patch.inView).toBe(true)
    if (patch.region.level < maxLevel)
      expect(patch.distance).toBeGreaterThanOrEqual(
        patch.spacing * atLens * (1 - 1e-9),
      )
    if (patch.region.level > 0)
      expect(patch.morphEnd / (patch.spacing * atLens)).toBeCloseTo(
        MORPH_END,
        6,
      )
  }
  for (const patch of selection.patches)
    if (!patch.inView && patch.region.level < maxLevel)
      expect(patch.distance).toBeGreaterThanOrEqual(
        patch.spacing * atReference * (1 - 1e-9),
      )
  holdsTogether(selection, looking)
}

describe('a long lens refines what it can see', () => {
  const EARTH_RELIEF = 9_900

  it('changes nothing without a view, or at a lens no longer than the reference (property)', () => {
    /*
     * The view is a strict addition. At the flight lens and wider the
     * reference is finer than the lens, refining ground behind the camera
     * finer than the frame would spend the cap backwards, and the selection
     * is the whole-disk one to the last field — which is what keeps every
     * figure measured before the view existed true there.
     */
    fc.assert(
      fc.property(
        fc.double({ min: 1e5, max: 2e7, noNaN: true }),
        fc.double({ min: 0, max: 20, noNaN: true }),
        directions,
        fc.double({ min: 65, max: 110, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (radius, exponent, direction, fov, heading) => {
          const eye = eyeAt(
            radius,
            radius * 0.002,
            Math.max(2, radius * 2 ** -exponent),
            direction,
          )
          const lens = lensForFov(fov)
          const whole = selectTerrain(eye, { lens })
          const viewed = selectTerrain(eye, {
            lens,
            view: { forward: aim(direction, heading, -0.1) },
          })
          expect(viewed).toEqual(whole)
          expect(whole.outside).toBe(0)
          expect(whole.patches.every((patch) => patch.inView)).toBe(true)
          holdsTogether(whole)
        },
      ),
      { numRuns: 40 },
    )
  })

  it('keeps the frame at its own lens and lets the ground behind the camera go (property)', () => {
    /*
     * Every datum point the frame shows lies in a patch refined at the lens,
     * banded at the lens; ground the frame cannot reach stopped at the
     * reference's range; and crack-free, 2:1 and one band between equals hold
     * across the boundary. From orbit to a few meters, where the range rather
     * than the floor is what stops most of the tree.
     */
    fc.assert(
      fc.property(
        fc.double({ min: 1e5, max: 2e7, noNaN: true }),
        fc.double({ min: 4, max: 24, noNaN: true }),
        directions,
        fc.double({ min: 8, max: 20, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -1.5, max: 0.05, noNaN: true }),
        (radius, exponent, direction, fov, heading, pitch) => {
          const eye = eyeAt(
            radius,
            radius * 0.002,
            Math.max(2, radius * 2 ** -exponent),
            direction,
          )
          const lens = lensForFov(fov)
          const forward = aim(direction, heading, pitch)
          const options: TerrainSelectOptions = {
            lens,
            view: { forward },
            maxPatches: 1_000_000,
          }
          const selection = selectTerrain(eye, options)
          expect(selection.coarsening).toBe(1)
          keepsFrame(selection, { eye, forward, lens }, DEFAULT_MAX_LEVEL)
        },
      ),
      // Uncapped at 8° a selection is thousands of patches and the checks
      // walk all of them; twenty eyes is under the timeout on a loaded machine.
      { numRuns: 20 },
    )
  })

  it('keeps a standing eye’s frame on one band where the level floor stops the tree (property)', () => {
    /*
     * The regime the margin does not cover. At the floor a patch is kept
     * because it may not go deeper, not because it reached its range, so one
     * in view can be far nearer than its range and far wider than the margin:
     * a level-16 patch on Luna is 41 m across, over 2,000 px at 100 m through
     * 11.4°. Where such a patch borders coarser ground outside the view, a
     * band taken at the reference to close that edge is a band its neighbors
     * in view do not share, and the edge between them opened in the frame —
     * or one turn away from it, which the held selection does not retake.
     *
     * Standing two to twenty meters up, at the long end and the floor the
     * streamer gives the zoo, with a 21 × 21 grid over the frame.
     */
    fc.assert(
      fc.property(
        fc.constantFrom({ radius: 1_737_400, relief: 10_800 }, MARS, {
          radius: EARTH,
          relief: EARTH_RELIEF,
        }),
        fc.double({ min: 2, max: 20, noNaN: true }),
        directions,
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -0.1, max: 0.03, noNaN: true }),
        (body, height, direction, heading, pitch) => {
          const eye = eyeAt(body.radius, body.relief, height, direction)
          const lens = lensForFov(11.4)
          const forward = aim(direction, heading, pitch)
          const selection = selectTerrain(eye, {
            lens,
            view: { forward },
            maxLevel: 16,
            maxPatches: 1_000_000,
          })
          keepsFrame(selection, { eye, forward, lens }, 16, 21)
        },
      ),
      // A standing selection at the floor is two thousand patches; twenty-four
      // eyes cover the three bodies with every eye's checks under a second.
      { numRuns: 24 },
    )
  })

  it('lets the ground behind the camera go however tall the body’s relief', () => {
    /*
     * The relief bound is a vertical claim — a summit can rise into the frame
     * and a canyon fall into it — and a bounding sphere about each node turns
     * it into an omnidirectional one: Earth's 9.9 km makes every node within
     * ten kilometers hold the eye inside its sphere, so standing at 11.4° the
     * three finest levels were in view whole, behind the camera included, and
     * the selection came to 3,289 patches. The capsule keeps the claim
     * vertical. A kilometer behind a camera looking at the horizon is out of
     * view at any height.
     */
    const direction = regionDirection(regionAddress(2, 0, 0, 0), 0.4, 0.6)
    const eye = eyeAt(EARTH, EARTH_RELIEF, 2, direction)
    const lens = lensForFov(11.4)
    const forward = aim(direction, 0, 0.033)
    const selection = selectTerrain(eye, {
      lens,
      maxLevel: 16,
      view: { forward },
      maxPatches: 1_000_000,
    })
    const behind = aim(direction, Math.PI, 0)
    for (const meters of [300, 1_000, 3_000]) {
      const point = Vec.normalize(
        Vec.add(Vec.scale(direction, EARTH), Vec.scale(behind, meters)),
      ) as TerrainEye['direction']
      const covering = selection.patches.filter((patch) =>
        contains(patch, point),
      )
      expect(covering).toHaveLength(1)
      expect(covering[0]!.inView).toBe(false)
    }
    const whole = selectTerrain(eye, {
      lens,
      maxLevel: 16,
      maxPatches: 1_000_000,
    })
    expect(selection.patches.length).toBeLessThan(whole.patches.length / 2)
  })

  it('is over the cap only at the top of the ladder (property)', () => {
    /*
     * The cap bounds what is drawn, and what is drawn is the balanced tree.
     * With two regimes the 2:1 rings grade the level gap across the frame's
     * edges, which the walk's own count never sees — so a walk that fitted
     * could come back hundreds over, at the lens's own tolerance, with
     * nothing loosened. The overrun climbs the ladder; only the loosest
     * tolerance may hand back more than the cap, and then it says so.
     */
    const loosest = COARSEN_STEP ** COARSEN_STEPS
    fc.assert(
      fc.property(
        fc.double({ min: 2e5, max: 7e6, noNaN: true }),
        fc.double({ min: 10, max: 24, noNaN: true }),
        directions,
        fc.double({ min: 8, max: 20, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (radius, exponent, direction, fov, heading) => {
          const eye = eyeAt(
            radius,
            radius * 0.002,
            Math.max(2, radius * 2 ** -exponent),
            direction,
          )
          const selection = selectTerrain(eye, {
            lens: lensForFov(fov),
            maxLevel: 16,
            view: { forward: aim(direction, heading, 0.02) },
          })
          if (selection.patches.length > DEFAULT_MAX_PATCHES) {
            expect(selection.saturated).toBe(true)
            expect(selection.coarsening).toBeCloseTo(loosest, 9)
          }
        },
      ),
      { numRuns: 20 },
    )
  })

  it('reads the reference it is handed, and the flight lens when it is not', () => {
    const direction = regionDirection(regionAddress(4, 0, 0, 0), 0.3, 0.3)
    const eye = eyeAt(EARTH, EARTH_RELIEF, 2, direction)
    const view = { forward: aim(direction, 1, 0.02) }
    const lens = lensForFov(11.4)
    expect(REFERENCE_LENS).toEqual(LENS_PRESETS.flight)
    const base = { lens, view, maxLevel: 16, maxPatches: 1_000_000 }
    const flight = selectTerrain(eye, base)
    expect(
      selectTerrain(eye, { ...base, reference: LENS_PRESETS.flight }),
    ).toEqual(flight)
    // A reference as long as the lens is no reference at all.
    expect(selectTerrain(eye, { ...base, reference: lens })).toEqual(
      selectTerrain(eye, { lens, maxLevel: 16, maxPatches: 1_000_000 }),
    )
    expect(flight.outside).toBeGreaterThan(0)
  })

  it('calls a view stale past a quarter of the margin, and never where it is inert', () => {
    /*
     * The memo's half of the view. A turn is counted in the lens's own
     * pixels, so the same drag goes stale at the same point on any lens
     * longer than the reference — and at the reference or wider the view is
     * not an input to the walk, so no turn may cost one.
     */
    const viewport = DEFAULT_VIEWPORT
    const up = { x: 0, y: 0, z: 1 }
    const forward = aim(up, 0, 0)
    const turned = (lens: Lens, pixels: number): Vec3 =>
      aim(up, pixels * pixelAngle(lens, viewport), 0)
    expect(VIEW_TURN_PIXELS * 4).toBe(VIEW_MARGIN_PIXELS)
    for (const fov of [20, 11.4, 5]) {
      const lens = lensForFov(fov)
      expect(viewTurned(forward, turned(lens, 250), lens, viewport)).toBe(false)
      expect(viewTurned(forward, turned(lens, 262), lens, viewport)).toBe(true)
      expect(viewTurned(forward, null, lens, viewport)).toBe(true)
      expect(viewTurned(null, null, lens, viewport)).toBe(false)
    }
    for (const lens of [LENS_PRESETS.flight, lensForFov(110)]) {
      expect(viewTurned(forward, turned(lens, 4_000), lens, viewport)).toBe(
        false,
      )
      expect(viewTurned(forward, null, lens, viewport)).toBe(false)
    }
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
