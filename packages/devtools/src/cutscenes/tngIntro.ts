import {
  Quaternion as Q,
  type Quat,
  UV,
  type UniverseVector,
  Vec,
  vec3,
} from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import {
  type Body,
  bodyFrameId,
  systemFrameId,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import {
  type AimBeat,
  type CinematicEffects,
  type CinematicSample,
  type CinematicTextState,
  type CinematicTextStyle,
  type FadeWindow,
  fadeEnvelope,
  frameTarget,
  frameTwoTargets,
  lookAlong,
  type RouteBeat,
  routeOrientation,
  routePosition,
  screenDirection,
  smooth,
  warpFlashEnvelope,
} from '@inertialref/rendering'
import type { CutsceneScript, PreparedCutscene } from '../cutscene.ts'
import { placeShot, type ShotDefinition } from '../shots.ts'

/*
 * The demonstration cutscene: a shot-for-shot study of the 1987 television
 * title sequence, staged in the real Solar System.
 *
 * Every timing in this file is a measured number, not a guess: the reference
 * edit was analysed frame-by-frame (shot boundaries, title fade windows, the
 * credit grid, the warp-flash shape) and this script reproduces those
 * measurements on the same 24000/1001 fps timebase, so a render can be dumped
 * and diffed numerically against the reference. The structural facts the
 * script is built on, in the analysis's own terms:
 *
 * - The piece is four real scenes plus transitions: (A) a planet journey,
 *   (B) a locked-off starfield carrying the title and credits, (C) a locked
 *   starfield carrying the end cards, (D) black cards.
 * - The camera never moves while text is visible; all text transitions are
 *   4–8 frame opacity fades and the only text animation is the logo's settle.
 * - The f240 join is a composition-matched hard cut (planet right of centre,
 *   sun at its left limb on both sides), not a dissolve.
 * - Fly-through wipes follow one recipe, used three times: distant dot dead
 *   ahead → exponential approach → 3-frame occlusion → streak exit.
 * - Both warp flashes are the same symmetric 15-frame envelope.
 * - Credits 4–9 fire on a strict alternating 65/67-frame grid.
 *
 * Staging uses the live world rather than props: the planet passes are
 * Earth, Mars (with a moon transit if the catalogue gives Mars one), Jupiter
 * and Saturn at their actual ephemeris positions. Translation between them is
 * absurdly fast and deliberately so — the starfield sits on the star shell,
 * so translation moves no stars and only *rotation* is visible in the
 * background. That is the observation the whole journey shot rests on.
 */

/** The reference edit's timebase. NTSC film rate, verified constant. */
const FPS = 24000 / 1001
const DURATION = 2742

/**
 * A cinematic lens rather than the 65° flight FOV: the reference compositions
 * measure out near a 45° vertical field, and the flight default makes every
 * planet pass read wide-angle and small.
 */
const FOV = 45
/** Compositions are solved for the reference frame's shape. */
const ASPECT = 16 / 9

/** The hero hull's overall length, metres — offsets below are staged for it. */
const HULL = 642.5

const POLE = vec3(0, 1, 0)

/** A placeShot definition without the bookkeeping fields. */
const standoff = (
  distanceRadii: number,
  phaseDeg: number,
  elevationDeg: number,
): ShotDefinition => ({
  name: 'cinematic',
  description: '',
  distanceRadii,
  phaseDeg,
  elevationDeg,
  aim: 'centre',
})

interface TitleSpec {
  readonly id: string
  readonly style: CinematicTextStyle
  readonly text: string
  readonly x: number
  readonly y: number
  readonly window: FadeWindow
  /** The main logo's measured shrink over f1150–1162. */
  readonly settle?: boolean
}

/** A fade window from the measured (first, fadeOutStart, last) triple. */
const fade = (
  firstVisible: number,
  fadeOutStart: number,
  lastVisible: number,
  rise = 5,
): FadeWindow => ({
  firstVisible,
  fullOpacity: firstVisible + rise,
  fadeOutStart,
  lastVisible,
})

/*
 * Every line of text in the piece. Positions are the measured centroids;
 * windows are the measured threshold crossings. The label lines ride their
 * name's window (they fade as one element in the reference).
 *
 * The credit names are the reference edit's season-one cast order — they are
 * what the measured windows *are*, and swapping them out would decouple the
 * recreation from the numbers it is verified against. The opening and closing
 * cards are this project's own attributions.
 */
const TITLES: readonly TitleSpec[] = [
  // Shot 01 — the opening card, over pure black.
  {
    id: 'card-title',
    style: 'card',
    text: '« INERTIAL REF »',
    x: 0.5,
    y: 0.38,
    window: fade(3, 84, 104, 17),
  },
  {
    id: 'card-sub',
    style: 'label',
    text: 'AN ENGINE STUDY · AFTER THE 1987 TITLE SEQUENCE',
    x: 0.5,
    y: 0.46,
    window: fade(3, 84, 104, 17),
  },

  // Shot 05 — the main title. The logo settles (measured f1154–1162); the
  // subtitle joins 32 frames later.
  {
    id: 'logo',
    style: 'logo',
    text: 'STAR TREK',
    x: 0.512,
    y: 0.4,
    window: fade(1150, 1255, 1262, 4),
    settle: true,
  },
  {
    id: 'subtitle',
    style: 'subtitle',
    text: 'THE NEXT GENERATION',
    x: 0.512,
    y: 0.575,
    window: fade(1182, 1255, 1262, 20),
  },

  // Shot 06 — the cast. Credits 4–9 sit on the measured 65/67 grid.
  {
    id: 'c1-label',
    style: 'label',
    text: 'Starring',
    x: 0.363,
    y: 0.405,
    window: fade(1326, 1392, 1398),
  },
  {
    id: 'c1',
    style: 'name',
    text: 'PATRICK STEWART',
    x: 0.473,
    y: 0.503,
    window: fade(1326, 1392, 1398),
  },
  {
    id: 'c2',
    style: 'name',
    text: 'JONATHAN FRAKES',
    x: 0.496,
    y: 0.503,
    window: fade(1453, 1519, 1525),
  },
  {
    id: 'c3-label',
    style: 'label',
    text: 'Also Starring',
    x: 0.372,
    y: 0.405,
    window: fade(1574, 1632, 1638),
  },
  {
    id: 'c3',
    style: 'name',
    text: 'LEVAR BURTON',
    x: 0.482,
    y: 0.503,
    window: fade(1574, 1632, 1638),
  },
  {
    id: 'c4',
    style: 'name',
    text: 'DENISE CROSBY',
    x: 0.495,
    y: 0.503,
    window: fade(1654, 1698, 1703),
  },
  {
    id: 'c5',
    style: 'name',
    text: 'MICHAEL DORN',
    x: 0.499,
    y: 0.503,
    window: fade(1719, 1764, 1769),
  },
  {
    id: 'c6',
    style: 'name',
    text: 'GATES McFADDEN',
    x: 0.52,
    y: 0.503,
    window: fade(1786, 1830, 1835),
  },
  {
    id: 'c7',
    style: 'name',
    text: 'MARINA SIRTIS',
    x: 0.492,
    y: 0.503,
    window: fade(1851, 1896, 1901),
  },
  // Spiner and Wheaton sit low — the approaching saucer owns the upper half.
  {
    id: 'c8',
    style: 'name',
    text: 'BRENT SPINER',
    x: 0.509,
    y: 0.758,
    window: fade(1918, 1962, 1967),
  },
  // Wheaton's fade-out is the measured fast drop as the flyover begins.
  {
    id: 'c9',
    style: 'name',
    text: 'WIL WHEATON',
    x: 0.517,
    y: 0.757,
    window: fade(1983, 2028, 2031),
  },

  // Shot 08 — end cards.
  {
    id: 'e1-label',
    style: 'label',
    text: 'Executive Producer',
    x: 0.352,
    y: 0.405,
    window: fade(2440, 2498, 2504, 6),
  },
  {
    id: 'e1',
    style: 'name',
    text: 'GENE RODDENBERRY',
    x: 0.474,
    y: 0.503,
    window: fade(2440, 2498, 2504, 6),
  },
  {
    id: 'e2a-label',
    style: 'label',
    text: 'Starship Model By',
    x: 0.5,
    y: 0.19,
    window: fade(2530, 2609, 2613, 10),
  },
  {
    id: 'e2a',
    style: 'name',
    text: 'LOGANROLPHH',
    x: 0.5,
    y: 0.27,
    window: fade(2530, 2609, 2613, 10),
  },
  {
    id: 'e2b-label',
    style: 'label',
    text: 'Planet Textures By',
    x: 0.5,
    y: 0.45,
    window: fade(2530, 2609, 2613, 10),
  },
  {
    id: 'e2b',
    style: 'name',
    text: 'NASA / USGS',
    x: 0.5,
    y: 0.53,
    window: fade(2530, 2609, 2613, 10),
  },
  {
    id: 'e2c-label',
    style: 'label',
    text: 'Engine By',
    x: 0.5,
    y: 0.71,
    window: fade(2530, 2609, 2613, 10),
  },
  {
    id: 'e2c',
    style: 'name',
    text: 'INERTIALREF',
    x: 0.5,
    y: 0.79,
    window: fade(2530, 2609, 2613, 10),
  },

  // Shot 09 — the outro card, crediting the reference this was measured from.
  {
    id: 'o1-label',
    style: 'label',
    text: 'After The Recreation By',
    x: 0.5,
    y: 0.42,
    window: fade(2637, 2700, 2710, 13),
  },
  {
    id: 'o1',
    style: 'name',
    text: 'JASON T',
    x: 0.448,
    y: 0.5,
    window: fade(2637, 2700, 2710, 13),
  },
  {
    id: 'o1-accent',
    style: 'accent',
    text: '(JTVFX)',
    x: 0.588,
    y: 0.5,
    window: fade(2637, 2700, 2710, 13),
  },
]

/** The logo's measured settle: ~7% larger at first visibility, unity by f1162. */
const settleScale = (frame: number): number =>
  1 + 0.07 * (1 - smooth((frame - 1150) / 12))

/** The three fly-through wipes' occlusion frames (middle of each 3-frame hold). */
const WIPE_OCCLUSIONS = [1318, 1446, 1565] as const

/** Ship visibility windows, frames inclusive. */
const SHIP_WINDOWS: readonly (readonly [number, number])[] = [
  [700, 1098],
  [1290, 1323],
  [1400, 1450],
  [1520, 1569],
  [1780, 2395],
]

interface Stage {
  readonly cameraBeats: readonly RouteBeat[]
  readonly aimBeats: readonly AimBeat[]
  /** Scene A's ship, as camera-relative offsets — see the authoring note. */
  readonly shipOffsetsA: readonly RouteBeat[]
  /** Scene B's ship, absolute against the locked stage. */
  readonly shipBeatsB: readonly RouteBeat[]
  /** Scene B's frozen pose, for holds and camera-relative choreography. */
  readonly lockPosition: UniverseVector
  readonly lockOrientation: Quat
}

export const TNG_INTRO: CutsceneScript = {
  id: 'tng-intro',
  description:
    'shot-for-shot study of the 1987 title sequence, staged in Sol (114 s)',
  fps: FPS,
  durationFrames: DURATION,
  prepare(world: World): PreparedCutscene {
    const stage = buildStage(world)
    return { sample: (frame) => sample(stage, frame) }
  },
}

/* ------------------------------------------------------------------------- */
/* Stage construction                                                         */
/* ------------------------------------------------------------------------- */

function buildStage(world: World): Stage {
  const system = world.loadSystem(systemId('SOL'))
  const time = world.clock.time
  const positionOf = (body: Body): UniverseVector =>
    world.frames.pose(bodyFrameId(body.address), time).position
  const sun = world.frames.pose(systemFrameId(system.id), time).position

  const bodies = [...walkBodies(system)]
  const byName = (name: string): Body | undefined =>
    bodies.find((body) => body.name.toLowerCase() === name.toLowerCase())
  const require = (name: string): Body => {
    const body = byName(name)
    if (body === undefined)
      throw new Error(`The ${name} this script stages on is not in SOL`)
    return body
  }

  const earth = require('Earth')
  const jupiter = require('Jupiter')
  const saturn = require('Saturn')

  /*
   * The eclipse planet: dark, right of centre, sun sliding behind its limb —
   * and ideally owning a close-orbiting moon for the f253 transit. Mars is
   * first choice (Phobos sits at 2.8 radii, so the transit detour barely
   * disturbs the framing); the others degrade gracefully down to "no transit"
   * rather than failing the whole scene over a moonless catalogue.
   */
  const eclipseCandidates = ['Mars', 'Uranus', 'Neptune', 'Venus']
  let eclipse: Body | undefined
  for (const name of eclipseCandidates) {
    const body = byName(name)
    if (body === undefined) continue
    if (eclipse === undefined) eclipse = body
    if (body.moons.length > 0) {
      eclipse = body
      break
    }
  }
  if (eclipse === undefined) eclipse = earth

  const at = (
    body: Body,
    position: UniverseVector,
    distanceRadii: number,
    phaseDeg: number,
    elevationDeg: number,
  ): UniverseVector => {
    const toStar = Vec.normalize(UV.difference(sun, position))
    const placement = placeShot(
      standoff(distanceRadii, phaseDeg, elevationDeg),
      body.radius,
      toStar,
    )
    return UV.translate(position, placement.position)
  }

  /* --------------------------- Scene A: Earth --------------------------- */

  const earthPos = positionOf(earth)
  /*
   * The reference's opening (checked against its frame dump, f154) is a *low
   * sweep*, not a framed disc: the camera rides ~1.3 radii out with the limb
   * slashing diagonally across the frame, daylight terrain filling the right
   * two-thirds, and the sun a warm ball in the upper left over the stars.
   * Only in the last third of the shot does the pull-back collapse the
   * planet to the measured small-disc-right-of-centre end state that the
   * f240 match cut answers. So the stage starts on the limb-aimed shot
   * grammar — the ISS composition machinery — and hands over to the
   * two-target solver as the disc resolves.
   */
  const toStarEarth = Vec.normalize(UV.difference(sun, earthPos))
  const earthShot = (
    distanceRadii: number,
    phaseDeg: number,
  ): { position: UniverseVector; orientation: Quat } => {
    const placement = placeShot(
      {
        name: 'cinematic',
        description: '',
        distanceRadii,
        phaseDeg,
        elevationDeg: 0,
        aim: 'limb',
        aimLift: 0.035,
      },
      earth.radius,
      toStarEarth,
    )
    // The limb aim centres the sunward horizon level; the reference runs it
    // diagonally — planet filling the lower right, sun drifting upper left —
    // so the frame is shifted (the `frameTarget` trick applied to the whole
    // composition) and rolled about the view axis.
    const orientation = Q.normalize(
      Q.multiply(
        Q.multiply(
          placement.orientation,
          Q.fromUnitVectors(
            screenDirection(0.62, 0.58, FOV, ASPECT),
            vec3(0, 0, -1),
          ),
        ),
        Q.fromAxisAngle(vec3(0, 0, 1), (-28 * Math.PI) / 180),
      ),
    )
    return {
      position: UV.translate(earthPos, placement.position),
      orientation,
    }
  }
  const eLow = earthShot(1.28, 104)
  const eLift = earthShot(1.7, 116)
  const eTurn = at(earth, earthPos, 3.4, 134, 4)
  const eLate = at(earth, earthPos, 9, 152, 5)
  const e1 = at(earth, earthPos, 20, 160, 6)
  const earthAimTurn = frameTwoTargets(
    eTurn,
    { at: earthPos, x: 0.7, y: 0.6 },
    { at: sun, x: 0.38, y: 0.38 },
    FOV,
    ASPECT,
  )
  const earthAimLate = frameTwoTargets(
    eLate,
    { at: earthPos, x: 0.66, y: 0.55 },
    { at: sun, x: 0.45, y: 0.43 },
    FOV,
    ASPECT,
  )
  const earthAim1 = frameTwoTargets(
    e1,
    { at: earthPos, x: 0.66, y: 0.55 },
    { at: sun, x: 0.45, y: 0.43 },
    FOV,
    ASPECT,
  )

  /* ------------------- Scene A: the journey (f240–1084) ------------------ */

  const eclipsePos = positionOf(eclipse)
  /*
   * The eclipse pass. The reference's sun does not merely hide: it starts at
   * the planet's left limb (the match-cut composition), slides *behind* the
   * dark disc, and re-emerges on the other side — by f317 the planet is a
   * small silhouette left of the sun. That crossing is a signed sweep of the
   * camera across the anti-sun axis, which `placeShot`'s unsigned phase angle
   * cannot express, so the standoffs are built by hand in a sun-line basis:
   * `swing` positive puts the sun off the planet's left limb, negative off
   * its right.
   */
  const toSunE = Vec.normalize(UV.difference(sun, eclipsePos))
  const eclipseEast = (() => {
    const horizontal = Vec.cross(POLE, toSunE)
    return Vec.length(horizontal) > 1e-6
      ? Vec.normalize(horizontal)
      : Vec.normalize(Vec.cross(vec3(1, 0, 0), toSunE))
  })()
  const eclipsePoleward = Vec.cross(toSunE, eclipseEast)
  const eclipseCam = (
    swingDeg: number,
    liftDeg: number,
    distanceRadii: number,
  ): UniverseVector => {
    const swing = (swingDeg * Math.PI) / 180
    const lift = (liftDeg * Math.PI) / 180
    const direction = Vec.normalize(
      Vec.add(
        Vec.add(
          Vec.scale(toSunE, -Math.cos(swing) * Math.cos(lift)),
          Vec.scale(eclipseEast, Math.sin(swing) * Math.cos(lift)),
        ),
        Vec.scale(eclipsePoleward, Math.sin(lift)),
      ),
    )
    return UV.translate(
      eclipsePos,
      Vec.scale(direction, distanceRadii * eclipse.radius),
    )
  }
  // At 7.2 radii the disc's angular radius is ~8°, so ±9° of swing is "at the
  // limb" and the zero crossing near f278 is totality.
  const p0 = eclipseCam(9.2, 3, 7.2)
  const pMid = eclipseCam(1.5, 2.5, 6.8)
  const p1 = eclipseCam(-3.5, 2, 7.5)
  const p2 = eclipseCam(-11, 2, 13)
  const eclipseAim0 = frameTwoTargets(
    p0,
    { at: eclipsePos, x: 0.66, y: 0.55 },
    { at: sun, x: 0.515, y: 0.53 },
    FOV,
    ASPECT,
  )
  const eclipseAim1 = frameTwoTargets(
    p2,
    { at: eclipsePos, x: 0.4, y: 0.5 },
    { at: sun, x: 0.53, y: 0.51 },
    FOV,
    ASPECT,
  )

  /*
   * The moon transit: the route dips through the moon's neighbourhood while
   * the aim stays on the eclipsed planet, so the moon sweeps across the frame
   * rather than being looked at. The crossing point is anchored on the *view
   * axis* — camera at `moon − d·view` when the sweep peaks — because the
   * first construction offset the pass perpendicular to the view, which is a
   * moon that whips past 90° off-screen and a transit nobody sees. Beats sit
   * close together so the Catmull-Rom tangents stay local; the fast legs
   * either side would otherwise drag the pass through the moon itself.
   */
  /*
   * The detour must not pass through the planet, and the ephemeris decides
   * whether it would: a moon on the far side of its orbit at play time means
   * the dip toward it dives across the disc. The test is the real one —
   * closest approach of each straight leg to the planet's centre — because
   * the first guard (an angle threshold) rejected transits that were fine and
   * would have accepted ones that were not. Every moon is auditioned,
   * innermost first; when none clears, the edit degrades to a plain eclipse.
   */
  const clearanceOf = (a: UniverseVector, b: UniverseVector): number => {
    const ab = UV.difference(b, a)
    const toPlanet = UV.difference(eclipsePos, a)
    const t = Math.max(
      0,
      Math.min(
        1,
        Vec.dot(toPlanet, ab) / Math.max(Vec.lengthSquared(ab), 1e-9),
      ),
    )
    return Vec.length(Vec.sub(toPlanet, Vec.scale(ab, t)))
  }
  const transitBeats: RouteBeat[] = []
  /*
   * Audition moons by how close their orbit lies to the camera's standoff
   * sphere, not innermost-first. Phobos cleared the geometric guard and still
   * wrecked the shot: its orbit sits at 2.8 planet radii, so dipping to it
   * from a 7.2-radii standoff ballooned the eclipsed disc to thrice its
   * composition while the aim held — the planet wandered huge and off-frame
   * for twenty frames. A moon orbiting near the standoff distance gives the
   * same four-frame sweep with almost no detour at all.
   */
  const standoffMetres = Vec.length(UV.difference(p0, eclipsePos))
  const moonsByFit = [...eclipse.moons].sort(
    (a, b) =>
      Math.abs(a.elements.semiMajorAxis - standoffMetres) -
      Math.abs(b.elements.semiMajorAxis - standoffMetres),
  )
  for (const candidate of moonsByFit) {
    const moonPos = world.frames.pose(
      bodyFrameId(candidate.address),
      time,
    ).position
    const rM = candidate.radius
    const view = Vec.normalize(UV.difference(eclipsePos, p0))
    const travelRaw = Vec.normalize(UV.difference(pMid, p0))
    // The sweep needs travel across the view, not along it; project out the
    // view component so the crossing rate is what the beat spacing says.
    const travel = Vec.normalize(
      Vec.sub(travelRaw, Vec.scale(view, Vec.dot(travelRaw, view))),
    )
    const crossing = UV.translate(moonPos, Vec.scale(view, -3.4 * rM))
    const margin = eclipse.radius * 1.35
    if (
      clearanceOf(p0, crossing) < margin ||
      clearanceOf(crossing, pMid) < margin
    ) {
      continue
    }
    {
      const leg = (k: number): UniverseVector =>
        UV.translate(crossing, Vec.scale(travel, k * rM))
      // ±2 moon radii per frame past a disc 3.4 radii away: the measured
      // four-frame full transit.
      transitBeats.push(
        { frame: 246, position: leg(-18) },
        { frame: 251, position: leg(-8) },
        { frame: 255, position: leg(0) },
        { frame: 259, position: leg(8) },
        { frame: 264, position: leg(18) },
      )
    }
    break
  }

  const jupiterPos = positionOf(jupiter)
  const jIn = at(jupiter, jupiterPos, 14, 44, 12)
  const j0 = at(jupiter, jupiterPos, 5.4, 48, 10)
  const jOut = at(jupiter, jupiterPos, 6.5, 85, 6)
  const jupiterAim = frameTarget(
    j0,
    { at: jupiterPos, x: 0.42, y: 0.47 },
    FOV,
    ASPECT,
    POLE,
  )
  const jupiterAimOut = frameTarget(
    jOut,
    { at: jupiterPos, x: 0.24, y: 0.44 },
    FOV,
    ASPECT,
    POLE,
  )

  const saturnPos = positionOf(saturn)
  const s0 = at(saturn, saturnPos, 6, 40, -22)
  const s1 = at(saturn, saturnPos, 7.5, 72, -48)
  const saturnAim = frameTarget(
    s0,
    { at: saturnPos, x: 0.52, y: 0.2 },
    FOV,
    ASPECT,
    POLE,
  )

  /*
   * The cruise: down-sun, out into the dark where the ship appears. The
   * direction is anti-sunward on purpose — the sun sits behind the camera, so
   * the approaching hull is lit full-face the way the reference's is, and
   * after the pass the held stern view looks back into the glare that sells
   * the warp-out. The first cruise followed Saturn's exit trajectory, which
   * left the sun wherever the ephemeris put it and rendered the flyby as a
   * silhouette: a black hull on black space, filling the frame invisibly.
   */
  const cruiseDir = Vec.normalize(UV.difference(s1, sun))
  const cruise = (from: UniverseVector, metres: number): UniverseVector =>
    UV.translate(from, Vec.scale(cruiseDir, metres))
  const c700 = cruise(s1, 5e8)
  const c940 = cruise(s1, 7.5e8)
  const c1084 = cruise(s1, 9e8)
  const cruiseAim = lookAlong(cruiseDir, POLE)
  // The measured slight upward drift through the quiet stretch.
  const cruiseAimUp = Q.multiply(
    cruiseAim,
    Q.fromAxisAngle(vec3(1, 0, 0), (2.5 * Math.PI) / 180),
  )

  const cameraBeats: RouteBeat[] = [
    // Earth (the shot-02 stage; the hard cut at 240 is two separate routes,
    // spliced in `sample`).
    { frame: 125, position: eLow.position },
    { frame: 165, position: eLift.position },
    { frame: 195, position: eTurn },
    { frame: 220, position: eLate },
    { frame: 239, position: e1 },
    // The journey.
    { frame: 240, position: p0 },
    ...transitBeats,
    { frame: 285, position: pMid },
    { frame: 308, position: p1 },
    { frame: 330, position: p2 },
    { frame: 355, position: jIn },
    { frame: 393, position: j0 },
    { frame: 440, position: jOut },
    { frame: 470, position: s0 },
    { frame: 540, position: s1 },
    { frame: 700, position: c700 },
    { frame: 940, position: c940 },
    { frame: 1084, position: c1084 },
  ]

  /*
   * The overhead pass, as authored orientation beats rather than per-frame
   * ship tracking. The first version aimed the camera at the hull every
   * frame, which is exactly wrong at the moment of the pass: the ship crosses
   * within metres of the lens, the look-at direction whips through the
   * vertical, and the camera rubber-bands after the receding hull at angles
   * no operator would produce. Instead the camera pitches up and over the
   * top as the hull passes — banked, like the measured −3.7°/window roll —
   * and settles into a *held* stern-view pose; the ship then recedes along
   * that frozen axis, so the hold is guaranteed to frame it.
   */
  const passAim = (pitchDeg: number, rollDeg: number): Quat =>
    Q.multiply(
      cruiseAimUp,
      Q.multiply(
        Q.fromAxisAngle(vec3(1, 0, 0), (pitchDeg * Math.PI) / 180),
        Q.fromAxisAngle(vec3(0, 0, 1), (rollDeg * Math.PI) / 180),
      ),
    )
  // 174°, not 180: the hold looks slightly above straight astern, which keeps
  // the receding ship in the upper-centre of the held frame.
  const aimHold = passAim(174, 0)

  const aimBeats: AimBeat[] = [
    { frame: 125, orientation: eLow.orientation },
    { frame: 165, orientation: eLift.orientation },
    { frame: 195, orientation: earthAimTurn },
    { frame: 220, orientation: earthAimLate },
    { frame: 239, orientation: earthAim1 },
    { frame: 240, orientation: eclipseAim0 },
    { frame: 268, orientation: eclipseAim0 },
    { frame: 330, orientation: eclipseAim1 },
    { frame: 372, orientation: jupiterAim },
    { frame: 400, orientation: jupiterAim },
    { frame: 440, orientation: jupiterAimOut },
    { frame: 474, orientation: saturnAim },
    { frame: 548, orientation: cruiseAim },
    { frame: 700, orientation: cruiseAimUp },
    { frame: 930, orientation: cruiseAimUp },
    { frame: 962, orientation: passAim(16, -12) },
    { frame: 987, orientation: passAim(64, -34) },
    { frame: 1022, orientation: aimHold },
    { frame: 1084, orientation: aimHold },
  ]

  /* -------------------- The hero ship's scene A route -------------------- */

  const fwd = Q.rotate(cruiseAimUp, vec3(0, 0, -1))
  const upA = Q.rotate(cruiseAimUp, vec3(0, 1, 0))
  // Where the held pose looks: the receding ship travels along this axis.
  const recede = Q.rotate(aimHold, vec3(0, 0, -1))
  /*
   * Scene A ship choreography is *offsets from the camera*, interpolated in
   * offset space and added to the camera's position at sample time. It was
   * absolute world beats first — each anchored to the camera's position at
   * its own frame — and that broke quietly: the cruise camera covers ~1000 km
   * a frame, so the ship's spline and the camera's spline ran through beats
   * tens of thousands of kilometres apart and diverged by tens of kilometres
   * mid-segment. Relative choreography has to stay relative, or the hero
   * hull is a dot on the wrong side of the sky.
   */
  const offset = (frame: number, ahead: number, above: number): RouteBeat => ({
    frame,
    position: UV.fromVec3(
      Vec.add(Vec.scale(fwd, ahead), Vec.scale(upA, above)),
    ),
  })
  const asternOffset = (frame: number, metres: number): RouteBeat => ({
    frame,
    position: UV.fromVec3(Vec.scale(recede, metres)),
  })

  // Dead ahead as a point, exponential-feeling approach, overhead pass at
  // f975, then receding down the held view axis and hurled away under the
  // warp flash.
  const shipOffsetsA: RouteBeat[] = [
    offset(700, 60_000, 150),
    offset(780, 30_000, 160),
    offset(860, 12_000, 170),
    offset(920, 3_600, 180),
    offset(950, 1_100, 170),
    offset(975, 90, 115),
    asternOffset(1000, 520),
    asternOffset(1030, 1_900),
    asternOffset(1084, 26_000),
    asternOffset(1090, 120_000),
    asternOffset(1099, 900_000),
  ]

  /* ------------------------ Scene B: the locked stage --------------------- */

  const lockPosition = c1084
  /*
   * The lock is a *different* orientation from the held stern view, swapped
   * under the whiteout — the same trick the reference's f240 match cut plays
   * with a hard cut. It has to be: the held view looks back down-sun into the
   * glare (that is what sells the warp-out), and a credits scene locked onto
   * the sun would put a star's disc behind forty seconds of type. The lock
   * looks perpendicular to the sun line, tipped a few degrees up, with the
   * sign chosen to keep Saturn out of the background too.
   */
  const toSunAtLock = Vec.normalize(UV.difference(sun, lockPosition))
  const lockSide = (() => {
    const side = Vec.normalize(Vec.cross(toSunAtLock, POLE))
    const towardSaturn = Vec.normalize(UV.difference(saturnPos, lockPosition))
    return Vec.dot(side, towardSaturn) > 0 ? Vec.negate(side) : side
  })()
  // Tilted well past perpendicular towards down-sun: the sun stays ~130° off
  // the view axis (far outside the frame and the flare's edge fade), while
  // the hull doing the credit fly-bys catches real front light instead of
  // reading as a grey silhouette lit edge-on.
  const lockOrientation = lookAlong(
    Vec.normalize(
      Vec.add(
        Vec.add(lockSide, Vec.scale(toSunAtLock, -0.8)),
        Vec.scale(POLE, 0.08),
      ),
    ),
    POLE,
  )

  const local = (
    frame: number,
    x: number,
    y: number,
    z: number,
  ): RouteBeat => ({
    frame,
    position: UV.translate(
      lockPosition,
      Q.rotate(lockOrientation, vec3(x, y, z)),
    ),
  })

  // One wipe, per the measured recipe: distant dot dead ahead, exponential
  // approach, occlusion, exit past the camera. Slightly above the axis, so
  // occlusion is the hull filling the frame rather than the near plane
  // slicing the bridge.
  const wipe = (
    start: number,
    occlusion: number,
    exit: number,
  ): RouteBeat[] => {
    const approach = occlusion - start
    /*
     * Checked against the reference dump (f1441, four frames before its
     * occlusion): the hull is still ~400 m out there and covers the frame by
     * *passing*, not by asymptotic approach — a pure exponential reached
     * occlusion range ten frames early and hung there. These beats keep the
     * exponential feel through the middle and finish with a fast, nearly
     * linear rush through the camera plane.
     */
    return [
      local(start, 0, 5, -40_000),
      local(start + approach * 0.5, 0, 8, -7_000),
      local(start + approach * 0.8, 0, 13, -1_800),
      local(start + approach * 0.93, 0, 19, -520),
      local(occlusion, 0, 26, -60),
      local(exit, 0, 34, 260),
    ]
  }

  const shipBeatsB: RouteBeat[] = [
    ...wipe(1290, 1317, 1322),
    ...wipe(1400, 1445, 1450),
    ...wipe(1520, 1564, 1569),
    // The return: in at the top of frame, descending and growing through the
    // remaining credits — the camera never moves until the last title is
    // gone. Calibrated against the reference dump: at f1990 its saucer spans
    // ~65% of the frame width, which for this hull is ~750 m out, sitting
    // just above the vertical centre.
    local(1780, 0, 950, -4_800),
    local(1850, 0, 520, -2_600),
    local(1918, 0, 250, -1_350),
    local(1995, 0, 110, -780),
    local(2031, 0, 85, -660),
    local(2100, 0, 45, -560),
    // The close flyover: the saucer slides just beneath the camera and pulls
    // ahead, ending on the stern.
    local(2150, 0, -55, -350),
    local(2230, 0, -70, -430),
    local(2300, 0, -60, -600),
    local(2381, 0, -35, -850),
    local(2390, 0, -20, -80_000),
    local(2396, 0, 0, -900_000),
  ]

  // The flyover's camera track — the one camera move in scene B, and it
  // begins only after Wheaton's fast drop is complete (measured: no text
  // survives past f2031; the move starts at f2100).
  const pitch = (deg: number): Quat =>
    Q.multiply(
      lockOrientation,
      Q.fromAxisAngle(vec3(1, 0, 0), (deg * Math.PI) / 180),
    )
  const flyoverAim: AimBeat[] = [
    { frame: 2100, orientation: lockOrientation },
    { frame: 2175, orientation: pitch(-13) },
    { frame: 2265, orientation: pitch(-8) },
    { frame: 2345, orientation: pitch(-3) },
    { frame: 2381, orientation: lockOrientation },
  ]

  return {
    cameraBeats,
    aimBeats: [...aimBeats, ...flyoverAim],
    shipOffsetsA,
    shipBeatsB,
    lockPosition,
    lockOrientation,
  }
}

/* ------------------------------------------------------------------------- */
/* Sampling                                                                   */
/* ------------------------------------------------------------------------- */

function shipVisible(frame: number): boolean {
  return SHIP_WINDOWS.some(([from, to]) => frame >= from && frame <= to)
}

/** Streak burst around a wipe occlusion: leads by a few frames, dies after. */
function wipeStreak(occlusion: number, frame: number): number {
  return Math.min(
    smooth((frame - (occlusion - 7)) / 6),
    1 - smooth((frame - occlusion - 2) / 8),
  )
}

function effectsAt(frame: number): CinematicEffects {
  const flash1 = warpFlashEnvelope(1085, frame)
  const flash2 = warpFlashEnvelope(2382, frame)

  let blackout = 0
  if (frame < 125) blackout = 1
  else if (frame < 133) blackout = 1 - smooth((frame - 125) / 7)
  else if (frame >= 2614) blackout = 1
  else if (frame >= 2604) blackout = smooth((frame - 2604) / 10)

  let streaks = Math.max(flash1.streaks, flash2.streaks)
  // Warp streaks igniting ahead of both flashes (measured onsets 1080, 2332).
  streaks = Math.max(
    streaks,
    0.35 * smooth((frame - 1078) / 7) * (frame < 1100 ? 1 : 0),
  )
  streaks = Math.max(
    streaks,
    0.5 * smooth((frame - 2332) / 50) * (frame < 2382 ? 1 : 0),
  )
  for (const occlusion of WIPE_OCCLUSIONS)
    streaks = Math.max(streaks, 0.85 * wipeStreak(occlusion, frame))

  let nacelleGlow = 0
  if (frame >= 867 && frame < 1100) nacelleGlow = smooth((frame - 867) / 120)
  else if (frame >= 2332 && frame < 2397)
    nacelleGlow = smooth((frame - 2332) / 40)

  return {
    blackout,
    flash: Math.max(flash1.flash, flash2.flash),
    streaks,
    nacelleGlow,
  }
}

function textsAt(frame: number): CinematicTextState[] {
  return TITLES.map((title) => ({
    id: title.id,
    style: title.style,
    text: title.text,
    x: title.x,
    y: title.y,
    opacity: fadeEnvelope(title.window, frame),
    scale: title.settle === true ? settleScale(frame) : 1,
  }))
}

function cameraAt(
  stage: Stage,
  frame: number,
): { position: UniverseVector; orientation: Quat } {
  // Scenes B–D: the camera is locked (the one exception, the hull flyover,
  // lives in the aim beats) — the measured constraint is that nothing but the
  // ship moves while text is on screen. The boundary sits mid-whiteout
  // (flash full from f1089), so the swap from the held stern view to the
  // locked stage happens behind a fully covered frame.
  if (frame >= 1092) {
    return {
      position: stage.lockPosition,
      orientation: routeOrientation(
        stage.aimBeats.filter((beat) => beat.frame >= 2100),
        Math.max(frame, 2100),
      ),
    }
  }

  const position = routePosition(
    // Splice out the pre-cut beats so the f240 hard cut stays hard: a single
    // route would spline across the seam and turn the match cut into a swoop.
    frame < 240
      ? stage.cameraBeats.filter((beat) => beat.frame < 240)
      : stage.cameraBeats.filter((beat) => beat.frame >= 240),
    frame,
  )
  const aims =
    frame < 240
      ? stage.aimBeats.filter((beat) => beat.frame < 240)
      : stage.aimBeats.filter((beat) => beat.frame >= 240 && beat.frame < 2100)
  // The overhead pass is authored into the aim beats — no per-frame ship
  // tracking anywhere. A camera that chases a hull crossing metres from the
  // lens whips through the vertical and rubber-bands after it; the beats
  // pitch over the top once and hold.
  return { position, orientation: routeOrientation(aims, frame) }
}

/**
 * Where the hull is at a frame. Scene A rides the camera (offsets sampled in
 * offset space, then added to the camera's own position this frame); scene B
 * is absolute against the locked stage. The split point sits in the dead
 * window between the first flash and the first wipe, where the ship is not
 * drawn either way.
 */
function shipPositionAt(stage: Stage, frame: number): UniverseVector {
  if (frame < 1200) {
    const camera = cameraAt(stage, frame)
    return UV.translate(
      camera.position,
      UV.approxMeters(routePosition(stage.shipOffsetsA, frame)),
    )
  }
  return routePosition(stage.shipBeatsB, frame)
}

function shipAt(
  stage: Stage,
  frame: number,
): { position: UniverseVector; orientation: Quat; visible: boolean } {
  const visible = shipVisible(frame)
  const position = shipPositionAt(stage, frame)
  // Nose along the direction of travel, level against the stage's up. The
  // finite difference straddles the sample so the orientation is centred.
  const ahead = shipPositionAt(stage, frame + 1.5)
  const behind = shipPositionAt(stage, frame - 1.5)
  const travel = UV.difference(ahead, behind)
  const up = Q.rotate(stage.lockOrientation, vec3(0, 1, 0))
  const orientation =
    Vec.length(travel) > 1e-3
      ? lookAlong(Vec.normalize(travel), up)
      : stage.lockOrientation
  return { position, orientation, visible }
}

function sample(stage: Stage, frame: number): CinematicSample {
  const camera = cameraAt(stage, frame)
  const ship = shipAt(stage, frame)
  return {
    frame,
    camera,
    fov: FOV,
    ship,
    texts: textsAt(frame),
    effects: effectsAt(frame),
    done: frame >= DURATION - 1,
  }
}

/** Exposed for tests: the measured windows the script must reproduce. */
export const TNG_TITLE_WINDOWS: ReadonlyMap<string, FadeWindow> = new Map(
  TITLES.map((title) => [title.id, title.window]),
)

/** Exposed for tests and the effects layer: hull length the offsets assume. */
export const TNG_HULL_LENGTH = HULL
