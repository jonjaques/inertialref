import { afterEach, describe, expect, it } from 'vitest'
import { LIGHT_YEAR } from '@inertialref/shared'
import { Quaternion as Q, UV, Vec } from '@inertialref/spatial'
import {
  bodyFixedFrameId,
  findBody,
  geodeticDirection,
  parseAddress,
  SURFACE_ARCHETYPES,
  surfaceDetailFloor,
  surfaceRadius,
  systemId,
  systemsWithin,
  type Body,
} from '@inertialref/universe'
import { MIN_STANCE_HEIGHT, surfaceHeightBounds } from '@inertialref/rendering'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { openSession, type Session } from './session.ts'
import { simulateDescent } from './descent.ts'
import { missingArchetypes, terrainZoo } from './terrainZoo.ts'

/*
 * The terrain rig against a live world.
 *
 * `rendering/surfaceStance.test.ts` proves the arithmetic and
 * `universe/surveySites.test.ts` proves the geology classification; this proves
 * the binding — that a zoo entry resolves to a body, that standing on it puts
 * the camera where the terrain says the ground is, and above all that none of it
 * touches canonical state. The planetarium's whole architectural claim is that
 * looking is not going, and the surface arm reaches further below a body than
 * anything in this codebase ever has: it is exactly the place that claim would
 * break first.
 */

/*
 * Sessions are torn down from `afterEach`, not from the end of a test body.
 *
 * Vitest aborts a body at the first failed expectation, so a trailing
 * `session.dispose()` is the one line a failure guarantees will not run — and
 * what leaks is an inline worker pool, a set of loaded systems and a batch of
 * `surveySites` cache entries, for every test after it. A cascade of secondary
 * failures from a leaked pool is indistinguishable from the original.
 */
const open: Session[] = []

function live(): Session {
  const registry = createTaskRegistry()
  // No catalog, so `SOL_ONLY_CATALOG` — the galaxy outside Sol is entirely
  // procedural, which is what makes the zoo's search reproducible here without
  // shipping the packed asset into a unit test.
  const session = openSession({
    seed: 'inertialref',
    workers: () => createInlineWorker(registry),
  })
  open.push(session)
  return session
}

afterEach(() => {
  for (const session of open.splice(0)) session.dispose()
})

const bodyAt = (session: Session, address: string): Body => {
  const parsed = parseAddress(address)
  if (parsed.kind !== 'body') throw new Error(`${address} is not a body`)
  const body = findBody(session.world.loadSystem(parsed.system), parsed.body)
  if (body === undefined) throw new Error(`no body at ${address}`)
  return body
}

describe('the terrain zoo', () => {
  it('contains one body of every archetype', () => {
    /*
     * The assertion the zoo exists for. Its members are *found*, so a catalog
     * revision or a generator change can move them — what must not happen is
     * that one of the four quietly stops being found and every later phase's
     * plate set silently becomes three worlds that nobody counts.
     */
    const session = live()
    const zoo = terrainZoo(session.world)
    expect(missingArchetypes(zoo)).toEqual([])
    expect(zoo.map((entry) => entry.archetype)).toEqual(SURFACE_ARCHETYPES)
  })

  it('picks only bodies with terrain worth looking at', () => {
    const session = live()
    for (const entry of terrainZoo(session.world)) {
      const body = bodyAt(session, entry.address)
      // Each of the four carve-outs the plan names, checked on every member:
      // unmapped, round, solid, and with relief above zero.
      expect(`${entry.name}: ${body.appearance.texture}`).toBe(
        `${entry.name}: null`,
      )
      expect(`${entry.name}: ${body.figure}`).toBe(`${entry.name}: null`)
      expect(entry.maxElevation).toBeGreaterThan(0)
      expect(entry.meanRadiusKm).toBeGreaterThanOrEqual(200)
    }
  })

  it('does not depend on where the session has been', () => {
    /*
     * The regression this exists for, and the first version of it could not
     * fail.
     *
     * It loaded `SOL` between the two calls — which is loaded in every session
     * already, so `loadSystem` was a no-op, the world was byte-identical across
     * both, and the assertion was `terrainZoo(w) === terrainZoo(w)`. It stayed
     * green with the defect wide open: the search read `world.loadedSystems()`
     * first, so a browser that had flown fifteen light years returned a
     * different rocky pair from `pnpm sim` on the same seed.
     *
     * So the system loaded in between has to be one the zoo did *not* generate
     * for itself. Twenty of them, from further out than the search's own radius
     * — which is exactly the state an ordinary session is in after a few
     * minutes of travel.
     */
    const session = live()
    const first = terrainZoo(session.world)
    const sol = session.world.loadSystem(systemId('SOL'))
    let loaded = 0
    for (const stub of systemsWithin(
      session.world.galaxySeed,
      session.world.catalog,
      sol.position,
      25 * LIGHT_YEAR,
    )) {
      if (loaded >= 20) break
      if (stub.id === sol.id) continue
      try {
        session.world.loadSystem(stub.id)
        loaded += 1
      } catch {
        continue
      }
    }
    expect(loaded).toBe(20)
    expect(terrainZoo(session.world)).toEqual(first)
  })
})

describe('a simulated descent', () => {
  it('climbs the level ladder monotonically when it drops straight down', () => {
    /*
     * What "orbit to on foot" costs today, as levels. The profile starts at the
     * orbit arm's floor and ends at two meters, so it passes through every level
     * the selection can produce and ends at the field's own detail floor.
     *
     * `trackDegrees: 0`, because straight down the deepest level is a function
     * of height alone and a descent must never coarsen. It may now *hold* a
     * level for several steps where the old rule stepped every octave, because
     * refinement is per patch: the ring under the camera deepens before the ring
     * beyond it does, and the report's deepest level is the first of those.
     */
    const session = live()
    for (const entry of terrainZoo(session.world)) {
      const body = bodyAt(session, entry.address)
      const floor = surfaceDetailFloor(body.radius, body.surface)
      const report = simulateDescent(body, { site: 'basin', trackDegrees: 0 })
      const levels = report.levels
      expect(`${entry.name}: ${levels.length > 4}`).toBe(`${entry.name}: true`)
      for (let i = 1; i < levels.length; i += 1) {
        expect(
          `${entry.name}: ${(levels[i] ?? 0) > (levels[i - 1] ?? 0)}`,
        ).toBe(`${entry.name}: true`)
      }
      expect(`${entry.name}: ${levels[levels.length - 1]}`).toBe(
        `${entry.name}: ${floor}`,
      )
    }
  })

  it('streams a summit exactly as it streams a basin', () => {
    /*
     * Half of the datum finding, now the other way round.
     *
     * Phase 0 measured this pair at 11 and 12: standing two meters above
     * Iapetus's highest ground the streamer asked for a level coarser than the
     * same two meters over its deepest basin, because `terrainLevelFor` was
     * handed `distance − radius` — which for a camera on the ground is
     * `groundElevation + height`, and that summit is 4.4 km above the datum.
     *
     * The quadtree measures a node against the shell of ground it can hold
     * rather than against the datum sphere, so an eye inside that shell is on
     * the ground wherever the ground happens to be. Still asserted as a pair,
     * because the pair is what makes it a property rather than a constant.
     */
    const session = live()
    const icy = terrainZoo(session.world).find(
      (entry) => entry.archetype === 'icy-dead',
    )
    const body = bodyAt(session, icy?.address ?? '')
    const last = (site: string): number => {
      const report = simulateDescent(body, { site, trackDegrees: 0 })
      return report.levels[report.levels.length - 1] ?? -1
    }
    const floor = surfaceDetailFloor(body.radius, body.surface)
    expect(last('basin')).toBe(floor)
    expect(last('summit')).toBe(floor)
  })

  it('draws a mountain that used to be too tall to draw', () => {
    /*
     * The other half, and the one that was a hole rather than a degradation.
     *
     * `terrainOpacity` faded out over one octave above `radius · 2^(4.5−12)`,
     * measured — again — from the datum. On Miranda that cutoff is 2,605 m and
     * the summit the survey finds is 4,826 m, so standing on it the streamer
     * requested nothing, drew nothing, and left the datum sphere on screen: two
     * of six survey sites were ground that could not be looked at at any
     * altitude, including zero. It is not an exotic case, it is Verona Rupes on
     * a 236 km moon.
     *
     * There is no fade any more, and nothing about the selection knows the
     * datum. Every site bottoms out at the same floor, including the two that
     * were holes.
     */
    const session = live()
    const active = terrainZoo(session.world).find(
      (entry) => entry.archetype === 'icy-active',
    )
    const body = bodyAt(session, active?.address ?? '')
    const floor = surfaceDetailFloor(body.radius, body.surface)
    for (const site of ['summit', 'rough', 'basin']) {
      const report = simulateDescent(body, { site, trackDegrees: 0 })
      expect(`${site}: ${report.levels[report.levels.length - 1]}`).toBe(
        `${site}: ${floor}`,
      )
      // And there is ground drawn at every step of the way down, which is the
      // sentence the fade made false.
      for (const step of report.steps) {
        expect(`${site}@${step.index}: ${step.wanted > 0}`).toBe(
          `${site}@${step.index}: true`,
        )
      }
    }
  })

  it('holds its level on a pass across a peak and a basin', () => {
    /*
     * The third of Phase 0's findings, inverted.
     *
     * `terrainLevelFor` took `distance − radius`, so flying level across
     * Iapetus — 10 km of relief on a 735 km radius — moved that number by up to
     * 20 km and coarsened the whole window by a step as the ground rose and fell
     * beneath a camera that had not changed height at all. Nine patches thrown
     * away and re-requested, which was harmless at nine and would not have been
     * at two hundred.
     *
     * A pass at fixed height now holds its deepest level, because the level a
     * patch is drawn at depends on the distance to *that patch* and standing on
     * a mountain is standing on the ground.
     */
    const session = live()
    const icy = terrainZoo(session.world).find(
      (entry) => entry.archetype === 'icy-dead',
    )
    const body = bodyAt(session, icy?.address ?? '')
    const report = simulateDescent(body, {
      fromHeight: 2,
      toHeight: 2,
      trackDegrees: 10,
    })
    expect(report.levels).toEqual([
      surfaceDetailFloor(body.radius, body.surface),
    ])
    expect(report.levelChanges).toBe(0)
  })

  it('keeps the whole disk inside a budget, on every zoo body', () => {
    /*
     * The window's virtue was that it could never ask for more than nine
     * patches; its vice was that nine patches is not a planet. What replaces
     * that bound is a measured one, and it is the number Phase 1 is judged on:
     * a whole-disk selection at the shipped tolerance is a couple of hundred
     * patches, the budget never bites, and every patch the selection wanted is
     * accounted for as a request or a hit.
     */
    const session = live()
    for (const entry of terrainZoo(session.world)) {
      const report = simulateDescent(bodyAt(session, entry.address), {
        site: 'basin',
      })
      expect(`${entry.name}: ${report.saturatedSteps}`).toBe(`${entry.name}: 0`)
      /*
       * The measured ceiling, and the number `DEFAULT_MAX_PATCHES` has to stay
       * clear of. It is set by the *balance* rather than by the error
       * tolerance: a restricted quadtree grading from the level underfoot out
       * to the level at the horizon costs 410 to 480 patches on a body with
       * seven or eight levels between the two, and changing the tolerance moves
       * it by a few percent. The assertion is here so that a change to either
       * is a change to a number rather than a surprise in a frame.
       */
      expect(`${entry.name}: ${report.peakDrawn < 700}`).toBe(
        `${entry.name}: true`,
      )
      const wanted = report.steps.reduce((sum, step) => sum + step.wanted, 0)
      expect(report.totalRequests + report.cacheHits).toBe(wanted)
      expect(report.uniqueRegions).toBeLessThanOrEqual(report.totalRequests)
      /*
       * And the descent's working set is still multiples of the cache, which is
       * a finding rather than a defect in the cache: what a descent touches is
       * thousands of regions, so the streamer's 512 heightfields are sized to
       * hold the *selection* and its lookahead rather than the journey.
       */
      expect(report.uniqueRegions).toBeGreaterThan(512)
    }
  })

  it('is deterministic', () => {
    const session = live()
    const body = bodyAt(session, terrainZoo(session.world)[0]?.address ?? '')
    const a = simulateDescent(body, { site: 'basin' })
    const b = simulateDescent(body, { site: 'basin' })
    expect(b.steps.map((step) => step.level)).toEqual(
      a.steps.map((step) => step.level),
    )
    expect(b.totalRequests).toBe(a.totalRequests)
  })
})

describe('the observatory on the ground', () => {
  it('stands without touching canonical state', () => {
    /*
     * The planetarium's design promise, extended to the arm that goes below the
     * orbit clamp. `observatory.test.ts` makes the same comparison for looking;
     * this one matters more, because standing samples the terrain, resolves a
     * spin frame and reads the clock — three places a read could become a write
     * without anything looking wrong on screen.
     */
    const session = live()
    const { harness } = session
    const zoo = terrainZoo(session.world)
    const before = session.world.stateHash()

    for (const entry of zoo) {
      harness.visit(entry.address, { site: 'summit', height: 2 })
      harness.observatory.setStanceScrub(0.5)
      harness.observatory.setHeading(1.2)
      harness.observatory.sample(1 / 60)
      harness.sites(entry.address)
      harness.descend(entry.address)
    }
    harness.ascend()

    expect(session.world.stateHash()).toBe(before)
  })

  it('puts the eye exactly the stance height above the ground', () => {
    /*
     * The one assertion that ties the arithmetic to the terrain: the distance
     * from the body's *center* to the camera has to be `surfaceRadius` at the
     * stance plus the height. If the pose were composed against the orbital
     * `b:` frame instead of the rotating `bf:` one it would still be the right
     * distance — the frames share an origin — so the second half of the test is
     * the one that catches that: the camera's own up axis must be the local up,
     * carried into universe axes by the *spin* orientation.
     */
    const session = live()
    const { harness, world } = session
    const entry = terrainZoo(world)[0]
    const body = bodyAt(session, entry?.address ?? '')

    harness.visit(entry?.address, { site: 'rough' })
    harness.visit(entry?.address, { site: 'summit', height: 120 })
    const pose = harness.observerSample(0)
    expect(pose).not.toBeNull()

    const spin = world.frames.pose(
      bodyFixedFrameId(body.address),
      world.clock.renderTime,
    )
    const offset = UV.difference(pose?.position ?? spin.position, spin.position)
    const status = harness.observerStatus()
    const stance = status?.surface?.stance
    expect(stance).toBeDefined()

    const up = geodeticDirection(stance?.latitude ?? 0, stance?.longitude ?? 0)
    const ground = surfaceRadius(body, up)
    // A millimeter in a radius of hundreds of kilometers: the float64 offset
    // arithmetic resolves far better than that, so a looser bound would let a
    // datum error through.
    expect(Vec.length(offset)).toBeCloseTo(ground + 120, 3)

    /*
     * And it is standing on *that* point, not merely at that distance.
     *
     * `rotateInverse`, because `offset` is in universe axes and `up` is
     * body-fixed. Comparing them directly reads 0.9997 rather than 1 — a degree
     * and a half, which is the body's axial tilt at this instant and would grow
     * to a full hemisphere as the planet turned. That is the whole `b:` versus
     * `bf:` distinction, and a test that compared across frames would pass at
     * epoch and fail at noon.
     */
    const inSpin = Vec.normalize(Q.rotateInverse(spin.orientation, offset))
    expect(Vec.dot(inSpin, up)).toBeCloseTo(1, 9)
  })

  it('takes degrees at the harness and radians below it', () => {
    // `ir.land` takes radians and is the odd one out; every listing verb prints
    // degrees, so a console that copies a latitude out of `ir.sites()` into
    // `ir.visit()` has to mean the same thing by it.
    const session = live()
    const { harness } = session
    const entry = terrainZoo(session.world)[0]
    harness.visit(entry?.address, { latitude: 45, longitude: -30, height: 10 })
    const stance = harness.observerStatus()?.surface?.stance
    expect((stance?.latitude ?? 0) * (180 / Math.PI)).toBeCloseTo(45, 9)
    expect((stance?.longitude ?? 0) * (180 / Math.PI)).toBeCloseTo(-30, 9)
  })

  it('leaves the ground when the camera is pointed somewhere else', () => {
    /*
     * A stance names a latitude and a longitude on one particular body.
     * Carrying it across a change of target would put the camera at those
     * coordinates on a different world — a bug that shows up as terrain, so
     * nothing about the picture would look wrong.
     */
    const session = live()
    const { harness } = session
    const zoo = terrainZoo(session.world)
    harness.visit(zoo[0]?.address, { site: 'summit' })
    expect(harness.observatory.standing).toBe(true)
    harness.look(zoo[1]?.address ?? '')
    expect(harness.observatory.standing).toBe(false)
    expect(harness.observerStatus()?.surface).toBeNull()
  })

  it('clamps the descent to the band between the ground and the orbit arm', () => {
    const session = live()
    const { harness } = session
    const entry = terrainZoo(session.world)[0]
    const body = bodyAt(session, entry?.address ?? '')
    const bounds = surfaceHeightBounds(body.radius)

    harness.visit(entry?.address, { site: 'summit', height: 1e12 })
    expect(harness.observerStatus()?.surface?.stance.height).toBeCloseTo(
      bounds.max,
      6,
    )
    harness.observatory.setStanceHeight(-5)
    expect(harness.observerStatus()?.surface?.stance.height).toBe(
      MIN_STANCE_HEIGHT,
    )
  })

  it('refuses a body with no surface, and leaves the camera where it was', () => {
    const session = live()
    const { harness } = session
    // Saturn's bulk density is 687 kg/m³, so a classifier reading density alone
    // calls it an icy world. `hasSolidSurface` is what stops a descent aimed at
    // where the drag model stops integrating.
    harness.look('s:SOL/b:2')
    const before = harness.observatory.target?.address
    expect(() => harness.visit('s:SOL/b:5')).toThrow(/no surface/)
    // The second half, and it is the half that was wrong: the refusal used to
    // happen *after* `focus` had already committed, so a call that threw still
    // left the planetarium looking at Saturn.
    expect(harness.observatory.target?.address).toBe(before)
  })

  it('gives back the framing the descent started from', () => {
    /*
     * What `ascend` promises in four docstrings and the harness guide, and did
     * not do.
     *
     * `stand` called `focus` unconditionally, and `focus` re-solves the distance
     * from `framingDistance(radius, fov, DEFAULT_FILL)`. So descending from a
     * framing the user had zoomed to and coming back up landed on the default
     * instead — a restore of a value nobody had chosen, which is the same bug
     * class `presentation.ts` was written to make unrepresentable.
     *
     * The Surface panel's site buttons take exactly this path: they call
     * `visit(undefined, …)`, which resolves to the address already held.
     */
    const session = live()
    const { harness } = session
    const entry = terrainZoo(session.world)[0]
    harness.look(entry?.address ?? '')
    harness.observatory.setDistance(1_100_000, false)
    const framing = harness.observatory.state.distance

    harness.visit(entry?.address, { site: 'summit', height: 2 })
    harness.visit(undefined, { site: 'basin', height: 2 })
    harness.ascend()

    expect(harness.observatory.state.distance).toBeCloseTo(framing, 6)
  })
})
