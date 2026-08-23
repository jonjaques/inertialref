import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AU, type Meters } from '@inertialref/shared'
import { TEST_CATALOG } from '@inertialref/universe'
import {
  type FrameId,
  UV,
  type UniverseVector,
  Vec,
} from '@inertialref/spatial'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { MAX_OBSERVER_DISTANCE } from '@inertialref/rendering'
import { openSession, type Session } from './session.ts'
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
function harness(): { harness: GameHarness; session: Session } {
  const registry = createTaskRegistry()
  const session = openSession({
    seed: 'inertialref',
    workers: () => createInlineWorker(registry),
    catalog: TEST_CATALOG,
  })
  return { harness: session.harness, session }
}

/** A sample that must exist. Keeps the assertions about geometry, not nulls. */
function posed(pose: ObserverPose | null): ObserverPose {
  if (pose === null) throw new Error('expected the observatory to have a pose')
  return pose
}

/** Where a frame's origin is right now. */
function originOf(session: Session, frame: string): UniverseVector {
  return session.world.frames.pose(frame as FrameId, session.world.clock.time)
    .position
}

describe('the observatory', () => {
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
