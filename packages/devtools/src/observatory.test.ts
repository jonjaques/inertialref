import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AU, type Meters } from '@inertialref/shared'
import {
  bodyFixedFrameId,
  type Body,
  bodyFrameId,
  findBody,
  directionToGeodetic,
  geodeticDirection,
  parseAddress,
  systemFrameId,
  type StarSystem,
  systemId,
  TEST_CATALOG,
} from '@inertialref/universe'
import {
  type FrameId,
  Quaternion as Q,
  UV,
  type UniverseVector,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import {
  type Lens,
  LENS_PRESETS,
  MAX_OBSERVER_DISTANCE,
  MIN_STANCE_HEIGHT,
  verticalFov,
  verticalFovDegrees,
} from '@inertialref/rendering'
import { openSession, type Session } from './session.ts'
import { PICTURES } from './pictures.ts'
import type { GameHarness } from './harness.ts'
import type { ObserverPose } from './observatory.ts'

/*
 * The observatory against a live world.
 *
 * `packages/rendering/src/observer.test.ts` proves the arithmetic; this proves
 * the binding — that an address resolves, that the camera ends up where the
 * body actually is *this tick*, and above all that looking at something is not
 * the same act as going there. The last one is the whole architectural claim
 * the planetarium rests on and it is one line to check.
 */
function harness(): {
  harness: GameHarness
  session: Session
  lens: () => Lens
} {
  const registry = createTaskRegistry()
  /*
   * The session gets a lens the way a browser does, and it has to.
   *
   * With no render side, `renderHost()` answers `framingLens` with
   * `LENS_PRESETS.flight` and `setFlightLens` with a no-op — so every picture
   * composes at 65° whatever it names, and the
   * `fovDeg` a test asserts against is the literal echoed back out of
   * `PICTURES`. `preset`'s central claim, that a `fill` standoff is solved
   * *against* the lens and so the lens is fitted first, was exercised by
   * nothing: swapping the two lines left the suite green while `the-rings`
   * moved from 2.249 radii to 2.735.
   *
   * Two lines of host is the whole fix, and it makes the ordering assertable.
   */
  let held: Lens = LENS_PRESETS.flight
  const session = openSession({
    seed: 'inertialref',
    workers: () => createInlineWorker(registry),
    catalog: TEST_CATALOG,
    render: {
      framingLens: () => held,
      setFlightLens: (next) => {
        held = next
      },
    },
  })
  return { harness: session.harness, session, lens: () => held }
}

/** A sample that must exist. Keeps the assertions about geometry, not nulls. */
function posed(pose: ObserverPose | null): ObserverPose {
  if (pose === null) throw new Error('expected the observatory to have a pose')
  return pose
}

/**
 * Where a frame's origin is at the instant the frame being drawn depicts.
 *
 * `renderTime`, not `clock.time`. This helper used to say the tick, which made
 * every standoff assertion below agree with the camera only because the camera
 * was making the same mistake — the two were wrong together and the suite was
 * green. `renderTime` is what `snapshot` places bodies at, so it is what "where
 * is it, in the picture" means.
 */
function originOf(session: Session, frame: string): UniverseVector {
  return session.world.frames.pose(
    frame as FrameId,
    session.world.clock.renderTime,
  ).position
}

describe('the observatory', () => {
  it('holds an automatic orbit when simulation time is paused and releases it with its target', () => {
    const { harness: ir, session } = harness()
    ir.look('s:SOL/b:2', { ease: false })
    const before = session.world.stateHash()
    ir.observatory.orbitPhase(-112, -1.8, 16)
    const opening = posed(ir.observerSample(0))
    expect(session.world.stateHash()).toBe(before)
    for (let i = 0; i < 60; i += 1) {
      session.world.advance(1 / 60)
      ir.observerSample(1 / 60)
    }
    expect(posed(ir.observerSample(0))).not.toEqual(opening)
    ir.pause()
    // Let the clock publish its held render instant before comparing poses.
    session.world.advance(0)
    const held = posed(ir.observerSample(0))
    for (let i = 0; i < 120; i += 1) {
      session.world.advance(1 / 60)
      expect(posed(ir.observerSample(1 / 60))).toEqual(held)
    }
    ir.resume()
    session.world.advance(1 / 60)
    expect(posed(ir.observerSample(1 / 60))).not.toEqual(held)
    ir.observatory.clear()
    ir.look('s:SOL/b:2', { ease: false })
    const state = ir.observatory.state
    session.world.advance(1 / 60)
    ir.observerSample(1 / 60)
    expect(ir.observatory.state).toEqual(state)
  })

  it('sweeps with the presented frame, not the time warp the session left', () => {
    // The front door is forbidden from changing the warp, and it mutes the
    // keys that would; a sweep on the simulated clock would spin it at warp
    // rate with no way back. Two sessions at the same instant, one at 1000×:
    // never advancing the world holds both bodies fixed, so only warp differs.
    const run = (warp: number) => {
      const { harness: ir } = harness()
      ir.look('s:SOL/b:2', { ease: false })
      ir.timeWarp(warp)
      ir.observatory.orbitPhase(-112, -1.8, 16)
      ir.observerSample(0)
      return posed(ir.observerSample(1 / 60))
    }
    expect(run(1000)).toEqual(run(1))
  })

  it('moves the camera without moving the ship', () => {
    // The claim the whole planetarium rests on: it is a *view* of the same
    // universe, not a mode with its own rules. If this ever fails, a save
    // taken in the planetarium would differ from one taken beside it.
    const { harness: ir } = harness()
    const before = ir.status().world.stateHash
    ir.look('s:SOL/b:5')
    ir.observatory.drag(300, 120)
    ir.observatory.zoomNotches(-8)
    ir.observerSample(1 / 60)
    expect(ir.status().world.stateHash).toBe(before)
  })

  it('frames what it was asked for, at the distance it claims', () => {
    const { harness: ir, session } = harness()
    const status = ir.look('s:SOL/b:2')
    expect(status.target?.name).toBe('Earth')
    expect(status.target?.kind).toBe('planet')

    // The target's own frame, which is the thing the camera orbits.
    const centre = originOf(session, status.target?.frame ?? '')
    const range = UV.distance(posed(ir.observerSample(0)).position, centre)
    expect(range / status.state.distance).toBeCloseTo(1, 6)
  })

  it('holds its standoff every frame, not on average', () => {
    /*
     * The regression that stopped Phobos and Deimos vibrating in the
     * planetarium — at 1x, which is what took so long to believe.
     *
     * `#targetPosition` asked the world where the target was at
     * `clock.time`, while `snapshot` draws every body at `renderTime`. Those
     * differ by up to one tick, and — this is the part a single sample cannot
     * see — the gap *sawtooths*, because alpha sweeps 0→1 between ticks and
     * resets. So the camera was placed against a point the drawn body had
     * already left, by a different amount every frame.
     *
     * The error is the target's velocity times up to 15.6 ms, which is a fixed
     * ~400 m for anything riding Mars around the Sun. What decides whether you
     * see it is that distance in units of the body's own radius, and Phobos and
     * Deimos are 11.3 km and 6.2 km: 3.5% and 6.6%, against 0.01% for Mars.
     * Framed to fill the view they vibrated by 11 and 19 pixels while Mars,
     * Luna and Io held still inside a twentieth of a pixel.
     *
     * Sixty frames at 60 fps against a 64 Hz tick, so alpha wraps four times
     * and every phase of the sawtooth is sampled.
     */
    const { harness: ir, session } = harness()
    for (const address of ['s:SOL/b:3.0', 's:SOL/b:3.1', 's:SOL/b:3']) {
      ir.look(address)
      const frame = ir.observatory.target?.frame ?? ''
      // Let the fly-to arrive: while it is easing the standoff is *meant* to
      // be changing, and this is a claim about a settled camera.
      for (let i = 0; i < 240; i += 1) {
        session.world.advance(1 / 60)
        ir.observerSample(1 / 60)
      }

      const standoff = ir.observatory.state.distance
      let worst = 0
      for (let i = 0; i < 60; i += 1) {
        session.world.advance(1 / 60)
        const eye = posed(ir.observerSample(1 / 60)).position
        // Against the body as *drawn*, which is the whole point.
        const range = UV.distance(eye, originOf(session, frame))
        worst = Math.max(worst, Math.abs(range - standoff))
      }

      /*
       * A millimeter. Not a tolerance chosen to pass: the two positions are
       * built from the same `UniverseVector` at the same instant, so the only
       * thing between them is the frame graph's own arithmetic, and
       * `POSITION_RESOLUTION` is a quarter of a millimeter anywhere in the
       * galaxy. Before the fix this reached 409 m on Phobos — Mars's orbital
       * speed times one tick.
       */
      expect(worst).toBeLessThan(1e-3)
    }
  })

  it('follows a body as it moves, rather than orbiting where it was', () => {
    /*
     * The one behavior that separates this from the cutscene director. A
     * script resolves its stage once and is pure afterwards; the observatory
     * must re-ask, or a minute of time warp leaves the camera orbiting empty
     * space where Jupiter used to be.
     */
    const { harness: ir, session } = harness()
    ir.look('s:SOL/b:5')
    const first = posed(ir.observerSample(0))
    const bodyFrame = ir.observatory.target?.frame ?? ''
    const startCentre = originOf(session, bodyFrame)

    // An hour of simulated time. A minute moves Jupiter about 800 km, which
    // is under the tolerance this test wants to be able to assert.
    ir.step(64 * 3600)
    const later = posed(ir.observerSample(0))
    const laterCentre = originOf(session, bodyFrame)

    const bodyMoved = UV.distance(startCentre, laterCentre)
    // The body genuinely went somewhere, or the test proves nothing.
    expect(bodyMoved).toBeGreaterThan(1e6)
    const cameraMoved = UV.distance(first.position, later.position)
    // The camera went with it: it moved by about as much as the body did.
    expect(Math.abs(cameraMoved / bodyMoved - 1)).toBeLessThan(0.5)
    // ...and it is still exactly its orbit radius from the new center.
    const range = UV.distance(later.position, laterCentre)
    expect(range / ir.observatory.state.distance).toBeCloseTo(1, 6)
  })

  it('eases a fly-to instead of cutting', () => {
    const { harness: ir } = harness()
    ir.look('s:SOL/b:2')
    ir.look('s:SOL/b:5')
    // The desired distance jumped; the actual one has not arrived yet.
    expect(ir.observerStatus()?.travelling).toBe(true)
    const status = ir.observerStatus()
    expect(status?.state.distance).toBeLessThan(status?.desired.distance ?? 0)
    // Earth's framing is *inside* Jupiter, so the ease does not start there —
    // see `focus`. It starts at the nearest distance Jupiter's own band allows.
    expect(status?.state.distance).toBe(ir.observatory.bounds().min)
    // Fifteen seconds. `TRAVEL_TAU` is 0.55 s and the gap here is Earth's
    // framing to Jupiter's — about four e-folds of distance — so the ease is
    // still visibly running at four seconds. That is the intended feel; the
    // test just has to outlast it.
    for (let i = 0; i < 900; i += 1) ir.observerSample(1 / 60)
    expect(ir.observerStatus()?.travelling).toBe(false)
  })

  it('stops reporting a move once it has stopped moving, however far round', () => {
    /*
     * `#arrived` compared raw azimuths while `approachState` converges via
     * `shortestAngle`. Azimuth accumulates as you drag, so after a couple of
     * turns the ease settles at a *difference* of 2π — the same heading, a
     * whole turn apart numerically — which never falls below
     * `ARRIVED_LOG_EPSILON`. `travelling` then stayed true for the rest of the
     * session, which is the exact failure that constant's docstring says it
     * exists to prevent: a panel flickering "moving" at a camera that is
     * perfectly still.
     */
    const { harness: ir } = harness()
    ir.look('s:SOL/b:2', { ease: false })
    // Three turns of the hand, which is a normal amount of looking around.
    for (let i = 0; i < 60; i += 1) ir.observatory.drag(200, 0)
    expect(Math.abs(ir.observatory.state.azimuth)).toBeGreaterThan(4 * Math.PI)

    // A preset, whose azimuth comes back in (−π, π] however far the drag went.
    ir.observatory.setPhase(150, 10)
    for (let i = 0; i < 900; i += 1) ir.observerSample(1 / 60)
    expect(ir.observerStatus()?.travelling).toBe(false)
  })

  it('never passes through the target on the way to it', () => {
    /*
     * The property, and the bug it was written for: `focus` carried the old
     * target's distance across unchanged and `approachState` clamps only
     * elevation, so a fly-to from a small body to a large one spent the whole
     * transition *inside* the thing it was flying to. Luna to the Sun put the
     * eye 695,700 km under the photosphere for a second, and `status()` said
     * `altitude: 0` throughout because it is `Math.max(0, distance - radius)`.
     *
     * Every intermediate state, for every ordered pair of targets — not the
     * endpoints, which were always legal. The bodies differ by four orders of
     * radius in both directions, which is what makes the pair ordering matter.
     */
    const targets = ['s:SOL', 's:SOL/b:2', 's:SOL/b:2.0', 's:SOL/b:5']
    fc.assert(
      fc.property(
        fc.constantFrom(...targets),
        fc.constantFrom(...targets),
        // Any starting distance the band permits, including a hand-dragged one
        // that never came from `framingDistance`.
        fc.double({ min: 1e3, max: 1e12, noNaN: true }),
        (from, to, distance) => {
          const { harness: ir } = harness()
          ir.look(from, { ease: false })
          ir.observatory.setDistance(distance as Meters, false)
          ir.look(to)
          for (let i = 0; i < 300; i += 1) {
            ir.observerSample(1 / 60)
            const { min, max } = ir.observatory.bounds()
            expect(ir.observatory.state.distance).toBeGreaterThanOrEqual(min)
            expect(ir.observatory.state.distance).toBeLessThanOrEqual(max)
          }
        },
      ),
      // One session per case and a live world behind it; the interesting axis
      // is the pair of targets, and there are sixteen of those.
      { numRuns: 40 },
    )
  })

  it('accepts everything the console accepts, and refuses what it should', () => {
    // One resolver with `goTo`, so a search box and a console cannot disagree
    // about what `SOL` means.
    const { harness: ir } = harness()
    expect(ir.look('SOL').target?.kind).toBe('star')
    expect(ir.look('s:SOL/b:2').target?.name).toBe('Earth')
    // Relative to the system the *player* is in, which is how a listing's row
    // reads when it is clicked.
    expect(ir.look('b:2').target?.name).toBe('Earth')
    // A path that names no body. The refusal comes out of `parseAddress` or
    // out of the system walk depending on how malformed it is, and either is
    // the right answer — what matters is that it is not silently ignored.
    expect(() => ir.look('s:SOL/b:9999')).toThrow()
  })

  it('clamps the camera out of the ground and short of the galaxy', () => {
    const { harness: ir } = harness()
    ir.look('s:SOL/b:2')
    ir.observatory.zoomNotches(-500)
    // Inside the datum sphere the body is drawn inside-out; there is nothing
    // to look at and the framing math has no answer.
    expect(ir.observatory.state.distance).toBeGreaterThan(
      (ir.observatory.target?.radius ?? 0) * 1.0,
    )
    ir.observatory.zoomNotches(500)
    expect(ir.observatory.state.distance).toBeLessThanOrEqual(
      MAX_OBSERVER_DISTANCE,
    )
  })

  it('solves a phase angle against where the star actually is', () => {
    const { harness: ir, session } = harness()
    ir.look('s:SOL/b:2', { ease: false })
    ir.observatory.setPhase(150, 0)
    // `setPhase` eases like everything else; settle it before measuring.
    for (let i = 0; i < 900; i += 1) ir.observerSample(1 / 60)
    const pose = posed(ir.observerSample(0))
    const centre = originOf(session, ir.observatory.target?.frame ?? '')
    // The system frame's origin is the star.
    const star = originOf(session, 's:SOL')
    const toCamera = Vec.normalize(UV.difference(pose.position, centre))
    const toStar = Vec.normalize(UV.difference(star, centre))
    const phase = (Math.acos(Vec.dot(toCamera, toStar)) * 180) / Math.PI
    // A crescent: the camera is nearly opposite the sun from the body.
    expect(phase).toBeGreaterThan(145)
    expect(phase).toBeLessThan(155)
  })

  it('survives a target whose system has gone', () => {
    // A save loaded from the console replaces the world under a running
    // planetarium. Losing a frame's pose is not worth throwing out of a render
    // loop over — the panel says "no target" and the next click fixes it.
    const { harness: ir } = harness()
    ir.look('s:SOL/b:2')
    const other = harness().harness
    expect(() => other.observerSample(1 / 60)).not.toThrow()
    expect(other.observerStatus()).toBeNull()
  })

  it('centers the catalog on the eye, not on the ship', () => {
    /*
     * A regression test for a listing that described somewhere the reader was
     * not.
     *
     * `travelTargets` took the *player's* position, which is the same thing as
     * the camera in a flight mode and is not remotely the same thing here —
     * `look` is the planetarium's whole verb, and it moves a camera four light
     * years without moving the hull. Centered on the ship, opening the
     * catalog at Alpha Centauri listed Sol's moons first and reported the
     * star filling the frame as 4.4 ly away, twenty rows down.
     *
     * The survey radius is centered on the same point, so what is offered is the
     * eye's neighbors rather than the hull's.
     */
    const { harness: ir } = harness()
    const nearest = (origin?: 'player' | 'observer') =>
      ir
        .targets({ lightYears: 6, ...(origin === undefined ? {} : { origin }) })
        .filter((row) => row.kind === 'system')
        .map((row) => row.name)[0]

    // The ship starts in Sol, so both agree before the camera goes anywhere.
    ir.look('s:SOL/b:2')
    expect(nearest('observer')).toBe('Sol')

    ir.look('HIP71683')
    // The hull has not moved — that is the guarantee the mode is built on —
    // so the player-centered listing still leads with Sol.
    expect(nearest('player')).toBe('Sol')
    expect(nearest()).toBe('Sol')
    // The eye has, and the listing follows it.
    expect(nearest('observer')).toBe('Alpha Centauri')

    // With nothing held, the observer origin falls back to the player rather
    // than to an empty listing: the panel polls before the mode's first focus
    // lands, and an empty state flashing on every entry is worse than a stale
    // center for two frames.
    ir.observatory.clear()
    expect(nearest('observer')).toBe('Sol')
  })

  it('reports how much of the frame the target fills', () => {
    const { harness: ir } = harness()
    const status = ir.look('s:SOL/b:2', { fill: 0.5, ease: false })
    // The default framing is a disk with sky around it, and the readout is
    // what a "frame it" button in a panel is checked against.
    expect(status.fill).toBeCloseTo(0.5, 2)
    expect(status.altitude).toBeGreaterThan(0)
    expect(status.altitudeText).toMatch(/\d/)
    expect(status.state.distance).toBeLessThan(AU)
  })
})

describe('the compositions, through the camera rather than the hull', () => {
  it('lands the low ones on the surface arm and the rest in orbit', () => {
    /*
     * The claim that removes the second list. `glint`, `sunset` and `oblique`
     * were ship-only bookmarks, not because a hull is needed to take them but
     * because they aim somewhere other than the body's center and the orbit
     * arm's pose is `lookAlong(−offset, up)`, always. With the aim solved as an
     * offset the observatory can take all sixteen — and the two that stand off
     * below 1.5 radii land on the arm that goes there.
     */
    const { harness: ir, session } = harness()
    ir.look('s:SOL/b:2')

    const orbiting = ir.compose('glint')
    expect(orbiting.surface).toBeNull()
    // An aimed composition is the one that has a look offset at all; the nine
    // drawn framings are centre-aimed and must be bit-identical to their old
    // poses, which `packages/rendering` states as a property.
    expect(orbiting.aimed).toBe(true)

    const standing = ir.compose('sunset')
    expect(standing.surface).not.toBeNull()
    // 1.04 radii is four hundredths of a radius up — 255 km over Earth.
    expect(standing.surface?.stance.height).toBeGreaterThan(0)
    expect(standing.surface?.stance.height).toBeLessThan(0.05 * 6.371e6)

    expect(ir.compose('portrait').aimed).toBe(false)
    session.dispose()
  })

  it('aims a surface composition at the sun, on a body whose axis is tilted', () => {
    /*
     * The frame conversion, stated where it is visible.
     *
     * `placeComposition` solves the aim in the axes the sun line is given in —
     * universe — and a stance is held in the body's own, which the spin pose
     * tilts by `axialTilt`. A heading is measured against a triad built on the
     * pole of *whichever* axes it was solved in, so carrying the angle across
     * instead of the direction rotates the camera about the local vertical by
     * that tilt: 5.31° off the sunward limb on Earth, 14.36° for `oblique`,
     * and zero only on a body with no tilt at all.
     *
     * Measured as a horizontal bearing rather than as a heading, because the
     * bearing is the composition's own claim — `sunset` looks along the ground
     * toward the star — and it is the one quantity the mistake moves.
     */
    const { harness: ir, session } = harness()
    ir.look('s:SOL/b:2', { ease: false })
    for (const id of ['sunset', 'oblique']) {
      ir.compose(id)
      const pose = posed(ir.observerSample(0))
      const centre = originOf(session, ir.observatory.target?.frame ?? '')
      const star = originOf(session, 's:SOL')
      const up = Vec.normalize(UV.difference(pose.position, centre))
      const flat = (v: Vec3): Vec3 =>
        Vec.normalize(Vec.sub(v, Vec.scale(up, Vec.dot(v, up))))
      const forward = flat(Q.rotate(pose.orientation, vec3(0, 0, -1)))
      const toStar = flat(Vec.normalize(UV.difference(star, pose.position)))
      const bearing =
        (Math.acos(Math.max(-1, Math.min(1, Vec.dot(forward, toStar)))) * 180) /
        Math.PI
      expect(bearing, id).toBeLessThan(1)
    }
    session.dispose()
  })

  it('re-solves against the star, so a composition means one picture', () => {
    // The bug `placeShot` documents, met on this arm: a phase solved once
    // against a stale sun line is right in one season and wrong in the other
    // three. Both calls go through `#starDirection` at `renderTime`.
    const { harness: ir, session } = harness()
    ir.look('s:SOL/b:2')
    const first = ir.compose('half')
    const second = ir.compose('half')
    expect(second.state.azimuth).toBeCloseTo(first.state.azimuth, 12)
    session.dispose()
  })
})

describe('a rise', () => {
  it('stands on the moon and looks at the planet', () => {
    /*
     * Earthrise, end to end. The verb refuses on a body with nothing going
     * round it, stands on the moon rather than on the subject, and hands back
     * the field of view it solved — which the observatory deliberately does not
     * apply, because it has no lens of its own.
     */
    const { harness: ir, session } = harness()
    ir.look('s:SOL/b:2.0')
    const { status, fovDeg } = ir.rise()
    expect(status.surface).not.toBeNull()
    // The eye is a fraction of Luna's own radius up — 110 km, which is where
    // the photograph was taken from.
    expect(status.surface?.stance.height).toBeGreaterThan(50_000)
    expect(status.surface?.stance.height).toBeLessThan(200_000)
    // Earth is 1.9° across from here, so the solve wants 11.4° and gets the
    // 20° floor. Stated as the floor rather than as a range, because the clamp
    // is the interesting fact: a lens below 20° is its own phase.
    expect(fovDeg).toBe(20)
    session.dispose()
  })

  it('refuses a body with nothing to see rise', () => {
    const { harness: ir, session } = harness()
    ir.look('s:SOL/b:0')
    // Mercury has no moons, so there is no second body for the picture to be
    // about. A card that silently did nothing would be worse than the refusal.
    expect(() => ir.rise()).toThrow(/rise/i)
    session.dispose()
  })
})

describe('the pictures', () => {
  it('the fixture catalog’s pictures resolve and take the frame they name', () => {
    /*
     * The half of `presets:check` that needs a world. The script's job is the
     * plate on disk and the composition id; this is the claim neither a
     * filesystem nor a type can make — that the address still names a body in
     * the catalog this build ships, and that the framing it asks for is one the
     * observatory can actually take.
     *
     * The failure it guards is specific and quiet: a preset is a button, and a
     * button whose address stopped resolving throws out of an onClick. The
     * phase these exist for is a review, so a picture that has gone missing has
     * to be a red test rather than a discovery on review day.
     */
    const { harness: ir, session } = harness()
    for (const { id, address } of PICTURES) {
      // The complete shipped catalog is exercised by the headless host.
      if (!address.startsWith('s:SOL/')) continue
      const { status, fovDeg, picture } = ir.preset(id)
      expect(status.target, id).not.toBeNull()
      expect(status.target?.address, id).toContain(
        picture.address.replace('s:', ''),
      )
      // A lens the slider can actually be set to. A picture composed at an
      // angle the control cannot reach is a frame nobody can reproduce by hand.
      expect(fovDeg, id).toBeGreaterThanOrEqual(20)
      expect(fovDeg, id).toBeLessThanOrEqual(110)
    }
    session.dispose()
  })

  it('puts Earthrise on Luna and everything else on its subject', () => {
    // The one that is about two bodies, checked against the one thing that
    // distinguishes it: the camera ends up standing, on the moon, not framing
    // the planet the picture is of.
    const { harness: ir, session } = harness()
    const earthrise = ir.preset('earthrise')
    expect(earthrise.status.surface).not.toBeNull()
    expect(earthrise.status.target?.name).toBe('Luna')

    const marble = ir.preset('blue-marble')
    expect(marble.status.surface).toBeNull()
    expect(marble.status.target?.name).toBe('Earth')
    session.dispose()
  })
})

describe('a picture fits the lens it names', () => {
  it('leaves the lens where a rise solved it', () => {
    // A rise solves its own field from the parent's angular size, so the fit
    // has to happen *after* the stance rather than before it.
    const { harness: ir, session, lens } = harness()
    const taken = ir.preset('earthrise')
    expect(verticalFovDegrees(lens())).toBeCloseTo(taken.fovDeg, 6)
    expect(taken.fovDeg).toBe(20)
    session.dispose()
  })

  it('composes at the fitted lens, not at the one before it', () => {
    /*
     * The claim stated without reaching into private state: take a picture at
     * 80°, then take one at 65°, and the standoff for the *same* fill has to
     * differ — a wider field frames the same fraction from nearer.
     */
    const { harness: ir, session } = harness()
    const wide = ir.preset('the-rings')
    // `desired`, not `state`: the orbit arm eases, and the ease only runs
    // inside `sample()`, which is the render loop's to call. Headlessly nothing
    // draws, so `state` is wherever the camera was when the verb was issued —
    // reading it here compared two focus distances and passed for the wrong
    // reason on the first run.
    const wideDistance = wide.status.desired.distance

    ir.preset('blue-marble')
    ir.look('s:SOL/b:5')
    const narrow = ir.compose('high-angle')

    expect(narrow.desired.distance).toBeGreaterThan(wideDistance)
    // 65° against 80° on one fill: the standoff is `r / sin(fill · fov/2)`, so
    // 2.734 radii against 2.249 — 22%, not a rounding difference.
    expect(narrow.desired.distance / wideDistance).toBeCloseTo(1.216, 2)
    session.dispose()
  })
})

describe('the drag sensitivity', () => {
  it('is per CSS pixel, not per display pixel', () => {
    /*
     * The claim is "the ground under the pointer follows the pointer", and a
     * pointer delta arrives in CSS pixels. `pixelAngle` answers in *display*
     * pixels — the viewport keeps the device ratio deliberately, because the
     * terrain predicate and the circle of confusion are claims about physical
     * pixels — so the two have to be reconciled somewhere.
     *
     * The check that catches the conflation: the same window at 1× and at 2×
     * must drag at the same rate. Without the ratio the 2× answer is half, so
     * the picture moves at half the speed of the hand on every Retina display
     * and at two thirds on a phone, which is the case free look exists for.
     */
    const rate = (ratio: number): number => {
      const registry = createTaskRegistry()
      const session = openSession({
        seed: 'inertialref',
        workers: () => createInlineWorker(registry),
        catalog: TEST_CATALOG,
        render: {
          lensView: () => ({
            lens: LENS_PRESETS.flight,
            // A 1000×750 CSS window, at whatever ratio the display has.
            viewport: { width: 1000 * ratio, height: 750 * ratio },
          }),
          pixelRatio: () => ratio,
        },
      })
      const sensitivity = session.harness.observatory.dragSensitivity()
      session.dispose()
      return sensitivity
    }
    expect(rate(2)).toBeCloseTo(rate(1), 12)
    expect(rate(1.5)).toBeCloseTo(rate(1), 12)

    /*
     * And the absolute value is the lens's own, through `pixelAngle` — which is
     * the *tangent* form, `2·tan(fov/2)/height`, rather than `fov/height`.
     * That is the angle a pixel actually subtends at the center of a
     * projection, and it is the identity the terrain predicate and the LOD
     * thresholds already stand on: at 65° over 750 pixels it is 1.699 mrad
     * against the naive 1.513, an 11% difference that would put this arm and
     * the refinement predicate on two different ideas of a pixel.
     */
    const tangent = (2 * Math.tan(verticalFov(LENS_PRESETS.flight) / 2)) / 750
    expect(rate(1) * 0.005).toBeCloseTo(tangent, 9)
    expect(tangent * 1000).toBeCloseTo(1.699, 3)
  })

  it('falls back to the reference rate with no display', () => {
    // Headlessly the gesture is a number in a script rather than a hand on a
    // surface, and there is no viewport for an angle to be measured over.
    const { harness: ir, session } = harness()
    expect(ir.observatory.dragSensitivity()).toBe(1)
    session.dispose()
  })
})

describe('a drop', () => {
  /** Where a body's rotating frame is at the instant the picture depicts. */
  const spinOf = (session: Session, address: string) =>
    session.world.frames.pose(
      bodyFixedFrameId(parseAddress(address)),
      session.world.clock.renderTime,
    )

  /** Which way the camera is looking. `lookAlong` maps −Z to forward. */
  const forwardOf = (pose: ObserverPose) =>
    Q.rotate(pose.orientation, vec3(0, 0, -1))

  /** A direction with the radial part removed — a bearing, as a vector. */
  const horizontal = (direction: Vec3, up: Vec3): Vec3 =>
    Vec.normalize(Vec.sub(direction, Vec.scale(up, Vec.dot(direction, up))))

  it('leaves from exactly the camera it was released from', () => {
    /*
     * The frame the figure is let go is the frame before it. A drop that cut
     * to the top of its own arc would be the interface taking the camera away
     * and handing back a different one, which is the thing the ease exists to
     * avoid — and it is invisible in a still, because the still after the cut
     * is a perfectly good picture of somewhere else.
     */
    const { harness: ir } = harness()
    ir.look('s:SOL/b:2')
    ir.observatory.drag(200, 80)
    const before = posed(ir.observerSample(0))
    ir.drop(12, 34)
    const first = posed(ir.observerSample(0))
    expect(UV.distance(first.position, before.position)).toBeLessThan(1)
    expect(Q.approxEquals(first.orientation, before.orientation, 1e-9)).toBe(
      true,
    )
  })

  it('lands on the coordinates it was given, at eye height', () => {
    const { harness: ir } = harness()
    ir.look('s:SOL/b:2')
    ir.drop(12, 34, { seconds: 4 })
    for (let i = 0; i < 300; i += 1) ir.observerSample(1 / 60)
    const status = ir.observerStatus()
    const stance = status?.surface?.stance
    expect(status?.descent).toBeNull()
    expect(status?.travelling).toBe(false)
    // Degrees at the harness boundary, radians under it.
    expect(((stance?.latitude ?? 0) * 180) / Math.PI).toBeCloseTo(12, 9)
    expect(((stance?.longitude ?? 0) * 180) / Math.PI).toBeCloseTo(34, 9)
    expect(stance?.height).toBe(MIN_STANCE_HEIGHT)
  })

  it('faces the star it landed under', () => {
    /*
     * The whole point of the gesture: you arrive looking at the lit half of
     * the world you just dropped onto. Measured as a bearing rather than as a
     * heading in radians, because a heading is a number in the body's rotating
     * axes and the claim is about where the light is.
     */
    const { harness: ir, session } = harness()
    ir.look('s:SOL/b:2')
    ir.drop(12, 34, { seconds: 4 })
    for (let i = 0; i < 300; i += 1) ir.observerSample(1 / 60)
    const pose = posed(ir.observerSample(0))
    const star = originOf(session, systemFrameId(systemId('SOL')))
    const spin = spinOf(session, 'g:milky-way/s:SOL/b:2')
    const up = Q.rotate(
      spin.orientation,
      geodeticDirection((12 * Math.PI) / 180, (34 * Math.PI) / 180),
    )
    const toStar = Vec.normalize(UV.difference(star, pose.position))
    const bearing = Vec.dot(
      horizontal(forwardOf(pose), up),
      horizontal(toStar, up),
    )
    // Within a degree of the star's own bearing along the ground.
    expect(bearing).toBeGreaterThan(Math.cos((1 * Math.PI) / 180))
    // And level with the horizon rather than at the sky or at its feet.
    expect(Math.abs(Vec.dot(forwardOf(pose), up))).toBeLessThan(0.02)
  })

  it('comes down except where the ground rises, and never through it', () => {
    /*
     * Two claims, and the second is why the first is not "monotonic".
     *
     * `standing` from frame one is what refuses the orbit writers for the
     * whole descent: a wheel notch mid-drop would otherwise rewrite the state
     * `ascend` returns to, which is the failure the surface arm's refusal
     * exists to prevent.
     *
     * The camera's *radius* is not monotonic and must not be. The conic is
     * solved against the ground under the touchdown point, and the track
     * crosses ground that is higher — so the stance's height clamp lifts the
     * eye over a ridge rather than flying it through one, and the radius
     * climbs while it does. The bound is the body's own relief, which is the
     * most the ground can rise anywhere: 9.9 km on Earth against the 12 m this
     * track actually meets. A schedule that ran away upward would break it;
     * a mountain cannot.
     */
    const { harness: ir, session } = harness()
    ir.look('s:SOL/b:2')
    ir.drop(-30, 100, { seconds: 3 })
    expect(ir.observatory.standing).toBe(true)
    const system = session.world.system(systemId('SOL'))
    const earth = findBody(system as StarSystem, [2]) as Body
    const relief = earth.surface.maxElevation
    const centre = originOf(
      session,
      bodyFrameId(parseAddress('g:milky-way/s:SOL/b:2')),
    )
    let previous = Number.POSITIVE_INFINITY
    let climbed = 0
    for (let i = 0; i < 200; i += 1) {
      const pose = posed(ir.observerSample(1 / 60))
      const radius = UV.distance(pose.position, centre)
      if (radius > previous) climbed = Math.max(climbed, radius - previous)
      // Never inside the world it is landing on.
      expect(radius).toBeGreaterThan(earth.radius - relief)
      previous = radius
    }
    expect(climbed).toBeLessThan(relief)
    expect(previous).toBeLessThan(earth.radius + relief)
    expect(ir.observerStatus()?.descent).toBeNull()
  })

  it('reports how far down it is while it is going', () => {
    const { harness: ir } = harness()
    ir.look('s:SOL/b:2')
    ir.drop(0, 0, { seconds: 4 })
    expect(ir.observerStatus()?.descent?.progress).toBe(0)
    expect(ir.observerStatus()?.descent?.remainingSeconds).toBe(4)
    for (let i = 0; i < 120; i += 1) ir.observerSample(1 / 60)
    const half = ir.observerStatus()?.descent
    expect(half?.progress).toBeCloseTo(0.5, 2)
    expect(half?.remainingSeconds).toBeCloseTo(2, 2)
    expect(ir.observerStatus()?.travelling).toBe(true)
  })

  it('moves the camera without moving the ship', () => {
    // The planetarium's one rule, over the mode's one animated descent.
    const { harness: ir } = harness()
    const before = ir.status().world.stateHash
    ir.look('s:SOL/b:2')
    ir.drop(45, -120, { seconds: 2 })
    for (let i = 0; i < 200; i += 1) ir.observerSample(1 / 60)
    expect(ir.status().world.stateHash).toBe(before)
  })

  it('is abandoned by ascending, at the framing it left', () => {
    const { harness: ir } = harness()
    ir.look('s:SOL/b:2')
    const orbit = ir.observerStatus()?.state.distance
    ir.drop(12, 34)
    for (let i = 0; i < 60; i += 1) ir.observerSample(1 / 60)
    ir.ascend()
    const status = ir.observerStatus()
    expect(status?.descent).toBeNull()
    expect(status?.surface).toBeNull()
    // The orbit state was never touched, so there is nothing to restore.
    expect(status?.state.distance).toBe(orbit)
  })

  it('refuses what it cannot land on, before it retargets anything', () => {
    const { harness: ir } = harness()
    ir.look('s:SOL/b:2')
    // A star has no ground; the refusal must not leave the camera on it.
    expect(() => ir.drop(0, 0, { address: 's:SOL' })).toThrow(/not a body/)
    expect(ir.observatory.target?.address).toBe('g:milky-way/s:SOL/b:2')
    expect(() => ir.drop(Number.NaN, 0)).toThrow(/finite/)
    // And a second drop from the ground is a refusal rather than a new arc
    // from an eye that is already standing on the answer.
    ir.drop(12, 34, { seconds: 1 })
    expect(() => ir.drop(20, 40)).toThrow(/leave the surface/)
  })

  it('finds the ground under a ray, and misses cleanly', () => {
    /*
     * The hit test the gesture is aimed with. Straight down from the camera is
     * the sub-camera point, whatever the camera's angles are; a ray at right
     * angles to that direction leaves the body entirely and must answer with
     * nothing rather than with a plausible coordinate.
     */
    const { harness: ir, session } = harness()
    ir.look('s:SOL/b:2')
    const eye = ir.observatory.eye
    const centre = originOf(
      session,
      bodyFrameId(parseAddress('g:milky-way/s:SOL/b:2')),
    )
    const down = Vec.normalize(UV.difference(centre, eye ?? centre))
    const hit = ir.observatory.groundUnderRay(undefined, down)
    expect(hit?.address).toBe('g:milky-way/s:SOL/b:2')
    const spin = spinOf(session, 'g:milky-way/s:SOL/b:2')
    const under = Q.rotateInverse(
      spin.orientation,
      UV.difference(eye ?? centre, spin.position),
    )
    const expected = directionToGeodetic(under)
    expect(hit?.latitude).toBeCloseTo(expected.latitude, 6)
    expect(hit?.longitude).toBeCloseTo(expected.longitude, 6)
    /*
     * A ray that misses answers with the limb rather than with nothing, and
     * that is the deliberate half: the near limb is the one part of a sphere a
     * pointer cannot land on from outside, because the ray grazes it at a
     * tangent. So a ray at right angles to the body still names a point, and
     * that point is on the surface.
     */
    const across = Vec.normalize(
      Vec.cross(down, Math.abs(down.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)),
    )
    const grazed = ir.observatory.groundUnderRay(undefined, across)
    expect(grazed).not.toBeNull()
    expect(Math.abs(grazed?.latitude ?? 9)).toBeLessThanOrEqual(Math.PI / 2)
    // What still answers with nothing is a ray pointing away from the body:
    // there is no surface behind the viewer to land on.
    expect(
      ir.observatory.groundUnderRay(undefined, Vec.negate(down)),
    ).toBeNull()
  })

  it('previews a fall from over the aim down to the ground under it', () => {
    /*
     * In body radii, in the body's own axes — the frame the drawer needs, and
     * a frame the assertions can be written in without a world: one unit is
     * the drawn surface, so "lands on the ground" is a number near 1 rather
     * than a distance that has to be compared against a radius fetched from
     * somewhere else.
     */
    const { harness: ir } = harness()
    ir.look('s:SOL/b:2')
    const aim = {
      latitude: (40 * Math.PI) / 180,
      longitude: (-70 * Math.PI) / 180,
    }
    const preview = ir.observatory.entryArcPreview(undefined, aim)
    const radii = (point: Vec3): number => Vec.length(point)
    const arc = preview?.arc ?? []
    const first = arc[0] as Vec3
    const last = arc[arc.length - 1] as Vec3

    // It starts above the ground and ends on it. Earth's relief is 9.9 km on
    // 6,378, so the surface is within a part in 500 of one radius.
    expect(radii(first)).toBeGreaterThan(1.05)
    expect(radii(last)).toBeCloseTo(1, 2)
    // Straight down: the fall is a drop from rest, so every sample of it lies
    // along the one direction the aim names.
    const down = Vec.normalize(first)
    for (const point of arc)
      expect(Vec.dot(Vec.normalize(point), down)).toBeCloseTo(1, 6)
    // And the aim is where it lands, not merely near it.
    const { latitude, longitude } = directionToGeodetic(last)
    expect(latitude).toBeCloseTo(aim.latitude, 9)
    expect(longitude).toBeCloseTo(aim.longitude, 9)

    // The continuation passes under the ground and out the far side, which is
    // what makes the trajectory an entry rather than a capture.
    const through = preview?.through ?? []
    // Near the centre rather than at it: the continuation is sampled evenly in
    // angle over 48 points, and none of them lands exactly on the midpoint —
    // the nearest is 1/47 of the sweep away, which is 2.1% of a radius.
    expect(Math.min(...through.map(radii))).toBeLessThan(0.05)
    expect(
      Vec.dot(Vec.normalize(through[through.length - 1] as Vec3), down),
    ).toBeCloseTo(-1, 6)

    // Both rings close, and the ground one lies on the ground it follows.
    const ring = preview?.ring ?? []
    expect(
      Vec.distance(ring[0] as Vec3, ring[ring.length - 1] as Vec3),
    ).toBeLessThan(1e-9)
    for (const point of ring) expect(radii(point)).toBeCloseTo(1, 1)
    const hold = preview?.hold ?? []
    expect(
      Vec.distance(hold[0] as Vec3, hold[hold.length - 1] as Vec3),
    ).toBeLessThan(1e-9)
  })

  it('puts the actual camera at the preview touchdown on round and irregular bodies', () => {
    const { harness: ir, session } = harness()
    try {
      fc.assert(
        fc.property(
          fc.constantFrom('s:SOL/b:2', 's:SOL/b:2.0', 's:SOL/b:3.0'),
          fc.double({ min: -Math.PI / 2, max: Math.PI / 2, noNaN: true }),
          fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
          (address, latitude, longitude) => {
            ir.ascend()
            ir.look(address)
            const point = { latitude, longitude }
            const preview = ir.observatory.entryArcPreview(undefined, point)
            expect(preview).not.toBeNull()
            const radius = ir.observatory.target!.radius
            ir.observatory.drop(undefined, point, { seconds: 0.1 })
            const pose = posed(ir.observerSample(1))
            const spin = spinOf(session, ir.observatory.target!.address)
            const expected = UV.translate(
              spin.position,
              Q.rotate(spin.orientation, Vec.scale(preview!.touchdown, radius)),
            )
            expect(UV.distance(pose.position, expected)).toBeLessThan(
              UV.POSITION_RESOLUTION * 4,
            )
          },
        ),
        { numRuns: 24 },
      )
    } finally {
      session.dispose()
    }
  })

  it('lands at the gravity-selected rope endpoint, including on an irregular body', () => {
    const { harness: ir, session } = harness()
    const before = session.world.stateHash()
    try {
      for (const address of ['s:SOL/b:2', 's:SOL/b:3.0']) {
        ir.ascend()
        ir.look(address)
        ir.observatory.previewLaunch(vec3(-2, -0.5, 1.2), vec3(0, 1, 0))
        const aim = ir.observatory.aim!
        const preview = ir.observatory.entryArcPreview(undefined, aim)!
        expect(preview.from).toEqual(vec3(-2, -0.5, 1.2))
        const radius = ir.observatory.target!.radius
        ir.observatory.drop(undefined, aim, { seconds: 0.1 })
        const pose = posed(ir.observerSample(1))
        const spin = spinOf(session, ir.observatory.target!.address)
        const expected = UV.translate(
          spin.position,
          Q.rotate(spin.orientation, Vec.scale(preview.touchdown, radius)),
        )
        expect(UV.distance(pose.position, expected)).toBeLessThan(
          UV.POSITION_RESOLUTION * 4,
        )
      }
      expect(session.world.stateHash()).toBe(before)
    } finally {
      session.dispose()
    }
  })

  it('has no preview to draw once there is no aim', () => {
    const { harness: ir } = harness()
    ir.look('s:SOL/b:2')
    expect(ir.observatory.aim).toBeNull()
    ir.observatory.previewDrop({ latitude: 0.2, longitude: 0.3 })
    expect(ir.observatory.aim?.latitude).toBeCloseTo(0.2, 9)
    // Anything that replaces the pose takes the aim with it: an arc left over
    // a body the camera is no longer at is a curve pointing at nothing.
    ir.look('s:SOL/b:5')
    expect(ir.observatory.aim).toBeNull()
  })
})
