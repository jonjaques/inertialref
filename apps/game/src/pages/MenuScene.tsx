import { useEffect } from 'react'
import { Outlet } from 'react-router'
import type { GameEngine } from '../engine/GameEngine.ts'

/*
 * The menu's scene: Earth, framed by the observatory, with the sun carried
 * across it — behind every page of the menu, the front door and the account
 * pages alike.
 *
 * A layout route rather than an effect in each page, because the orbit is a
 * ramp that starts at `PHASE_OPEN` when the stance is pushed. Pushed by each
 * page, going from the front door to `/sign-in` would release the stance and
 * push it again, and the camera would jump back to the opening phase at the
 * moment somebody clicked a link. Held here, the pages change over a scene
 * that keeps turning.
 */

/*
 * The orbit, in phase rather than in azimuth — which is the whole reason the
 * sun crosses the frame at all.
 *
 * `anglesForPhase` solves the camera against the *sun line*: phase 0 is the
 * fully lit face with the star behind the lens, 180 is dead anti-sun, and it is
 * continuous through 360, so ramping it is a real orbit and not a preset being
 * re-applied. Dragging the azimuth — which is what this used to do — orbits
 * around the world's pole instead, and where the star ends up in that circle
 * depends on which way Sol's ecliptic happens to lie against the galactic
 * plane. The old drift was 0.4°/s of azimuth and the star never reliably
 * entered the frame at all.
 *
 * The numbers, and each of them is a composition decision. The phase magnitudes
 * below were read off the running page, not derived:
 *
 *   PHASE_OPEN   112°  arrival: a broad lit disk turned three-quarters away
 *                      from the star, which is still the blue marble and not
 *                      yet a crescent, with the star just past the right edge.
 *   PHASE_RATE   1.8°/s  a turn in 200 s. The star crosses into frame around
 *                      131° and slides behind the limb around 158°, so it
 *                      climbs into shot about ten seconds after the page opens
 *                      and streams across for the next fifteen. At 150° — the
 *                      picture this was tuned on — the disk is a bright rim on
 *                      the left, the star sits clear of it at two thirds of the
 *                      way across, and the anamorphic streak runs the full
 *                      width of the frame under the type.
 *   SWING_TILT   16°   the orbit is tipped off the star's own plane, so the
 *                      star passes above the limb rather than straight through
 *                      it and the axis reads as tilted rather than flat.
 *   FILL         0.66  a hair smaller than the old 0.78. The extra sky is what
 *                      the streak has to cross.
 *
 * The phase is fed in **negative**, which is not a detail. A phase and its
 * negative put the camera on mirror-image arcs either side of the star line, so
 * the sign decides which half of the frame the star crosses — and the poster's
 * left third is a near-solid gradient with all of the type on it. Measured on
 * the positive arc, the star's image sat at NDC x = −0.58: dead center of the
 * black panel, invisible, with its ghost chain out over the empty sky on the
 * right. Negated it is at +0.58, and the picture is the one described above.
 *
 * The ramp is unbounded and deliberately not wrapped: `anglesForPhase` is built
 * out of a sine and a cosine, so −540° is −180° and the orbit simply keeps
 * going. A modulo here would be a discontinuity waiting to be introduced.
 */
const PHASE_OPEN = -112
const PHASE_RATE = -1.8
const SWING_TILT = 16
const FILL = 0.66

/**
 * How much of the lens's ghost chain the front door shows. About a third.
 *
 * The ghosts are strung along the line from the star through the center of the
 * frame, so the closer the star gets to the right edge the further the chain
 * reaches toward the type on the left — and at full strength the red aperture
 * ring is a 260 px hoop that lands on the paragraph. A flight camera earns its
 * artifacts; a page of type does not.
 *
 * Not zero, because `flare.ts` counts the anamorphic streak as an artifact
 * along with the ghosts, and the streak is the *thing this page is composed
 * around* — a blade of light across the whole frame, which is the contrast the
 * gradient was always missing. A third is where the streak reads and the ring
 * has become two faint colored smudges on empty sky.
 */
const MENU_FLARE_ARTIFACTS = 0.35

export function MenuScene({ engine }: { engine: GameEngine | null }) {
  /*
   * Frame Earth, and carry the sun across it.
   *
   * Through the observatory rather than by moving the ship: the menu must not
   * change canonical state, so that arriving here from a flight session and
   * leaving again puts you back exactly where you were.
   *
   * The observatory solves the phase at render time, before the engine builds
   * the scene. Its automatic orbit advances with the presented frame and holds
   * while the clock is paused, so pausing through the harness holds the camera
   * and the sky at the same instant — and a time warp a flight session left
   * behind does not spin the front door, which may not touch that warp.
   */
  useEffect(() => {
    if (engine === null) return
    const observatory = engine.harness.observatory
    /*
     * The menu's stance. It used to capture the previous values and put them
     * back by hand — the only one of the three writers that did, which is why
     * it was the one that worked. Now nobody remembers anything: `release`
     * means whatever was underneath.
     */
    const stance = engine.presentation.push({
      showShip: false,
      flareArtifacts: MENU_FLARE_ARTIFACTS,
      observatory: true,
      diffuseGalaxy: true,
    })
    try {
      observatory.focus('s:SOL/b:2', { fill: FILL, ease: false })
      observatory.orbitPhase(PHASE_OPEN, PHASE_RATE, SWING_TILT)
    } catch {
      // A world without Sol is not a world this build makes, but a menu that
      // throws is a black page — and the scene behind it is decoration.
    }

    return () => {
      // Releasing the stance is what drops the observatory's target, so the
      // camera goes back to whatever the next layer is holding.
      stance.release()
    }
  }, [engine])

  return <Outlet />
}
