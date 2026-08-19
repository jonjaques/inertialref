import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AU, LIGHT_YEAR } from '@inertialref/shared'
import {
  createRenderOrigin,
  Quaternion as Q,
  rebase,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import { snapshot, World } from '@inertialref/simulation'
import { bodyFrameId, regionAddress, systemId, walkBodies } from '@inertialref/universe'
import { generateHeightfield } from '@inertialref/universe'
import { angularRadius, selectLod, starColor, terrainLevelFor } from './lod.ts'
import { compressDistance, DEFAULT_PLACEMENT, placeAt } from './placement.ts'
import { buildScene, nearestBody, originForCamera } from './scene.ts'
import { buildPatch } from './terrainMesh.ts'

const ORIGIN = createRenderOrigin(UV.fromMeters(4.2 * LIGHT_YEAR, 0, 0))

describe('LOD selection', () => {
  it('chooses representation by angular size, not distance', () => {
    // A gas giant far away and a boulder up close subtend the same angle and
    // deserve the same treatment.
    const giant = selectLod(7e7, 3.5e10, DEFAULT_PLACEMENT.thresholds)
    const boulder = selectLod(2, 1_000, DEFAULT_PLACEMENT.thresholds)
    expect(angularRadius(7e7, 3.5e10)).toBeCloseTo(angularRadius(2, 1_000), 6)
    expect(giant).toBe(boulder)
  })

  it('escalates as you approach', () => {
    const radius = 6.371e6
    expect(selectLod(radius, 1e12)).toBe('point')
    expect(selectLod(radius, 1e10)).toBe('billboard')
    expect(selectLod(radius, 1e9)).toBe('sphere')
    expect(selectLod(radius, radius * 4)).toBe('surface')
  })

  it('asks for finer terrain as altitude drops', () => {
    const radius = 6.371e6
    const high = terrainLevelFor(radius, radius + 1e6)
    const low = terrainLevelFor(radius, radius + 1e3)
    expect(low).toBeGreaterThan(high)
    expect(terrainLevelFor(radius, radius + 1)).toBeLessThanOrEqual(12)
  })

  it('gives hot stars blue light and cool stars red', () => {
    const hot = starColor(20_000)
    const cool = starColor(3_000)
    expect(hot.b).toBeGreaterThan(hot.r * 0.9)
    expect(cool.r).toBeGreaterThan(cool.b)
  })
})

describe('render placement', () => {
  it('does not compress the world you are in orbit around', () => {
    // The regression that made terrain invisible: in a 400 km orbit the centre
    // of a 2,864 km planet is far beyond the near limit, but its surface — and
    // the streamed patches on it — are right in front of the camera.
    const radius = 2.864e6
    const centre = UV.translate(ORIGIN.position, vec3(radius + 400e3, 0, 0))
    const planet = placeAt(ORIGIN, centre, radius)
    expect(planet.compressed).toBe(false)
    // The rendered near surface sits exactly at the true altitude.
    expect(Vec.length(planet.position) - planet.scale).toBeCloseTo(400e3, 3)
  })

  it('leaves the near field completely alone', () => {
    const near = UV.translate(ORIGIN.position, vec3(1_000, 0, 0))
    const placement = placeAt(ORIGIN, near, 5)
    expect(placement.compressed).toBe(false)
    expect(placement.position.x).toBeCloseTo(1_000, 6)
    expect(placement.scale).toBe(5)
  })

  it('preserves angular size when it compresses', () => {
    // The whole justification for compressing: the picture must not change.
    fc.assert(
      fc.property(
        fc.double({ min: 1e7, max: 1e16, noNaN: true }),
        fc.double({ min: 1e3, max: 1e9, noNaN: true }),
        (distance, radius) => {
          const position = UV.translate(ORIGIN.position, vec3(distance, 0, 0))
          const placement = placeAt(ORIGIN, position, radius)
          const trueAngle = radius / distance
          const renderedAngle = placement.scale / Vec.length(placement.position)
          // Relative, not absolute: these angles span ten orders of magnitude
          // and an absolute tolerance would be meaningless at either end.
          expect(Math.abs(renderedAngle / trueAngle - 1)).toBeLessThan(1e-9)
        },
      ),
    )
  })

  it('never inverts depth ordering (property)', () => {
    // The property occlusion actually depends on: nearer never renders further.
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e18, noNaN: true }),
        fc.double({ min: 1, max: 1e18, noNaN: true }),
        (a, b) => {
          const ca = compressDistance(a, DEFAULT_PLACEMENT)
          const cb = compressDistance(b, DEFAULT_PLACEMENT)
          if (a < b) expect(ca).toBeLessThanOrEqual(cb)
          if (a > b) expect(ca).toBeGreaterThanOrEqual(cb)
        },
      ),
    )
  })

  it('separates depths that are resolvable at all (property)', () => {
    // Strictly increasing wherever the separation survives double precision.
    // It is not strictly increasing everywhere, and pretending otherwise made
    // this test flaky: at 1e18 m the compression slope is ~2e-12, so a 100 m
    // difference maps to less than one ULP of the compressed value. Two objects
    // 100 m apart a hundred light-years away are the same pixel; the honest
    // claim is non-inversion above, plus strict ordering once the difference is
    // large enough to mean anything.
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e18, noNaN: true }),
        fc.double({ min: 1, max: 1e18, noNaN: true }),
        (a, b) => {
          fc.pre(Math.abs(a - b) / Math.max(a, b) > 1e-9)
          const ca = compressDistance(a, DEFAULT_PLACEMENT)
          const cb = compressDistance(b, DEFAULT_PLACEMENT)
          expect(a < b).toBe(ca < cb)
        },
      ),
    )
  })

  it('is continuous at the compression boundary', () => {
    const { nearLimit } = DEFAULT_PLACEMENT
    // Continuous in value...
    expect(compressDistance(nearLimit, DEFAULT_PLACEMENT)).toBeCloseTo(nearLimit, 6)
    // ...and in slope, which is what stops a body changing its apparent rate of
    // approach as it crosses the boundary.
    const step = nearLimit * 1e-6
    const slope = (compressDistance(nearLimit + step, DEFAULT_PLACEMENT) - nearLimit) / step
    expect(slope).toBeCloseTo(1, 5)
  })

  it('brings a star four light-years away inside float32 comfort', () => {
    const star = UV.translate(ORIGIN.position, vec3(4 * LIGHT_YEAR, 0, 0))
    const placement = placeAt(ORIGIN, star, 6.957e8)
    expect(placement.distance / LIGHT_YEAR).toBeCloseTo(4, 3)
    // Rendered under a billion metres out instead of 4e16 — inside what a
    // logarithmic depth buffer handles comfortably. The star's own radius
    // dominates that figure, because a body's radius is never compressed away.
    expect(Vec.length(placement.position)).toBeLessThan(1e10)
    expect(Vec.length(placement.position)).toBeGreaterThan(1e7)
    expect(Math.fround(placement.position.x)).not.toBe(0)
  })
})

describe('scene', () => {
  function sceneFixture() {
    const world = new World({ seed: 'inertialref' })
    const system = world.loadSystem(systemId('SOL'))
    const planet = [...walkBodies(system)].find((b) => b.kind === 'rocky' && b.radius > 1e6)
    if (planet === undefined) throw new Error('no planet')
    const ship = world.spawnShip('cam', bodyFrameId(planet.address), vec3(planet.radius * 2.2, 0, 0))
    world.runTicks(4)
    const shot = snapshot(world)
    const camera = shot.entities.find((e) => e.id === ship.id)
    if (camera === undefined) throw new Error('no camera')
    const origin = originForCamera(null, camera.position)
    return { world, planet, ship, shot, origin, scene: buildScene(shot, origin, ship.id) }
  }

  it('describes bodies, stars and entities without touching Three.js', () => {
    const { scene, planet } = sceneFixture()
    expect(scene.bodies.length).toBeGreaterThan(0)
    expect(scene.stars).toHaveLength(1)
    expect(scene.entities.some((e) => e.isCamera)).toBe(true)
    const target = scene.bodies.find((b) => b.address === planet.id.slice(1))
    expect(target?.placement.tier).toBe('surface')
    expect(scene.terrainCandidates[0]?.address).toBe(target?.address)
  })

  it('puts the camera at the render origin, near enough', () => {
    const { scene } = sceneFixture()
    expect(Vec.length(scene.camera.position)).toBeLessThan(4_096)
  })

  it('does not move anything canonical when the origin is rebased', () => {
    const { shot, scene, ship } = sceneFixture()
    const moved = rebase(scene.origin, UV.translate(scene.origin.position, vec3(50_000, 0, 0)))
    const rebased = buildScene(shot, moved, ship.id)
    // Render coordinates shift by exactly the origin delta — which is snapped
    // to the 1024 m grid, hence 50176 rather than 50000.
    const shift = UV.difference(moved.position, scene.origin.position)
    expect(shift.x).toBe(50_176)
    const before = scene.entities.find((e) => e.isCamera)
    const after = rebased.entities.find((e) => e.isCamera)
    expect((before?.position.x ?? 0) - (after?.position.x ?? 0)).toBeCloseTo(shift.x, 3)
    // ...and the canonical positions in the snapshot are untouched.
    expect(UV.equals(rebased.camera.universePosition, scene.camera.universePosition)).toBe(true)
  })

  it('finds the body the player is closest to the surface of', () => {
    const { scene, planet } = sceneFixture()
    expect(nearestBody(scene)?.address).toBe(planet.id.slice(1))
  })

  it('culls what would be smaller than a pixel', () => {
    const { shot, ship } = sceneFixture()
    const farAway = createRenderOrigin(UV.fromMeters(0, 0, 0))
    const scene = buildScene(shot, farAway, ship.id)
    // From the galactic centre, Sol's planets are far below one pixel.
    expect(scene.bodies).toHaveLength(0)
  })
})

describe('terrain mesh', () => {
  it('builds a patch that sits on the body, in render space', () => {
    const world = new World({ seed: 'inertialref' })
    const system = world.loadSystem(systemId('SOL'))
    const planet = [...walkBodies(system)].find((b) => b.surface.maxElevation > 0)
    if (planet === undefined) throw new Error('no solid body')

    const bodyPose = world.frames.pose(bodyFrameId(planet.address), 0)
    const region = regionAddress(0, 4, 8, 8)
    const field = generateHeightfield(planet.surface, { region, resolution: 17 })
    const origin = createRenderOrigin(bodyPose.position)
    const patch = buildPatch(
      {
        region,
        resolution: 17,
        elevations: field.elevations,
        bodyRadius: planet.radius,
        bodyCentre: bodyPose.position,
        bodyOrientation: Q.IDENTITY,
      },
      origin,
    )

    expect(patch.positions.length).toBe(17 * 17 * 3)
    expect(patch.indices.length).toBe(16 * 16 * 6)
    expect(patch.originGeneration).toBe(origin.generation)
    // Every vertex is at the planet's radius plus its own elevation.
    for (let i = 0; i < patch.positions.length; i += 3) {
      const r = Math.hypot(patch.positions[i] as number, patch.positions[i + 1] as number, patch.positions[i + 2] as number)
      expect(Math.abs(r - planet.radius)).toBeLessThanOrEqual(planet.surface.maxElevation * 1.5)
    }
    // Normals are unit length.
    expect(Math.hypot(patch.normals[0] as number, patch.normals[1] as number, patch.normals[2] as number)).toBeCloseTo(1, 5)
  })

  it('places meter-scale detail on an astronomically distant surface', () => {
    // Requirement 8 of the milestone, checked at the level that decides it: a
    // vertex a metre from its neighbour must still be a metre from it after
    // going through render space, four light-years out.
    const centre = UV.fromMeters(4.2 * LIGHT_YEAR, 0, 0)
    const a = UV.translate(centre, vec3(6.371e6, 0, 0))
    const b = UV.translate(centre, vec3(6.371e6, 1, 0))
    // The origin follows the camera, so the ground under the player is always
    // in the uncompressed near field. That is what makes metre-scale objects
    // exact four light-years from anywhere.
    const origin = createRenderOrigin(a)
    const pa = placeAt(origin, a, 1)
    const pb = placeAt(origin, b, 1)
    expect(pa.compressed).toBe(false)
    expect(Vec.distance(Vec.toFloat32(pa.position), Vec.toFloat32(pb.position))).toBeCloseTo(1, 4)

    // Sanity: from an origin at the planet's centre those same two points *are*
    // compressed, and the metre between them shrinks. Compression is a property
    // of the far field, and the far field is not where gameplay happens.
    const distant = createRenderOrigin(centre)
    expect(placeAt(distant, a, 1).compressed).toBe(true)
    expect(AU).toBeGreaterThan(0)
  })
})
