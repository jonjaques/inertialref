import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AU, LIGHT_YEAR } from '@inertialref/shared'
import {
  createRenderOrigin,
  Quaternion as Q,
  rebase,
  toRenderSpace,
  universeVector,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import { snapshot, World } from '@inertialref/simulation'
import {
  bodyFrameId,
  installSurfaceFrame,
  regionAddress,
  systemFrameId,
  systemId,
  TEST_CATALOG,
  walkBodies,
} from '@inertialref/universe'
import { generateHeightfield } from '@inertialref/universe'
import {
  angularRadius,
  selectLod,
  starColor,
  terrainLevelFor,
  terrainOpacity,
} from './lod.ts'
import {
  compressDistance,
  NEAR_LIMIT,
  placeAt,
  placeOnStarShell,
  STAR_SHELL_RADIUS,
} from './placement.ts'
import {
  buildScene,
  nearestBody,
  originForCamera,
  type RenderScene,
} from './scene.ts'
import {
  CAMERA_GROUND_CLEARANCE,
  CHASE_OFFSET,
  chaseOffsetFor,
  chaseCameraPosition,
} from './camera.ts'
import { buildPatch, patchPlacement } from './terrainMesh.ts'

const ORIGIN = createRenderOrigin(UV.fromMeters(4.2 * LIGHT_YEAR, 0, 0))

describe('LOD selection', () => {
  it('chooses representation by angular size, not distance', () => {
    // A gas giant far away and a boulder up close subtend the same angle and
    // deserve the same treatment.
    const giant = selectLod(7e7, 3.5e10)
    const boulder = selectLod(2, 1_000)
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

  it('hides streamed terrain from orbit and fades it in on the way down', () => {
    /*
     * The streamed set is a fixed 3×3 window, so from altitude it is a lone
     * raised tile on the datum sphere — invisible for as long as the winding
     * bug culled terrain from above, and a floating sticker the moment that
     * was fixed. The rule: fully present exactly where `terrainLevelFor`
     * saturates at its maximum, gone one octave of altitude above that.
     */
    const radius = 2.864333e6 // the first planet, where this was observed
    const full = radius * 2 ** (4.5 - 12)

    // Landed and anywhere at full streaming detail: solid ground.
    expect(terrainOpacity(radius, radius + 1)).toBe(1)
    expect(terrainOpacity(radius, radius + full * 0.99)).toBe(1)
    // A 300 km orbit: nothing at all, so the streamer can skip the workers.
    expect(terrainOpacity(radius, radius + 300_000)).toBe(0)
    // In the fade band it is genuinely between, which is the landing transition.
    const mid = terrainOpacity(radius, radius + full * 1.5)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)

    // Presence and level saturation are the same boundary: partially or fully
    // hidden terrain is exactly the terrain that would have streamed coarse.
    fc.assert(
      fc.property(
        fc.double({ min: 1e5, max: 1e8, noNaN: true }),
        fc.double({ min: 0, max: 25, noNaN: true }),
        (r, exponent) => {
          const altitude = r * 2 ** -exponent
          const opacity = terrainOpacity(r, r + altitude)
          if (opacity === 1) expect(terrainLevelFor(r, r + altitude)).toBe(12)
          if (terrainLevelFor(r, r + altitude) < 12)
            expect(opacity).toBeLessThan(1)
          // And it never increases with altitude.
          expect(terrainOpacity(r, r + altitude * 2)).toBeLessThanOrEqual(
            opacity,
          )
        },
      ),
    )
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
    // The regression that made terrain invisible: in a 400 km orbit the center
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
          const ca = compressDistance(a)
          const cb = compressDistance(b)
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
          const ca = compressDistance(a)
          const cb = compressDistance(b)
          expect(a < b).toBe(ca < cb)
        },
      ),
    )
  })

  it('is continuous at the compression boundary', () => {
    const nearLimit = NEAR_LIMIT
    // Continuous in value...
    expect(compressDistance(nearLimit)).toBeCloseTo(nearLimit, 6)
    // ...and in slope, which is what stops a body changing its apparent rate of
    // approach as it crosses the boundary.
    const step = nearLimit * 1e-6
    const slope = (compressDistance(nearLimit + step) - nearLimit) / step
    expect(slope).toBeCloseTo(1, 5)
  })

  it('brings a star four light-years away inside float32 comfort', () => {
    const star = UV.translate(ORIGIN.position, vec3(4 * LIGHT_YEAR, 0, 0))
    const placement = placeAt(ORIGIN, star, 6.957e8)
    expect(placement.distance / LIGHT_YEAR).toBeCloseTo(4, 3)
    // Rendered under a billion meters out instead of 4e16 — inside what a
    // logarithmic depth buffer handles comfortably. The star's own radius
    // dominates that figure, because a body's radius is never compressed away.
    expect(Vec.length(placement.position)).toBeLessThan(1e10)
    expect(Vec.length(placement.position)).toBeGreaterThan(1e7)
    expect(Math.fround(placement.position.x)).not.toBe(0)
  })
})

describe('scene', () => {
  function sceneFixture() {
    const world = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
    const system = world.loadSystem(systemId('SOL'))
    const planet = [...walkBodies(system)].find(
      (b) => b.kind === 'rocky' && b.radius > 1e6,
    )
    if (planet === undefined) throw new Error('no planet')
    const ship = world.spawnShip(
      'cam',
      bodyFrameId(planet.address),
      vec3(planet.radius * 2.2, 0, 0),
    )
    world.runTicks(4)
    const shot = snapshot(world)
    const camera = shot.entities.find((e) => e.id === ship.id)
    if (camera === undefined) throw new Error('no camera')
    const origin = originForCamera(null, camera.position)
    return {
      world,
      planet,
      ship,
      shot,
      origin,
      scene: buildScene(shot, origin, ship.id),
    }
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
    const moved = rebase(
      scene.origin,
      UV.translate(scene.origin.position, vec3(50_000, 0, 0)),
    )
    const rebased = buildScene(shot, moved, ship.id)
    // Render coordinates shift by exactly the origin delta — which is snapped
    // to the 1024 m grid, hence 50176 rather than 50000.
    const shift = UV.difference(moved.position, scene.origin.position)
    expect(shift.x).toBe(50_176)
    const before = scene.entities.find((e) => e.isCamera)
    const after = rebased.entities.find((e) => e.isCamera)
    expect((before?.position.x ?? 0) - (after?.position.x ?? 0)).toBeCloseTo(
      shift.x,
      3,
    )
    // ...and the canonical positions in the snapshot are untouched.
    expect(
      UV.equals(rebased.camera.universePosition, scene.camera.universePosition),
    ).toBe(true)
  })

  it('finds the body the player is closest to the surface of', () => {
    const { scene, planet } = sceneFixture()
    expect(nearestBody(scene)?.address).toBe(planet.id.slice(1))
  })

  it('lights the scene from the star you are actually at', () => {
    /*
     * `stars[0]` is the key light. It used to be whichever system was loaded
     * first, which nothing could notice until traveling between systems became
     * an ordinary thing to do: arriving 40 AU from Proxima left the scene lit by
     * Sol, 4.2 light years behind, and the star overhead contributing nothing.
     */
    const { world, ship } = sceneFixture()
    const proxima = world.loadSystem(systemId('HIP70890'))
    world.teleport(ship.id, {
      frame: systemFrameId(proxima.id),
      position: vec3(40 * AU, 0, 0),
      orientation: Q.IDENTITY,
      velocity: Vec.ZERO,
      angularVelocity: Vec.ZERO,
    })
    world.runTicks(1)
    const shot = snapshot(world)
    const camera = shot.entities.find((e) => e.id === ship.id)
    if (camera === undefined) throw new Error('no camera')
    const scene = buildScene(
      shot,
      originForCamera(null, camera.position),
      ship.id,
    )

    expect(scene.stars).toHaveLength(2)
    expect(scene.stars[0]?.name).toBe('Proxima Centauri')
    // Sol is still in the scene — it is simply not the sun any more.
    expect(scene.stars[1]?.name).toBe('Sol')
    expect(scene.stars[0]?.brightness).toBe(1)
  })

  it('culls what would be smaller than a pixel', () => {
    const { shot, ship } = sceneFixture()
    const farAway = createRenderOrigin(UV.fromMeters(0, 0, 0))
    const scene = buildScene(shot, farAway, ship.id)
    // From the galactic center, Sol's planets are far below one pixel.
    expect(scene.bodies).toHaveLength(0)
  })
})

describe('chase camera', () => {
  /*
   * The camera has 14 m of lever arm behind the ship, and the offset is in ship
   * axes so it swings with the attitude. Landed and nose-high that swings it
   * *down*: 10° puts it at ground level and 40° puts it 7 m under, where the
   * near terrain is backface-culled, stars show through the ground and the far
   * terrain reads as a second band of land. It looks like broken geometry and
   * it is a camera with no floor.
   */
  function landedScene(pitchDegrees: number): RenderScene {
    const world = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
    const system = world.loadSystem(systemId('SOL'))
    const planet = [...walkBodies(system)].find(
      (b) => b.kind === 'rocky' && b.radius > 1e6,
    )
    if (planet === undefined) throw new Error('no planet')

    const frame = installSurfaceFrame(world.frames, planet, 0.35, -1.1)
    const ship = world.spawnShip('cam', frame, vec3(0, 0, 0))
    world.runTicks(64)
    world.teleport(ship.id, {
      ...world.entities.require(ship.id).state,
      orientation: Q.fromAxisAngle(
        vec3(1, 0, 0),
        (pitchDegrees * Math.PI) / 180,
      ),
    })
    world.runTicks(1)

    const shot = snapshot(world)
    const view = shot.entities.find((e) => e.id === ship.id)
    if (view === undefined) throw new Error('no camera')
    return buildScene(shot, originForCamera(null, view.position), ship.id)
  }

  it('knows which way is up independently of where the ship is pointing', () => {
    const level = landedScene(0)
    const nose = landedScene(80)
    // Up is the radial direction, so it does not care about attitude.
    expect(Vec.dot(level.camera.up, nose.camera.up)).toBeCloseTo(1, 6)
    expect(Vec.length(level.camera.up)).toBeCloseTo(1, 9)
    // Parked, so the altitude is zero to within the millimeter the contact
    // clamp and the one-tick-old snapshot leave behind.
    expect(Math.abs(level.camera.altitude ?? 1)).toBeLessThan(0.01)
  })

  it('keeps the camera above the ground at any attitude', () => {
    for (const pitch of [0, 10, 20, 40, 60, 90, 180, -40]) {
      const scene = landedScene(pitch)
      const eye = chaseCameraPosition(scene)
      // Height of the eye over the ship, along local up, plus the ship's own
      // altitude — which is zero, because it is parked.
      const height = Vec.dot(
        Vec.sub(eye, scene.camera.position),
        scene.camera.up,
      )
      expect(
        `pitch ${pitch}: ${height >= CAMERA_GROUND_CLEARANCE - 1e-9}`,
      ).toBe(`pitch ${pitch}: true`)
    }
  })

  it('keeps a modeled hull in frame at any length', () => {
    // The framing rule is a ratio, so the angle the hull subtends from the
    // camera must not depend on how long it is: a 6 m cone and a 642 m
    // starship should fill the same fraction of the view. The half-angle from
    // eye to bow is atan((L/2) / |offset|), which the ratio pins for every L.
    const lengths = [6, 60, 642.5, 5000]
    const subtended = lengths.map((length) => {
      const offset = chaseOffsetFor(length)
      expect(offset.z).toBeGreaterThan(0) // behind, never inside
      expect(offset.y).toBeGreaterThan(0) // above, so the deck is visible
      return Math.atan(length / 2 / Vec.length(offset))
    })
    for (const angle of subtended) {
      expect(angle).toBeCloseTo(subtended[0] as number, 9)
    }
  })

  it('keeps the camera above the ground behind a full-size hull', () => {
    // The clearance clamp was tuned against 14 m of lever arm; a modeled
    // hull hangs the camera ~900 m back, where the same nose-high pitch digs
    // proportionally deeper. The rule must hold regardless of the arm.
    for (const pitch of [0, 10, 20, 40, 60, 90, 180, -40]) {
      const scene = landedScene(pitch)
      const eye = chaseCameraPosition(scene, chaseOffsetFor(642.5))
      const height = Vec.dot(
        Vec.sub(eye, scene.camera.position),
        scene.camera.up,
      )
      expect(
        `pitch ${pitch}: ${height >= CAMERA_GROUND_CLEARANCE - 1e-9}`,
      ).toBe(`pitch ${pitch}: true`)
    }
  })

  it('leaves the offset alone when there is room', () => {
    // Nothing to clip through in deep space, and nothing to lift the camera
    // off: an unclamped chase view is the normal case and must stay exact.
    const scene = landedScene(0)
    const free: RenderScene = {
      ...scene,
      camera: { ...scene.camera, altitude: null },
    }
    const eye = chaseCameraPosition(free)
    const expected = Vec.add(
      free.camera.position,
      Q.rotate(free.camera.orientation, CHASE_OFFSET),
    )
    expect(Vec.length(Vec.sub(eye, expected))).toBeLessThan(1e-9)
  })
})

describe('terrain mesh', () => {
  it('builds a patch that sits on the body, in render space', () => {
    const world = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
    const system = world.loadSystem(systemId('SOL'))
    const planet = [...walkBodies(system)].find(
      (b) => b.surface.maxElevation > 0,
    )
    if (planet === undefined) throw new Error('no solid body')

    const bodyPose = world.frames.pose(bodyFrameId(planet.address), 0)
    const region = regionAddress(0, 4, 8, 8)
    const field = generateHeightfield(planet.surface, {
      region,
      resolution: 17,
    })
    const origin = createRenderOrigin(bodyPose.position)
    const patch = buildPatch({
      region,
      resolution: 17,
      elevations: field.elevations,
      bodyRadius: planet.radius,
    })

    expect(patch.positions.length).toBe(17 * 17 * 3)
    expect(patch.indices.length).toBe(16 * 16 * 6)

    // Vertices are anchor-relative, which is what keeps them inside float32's
    // useful range: measured from the body's center they would be ~10^6 m,
    // where a float32 step is 0.17 m and the relief this test checks for is
    // gone. A patch is a few hundred meters across at this level.
    for (let i = 0; i < patch.positions.length; i += 3) {
      expect(Math.abs(patch.positions[i] as number)).toBeLessThan(1e5)
    }

    // Put the pose back on: every vertex is then at the planet's radius plus
    // its own elevation, measured from the body's center in render space.
    const placement = patchPlacement(
      patch,
      origin,
      bodyPose.position,
      Q.IDENTITY,
    )
    const bodyInRender = toRenderSpace(origin, bodyPose.position)
    for (let i = 0; i < patch.positions.length; i += 3) {
      const local = vec3(
        patch.positions[i] as number,
        patch.positions[i + 1] as number,
        patch.positions[i + 2] as number,
      )
      const world = Vec.add(
        placement.position,
        Q.rotate(placement.orientation, local),
      )
      const r = Vec.length(Vec.sub(world, bodyInRender))
      expect(Math.abs(r - planet.radius)).toBeLessThanOrEqual(
        planet.surface.maxElevation * 1.5,
      )
    }
    /*
     * Normals follow the relief, not the datum sphere.
     *
     * "Unit length" was the whole assertion here, and a radial normal is also
     * unit length — so this test passed both before and after the fix for
     * "terrain patches carried radial normals, shading a mountain range exactly
     * like a smooth sphere". The check has to be that the normals *differ* from
     * radial where there is relief.
     */
    let maxTilt = 0
    let unitLengthFailures = 0
    for (let i = 0; i < patch.normals.length; i += 3) {
      const n = vec3(
        patch.normals[i] as number,
        patch.normals[i + 1] as number,
        patch.normals[i + 2] as number,
      )
      if (Math.abs(Vec.length(n) - 1) > 1e-5) unitLengthFailures += 1
      // The radial direction at this vertex — what a smooth sphere would give.
      const radial = Vec.normalize(
        vec3(
          patch.positions[i] as number,
          patch.positions[i + 1] as number,
          patch.positions[i + 2] as number,
        ),
      )
      maxTilt = Math.max(
        maxTilt,
        Math.acos(Math.min(1, Math.abs(Vec.dot(n, radial)))),
      )
    }
    expect(unitLengthFailures).toBe(0)
    // A patch spanning real mountains has to tilt somewhere. The bound is
    // deliberately small — this is one patch on one seed, and the point is that
    // it is not *zero*, which is what a radial normal would give.
    expect(maxTilt).toBeGreaterThan(1e-3)
  })

  it('winds every triangle counter-clockwise seen from outside the body', () => {
    /*
     * The renderer's terrain material is single-sided, and the GPU culls by
     * screen-space winding — the normal attribute has no say in it. So this is
     * the property the whole feature stands on: wound the other way, every
     * patch is culled from above, the datum sphere 11 km below reads as the
     * ground, and the far slopes of ridges above eye level leak through as a
     * terrain-colored band floating over the horizon. That shipped, and it
     * passed every distance-based test in this file, because winding is
     * invisible to arithmetic about vertex positions.
     *
     * Checked on all six cube faces because each face maps (s, t) to a
     * different pair of axes, so a fix that hard-codes one face's handedness
     * would pass anywhere a single-face test happened to land.
     */
    const world = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
    const system = world.loadSystem(systemId('SOL'))
    const planet = [...walkBodies(system)].find(
      (b) => b.surface.maxElevation > 0,
    )
    if (planet === undefined) throw new Error('no solid body')

    const resolution = 9
    for (let face = 0; face < 6; face += 1) {
      for (const [level, i, j] of [
        [4, 8, 8],
        [12, 3090, 2886],
      ] as const) {
        const span = 2 ** level
        const region = regionAddress(
          face,
          level,
          Math.min(i, span - 1),
          Math.min(j, span - 1),
        )
        const field = generateHeightfield(planet.surface, {
          region,
          resolution,
        })
        const patch = buildPatch({
          region,
          resolution,
          elevations: field.elevations,
          bodyRadius: planet.radius,
        })

        const vertex = (index: number) =>
          vec3(
            patch.positions[index * 3] as number,
            patch.positions[index * 3 + 1] as number,
            patch.positions[index * 3 + 2] as number,
          )
        for (let t = 0; t < patch.indices.length; t += 3) {
          const a = vertex(patch.indices[t] as number)
          const b = vertex(patch.indices[t + 1] as number)
          const c = vertex(patch.indices[t + 2] as number)
          const geometric = Vec.cross(Vec.sub(b, a), Vec.sub(c, a))
          // True radial direction at the triangle, which needs the anchor put
          // back on — the positions alone are anchor-relative.
          const centroid = Vec.add(
            patch.anchor,
            Vec.scale(Vec.add(Vec.add(a, b), c), 1 / 3),
          )
          expect(
            `face ${face} level ${level} triangle ${t / 3}: ${Vec.dot(geometric, centroid) > 0}`,
          ).toBe(`face ${face} level ${level} triangle ${t / 3}: true`)
        }
      }
    }
  })

  it('places meter-scale detail on an astronomically distant surface', () => {
    // Requirement 8 of the milestone, checked at the level that decides it: a
    // vertex a meter from its neighbor must still be a meter from it after
    // going through render space, four light-years out.
    const centre = UV.fromMeters(4.2 * LIGHT_YEAR, 0, 0)
    const a = UV.translate(centre, vec3(6.371e6, 0, 0))
    const b = UV.translate(centre, vec3(6.371e6, 1, 0))
    // The origin follows the camera, so the ground under the player is always
    // in the uncompressed near field. That is what makes meter-scale objects
    // exact four light-years from anywhere.
    const origin = createRenderOrigin(a)
    const pa = placeAt(origin, a, 1)
    const pb = placeAt(origin, b, 1)
    expect(pa.compressed).toBe(false)
    expect(
      Vec.distance(Vec.toFloat32(pa.position), Vec.toFloat32(pb.position)),
    ).toBeCloseTo(1, 4)

    // Sanity: from an origin at the planet's center those same two points *are*
    // compressed, and the meter between them shrinks. Compression is a property
    // of the far field, and the far field is not where gameplay happens.
    const distant = createRenderOrigin(centre)
    expect(placeAt(distant, a, 1).compressed).toBe(true)
    expect(AU).toBeGreaterThan(0)
  })
})

describe('the star shell', () => {
  /*
   * This projection used to live in the R3F component, written out over the raw
   * sector fields with `2 ** 40` inline, in the one directory vitest did not
   * cover. `placePoint` — written for exactly this — had no callers.
   */
  it("puts every star on the shell, in the origin's axes", () => {
    const centre = universeVector(3, -1, 7, 100, 200, 300)
    const origin = createRenderOrigin(centre)
    const star = UV.translate(centre, vec3(4 * LIGHT_YEAR, 0, 0))

    const point = placeOnStarShell(origin, star)
    if (point === null)
      throw new Error('a star four light years away has a direction')
    expect(Vec.length(point)).toBeCloseTo(STAR_SHELL_RADIUS, 3)

    // Direction is preserved; only the radius is invented.
    const direct = toRenderSpace(origin, star)
    const cosine = Vec.dot(Vec.normalize(point), Vec.normalize(direct))
    expect(cosine).toBeCloseTo(1, 12)
  })

  it('has no direction for a star at the origin', () => {
    const centre = universeVector(0, 0, 0, 0, 0, 0)
    expect(placeOnStarShell(createRenderOrigin(centre), centre)).toBeNull()
  })
})
