import { afterEach, describe, expect, it } from 'vitest'
import { LIGHT_YEAR } from '@inertialref/shared'
import { Quaternion as Q, UV, Vec } from '@inertialref/spatial'
import {
  bodyFixedFrameId,
  findBody,
  geodeticDirection,
  parseAddress,
  SURFACE_ARCHETYPES,
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
     * `terrainLevelFor` can produce and ends saturated at its cap.
     *
     * `trackDegrees: 0`, because the ground track is what breaks monotonicity —
     * see the next test. Straight down, the level is a function of height alone
     * and a descent must never coarsen.
     */
    const session = live()
    for (const entry of terrainZoo(session.world)) {
      const report = simulateDescent(bodyAt(session, entry.address), {
        // Into a basin, so that the summit's own elevation does not stand
        // between the camera and the bottom of the ladder — see the two tests
        // below, which are about exactly that.
        site: 'basin',
        trackDegrees: 0,
      })
      const levels = report.levels
      expect(`${entry.name}: ${levels.length > 6}`).toBe(`${entry.name}: true`)
      for (let i = 1; i < levels.length; i += 1) {
        expect(
          `${entry.name}: ${(levels[i] ?? 0) > (levels[i - 1] ?? 0)}`,
        ).toBe(`${entry.name}: true`)
      }
      // Into a basin the ladder saturates at the cap. Onto a summit it does
      // not, and the next two tests are what that costs.
      expect(`${entry.name}: ${levels[levels.length - 1]}`).toBe(
        `${entry.name}: 12`,
      )
    }
  })

  it('streams a summit as though the camera were still kilometers up', () => {
    /*
     * Half of the datum finding.
     *
     * Standing two meters above the highest ground on Iapetus, the streamer
     * asks for level 11 rather than 12 — because `terrainLevelFor` is handed
     * `distance − radius`, which for a camera on the ground is
     * `groundElevation + height`, and that summit is 4.4 km above the datum. The
     * ground under your boots is streamed at half the resolution the same two
     * meters would get in a basin.
     *
     * Asserted as the pair rather than as one number, because the pair is what
     * makes it a defect rather than a constant: same body, same height above the
     * ground, two different levels.
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
    expect(last('basin')).toBe(12)
    expect(last('summit')).toBe(11)
  })

  it('draws nothing at all on a mountain taller than the fade line', () => {
    /*
     * The other half, and the one that is a hole rather than a degradation.
     *
     * `terrainOpacity` fades out over one octave above `radius · 2^(4.5−12)`,
     * measured — again — from the datum. On Miranda that cutoff is 2,605 m and
     * the summit the survey found is 4,826 m, so standing on it the streamer
     * requests nothing, draws nothing, and leaves the datum sphere on screen.
     * Two of Miranda's six survey sites are ground that cannot be looked at, at
     * any altitude, including zero.
     *
     * It is a small moon with 10 km of relief on a 236 km radius, which is 4.2%
     * — and that is not an exotic case, it is Verona Rupes. Any body whose
     * relief exceeds `2^(5.5−maxLevel)` of its radius has this hole somewhere.
     */
    const session = live()
    const active = terrainZoo(session.world).find(
      (entry) => entry.archetype === 'icy-active',
    )
    const body = bodyAt(session, active?.address ?? '')
    const drawn = (site: string): number =>
      simulateDescent(body, { site, trackDegrees: 0 }).drawnSteps
    expect(drawn('summit')).toBe(0)
    expect(drawn('rough')).toBe(0)
    // And the same descent into the basin is fine, which is what makes it a
    // property of the elevation rather than of the body.
    expect(drawn('basin')).toBeGreaterThan(80)
  })

  it('coarsens on a level pass, because the level rule reads the datum', () => {
    /*
     * A finding, pinned so it stays a decision rather than a surprise.
     *
     * `terrainLevelFor` takes `distance − radius`, and the distance to a camera
     * standing on the ground is `surfaceRadius + height`. So the altitude it
     * sees is `groundElevation + height` — the elevation of the ground *under*
     * the camera, not the height above it. On Iapetus, whose relief is 10 km
     * against a 735 km radius, flying level from a peak into a basin drops that
     * number by up to 20 km and coarsens the level by a step: the whole window
     * is discarded and re-requested while the camera has not changed height at
     * all.
     *
     * Harmless today, when a window is nine patches. Not harmless in Phase 1,
     * where it is a few hundred — and the fix is already in the plan, because a
     * screen-space error metric measures against the patch rather than against
     * the datum.
     */
    const session = live()
    const icy = terrainZoo(session.world).find(
      (entry) => entry.archetype === 'icy-dead',
    )
    const report = simulateDescent(bodyAt(session, icy?.address ?? ''), {
      trackDegrees: 10,
    })
    const coarsenings = report.levels.filter(
      (level, i) => i > 0 && level < (report.levels[i - 1] ?? 0),
    )
    expect(coarsenings.length).toBeGreaterThan(0)
  })

  it('never asks for more than one window in a single step', () => {
    /*
     * The single-level window's one virtue, stated as a bound so that Phase 1
     * has to move it deliberately. Nine patches is a full window and no step can
     * ask for more, because the streamer asks for exactly what is missing from a
     * window that is nine patches wide however the camera got there.
     *
     * The *total* is a much larger number — the ground track slides the window
     * continuously, so most steps miss on one or two patches even at a stable
     * level. That total is a baseline figure rather than an assertion; what is
     * asserted is that every patch the window wanted is accounted for as either
     * a request or a hit, which is what would break first if the key or the
     * eviction came apart.
     */
    const session = live()
    for (const entry of terrainZoo(session.world)) {
      const report = simulateDescent(bodyAt(session, entry.address), {
        site: 'basin',
      })
      expect(`${entry.name}: ${report.peakBurst}`).toBe(`${entry.name}: 9`)
      const wanted = report.steps
        .filter((step) => step.opacity > 0)
        .reduce((sum, step) => sum + step.wanted, 0)
      expect(report.totalRequests + report.cacheHits).toBe(wanted)
      expect(report.uniqueRegions).toBeLessThanOrEqual(report.totalRequests)
      /*
       * And the cache is beaten by the descent, which is a finding rather than
       * a defect in the cache.
       *
       * A descent touches several hundred distinct regions and the streamer
       * holds 64 heightfields, so the working set is multiples of the cache
       * before eviction policy enters into it — the measured hit rate is under
       * 5%. The assertion is on the *cause*, because that is the sentence that
       * stays true: Phase 1's prefetch and budget have to be sized against the
       * number of regions a descent visits, not against a window's worth.
       */
      expect(report.uniqueRegions).toBeGreaterThan(64 * 3)
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
