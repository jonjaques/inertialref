import {
  Quaternion as Q,
  type Quat,
  UV,
  type UniverseVector,
  Vec,
  type Vec3,
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
  arrival,
  type CinematicEffects,
  type CinematicSample,
  type CinematicTextState,
  type CinematicTextStyle,
  type FadeWindow,
  fadeEnvelope,
  frameTarget,
  frameTwoTargets,
  lerp,
  lookAlong,
  rangeForWidth,
  type RouteBeat,
  routeOrientation,
  routePosition,
  type ScreenBeat,
  screenDirection,
  screenRoutePosition,
  smooth,
  sparkEnvelope,
  warpFlashEnvelope,
  withAttitude,
} from '@inertialref/rendering'
import type { CutsceneScript, PreparedCutscene } from '../cutscene.ts'
import { placeShot, type ShotDefinition } from '../shots.ts'

/*
 * The demonstration cutscene: a shot-for-shot study of the 1987 television
 * title sequence, staged in the real Solar System.
 *
 * Every timing and every composition here is a measured number. The reference
 * edit was tracked frame by frame — shot boundaries, the hull's bounding box
 * in every frame it appears in, each title's pixel mask, the flash envelopes —
 * and this script reproduces those measurements on the same 24000/1001 fps
 * timebase, so a render can be dumped and diffed against the reference
 * numerically rather than argued about.
 *
 * Two ideas carry the whole file.
 *
 * **It is an edit, not a move.** The piece is a *shot list*: each shot has its
 * own camera, placed against its own subject, and the cuts between them sit
 * where the reference's are — in darkness, behind a flash, or under a body
 * filling the frame. Authored as one continuous spline it becomes what the
 * first version of this script was: a camera crossing five astronomical units
 * between beats, drifting through long stretches of nothing, aimed at
 * whichever planet it was between. The reference's own analysis calls f240 to
 * f1084 "one unbroken camera move", but its frames do not: Jupiter is absent
 * at f370 and fills the right half at f382, Saturn is gone by f530 and the
 * screen is empty until f691. Those are cuts, hidden by an empty starfield.
 *
 * **Screen-space beats.** Ship choreography is authored as
 * `(frame, screen x, screen y, range)` through `screenOffset`, because that is
 * the language the measurement speaks: a tracked bounding box gives a center
 * and a width, and a width *is* a range once the hull's length and the lens
 * are known. Beats written this way can be read straight off the analysis.
 *
 * The structural facts, in the analysis's own terms:
 *
 * - The camera never moves while text is visible. Every credit is a pure 4–8
 *   frame opacity fade, horizontally centered, with its label line flush left
 *   against the name above it.
 * - The main logotype is **not** a fade. Two words are thrown in from opposite
 *   sides of the frame, converge, and shrink onto their marks (measured: the
 *   block is 1476 px wide at f1150 and 1123 px by f1161), out of an anamorphic
 *   lens spike the departing ship leaves behind.
 * - The f240 join is a composition-matched hard cut.
 * - Three fly-through wipes, of which the first and third are the *same*
 *   animation 247 frames apart and the second is its mirror.
 * - Both warp flashes are the same symmetric 15-frame envelope, and both are
 *   blue: the nacelles bloom, they do not white out.
 */

/** The reference edit's timebase. NTSC film rate, verified constant. */
const FPS = 24000 / 1001
const DURATION = 2742

/**
 * A cinematic lens rather than the 65° flight FOV. 45° is what the reference's
 * compositions measure out at: at that field the eclipsed disk's 440-pixel
 * diameter at f272 puts the camera 6.0 planet radii out, and the hull's
 * bounding box at f872 puts it 630 m away — both sane numbers for the shots
 * they describe, which is the test that fixes the field.
 */
const FOV = 45
/** Compositions are solved for the reference frame's shape. */
const ASPECT = 16 / 9

/** The hero hull's overall length, meters. Ranges below are derived from it. */
const HULL = 642.5

const POLE = vec3(0, 1, 0)

/* ------------------------------------------------------------------------- */
/* Titles                                                                     */
/* ------------------------------------------------------------------------- */

interface TitleSpec {
  readonly id: string
  readonly style: CinematicTextStyle
  readonly text: string
  /** The small line above; see `CinematicTextState.label`. */
  readonly label?: string
  readonly x: number
  readonly y: number
  readonly window: FadeWindow
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
 * Measured layout, from the blue-mask row bands of the reference frames:
 *
 * - A name's cap band is 79–81 px of 1080, centered on y 0.5032. Every name is
 *   horizontally centered at x 0.498–0.510; the per-credit centroids in the
 *   older analysis drifted left only because they were pixel-weighted and the
 *   label line pulled them.
 * - A label sits 0.1056 of the frame height above its name and is flush left
 *   with it — which is why it rides the name's own element rather than being
 *   positioned independently.
 * - Spiner and Wheaton sit at y 0.7644: by then the saucer owns the top half.
 */
const NAME_Y = 0.5032
const LOW_NAME_Y = 0.7644
const CENTRE_X = 0.5

const TITLES: readonly TitleSpec[] = [
  // Shot 01 — the opening card, over pure black. The reference's is the
  // rights-holder's copyright card; this project's own attribution stands in
  // its place, on the reference's measured marks.
  {
    id: 'card-title',
    style: 'card',
    text: 'INERTIAL REF',
    x: CENTRE_X,
    y: 0.327,
    window: fade(3, 84, 104, 17),
  },
  {
    id: 'card-sub',
    style: 'label',
    // Short enough to fit: the reference's copyright line runs 0.84 of the
    // frame at 44 characters, and this face sets ~7% wider per glyph, so the
    // same sentence spills off both edges. The card's job is the attribution,
    // not the whole sentence.
    text: 'AN ENGINE STUDY · AFTER 1987',
    x: CENTRE_X,
    y: 0.5347,
    window: fade(3, 84, 104, 17),
  },

  // Shot 05 — the main title. Positions here are the *settled* marks; the
  // fly-in overrides x/y/scale up to f1161. Measured word boxes at f1200:
  // STAR spans x 0.209–0.537 / y 0.271–0.426, TREK x 0.500–0.797 /
  // y 0.393–0.552.
  {
    id: 'logo-star',
    style: 'logo',
    text: 'STAR',
    x: 0.373,
    y: 0.3486,
    window: fade(1136, 1259, 1270, 14),
  },
  {
    id: 'logo-trek',
    style: 'logo',
    text: 'TREK',
    x: 0.6484,
    y: 0.4722,
    window: fade(1136, 1259, 1270, 14),
  },
  {
    id: 'subtitle',
    style: 'subtitle',
    text: 'THE NEXT GENERATION',
    x: 0.4964,
    y: 0.6245,
    window: fade(1178, 1259, 1270, 11),
  },

  // Shot 06 — the cast. Credits 4–9 sit on the measured 65/67 grid.
  {
    id: 'c1',
    style: 'name',
    label: 'Starring',
    text: 'PATRICK STEWART',
    x: CENTRE_X,
    y: NAME_Y,
    window: fade(1326, 1392, 1398),
  },
  {
    id: 'c2',
    style: 'name',
    text: 'JONATHAN FRAKES',
    x: CENTRE_X,
    y: NAME_Y,
    window: fade(1453, 1519, 1525),
  },
  {
    id: 'c3',
    style: 'name',
    label: 'Also Starring',
    text: 'LEVAR BURTON',
    x: CENTRE_X,
    y: NAME_Y,
    window: fade(1574, 1632, 1638),
  },
  {
    id: 'c4',
    style: 'name',
    text: 'DENISE CROSBY',
    x: CENTRE_X,
    y: NAME_Y,
    window: fade(1654, 1698, 1703),
  },
  {
    id: 'c5',
    style: 'name',
    text: 'MICHAEL DORN',
    x: CENTRE_X,
    y: NAME_Y,
    window: fade(1719, 1764, 1769),
  },
  {
    id: 'c6',
    style: 'name',
    text: 'GATES McFADDEN',
    x: CENTRE_X,
    y: NAME_Y,
    window: fade(1786, 1830, 1835),
  },
  {
    id: 'c7',
    style: 'name',
    text: 'MARINA SIRTIS',
    x: CENTRE_X,
    y: NAME_Y,
    window: fade(1851, 1896, 1901),
  },
  {
    id: 'c8',
    style: 'name',
    text: 'BRENT SPINER',
    x: CENTRE_X,
    y: LOW_NAME_Y,
    window: fade(1918, 1962, 1967),
  },
  // Wheaton's fade-out is the measured fast drop as the flyover begins.
  {
    id: 'c9',
    style: 'name',
    text: 'WIL WHEATON',
    x: CENTRE_X,
    y: LOW_NAME_Y,
    window: fade(1983, 2028, 2031),
  },

  // Shot 08 — end cards. The second is three label/name pairs on the measured
  // rows (name centers y 0.2486, 0.5125, 0.8074).
  {
    id: 'e1',
    style: 'name',
    label: 'Executive Producer',
    text: 'GENE RODDENBERRY',
    x: CENTRE_X,
    y: NAME_Y,
    window: fade(2440, 2498, 2504, 6),
  },
  {
    id: 'e2a',
    style: 'name',
    label: 'Starship Model By',
    text: 'LOGANROLPHH',
    x: CENTRE_X,
    y: 0.2486,
    window: fade(2530, 2604, 2613, 10),
  },
  {
    id: 'e2b',
    style: 'name',
    label: 'Planet Textures By',
    text: 'NASA / USGS',
    x: CENTRE_X,
    y: 0.5125,
    window: fade(2530, 2604, 2613, 10),
  },
  {
    id: 'e2c',
    style: 'name',
    label: 'Engine By',
    text: 'INERTIALREF',
    x: CENTRE_X,
    y: 0.8074,
    window: fade(2530, 2604, 2613, 10),
  },

  /*
   * Shot 09 — the outro card, crediting the reference this was measured from.
   *
   * The label is one word because the *label* is what the blue mask measures.
   * A label rides its name's element flush left (see `CinematicTextState`), so
   * its length is a horizontal extent added to the right of the block, and the
   * reference's is eight characters — "Video By" over "JASON T", 0.166 of the
   * frame against the name's 0.215. Set "After The Recreation By" there instead
   * and the label alone spans 0.313 to 0.778: the card still *looks* centered,
   * but the measured blue centroid lands at 0.494 where the reference's is
   * 0.371, and every title-channel number for the shot is a measurement of the
   * caption rather than of the card.
   *
   * Worth naming because the plan blamed the accent for that 0.494 and the
   * accent was never in the mask. Splitting the mask by row band is what shows
   * it: the 0.778 right edge sits in the label's rows (0.370–0.434), not the
   * name's (0.467–0.541), and the gold reads out as its own band entirely.
   *
   * Marks are the reference's own. Its name spans 0.276–0.491, center 0.383;
   * ours renders 0.007 right of its authored center, so 0.376 puts it there.
   * The accent then clears the name's right edge with room to spare and its
   * far edge lands on the reference's 0.715.
   */
  {
    id: 'o1',
    style: 'name',
    label: 'Reference',
    text: 'JASON T',
    x: 0.3761,
    y: NAME_Y,
    window: fade(2637, 2700, 2712, 13),
  },
  {
    id: 'o1-accent',
    style: 'accent',
    // Gold, and therefore outside the blue band `detect_titles.py` masks on —
    // which is also true of the reference's, and is why the reference's own
    // measured centroid covers the blue words alone.
    text: '(JTVFX)',
    x: 0.61,
    y: NAME_Y,
    window: fade(2637, 2700, 2712, 13),
  },
]

/* ------------------------------------------------------------------------- */
/* The logo fly-in                                                            */
/* ------------------------------------------------------------------------- */

/**
 * The measured arrival of the two words.
 *
 * They enter already at speed from opposite sides — STAR from off the left
 * edge, TREK from off the upper right — converge on their marks and shrink
 * onto them. The block's measured width runs 1476 px at f1150 down to 1123 px
 * by f1161 and is still from f1162: 1.31× settling to 1.00 over eleven frames.
 * `arrival` is the curve that fits, and the same parameter drives the travel,
 * so the words are always the right size for where they are.
 *
 * Nothing here is a fade in disguise. The words are at full opacity from
 * f1136, which is why the tight color mask first sees them — dim, because
 * they are big and moving — five frames before it sees a stable block.
 */
const FLY_IN_START = 1134
const FLY_IN_FRAMES = 27
/**
 * Both words start at 2.25× their settled size. Measured: STAR's cap band is
 * 0.312 of the frame at f1137 against 0.155 settled, and TREK's 0.277 at f1140
 * against 0.159 — the same curve through both.
 */
const FLY_IN_SCALE = 2.246
/**
 * Where each word is thrown from, as an offset from its settled mark.
 *
 * Recovered from the *unclipped* edge of each word, not its centroid: both
 * run off the frame for the first ten frames, so a bounding box's center is a
 * measurement of where the frame ends. Reconstructing the center from the
 * visible edge and the frame's own scale gives STAR entering low-left from
 * (0.000, 0.791) and TREK high-right from (0.932, −0.006), and the residuals
 * against every tracked frame sit under 0.005.
 */
const FLY_IN_FROM: Readonly<Record<string, readonly [number, number]>> = {
  'logo-star': [-0.3725, 0.4417],
  'logo-trek': [0.2836, -0.4776],
}

interface Placement {
  readonly x: number
  readonly y: number
  readonly scale: number
}

function logoPlacement(spec: TitleSpec, frame: number): Placement {
  const from = FLY_IN_FROM[spec.id]
  if (from === undefined) return { x: spec.x, y: spec.y, scale: 1 }
  const t = arrival(FLY_IN_START, FLY_IN_FRAMES, frame)
  return {
    x: lerp(spec.x + from[0], spec.x, t),
    y: lerp(spec.y + from[1], spec.y, t),
    scale: lerp(FLY_IN_SCALE, 1, t),
  }
}

/* ------------------------------------------------------------------------- */
/* Ship choreography                                                          */
/* ------------------------------------------------------------------------- */

/** The range at which the hull covers `fraction` of the frame's width. */
const atWidth = (fraction: number): number =>
  rangeForWidth(HULL, fraction, FOV, ASPECT)

/*
 * The cruise shot's pass, read off the tracked bounding boxes. Screen
 * positions are box centers; ranges come from the box width through
 * `atWidth`, using the hull's length where it is broadside and its beam once
 * it is nose- or stern-on.
 *
 * The hull enters at the bottom-left *corner* — not as a dot dead ahead, which
 * is what the previous script did and what the analysis's prose had said. It
 * climbs across the frame growing slowly (f760 and f792 measure the same
 * width: it is barely closing), rushes in over the last sixty frames, fills
 * the frame at f976, and pulls away up-right rather than passing behind the
 * lens. That last part is why the camera does not need to track it: the ship
 * banks away on its own and stays in a frame that never moves.
 */
const SHIP_CRUISE: readonly ScreenBeat[] = [
  { frame: 676, x: 0.02, y: 1.16, range: atWidth(0.1) },
  { frame: 700, x: 0.09, y: 0.98, range: atWidth(0.17) },
  { frame: 730, x: 0.155, y: 0.85, range: atWidth(0.29) },
  { frame: 760, x: 0.203, y: 0.757, range: atWidth(0.401) },
  { frame: 792, x: 0.242, y: 0.691, range: atWidth(0.395) },
  { frame: 824, x: 0.278, y: 0.635, range: atWidth(0.438) },
  /*
   * The close pass, refit from the reference's own landmarks rather than from
   * its bounding box — because through this stretch the box is not a
   * measurement.
   *
   * Three things break it at once, and all three were being read as range.
   * The box is **truncated by the frame edge** (f876–896 on the left, then the
   * top); it **saturates** — 84 frames, f920–1051, sit at w ≥ 0.995 against all
   * four edges; and a *second component*, the far Bussard cap, flickers across
   * the tracker's 400-pixel floor and takes the box's left edge with it, which
   * is the whole of the f752 0.376 → f754 0.292 → f756 0.383 step that looked
   * like closing and was a filter threshold.
   *
   * What survives all three is the **pair of Bussard collectors**: a rigid
   * baseline whose two centroids stay interior and stay bright. Calibrated
   * where the caps read equal area (no yaw foreshortening) the separation is
   * 265.5 m, and an independent check agrees — the ratio of cap separation to
   * box width has a hard ceiling when the nacelle axis is square to the sight
   * line, and the measured ceiling of 0.5725 is exactly 265.5 / 463.7.
   *
   * 463.7 m, and that number is the other finding: **the reference's hull is
   * nose-on or bow-quarter in every pass, never broadside**, so the width of
   * its box is the saucer's disc and not the ship's length. Widths below are
   * therefore the reference's *measured* screen widths, spliced at f872 from
   * the box to the cap-pair's range ratio once the box stops being interior.
   *
   * Why `atWidth` still divides by `HULL` and not by the saucer: the render's
   * own effective width, measured as its tracked width times its authored
   * range over f700–890, is 618 m — near the hull's 642.5 — because our hull
   * is lit along its length where the reference's reads as a disc. Two errors
   * have been cancelling, which is exactly why the cruise entry scores +0.013.
   * Correcting one alone would break the best stretch in the piece. Both are
   * written down here so whoever unwinds them unwinds both.
   */
  { frame: 856, x: 0.317, y: 0.568, range: atWidth(0.54) },
  { frame: 872, x: 0.353, y: 0.512, range: atWidth(0.664) },
  { frame: 890, x: 0.35, y: 0.505, range: atWidth(0.758) },
  { frame: 904, x: 0.341, y: 0.497, range: atWidth(0.849) },
  { frame: 916, x: 0.327, y: 0.487, range: atWidth(0.945) },
  { frame: 928, x: 0.308, y: 0.471, range: atWidth(1.059) },
  { frame: 940, x: 0.294, y: 0.445, range: atWidth(1.161) },
  { frame: 952, x: 0.293, y: 0.408, range: atWidth(1.237) },
  /*
   * f956–1031 has no measurement at all: the hull spans the frame and the far
   * cap is behind the engineering hull, so both channels are gone. Authored by
   * continuity, on the one thing that is still measurable through it — the lit
   * mask's *area* fraction, which peaks at f985. That is closest approach.
   *
   * The shape is a rise and then a settle, not a climb. The mask centroid
   * rides low, y 0.61–0.65, from f956 to f1008, breaks upward at f1008,
   * overshoots to 0.34 at f1032 and comes back to 0.38–0.45 through f1090. The
   * previous authoring ran a monotone climb through the middle of that and
   * missed both ends of it — the depth of the low and the overshoot.
   */
  { frame: 966, x: 0.388, y: 0.613, range: atWidth(1.32) },
  { frame: 985, x: 0.415, y: 0.633, range: atWidth(1.4) },
  { frame: 1000, x: 0.413, y: 0.647, range: atWidth(1.36) },
  { frame: 1016, x: 0.443, y: 0.492, range: atWidth(1.24) },
  { frame: 1032, x: 0.489, y: 0.34, range: atWidth(1.1) },
  /*
   * Interior again from here, so these are measurements — of the **area
   * centroid**, which is the channel the diff scores and which is not the box's
   * centre. The two disagree by up to 0.15 of the frame across this stretch
   * (f1056: centroid 0.536, box centre 0.689) because the lit mass is not
   * centred on the hull, and authoring against the wrong one of them put the
   * exit 0.09 too far right and 0.12 too high in the capture.
   *
   * Widths carry a factor of 1.32, and that is a measurement too: at these
   * ranges the render's own lit mass reads about 0.76 of the apparent width the
   * beat asks for — the hull is close enough that only part of it is in frame
   * and lit — so an unscaled measured width renders a third narrower than the
   * reference's. It is the same `atWidth` length mismatch documented above,
   * measured at the other end of the pass, and the same rule applies: the two
   * are written down rather than folded into `HULL`, because folding either one
   * in alone breaks the far end.
   */
  { frame: 1044, x: 0.563, y: 0.386, range: atWidth(1.24) },
  { frame: 1056, x: 0.536, y: 0.421, range: atWidth(1.27) },
  { frame: 1064, x: 0.5, y: 0.442, range: atWidth(1.2) },
  { frame: 1072, x: 0.49, y: 0.452, range: atWidth(1.12) },
  { frame: 1080, x: 0.489, y: 0.454, range: atWidth(1.01) },
  /*
   * The handover to `WARP_OUT_1`, not a warp-out of its own — and it is a beat
   * of *this* list because a Catmull-Rom segment is shaped by the knot past
   * its far end.
   *
   * This used to be three knots hurling the hull down its own axis to
   * `atWidth(0.0008)` by f1120, on the reasoning that the shot ends at f1091
   * so they are never read. They are: they set the tangent of the f1080–1092
   * segment, which `cruise-close` renders in full. Sampled, that put the hull
   * at 432 m and w 1.010 at f1080 and at 17.4 km and w 0.025 by f1091 — an
   * entire warp-out flown in the clear, the first two frames of it before the
   * wash has left zero — and then the titles stage's own f1092 knot snapped it
   * back to 568 m and w 0.768. The ship warped out twice, twelve frames apart.
   *
   * One knot instead, and it is `WARP_OUT_1`'s own first beat repeated: the
   * two shots then agree about where the hull is on the frame they hand over
   * on, and f1081–1091 is the gentle recede from w 1.010 to w 0.768 the
   * reference measures rather than a collapse. Change one of the two and
   * change the other.
   */
  { frame: 1092, x: 0.365, y: 0.497, range: atWidth(0.768) },
]

/*
 * The first warp-out, in the *titles* stage's frame — and it has to be here,
 * not in `SHIP_CRUISE`, which is the bug this fixes.
 *
 * The cut to the titles stage lands at f1092, mid-flash. From that frame the
 * hull is driven by the titles shot's own route, and that route used to begin
 * at the first wipe's f1288 knot — so for the twenty-six frames of the
 * warp-out the hull simply held at the wipe's entry mark, a 0.012-wide dot at
 * (0.236, 0.593), motionless. Verified in the browser — `view.ship.position`
 * was byte-identical at f1092, f1096, f1100, f1106 and f1120.
 *
 * `SHIP_CRUISE`'s own exit beats were *not* the other half of this. They
 * belong to a shot that ends at f1091 — but a Catmull-Rom reads the knot past
 * the far end of a segment, so they flew a second, earlier warp-out across
 * f1081–1091 with `cruise-close` still on screen. They are one handover knot
 * now, and it is this list's own first beat repeated: change one and change
 * the other.
 *
 * The track is the reference's, frame by frame: centred and still under the
 * whiteout, then thrown to the lower right over eight frames and gone by
 * f1108. The reference means 0.4 from f1108 to f1118 — the frame is genuinely
 * empty between the ship leaving and the lens spike arriving — which is why
 * the visibility window closes at f1107 rather than carrying a dot through it.
 */
const WARP_OUT_1: readonly ScreenBeat[] = [
  { frame: 1092, x: 0.365, y: 0.497, range: atWidth(0.768) },
  { frame: 1097, x: 0.391, y: 0.5, range: atWidth(0.738) },
  { frame: 1099, x: 0.543, y: 0.519, range: atWidth(0.681) },
  { frame: 1102, x: 0.609, y: 0.541, range: atWidth(0.478) },
  { frame: 1104, x: 0.607, y: 0.575, range: atWidth(0.403) },
  { frame: 1106, x: 0.644, y: 0.684, range: atWidth(0.118) },
  { frame: 1107, x: 0.654, y: 0.701, range: atWidth(0.069) },
  { frame: 1112, x: 0.656, y: 0.702, range: atWidth(0.008) },
  { frame: 1120, x: 0.656, y: 0.702, range: atWidth(0.0008) },
]

/*
 * The fly-through wipe, in the reference's own numbers: the hull is 0.018 of
 * the frame wide when it appears at (0.239, 0.591), grows at a constant
 * fractional rate, and is 0.80 wide at f1316 — one frame before it covers the
 * lens. It leaves up and to the right.
 *
 * One recipe, three uses. Wipes one and three are the *same animation* 247
 * frames apart (their tracks agree to three decimal places); the middle one is
 * its mirror in x, entering at 0.761 and leaving up-left. Authoring it as one
 * function with an offset and a mirror flag is not a tidy-up — it is the
 * measurement.
 */
const WIPE: readonly ScreenBeat[] = [
  { frame: 1288, x: 0.236, y: 0.593, range: atWidth(0.012) },
  { frame: 1292, x: 0.239, y: 0.591, range: atWidth(0.018) },
  { frame: 1300, x: 0.257, y: 0.584, range: atWidth(0.057) },
  { frame: 1305, x: 0.279, y: 0.575, range: atWidth(0.103) },
  { frame: 1310, x: 0.324, y: 0.56, range: atWidth(0.198) },
  { frame: 1313, x: 0.389, y: 0.533, range: atWidth(0.318) },
  { frame: 1315, x: 0.483, y: 0.485, range: atWidth(0.531) },
  { frame: 1316, x: 0.584, y: 0.422, range: atWidth(0.798) },
  { frame: 1317, x: 0.72, y: 0.33, range: atWidth(1.5) },
  { frame: 1319, x: 1.15, y: 0.05, range: atWidth(3.2) },
  { frame: 1322, x: 2.1, y: -0.5, range: atWidth(1.2) },
]
/*
 * Frame offsets of the three wipes, and their measured occlusion frames.
 *
 * 126, not 128 — and this is a reference-against-reference measurement, so it
 * owes nothing to the render. Aligning the reference's own tracked boxes for
 * the second wipe against the first's, mirrored in x, they agree to a
 * thousandth on *every* frame at an offset of 126: (0.239, w 0.018) against
 * (0.239, 0.020), (0.264, 0.072) against (0.264, 0.067), (0.427, 0.394)
 * against (0.427, 0.393). At 128 the whole pass ran two frames early — the
 * mirror looked like a bad mirror when it was a perfect mirror on the wrong
 * beat, which is the kind of thing a signed per-band diff finds and a
 * worst-frames list hides.
 *
 * Wipes one and three at 247 reproduce to a thousandth as authored; that half
 * of the recipe was already right.
 */
const WIPE_OFFSETS = [0, 126, 247] as const
/**
 * The first wipe's measured occlusion frame. The other two are it plus their
 * own offsets — derived rather than retyped, because it is the same frame of
 * the same animation and the two tables must not be able to disagree. Moving
 * the second offset 128 → 126 meant moving 1445 → 1443 with it, by hand, which
 * is the failure this removes.
 */
const WIPE_OCCLUSION = 1317
const WIPE_OCCLUSIONS = [
  WIPE_OCCLUSION + WIPE_OFFSETS[0],
  WIPE_OCCLUSION + WIPE_OFFSETS[1],
  WIPE_OCCLUSION + WIPE_OFFSETS[2],
] as const

const shifted = (beat: ScreenBeat, offset: number): ScreenBeat => ({
  ...beat,
  frame: beat.frame + offset,
})
const mirrored = (beat: ScreenBeat, offset: number): ScreenBeat => ({
  frame: beat.frame + offset,
  x: 1 - beat.x,
  y: beat.y,
  range: beat.range,
})

/*
 * The return, and the beauty pass. The hull enters at the top edge at f1765
 * and descends through the last six credits — measured box centers and widths
 * again — then keeps coming until the camera is skimming its dorsal surface.
 * The bridge module crosses the frame around f2214, which fixes the tail of
 * the approach: the ship has to be within a hull-length by f2150 for the
 * saucer to read as terrain.
 */
const SHIP_RETURN: readonly ScreenBeat[] = [
  { frame: 1755, x: 0.44, y: -0.1, range: atWidth(0.01) },
  { frame: 1775, x: 0.462, y: 0.005, range: atWidth(0.06) },
  { frame: 1800, x: 0.462, y: 0.048, range: atWidth(0.0875) },
  { frame: 1830, x: 0.45, y: 0.094, range: atWidth(0.11) },
  { frame: 1860, x: 0.432, y: 0.14, range: atWidth(0.15) },
  { frame: 1890, x: 0.408, y: 0.2, range: atWidth(0.21) },
  { frame: 1920, x: 0.392, y: 0.287, range: atWidth(0.24) },
  { frame: 1960, x: 0.41, y: 0.359, range: atWidth(0.32) },
  /*
   * The late descent, refit on the same two channels as the close pass: the
   * box while it is interior, the Bussard cap pair's range ratio once it is
   * not, spliced at f2040. Past f2085 the box is clipped on the left and its
   * width pins near 1.0, so the last three beats come from the fitted line's
   * own advance profile — the reference's track over f1801–2095 is straight to
   * a perpendicular residual of 40 m over 800 m and strictly monotone, with no
   * backsteps, so extrapolating along it is a stronger statement than reading a
   * clipped box.
   *
   * The previous authoring reached full frame fifteen to twenty frames late:
   * signed width error −0.427 across f1990–2100, the largest number anywhere
   * in the piece.
   *
   * Two limits, both real. From ~f2075 the caps foreshorten as the hull yaws
   * into the skim (their area ratio goes 1.01 at f2070 to 1.27 at f2085), so
   * the cap channel under-reads the closing there as well. And the reference
   * accelerates hard through f2095–2150 — by f2150 the camera is on the
   * saucer's surface — which a straight line at this throttle does not contain.
   * The skim's own beats below carry that, authored rather than measured,
   * because the skim is not measurable at all: 217 of its 282 frames are
   * saturated and 273 of them touch a frame edge.
   */
  { frame: 1990, x: 0.413, y: 0.403, range: atWidth(0.433) },
  { frame: 2010, x: 0.397, y: 0.432, range: atWidth(0.473) },
  { frame: 2030, x: 0.378, y: 0.463, range: atWidth(0.546) },
  { frame: 2040, x: 0.368, y: 0.48, range: atWidth(0.576) },
  { frame: 2050, x: 0.429, y: 0.496, range: atWidth(0.608) },
  { frame: 2065, x: 0.483, y: 0.521, range: atWidth(0.666) },
  { frame: 2075, x: 0.357, y: 0.535, range: atWidth(0.673) },
  { frame: 2085, x: 0.353, y: 0.553, range: atWidth(0.709) },
  { frame: 2100, x: 0.339, y: 0.591, range: atWidth(0.735) },
  { frame: 2115, x: 0.337, y: 0.634, range: atWidth(0.761) },
  { frame: 2130, x: 0.335, y: 0.683, range: atWidth(0.85) },
  /*
   * The skim: close enough that the saucer is a landscape, drifting aft — and
   * no closer, because the previous ranges flew the camera *through* it.
   *
   * Solved against the hull's own geometry rather than chosen. Decoding the
   * glTF's vertex positions and reducing them to a per-column height field in
   * hull axes puts the camera inside the surface envelope for 48 frames,
   * f2234–2281, by up to 3.5 m, and within 1–4 m either side of that. What
   * that looks like is the saucer's interior: at f2188 the camera sits 8 m over
   * the dorsal plating with the engineering hull's battle bridge visible
   * *through* it, which is the shot reading as a modelling error rather than as
   * speed.
   *
   * The camera's elevation over the hull's own plane falls from 38° to 14°
   * across this stretch, so a grazing pass over a 467 m disc simply needs more
   * range: 190–210 m through f2180–2280 rather than 125–168. Widths below are
   * the smallest that clear the envelope by 40 m at every frame, which
   * `clears the hero hull's geometry at every frame it is on stage` asserts.
   * The reference cannot arbitrate the exact scale here — 217 of the skim's 282
   * frames are saturated and 273 touch a frame edge — so "the saucer fills the
   * frame" is the whole of what it says, and it still does.
   */
  { frame: 2180, x: 0.45, y: 0.74, range: atWidth(2.25) },
  { frame: 2230, x: 0.53, y: 0.74, range: atWidth(2.0) },
  { frame: 2280, x: 0.6, y: 0.73, range: atWidth(2.0) },
  { frame: 2330, x: 0.62, y: 0.66, range: atWidth(1.45) },
  /*
   * f2355 is a knot placed to stop an *undershoot*, not to stage anything. The
   * log-range Catmull-Rom between f2330 and f2380 was pulled down by its
   * neighbours far enough to dip the range from 301 m to 242 m in the middle of
   * a stretch that is supposed to be opening out, which put the camera back
   * within 11 m of the saucer's rim at f2352 — inside the margin, on a segment
   * where every authored knot is clear. Three knots make the tail monotone.
   */
  { frame: 2355, x: 0.61, y: 0.62, range: atWidth(1.1) },
  { frame: 2380, x: 0.6, y: 0.58, range: atWidth(0.9) },
  { frame: 2392, x: 0.55, y: 0.55, range: atWidth(0.02) },
  { frame: 2404, x: 0.5, y: 0.52, range: atWidth(0.002) },
  { frame: 2416, x: 0.48, y: 0.51, range: atWidth(0.0004) },
]

/**
 * Where the hull points, as a direction in *camera* axes.
 *
 * Authored rather than derived: a finite difference of the world path gives
 * the camera's own heading whenever the two share a frame, and the reference
 * plainly shows the hull nose-on to the lens through the whole approach.
 * Levelling against the camera's up is what makes the top/underside views come
 * out right for free — a level ship below the frame's center shows its dorsal,
 * above it shows its belly, which is exactly what the reference does at f820
 * and f892.
 */
interface FacingBeat {
  readonly frame: number
  readonly forward: Vec3
  readonly bankDeg?: number
  /**
   * Nose-down pitch relative to the derived frame, degrees.
   *
   * The overlay `TNG-PLAN` §5.2 asks for, and it is needed because a fitted
   * line gives the hull's **flight path**, not its attitude, and here the two
   * differ. The reference's hull climbs the frame through the cruise while the
   * camera plainly looks down on the saucer's top — lit window rows, nacelles
   * and their red collectors below it, in every frame from f760 to f916. A ship
   * whose nose follows a climbing velocity vector shows a camera it is climbing
   * toward its *belly* instead; measured, `dot(toCamera, dorsal)` ran −0.09 to
   * −0.36 across the whole approach once the fitted direction went in. So the
   * reference flies its ship nose-down along a climbing path. That is a real
   * attitude, not an error, and it is exactly what has to be authored on top of
   * a derived frame rather than derived from it.
   */
  readonly pitchDeg?: number
}

/*
 * Forward vectors are now *fits*, not judgments, wherever the reference flies
 * straight — the direction of a least-squares line through the tracked
 * Bussard-cap midpoints, in camera axes. That is `orientationAlong` by hand:
 * for a straight pass the derived attitude is constant, so the beat list holds
 * one vector across the whole pass and sliding is impossible by construction.
 * Banks stay authored, because the reference really does roll.
 *
 * What the fits corrected:
 *
 * - The **cruise approach** was authored at (0.26, 0.02, 0.96) and fits
 *   (0.464, 0.408, 0.787) — 24° out, and out in the channel that shows: the
 *   hull climbs the frame from y 1.16 to y 0.43 while its nose pointed level.
 * - The **credit descent** was authored at (−0.02, 0.30, 0.95) and fits
 *   (−0.039, −0.605, 0.796) — 57° out, with **the wrong sign in y**. The hull
 *   descends 0.6 of the frame over 340 frames with its nose tipped up: flying
 *   backwards down its own track, which is precisely the "sliding" read.
 * - The **wipes** were authored nose-down at (0.06, −0.20, 0.98) and fit
 *   (0.369, 0.074, 0.926) — essentially level, and the three wipes' own fits
 *   agree with each other to 0.22°. The old comment argued the hull must be
 *   diving because its dorsal is lit; a level hull below the frame's centre
 *   shows its dorsal too, which is the simpler explanation and the measured
 *   one.
 *
 * **Each vector's uncertainty, because the tests are held to it.** A direction
 * fitted to the cap-pair midpoints and one fitted to the lit-mass box centre
 * are not the same line, and their spread is the honest error bar: **6.8° on
 * the cruise**, **15.0° on the descent**, **0.22° on the wipes** (that last is
 * the three wipes' own fits against each other, which is why the wipes are the
 * pass this can be asserted tightly on). Those three numbers are the bounds in
 * `cutscene.test.ts`'s flight-dynamics properties; change a vector and the
 * spread it was fitted with has to move with it.
 *
 * The roll and yaw census also moves the bank-away: cap-pair screen angle and
 * cap area ratio both break from their approach values at **f880–900**, not
 * f976. Roll runs 0° at f704 to −25.5° by f958, at up to 0.656°/frame. The
 * descent by contrast rolls 0.26° in total across 280 frames — dead straight
 * and unrolled, which is why one beat covers all of it.
 */
/**
 * How far the reference's hull noses down against its own climbing track.
 *
 * Solved rather than chosen: swept against `dot(toCamera, dorsal)` over
 * f700–930 until the camera is on the lit side of the saucer everywhere in the
 * approach, which is the one thing the reference's frames state without
 * ambiguity.
 */
const PITCH_CRUISE = -34

const FACING_CRUISE: readonly FacingBeat[] = [
  { frame: 676, forward: vec3(0.464, 0.408, 0.787), pitchDeg: PITCH_CRUISE },
  {
    frame: 800,
    forward: vec3(0.464, 0.408, 0.787),
    bankDeg: -10,
    pitchDeg: PITCH_CRUISE,
  },
  // The bank-away starts here, 80-100 frames earlier than it was authored.
  {
    frame: 880,
    forward: vec3(0.42, 0.4, 0.81),
    bankDeg: -18,
    pitchDeg: PITCH_CRUISE,
  },
  {
    frame: 930,
    forward: vec3(0.2, 0.34, 0.92),
    bankDeg: -23,
    pitchDeg: PITCH_CRUISE,
  },
  { frame: 985, forward: vec3(-0.25, 0.2, 0.95), bankDeg: -25 },
  { frame: 1035, forward: vec3(-0.62, -0.15, -0.77), bankDeg: -20 },
  { frame: 1120, forward: vec3(-0.6, -0.14, -0.79) },
]

const FACING_TITLES: readonly FacingBeat[] = [
  /*
   * The cruise's exit attitude, carried across the f1092 cut.
   *
   * `routeOrientation` holds its first beat before that beat's frame, so a
   * list starting at f1280 pinned the warp-out hull to the *wipes'* heading —
   * which points back down the lens. Measured: the attitude snapped 164.40° in
   * the single frame f1091→f1092 and the nose then sat 87°–169° off its own
   * velocity for every frame of `WARP_OUT_1`, on a hull three-quarters of the
   * frame wide. A ship flying tail-first out of its own warp point is the
   * defect this pass exists to remove, one shot along.
   *
   * These two beats are `FACING_CRUISE`'s last two, repeated verbatim.
   * `routeOrientation` slerps inside a segment and takes nothing from the
   * neighbours, so the same pair of endpoints gives the same attitude at every
   * frame of f1035–1120 in either list, and the cut is exact rather than
   * close. The swing from here to the wipes' heading happens across
   * f1120–1280, with the hull off stage from f1108.
   */
  { frame: 1035, forward: vec3(-0.62, -0.15, -0.77), bankDeg: -20 },
  { frame: 1120, forward: vec3(-0.6, -0.14, -0.79) },
  /*
   * The wipes' fitted heading — and the middle one's is mirrored, because its
   * *track* is.
   *
   * One forward vector used to cover all three passes while `mirrored()`
   * reflected only the beats, so the middle hull flew the mirrored track on the
   * unmirrored heading: nose 43.3° off its own velocity for thirty-five frames,
   * which reads as a ship crabbing sideways across the frame. A property test
   * now holds every straight pass's nose to its chord and this is what it
   * found.
   *
   * Reflecting in x negates the direction's x and nothing else. It would also
   * flip the sign of an authored bank — a mirrored frame's right axis is
   * negated — but the wipes carry none, so there is nothing to flip. The swings
   * between these four beats all happen while the hull is off stage
   * (`SHIP_WINDOWS` has gaps at f1324–1413 and f1452–1533), so nothing on
   * screen ever turns.
   */
  { frame: 1280, forward: vec3(0.369, 0.074, 0.926) },
  { frame: 1330, forward: vec3(0.369, 0.074, 0.926) },
  { frame: 1408, forward: vec3(-0.369, 0.074, 0.926) },
  { frame: 1452, forward: vec3(-0.369, 0.074, 0.926) },
  { frame: 1530, forward: vec3(0.369, 0.074, 0.926) },
  { frame: 1570, forward: vec3(0.369, 0.074, 0.926) },
  // The hull is off stage f1571-1757, so this swing is never on screen.
  { frame: 1758, forward: vec3(-0.039, -0.605, 0.796) },
  { frame: 2092, forward: vec3(-0.039, -0.605, 0.796) },
  // Into the skim, where the reference rolls +11.3° over f2315-2380.
  { frame: 2180, forward: vec3(-0.2, -0.4, 0.89), bankDeg: 4 },
  { frame: 2280, forward: vec3(-0.3, -0.2, 0.93), bankDeg: 8 },
  { frame: 2380, forward: vec3(-0.42, -0.1, 0.9), bankDeg: 11 },
  { frame: 2420, forward: vec3(-0.42, -0.1, 0.9), bankDeg: 11 },
]

/*
 * `lookAlong(forward, POLE)` is `orientationAlong` for a straight pass — a
 * line's derived attitude is constant and depends on nothing but its direction
 * — and `withAttitude` is the sparse overlay on top of it. Composed in that
 * order the previously authored bank angles are numerically unchanged.
 */
const facingBeats = (list: readonly FacingBeat[]): AimBeat[] =>
  list.map((beat) => ({
    frame: beat.frame,
    orientation: withAttitude(
      lookAlong(beat.forward, POLE),
      beat.bankDeg ?? 0,
      beat.pitchDeg ?? 0,
    ),
  }))

/** Ship visibility windows, frames inclusive. */
const SHIP_WINDOWS: readonly (readonly [number, number])[] = [
  // Measured: the reference means 0.4 from f1108 to f1118 — nothing on screen
  // between the ship leaving and the lens spike arriving at f1119.
  [676, 1107],
  [1286, 1323],
  [1414, 1451],
  [1534, 1570],
  [1758, 2422],
]

/* ------------------------------------------------------------------------- */
/* The shot list                                                              */
/* ------------------------------------------------------------------------- */

/**
 * One shot: a camera, an aim, and optionally a hull, all local to it.
 *
 * Shots are searched last-to-first, so a later entry covering the same frames
 * plays *over* an earlier one — which is how the six-frame cutaway inside the
 * eclipse is expressed without cutting the eclipse into two shots that have to
 * agree about where the camera was.
 */
interface Shot {
  readonly id: string
  readonly from: number
  readonly to: number
  readonly camera: readonly RouteBeat[]
  readonly aim: readonly AimBeat[]
  /** Camera-relative choreography, in frame terms. */
  readonly ship?: readonly ScreenBeat[]
  /** Hull facing, in camera axes. */
  readonly facing?: readonly AimBeat[]
}

interface Stage {
  readonly shots: readonly Shot[]
}

/**
 * The edit, as frame ranges. One table, read by the shot builder *and* by the
 * tests, so a boundary cannot drift out of agreement with the assertion that
 * checks it.
 *
 * Contiguous. Where each cut hides: f240 is the composition-matched match cut,
 * f357/f413/f532 land in empty starfield, and f1092 and f2393 sit at full
 * flash.
 */
const CUTS = {
  earth: [0, 239],
  eclipse: [240, 356],
  jupiter: [357, 412],
  saturn: [413, 531],
  cruise: [532, 947],
  /*
   * f948, not f938. The relight is a *consequence* of which face the camera can
   * see, so it has to sit where that flips — and correcting the hull's attitude
   * to the fitted flight path moved the crossing. Measured on the sample,
   * `dot(toCamera, dorsal)` runs +0.102 at f940 and −0.059 at f950: the camera
   * is still looking at the lit dorsal for ten frames after the old cut, so the
   * key used to swing under the ship while the top of it was still the thing on
   * screen. The hull is wider than the lens throughout, so the cut is hidden
   * either way.
   */
  'cruise-close': [948, 1091],
  titles: [1092, 2392],
  'end-cards': [2393, DURATION],
} as const satisfies Record<string, readonly [number, number]>

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
  const mars = require('Mars')
  const jupiter = require('Jupiter')
  const saturn = require('Saturn')

  /** A standoff in the body's own frame: distance in radii, phase, elevation. */
  const shot = (
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

  const at = (
    body: Body,
    position: UniverseVector,
    distanceRadii: number,
    phaseDeg: number,
    elevationDeg: number,
  ): UniverseVector => {
    const toStar = Vec.normalize(UV.difference(sun, position))
    const placement = placeShot(
      shot(distanceRadii, phaseDeg, elevationDeg),
      body.radius,
      toStar,
    )
    return UV.translate(position, placement.position)
  }

  /* ------------------------- Shot: Earth, f125–239 ---------------------- */

  /*
   * A low sweep, not a framed disk: the reference's limb slashes down the
   * frame from top-right to bottom-left with terrain filling everything to its
   * right, and the pull-back only closes the disk in the last third. It ends on
   * the composition the f240 cut answers — disk centered (0.634, 0.555) at 4.30
   * radii with the star 15.7° away, 2.3° outside the left limb.
   *
   * A previous pass here recorded that the reference was physically
   * self-contradictory — broadly lit terrain *and* a sun in frame beside the
   * planet — and ramped the phase from 78° as the honest compromise. That
   * finding was wrong, and it was wrong because of how the sun's clearance had
   * been measured: from the sprite to the lit mask's leftmost *bounding-box*
   * corner, which sits at the box's mid height rather than on the limb, and
   * which reads 7.2° when the true clearance is 16.7°. Fitting the visible limb
   * arc as a cone instead — a sphere's limb is a cone about the body direction,
   * so least squares over ~270 boundary points recovers the angular radius and
   * with it the standoff, on every frame and not just the one unclipped one —
   * gives a track that is smooth, well conditioned (residuals 0.26–0.42° from
   * f140 to f200) and, crucially, *self-consistent*:
   *
   *   f140  1.20 radii  phase 107°     f190  1.59  126°
   *   f150  1.22        phase 108°     f200  1.80  132°
   *   f160  1.25        phase 111°     f210  1.90  135°
   *   f170  1.31        phase 114°     f230  ~3.5  ~157°
   *   f180  1.40        phase 119°     f239  4.90  161°
   *
   * Rendered as a Lambert sphere plus a flat night-side term, that geometry
   * reproduces the reference's own frame luminance to within ±2.6 across
   * f140–f200 (41.6 → 20.4 measured, 44.0 → 19.9 predicted). There is no
   * contradiction to work around; there was a bad ruler.
   *
   * So the phase is not authored against the exposure — it is *derived* from
   * the two screen marks. Fix where the star is and where the disk's center is
   * and the elongation between them is fixed, and phase = 180° − elongation.
   * The star's mark, the limb's angle and the frame's brightness are one
   * variable, and the numbers below are that variable read off the reference
   * rather than three knobs tuned against each other.
   */
  const earthPos = positionOf(earth)
  const earthShot: Shot = (() => {
    /*
     * Standoff from the cone fit; phase from the pair of marks below. The
     * center's mark runs off the bottom-right corner for the first half of the
     * shot — that is not a mistake, it is what a camera 0.2 radii above the
     * terrain sees, and `frameTwoTargets` is happy to aim at a target the
     * frame does not contain.
     */
    const e125 = at(earth, earthPos, 1.19, 105.4, 4)
    const e150 = at(earth, earthPos, 1.22, 108.4, 4.5)
    const e175 = at(earth, earthPos, 1.35, 116.4, 5)
    const e200 = at(earth, earthPos, 1.8, 132.4, 5.5)
    const e222 = at(earth, earthPos, 2.55, 148.5, 6)
    const e239 = at(earth, earthPos, 4.3, 164.3, 6)
    /*
     * The star is the *primary* target on every knot but the last. Both land
     * when the standoff gives the pair the separation the marks ask for, which
     * is how these were solved — but the star's mark is a sprite centroid read
     * straight off a pixel, while the disk's center is extrapolated from a limb
     * that is three-quarters off-frame, so the star is the one to trust with
     * the exact placement. It is also the one that sets the roll: `frameTarget`
     * takes its roll from `POLE` alone, which is what left the render's limb
     * ~50° off the reference's, the largest orientation error in the sequence.
     */
    const pair = (
      from: UniverseVector,
      star: readonly [number, number],
      disk: readonly [number, number],
    ): Quat =>
      frameTwoTargets(
        from,
        { at: sun, x: star[0], y: star[1] },
        { at: earthPos, x: disk[0], y: disk[1] },
        FOV,
        ASPECT,
      )
    return {
      id: 'earth',
      from: CUTS.earth[0],
      to: CUTS.earth[1],
      camera: [
        { frame: 125, position: e125 },
        { frame: 150, position: e150 },
        { frame: 175, position: e175 },
        { frame: 200, position: e200 },
        { frame: 222, position: e222 },
        { frame: 239, position: e239 },
      ],
      aim: [
        // f125's marks are the f140–f150 track run back four frames; the
        // reference is still fading up out of black there and its sprite does
        // not clear the detector's floor until f140.
        { frame: 125, orientation: pair(e125, [0.081, 0.374], [0.995, 1.49]) },
        { frame: 150, orientation: pair(e150, [0.118, 0.381], [0.989, 1.394]) },
        { frame: 175, orientation: pair(e175, [0.182, 0.396], [0.938, 1.186]) },
        { frame: 200, orientation: pair(e200, [0.278, 0.416], [0.826, 0.884]) },
        { frame: 222, orientation: pair(e222, [0.378, 0.435], [0.732, 0.716]) },
        /*
         * Both marks, because the f240 cut lands invisibly only if the two
         * sides agree on the star *and* the disk; eyeballing a roll gets one.
         * This is the one knot with the *disk* primary, and it is deliberate:
         * the eclipse's f240 camera is built to put Mars's center on exactly
         * this mark, so the cut is invisible when the two disks agree, and a
         * knot whose primary is the star would spend the pair's residual on
         * the disk instead. The reference's own f239 says 4.90 radii and phase
         * 161° where this stands at 4.30 and 164.3° — a 14% larger disk and
         * 3.5° more separation. Held at 4.30 because the eclipse side is
         * built from the same numbers and the seam matters more here than the
         * last frame's diameter does.
         */
        {
          frame: 239,
          orientation: frameTwoTargets(
            e239,
            { at: earthPos, x: 0.634, y: 0.555 },
            { at: sun, x: 0.455, y: 0.435 },
            FOV,
            ASPECT,
          ),
        },
      ],
    }
  })()

  /* ------------------------ Shot: the eclipse, f240–356 ------------------ */

  /*
   * A signed sweep across the anti-sun axis: `swing` positive puts the sun off
   * the planet's left limb, negative off its right, and zero is totality.
   * `placeShot`'s phase angle is unsigned and cannot express the crossing, so
   * these standoffs are built by hand in a sun-line basis.
   *
   * The measured schedule: 15.7° of separation at f240 with the disk 13.4°
   * across, so the star sits 2.3° clear of the limb; zero at f272 with the
   * disk down to 9.6°; then out the other side as the camera keeps pulling
   * away. Angular radius α and standoff k are the same statement, k = 1/sin α,
   * which is what lets a measured pixel diameter fix a camera position.
   */
  const marsPos = positionOf(mars)
  const eclipseShot: Shot = (() => {
    const toSunE = Vec.normalize(UV.difference(sun, marsPos))
    const east = (() => {
      const horizontal = Vec.cross(POLE, toSunE)
      return Vec.length(horizontal) > 1e-6
        ? Vec.normalize(horizontal)
        : Vec.normalize(Vec.cross(vec3(1, 0, 0), toSunE))
    })()
    const poleward = Vec.cross(toSunE, east)
    const cam = (
      swingDeg: number,
      liftDeg: number,
      radii: number,
    ): UniverseVector => {
      const swing = (swingDeg * Math.PI) / 180
      const lift = (liftDeg * Math.PI) / 180
      const direction = Vec.normalize(
        Vec.add(
          Vec.add(
            Vec.scale(toSunE, -Math.cos(swing) * Math.cos(lift)),
            Vec.scale(east, Math.sin(swing) * Math.cos(lift)),
          ),
          Vec.scale(poleward, Math.sin(lift)),
        ),
      )
      return UV.translate(marsPos, Vec.scale(direction, radii * mars.radius))
    }
    /*
     * The standoff schedule is measured, and it is violent. The disk's height
     * in the reference frames inverts straight to a distance — k = 1/sin α —
     * and gives 4.3 radii at f240, 6.0 at totality, then 12 by f276, 17 by
     * f280, 24 by f284 and 32 by f288. The eclipse ends and the camera leaves
     * at a rate nothing physical would: sixteen frames take it from six planet
     * radii to thirty-two. Reproduced rather than smoothed, because that
     * acceleration *is* the shot — it is what makes the eclipse feel like
     * something the camera fell through rather than parked at.
     */
    const p240 = cam(15.7, 2.2, 4.3)
    const p256 = cam(9.0, 1.8, 4.9)
    const p272 = cam(0, 0.9, 6.0)
    const p276 = cam(-2.2, 0.8, 12)
    const p280 = cam(-3.6, 0.7, 17)
    const p288 = cam(-5.2, 0.6, 32)
    const p300 = cam(-6.4, 0.4, 45)
    const p320 = cam(-8.0, 0.2, 62)
    const p340 = cam(-9.4, 0, 78)
    const p356 = cam(-10.4, 0, 92)
    const pair = (
      from: UniverseVector,
      planet: readonly [number, number],
      star: readonly [number, number],
    ): Quat =>
      frameTwoTargets(
        from,
        { at: marsPos, x: planet[0], y: planet[1] },
        { at: sun, x: star[0], y: star[1] },
        FOV,
        ASPECT,
      )
    return {
      id: 'eclipse',
      from: CUTS.eclipse[0],
      to: CUTS.eclipse[1],
      camera: [
        { frame: 240, position: p240 },
        { frame: 256, position: p256 },
        { frame: 272, position: p272 },
        { frame: 276, position: p276 },
        { frame: 280, position: p280 },
        { frame: 288, position: p288 },
        { frame: 300, position: p300 },
        { frame: 320, position: p320 },
        { frame: 340, position: p340 },
        { frame: 356, position: p356 },
      ],
      aim: [
        { frame: 240, orientation: pair(p240, [0.634, 0.555], [0.455, 0.435]) },
        { frame: 256, orientation: pair(p256, [0.56, 0.53], [0.475, 0.46]) },
        // Totality: the two targets are one direction and TRIAD degenerates,
        // so the disk alone sets the frame.
        {
          frame: 272,
          orientation: frameTarget(
            p272,
            { at: marsPos, x: 0.499, y: 0.51 },
            FOV,
            ASPECT,
            POLE,
          ),
        },
        { frame: 288, orientation: pair(p288, [0.44, 0.46], [0.49, 0.46]) },
        { frame: 300, orientation: pair(p300, [0.38, 0.43], [0.43, 0.43]) },
        { frame: 320, orientation: pair(p320, [0.27, 0.42], [0.32, 0.42]) },
        { frame: 356, orientation: pair(p356, [0.05, 0.44], [0.1, 0.44]) },
      ],
    }
  })()

  /*
   * The reference's f254–259 foreground pass is deliberately NOT reproduced.
   *
   * It cuts a huge body across the frame from the bottom right while the
   * eclipse plays on behind it, and it cannot be staged here — twice over.
   * The geometry: the eclipse camera sits on Mars's anti-sun line at 14,600 to
   * 71,000 km, the only bodies in reach are Phobos and Deimos at 11 km and
   * 6 km across, and a camera close enough to either for it to cover half the
   * frame is twenty thousand kilometers off the line that *is* the shot.
   *
   * A seven-frame cutaway to Venus's limb was tried in its place, and the
   * capture loop is what killed it: the reference's body means 7–19 across the
   * frame — a dark, barely-lit limb — while Venus at a lit phase came out at
   * 97, and the reference keeps the eclipse pair on screen throughout while a
   * cutaway by definition cannot. A cut that loses the subject for a third of
   * a second reads as a glitch, not a beat. The eclipse now runs f240–356
   * unbroken, which is also what the reference's own `content_val` says it is:
   * a five-frame motion hump, not a cut.
   */

  /* ------------------- Shot: the gas giants, f357–531 -------------------- */

  /*
   * Both are close passes, not framings: at f382 Jupiter's limb crosses the
   * frame at x≈0.63 with the terminator still inside the right edge, which is
   * a camera about 1.7 radii out, and at f432 Saturn fills the frame with its
   * rings running off the lower-left corner. The previous script stood off at
   * 5–6 radii and rendered both as marbles. Each shot opens on empty sky —
   * seventeen dark frames before Jupiter arrives, which is where the cut from
   * the eclipse hides.
   */
  const jupiterPos = positionOf(jupiter)
  const jupiterShot: Shot = (() => {
    /*
     * Phase near 100°, not 50°: the reference's limb at f382 sits at x≈0.63
     * with lit cloud to its *right* fading to a terminator at x≈0.94, which
     * means the star is off the left edge and the sub-camera point is already
     * past the terminator. Standing on the day side mirrors the whole shot —
     * the first pass at this rendered a planet lit from frame right with its
     * dark side at the limb, which is the same picture backwards.
     */
    const j357 = at(jupiter, jupiterPos, 6.5, 88, 12)
    const j374 = at(jupiter, jupiterPos, 2.9, 96, 10)
    const j382 = at(jupiter, jupiterPos, 1.75, 102, 8)
    const j400 = at(jupiter, jupiterPos, 2.4, 116, 5)
    const j412 = at(jupiter, jupiterPos, 4.6, 128, 2)
    const aimAt = (from: UniverseVector, x: number, y: number): Quat =>
      frameTarget(from, { at: jupiterPos, x, y }, FOV, ASPECT, POLE)
    return {
      id: 'jupiter',
      from: CUTS.jupiter[0],
      to: CUTS.jupiter[1],
      camera: [
        { frame: 357, position: j357 },
        { frame: 374, position: j374 },
        { frame: 382, position: j382 },
        { frame: 400, position: j400 },
        { frame: 412, position: j412 },
      ],
      aim: [
        { frame: 357, orientation: aimAt(j357, 1.55, 0.3) },
        { frame: 374, orientation: aimAt(j374, 1.1, 0.4) },
        { frame: 382, orientation: aimAt(j382, 1.02, 0.46) },
        { frame: 400, orientation: aimAt(j400, 0.45, 0.62) },
        { frame: 412, orientation: aimAt(j412, -0.05, 0.78) },
      ],
    }
  })()

  const saturnPos = positionOf(saturn)
  const saturnShot: Shot = (() => {
    /*
     * A flyby, and the standoff schedule is a fit rather than a taste.
     *
     * The reference's subject bounding box, measured on the frames where it is
     * not clipped by an edge, gives the planet-and-rings angular span: 50.4° at
     * f426, 42.3° at f428, 35.9° at f430, 20.9° at f440, 16.6° at f445, 14.0°
     * at f450, 10.4° at f460. Distance runs as 1/tan(half-span), which puts
     * **closest approach near 2.4 radii at f425** — a fast flyby, not the
     * hover the previous schedule described.
     *
     * The pass is a straight line at a *varying* speed, and the asymmetry is
     * measured rather than convenient: matching the reference's tracked width
     * frame by frame needs 0.17 radii per frame closing and about 0.09 opening.
     * A constant-velocity line reproduces the approach and then leaves too
     * fast — captured at v = 0.20 throughout, f445 meant 8.1 against the
     * reference's 15.5 and f460 meant 3.1 against 7.7. Fixed direction,
     * throttled, which is what the plan's §4 finds in every ship pass too.
     *
     * The previous schedule stood closest at f432–440 rather than f425 and then
     * hung there, and the capture is what showed it: at f420 the reference means
     * 91.1 against the render's 34.3, and at f450 the reference means 11.8
     * against the render's 39.0. Too dim at the peak and too bright for the next
     * second, both from one error — the pass was arriving eight frames late and
     * then not leaving. Neither is an exposure problem; a planet flying past on
     * the wrong schedule is dim when the reference is bright and bright when the
     * reference is dark. It is also the case a mean-absolute summary cannot
     * see: over f413–470 the old schedule scored a respectable +3.1 of exposure
     * error, because −26.5 across the entry and +18.7 across the exit cancel.
     *
     * Phase stays near quadrature, which is what the reference's f432 shows: the
     * terminator runs down x≈0.60 with the lit half to its left. It opens a
     * little more slowly than before so the peak frames carry more light.
     *
     * Elevation is doing a second job now — it is the only handle on the ring
     * opening, because `placeShot` swings the camera in a basis around the sun
     * line and how far that lands out of Saturn's equatorial plane is what sets
     * how wide the rings read. The reference's rings are nearly edge-on through
     * the approach (a line at f425, moderately open by f445), and the render's
     * ran 11° open at the cut and 31° by f440. Held shallower early, they open
     * on roughly the reference's schedule.
     *
     * Measured over f413–470, captured: mean |Δcx| 0.036 → 0.029, |Δcy| 0.038 →
     * 0.016, |Δwidth| 0.110 → 0.093, exposure −26.5/+18.7 entry/exit → −14.4/−1.1.
     *
     * **Two things this shot cannot match, and both are physics.** Saturn sits
     * at 9.5 AU against Jupiter's 5.2, so it receives 30% of the light — the
     * render is dim at the peak (53–74 against the reference's 91) because it is
     * lit correctly, while the reference lights its Saturn like its Jupiter. And
     * the ring system reads: closer than ~2.5 radii ours spans the whole frame
     * where the reference's barely registers, so the width error concentrates
     * entirely in the entry (|Δwidth| 0.219 there against 0.027 on the exit).
     * Standing far enough back to match the width costs another 9 of exposure,
     * which is the trade this schedule declines.
     */
    const s413 = at(saturn, saturnPos, 3.13, 66, -4)
    const s417 = at(saturn, saturnPos, 2.56, 70, -7)
    const s421 = at(saturn, saturnPos, 2.2, 74, -10)
    const s425 = at(saturn, saturnPos, 2.1, 78, -13)
    const s430 = at(saturn, saturnPos, 2.35, 81, -16)
    const s440 = at(saturn, saturnPos, 3.1, 86, -20)
    const s460 = at(saturn, saturnPos, 5.0, 95, -25)
    const s500 = at(saturn, saturnPos, 8.9, 110, -30)
    const s531 = at(saturn, saturnPos, 12.2, 120, -32)
    const aimAt = (from: UniverseVector, x: number, y: number): Quat =>
      frameTarget(from, { at: saturnPos, x, y }, FOV, ASPECT, POLE)
    /*
     * Aim marks are the reference's own area-weighted subject centroids —
     * (0.967, 0.889) at f413, (0.807, 0.567) at f417, (0.719, 0.534) at f421,
     * (0.675, 0.521) at f425, (0.467, 0.498) at f430, (0.287, 0.436) at f440,
     * (0.108, 0.362) at f460, (0.022, 0.320) at f480 — pushed right and down at
     * the entry because at f413 the reference is a 0.095-wide ring sliver in the
     * bottom-right corner, so its centroid is a measurement of the corner and
     * not of where the planet is.
     */
    return {
      id: 'saturn',
      from: CUTS.saturn[0],
      to: CUTS.saturn[1],
      camera: [
        { frame: 413, position: s413 },
        { frame: 417, position: s417 },
        { frame: 421, position: s421 },
        { frame: 425, position: s425 },
        { frame: 430, position: s430 },
        { frame: 440, position: s440 },
        { frame: 460, position: s460 },
        { frame: 500, position: s500 },
        { frame: 531, position: s531 },
      ],
      aim: [
        { frame: 413, orientation: aimAt(s413, 1.5, 0.98) },
        { frame: 417, orientation: aimAt(s417, 0.95, 0.62) },
        { frame: 421, orientation: aimAt(s421, 0.8, 0.56) },
        { frame: 425, orientation: aimAt(s425, 0.7, 0.53) },
        { frame: 430, orientation: aimAt(s430, 0.55, 0.51) },
        { frame: 440, orientation: aimAt(s440, 0.35, 0.45) },
        { frame: 460, orientation: aimAt(s460, 0.15, 0.37) },
        { frame: 500, orientation: aimAt(s500, 0.02, 0.32) },
        { frame: 531, orientation: aimAt(s531, -0.04, 0.3) },
      ],
    }
  })()

  /* --------------------- Shot: the cruise, f532–1091 --------------------- */

  /*
   * The camera does not move. The starfield sits on the star shell, so
   * translation moves nothing in frame and only rotation would; the hull is
   * authored camera-relative anyway. A static camera is therefore not a
   * simplification but the *accurate* description of what the reference shows
   * — and it is what makes "never track a hull crossing meters from the lens"
   * free rather than a discipline.
   *
   * Light is staging, and this is the shot that proves it: the hull has to be
   * lit full-face through a 400-frame approach, so the camera looks *down-sun*
   * with the star up and behind. −0.62 along the sun line keeps it well
   * outside a 45° field — the frame's half-diagonal is 41° — while still
   * throwing the key over the camera's shoulder; the poleward and lateral
   * terms put it up and to the left, which is where the reference's key
   * plainly is. The saucer's port rim is the brightest thing in f820.
   */
  /**
   * The cruise camera, twice: once keyed over the top and once from below.
   *
   * The reference lights the hull's *dorsal* through the approach — f820's
   * brightest object is the saucer's top surface — and its *ventral* through
   * the close pass, where f960 and f990 are a lit underside with the deflector
   * ring and the rim's window rows. One directional light cannot do both, and
   * a captured render is what forced the issue: keyed overhead throughout, the
   * close pass meant 6–14 against the reference's 40–59, and no amount of
   * reframing moved it, because the problem was never the framing.
   *
   * So it relights, which is what the reference must itself have done. The cut
   * sits at f948 — the first frame where the hull is wider than the lens, and
   * the frame by which the reference has already swung its key under the
   * ship — the same place this piece hides every other cut. Camera position and hull choreography are
   * identical across it; only the key swings from 0.9 poleward to 0.9 the
   * other way, and the starfield that rotates with it is behind a wall of
   * spaceship.
   */
  const cruiseShot = (
    id: string,
    from: number,
    to: number,
    poleSign: number,
  ): Shot => {
    // Well outside Saturn's system, on the far side from the Sun: nothing in
    // frame but stars, which is what the reference's cruise is.
    const anchor = at(saturn, saturnPos, 900, 150, 20)
    const toStar = Vec.normalize(UV.difference(sun, anchor))
    const side = (() => {
      const raw = Vec.cross(POLE, toStar)
      return Vec.length(raw) > 1e-6
        ? Vec.normalize(raw)
        : Vec.normalize(Vec.cross(vec3(1, 0, 0), toStar))
    })()
    /*
     * Where the star lands in the frame is `dot(toStar, up)`, and with
     * `lookAlong` levelling against the pole that works out to
     * `−dot(toStar, forward) · dot(pole, forward)` for anything near the
     * ecliptic — a product, so *both* terms have to carry the right sign. An
     * early version had the second one negative by accident: the camera looked
     * down-sun and slightly downward, which put the key 32° below the axis and
     * lit the hull's belly through a four-hundred-frame approach in which the
     * reference shows nothing but its brightly lit dorsal.
     *
     * The bound is `dot(pole, forward)` itself, so the key goes as high as the
     * camera is willing to look up — or as low. 0.9 puts the star 60° off the
     * view axis, well outside a 45° field, and 0.87 of full illumination on a
     * level hull's facing surface.
     */
    const poleward = Vec.normalize(Vec.cross(toStar, side))
    const forward = Vec.normalize(
      Vec.add(
        Vec.add(Vec.scale(toStar, -0.42), Vec.scale(poleward, 0.9 * poleSign)),
        Vec.scale(side, -0.12 * poleSign),
      ),
    )
    return {
      id,
      from,
      to,
      camera: [{ frame: from, position: anchor }],
      aim: [{ frame: from, orientation: lookAlong(forward, POLE) }],
      ship: SHIP_CRUISE,
      facing: facingBeats(FACING_CRUISE),
    }
  }

  /* ------------------- Shot: the titles, f1092–2396 ---------------------- */

  /*
   * A *different* stage from the cruise, swapped under the whiteout — the same
   * trick the reference plays at f240 with a hard cut. It has to be: the
   * cruise looks down-sun into the glare that sells the warp-out, and forty
   * seconds of credits over a star's disk is not a title sequence.
   *
   * This one looks across the sun line with the star up and behind, so the
   * credit descent catches a strong dorsal key, while the star stays ~115° off
   * the view axis, outside both the frame and the flare's edge fade. It cannot
   * also serve the fly-through wipes, which turn the hull's other face to the
   * lens; those are lit from the camera. The key construction below carries the
   * measurements and the reason no re-aim changes them.
   */
  interface PitchBeat {
    readonly frame: number
    readonly deg: number
  }
  const lockShot = (
    id: string,
    from: number,
    to: number,
    seed: number,
    pitches: readonly PitchBeat[],
    ship?: readonly ScreenBeat[],
    facing?: readonly AimBeat[],
  ): Shot => {
    // Each locked shot stands somewhere different, so the starfield behind the
    // credits is not the starfield behind the end cards. The reference's
    // second flash is a scene change too.
    const anchor = at(saturn, saturnPos, 900 + seed * 40, 150 - seed * 9, 20)
    const toStar = Vec.normalize(UV.difference(sun, anchor))
    const side = (() => {
      const raw = Vec.normalize(Vec.cross(toStar, POLE))
      const towardSaturn = Vec.normalize(UV.difference(saturnPos, anchor))
      return Vec.dot(raw, towardSaturn) > 0 ? Vec.negate(raw) : raw
    })()
    const poleward = Vec.normalize(Vec.cross(toStar, side))
    // The same overhead key as the cruise, rolled the other way round the sun
    // line so the starfield behind the credits is not the starfield behind the
    // approach.
    //
    // It used to add that the hull is "dorsal-up under the camera" here and so
    // wants the light normal to the saucer. Do not restore any claim of that
    // shape: which face this shot shows the camera is a property of the beat
    // tables, not of the key, and it has already changed once. Under the
    // authored attitudes it was the *ventral* through the whole credit descent
    // — the far side from this key — and 205 frames of the descent rendered as
    // a silhouette because of it; the landmark refit of `FACING_TITLES` turned
    // the hull the right way round and the same beats now show the dorsal at
    // +0.24 to +0.63. The wipes went the other way in the same refit and are
    // near edge-on, showing the unlit side at −0.77.
    //
    // Which is the point: re-aiming this shot cannot settle it either way. The
    // hull's beats are camera-relative, so a rotation here carries the hull
    // with it and the visible face does not move — only the star does. Sweeping
    // every unit direction against the beats, no single key clears grazing on
    // all of them, and the direction that comes closest points back down the
    // lens. One shot showing both faces of a hull cannot be lit by one distant
    // source. The reference relights; so does `cruiseShot`, across its own cut
    // at f948. This shot has no cut to hide one in, so the light that covers
    // whichever face the star misses is mounted on the camera and lives in
    // `scene/CameraRig.tsx` — see `STAGE_FILL_INTENSITY`. It contributes
    // nothing to a face the key already reaches, so it costs the beats nothing
    // when they are right. `cutscene.test.ts` § "tng-intro lighting geometry"
    // asserts the condition, and says what to do if it stops holding.
    const orientation = lookAlong(
      Vec.normalize(
        Vec.add(
          Vec.add(Vec.scale(side, 0.2), Vec.scale(toStar, -0.4)),
          Vec.scale(poleward, 0.89),
        ),
      ),
      POLE,
    )
    // `withAttitude`'s pitch overlay, which is what this was a second copy of.
    // The composition order is the thing that must not drift, so there is one
    // of it.
    const pitch = (deg: number): Quat => withAttitude(orientation, 0, deg)
    return {
      id,
      from,
      to,
      camera: [{ frame: from, position: anchor }],
      aim: [
        { frame: from, orientation },
        ...pitches.map((beat) => ({
          frame: beat.frame,
          orientation: pitch(beat.deg),
        })),
      ],
      ...(ship === undefined ? {} : { ship }),
      ...(facing === undefined ? {} : { facing }),
    }
  }

  const shipTitles: readonly ScreenBeat[] = [
    ...WARP_OUT_1,
    ...WIPE.map((beat) => shifted(beat, WIPE_OFFSETS[0] as number)),
    ...WIPE.map((beat) => mirrored(beat, WIPE_OFFSETS[1] as number)),
    ...WIPE.map((beat) => shifted(beat, WIPE_OFFSETS[2] as number)),
    ...SHIP_RETURN,
  ]
  const facingTitles = facingBeats(FACING_TITLES)

  const titlesShot = lockShot(
    'titles',
    CUTS.titles[0],
    CUTS.titles[1],
    1,
    // The one camera move: a slight pitch through the beauty pass, beginning
    // only after Wheaton's fast drop is complete (measured: no text survives
    // past f2031).
    [
      { frame: 2100, deg: 0 },
      { frame: 2170, deg: -6 },
      { frame: 2260, deg: -3 },
      { frame: 2360, deg: 0 },
      { frame: 2392, deg: 0 },
    ],
    shipTitles,
    facingTitles,
  )

  /*
   * The cut sits at f2393 — mid-whiteout, where the second flash has been at
   * full for four frames — so the stage swap happens behind a covered frame,
   * exactly as the first one does. The hull's beats carry across because the
   * reference's ship is still streaking away at f2400: they are
   * camera-relative, so it leaves down the *new* camera's axis, and a
   * receding streak on a starfield is a receding streak on a starfield.
   */
  const endShot = lockShot(
    'end-cards',
    CUTS['end-cards'][0],
    CUTS['end-cards'][1],
    2,
    [],
    shipTitles,
    facingTitles,
  )

  return {
    shots: [
      earthShot,
      eclipseShot,
      jupiterShot,
      saturnShot,
      cruiseShot('cruise', CUTS.cruise[0], CUTS.cruise[1], 1),
      cruiseShot(
        'cruise-close',
        CUTS['cruise-close'][0],
        CUTS['cruise-close'][1],
        -1,
      ),
      titlesShot,
      endShot,
    ],
  }
}

/* ------------------------------------------------------------------------- */
/* Sampling                                                                   */
/* ------------------------------------------------------------------------- */

function shipVisible(frame: number): boolean {
  return SHIP_WINDOWS.some(([from, to]) => frame >= from && frame <= to)
}

/**
 * The shot a frame belongs to. Searched backwards so a later shot covering the
 * same frames plays over an earlier one; the last shot holds past the end so a
 * frame beyond the final beat still has a camera.
 */
function shotAt(stage: Stage, frame: number): Shot {
  for (let i = stage.shots.length - 1; i >= 0; i -= 1) {
    const candidate = stage.shots[i] as Shot
    if (frame >= candidate.from && frame <= candidate.to) return candidate
  }
  /*
   * Frames are fractional, so one can land in the sliver between `to` and the
   * next `from` — 356.0000000001 belongs to no shot. Falling back to the last
   * shot in the list teleports the camera five astronomical units for a single
   * frame, which is exactly the kind of one-frame glitch nobody finds by
   * watching. The nearest shot is always the right answer.
   */
  let best = stage.shots[0] as Shot
  let bestGap = Infinity
  for (const candidate of stage.shots) {
    const gap =
      frame < candidate.from ? candidate.from - frame : frame - candidate.to
    if (gap < bestGap) {
      bestGap = gap
      best = candidate
    }
  }
  return best
}

/**
 * Streak burst around a wipe occlusion.
 *
 * Peaks *at* the occlusion, not before it. The reference's approach frames
 * carry motion blur on the hull and nothing else; the blades only appear in
 * the two frames where the ship is actually crossing the lens. Leading them by
 * six frames — which is what this did first — hangs two white bars across a
 * clean frame while the ship is still a distant shape, and reads as a weapon
 * rather than as speed.
 */
function wipeStreak(occlusion: number, frame: number): number {
  return Math.min(
    smooth((frame - (occlusion - 3)) / 3),
    1 - smooth((frame - occlusion - 2) / 5),
  )
}

/*
 * The two lens spikes. Measured centers and windows: the first grows from
 * f1118 at (0.645, 0.665), the second from f2412 at (0.688, 0.43), both on the
 * 24-frame envelope. They are the same artifact — a warp point receding down
 * the axis — and each is the bridge into the card that follows it.
 */
const SPARKS: readonly { start: number; x: number; y: number }[] = [
  // (0.655, 0.695): the reference's spike registers at (0.659, 0.704) on f1119
  // and (0.655, 0.688) on f1120, which is also where the hull was last seen.
  { start: 1118, x: 0.655, y: 0.695 },
  { start: 2412, x: 0.688, y: 0.43 },
]

function effectsAt(frame: number): CinematicEffects {
  const flash1 = warpFlashEnvelope(1085, frame)
  const flash2 = warpFlashEnvelope(2382, frame)

  let blackout = 0
  if (frame < 125) blackout = 1
  else if (frame < 133) blackout = 1 - smooth((frame - 125) / 7)
  else if (frame >= 2724) blackout = 1
  else if (frame >= 2712) blackout = smooth((frame - 2712) / 12)

  let streaks = Math.max(flash1.streaks, flash2.streaks)
  // Warp streaks igniting ahead of both flashes (measured onsets 1078, 2332).
  streaks = Math.max(
    streaks,
    0.35 * smooth((frame - 1078) / 7) * (frame < 1100 ? 1 : 0),
  )
  streaks = Math.max(
    streaks,
    0.5 * smooth((frame - 2332) / 50) * (frame < 2382 ? 1 : 0),
  )
  /*
   * The residual streak carrying the hull out of each flash. It has to outlast
   * the flash — the frames after a warp-out are not empty, the ship is still
   * leaving; the first capture had 1.7 at f1100 where the reference means 10.3
   * — but it was made to outlast it by three times too long.
   *
   * Nine frames and fifteen, not twenty-six each — and they differ because the
   * two exits differ. The first is short and steep: 10.3, 9.7, 9.1, 8.1, 7.1,
   * 2.9, 1.2, 0.7 across f1100-1107, then 0.4 flat until the lens spike arrives
   * at f1119. A 26-frame decay leaves light on frames the reference has already
   * emptied, which are the frames the *spike* is supposed to arrive into. The
   * second runs 13.4, 11.1, 9.7, 8.4, 6.5, 5.0 across f2397-2402 before
   * dropping to 1.2 — twice as long, because the reference's ship is still a
   * recognizable w 0.68 hull at f2397 where the first exit has already gone.
   */
  streaks = Math.max(
    streaks,
    0.8 * (1 - smooth((frame - 1100) / 9)) * (frame >= 1096 ? 1 : 0),
  )
  streaks = Math.max(
    streaks,
    0.8 * (1 - smooth((frame - 2396) / 15)) * (frame >= 2392 ? 1 : 0),
  )
  for (const occlusion of WIPE_OCCLUSIONS)
    streaks = Math.max(streaks, 0.85 * wipeStreak(occlusion, frame))

  let nacelleGlow = 0
  if (frame >= 867 && frame < 1110) nacelleGlow = smooth((frame - 867) / 120)
  else if (frame >= 2332 && frame < 2410)
    nacelleGlow = smooth((frame - 2332) / 40)

  let spark = { drive: 0, x: 0.5, y: 0.5 }
  for (const candidate of SPARKS) {
    const drive = sparkEnvelope(candidate.start, frame)
    if (drive > spark.drive) spark = { drive, x: candidate.x, y: candidate.y }
  }

  /*
   * The wipes flood too. The reference's f1320 is a frame of blue light with a
   * hull silhouette in it — the same wash the warp flashes use, three frames
   * long instead of fifteen, which is what makes a fly-through a *wipe* rather
   * than a ship going past.
   */
  let flash = Math.max(flash1.flash, flash2.flash)
  for (const occlusion of WIPE_OCCLUSIONS) {
    flash = Math.max(
      flash,
      0.55 *
        Math.min(
          smooth((frame - (occlusion - 2)) / 2),
          1 - smooth((frame - occlusion - 1) / 4),
        ),
    )
  }

  return {
    blackout,
    flash,
    streaks,
    nacelleGlow,
    /*
     * The corona, on for the eclipse shot and nowhere else in the sequence.
     *
     * A hard edge rather than a ramp, because both ends of this shot *are*
     * cuts — f240 is the composition-matched match cut and f357 lands in empty
     * starfield — and a fade across a cut is a fade nobody can see the far side
     * of. The ring's own envelope is the occlusion geometry: `flareMath` returns
     * a depth that runs 0 at first contact to 1 at totality, so this switch says
     * *whether there is an eclipse in this shot*, not how deep it is.
     */
    corona: coronaAt(frame),
    spark,
  }
}

/**
 * Whether this frame is inside the eclipse shot.
 *
 * `Math.floor`, and it is not decoration: `frame` arrives as
 * `(renderTime - epoch) * fps` and at 24000/1001 the round trip through a float
 * lands the last frame of a shot at 356.00000000000006 as often as at 356. An
 * inclusive comparison against the shot table then reads it as the *next* shot
 * and the corona drops out one frame early — invisible in motion, and a test
 * asserting the boundary that fails on some machines and not others. A frame is
 * an integer index; the fraction is sub-frame interpolation and no shot
 * boundary is a function of it.
 */
const coronaAt = (frame: number): number => {
  const index = Math.floor(frame)
  return index >= CUTS.eclipse[0] && index <= CUTS.eclipse[1] ? 1 : 0
}

function textsAt(frame: number): CinematicTextState[] {
  return TITLES.map((title) => {
    const place = logoPlacement(title, frame)
    return {
      id: title.id,
      style: title.style,
      text: title.text,
      ...(title.label === undefined ? {} : { label: title.label }),
      x: place.x,
      y: place.y,
      opacity: fadeEnvelope(title.window, frame),
      scale: place.scale,
    }
  })
}

function cameraAt(
  shot: Shot,
  frame: number,
): { position: UniverseVector; orientation: Quat } {
  return {
    position: routePosition(shot.camera, frame),
    orientation: routeOrientation(shot.aim, frame),
  }
}

/**
 * Where the hull is, and which way it points.
 *
 * Both are camera-relative: offsets are interpolated in offset space and
 * rotated onto the camera's axes at sample time, and the facing is a direction
 * in those same axes. Absolute world beats were tried first and broke quietly
 * — the camera used to cover thousands of kilometers a frame, so the ship's
 * spline and the camera's ran through beats far enough apart to diverge
 * mid-segment by tens of kilometers, and the hero hull rendered as a dot on
 * the wrong side of the sky. Relative choreography has to stay relative, and
 * the shot list is what finally makes the camera hold still enough for anyone
 * to notice when it does not.
 */
function shipAt(
  shot: Shot,
  camera: { position: UniverseVector; orientation: Quat },
  frame: number,
): { position: UniverseVector; orientation: Quat; visible: boolean } {
  const visible = shipVisible(frame) && shot.ship !== undefined
  if (shot.ship === undefined || shot.facing === undefined) {
    return {
      position: UV.translate(
        camera.position,
        Q.rotate(camera.orientation, vec3(0, 0, -1e7)),
      ),
      orientation: camera.orientation,
      visible: false,
    }
  }
  const offset = screenRoutePosition(shot.ship, frame, FOV, ASPECT)
  const facing = routeOrientation(shot.facing, frame)
  return {
    position: UV.translate(
      camera.position,
      Q.rotate(camera.orientation, offset),
    ),
    orientation: Q.normalize(Q.multiply(camera.orientation, facing)),
    visible,
  }
}

function sample(stage: Stage, frame: number): CinematicSample {
  const shot = shotAt(stage, frame)
  const camera = cameraAt(shot, frame)
  return {
    frame,
    camera,
    fov: FOV,
    ship: shipAt(shot, camera, frame),
    texts: textsAt(frame),
    effects: effectsAt(frame),
    done: frame >= DURATION - 1,
  }
}

/* ------------------------------------------------------------------------- */
/* Exposed for tests                                                          */
/* ------------------------------------------------------------------------- */

/** The measured windows the script must reproduce. */
export const TNG_TITLE_WINDOWS: ReadonlyMap<string, FadeWindow> = new Map(
  TITLES.map((title) => [title.id, title.window]),
)

/** Hull length the ranges assume, and the lens they are solved for. */
export const TNG_HULL_LENGTH = HULL

/**
 * The cruise's authored nose-down pitch, so a test asserting the hull's nose
 * against its own track can account for it rather than restating the number.
 */
export const TNG_CRUISE_PITCH_DEG = PITCH_CRUISE
export const TNG_LENS = { fov: FOV, aspect: ASPECT } as const

/** The measured wipe occlusions, and the offsets that place them. */
export const TNG_WIPE_OCCLUSIONS = WIPE_OCCLUSIONS
export const TNG_WIPE_OFFSETS = WIPE_OFFSETS

/** The shot boundaries, so a test can assert where the cuts are. */
export const TNG_CUTS: readonly { id: string; from: number; to: number }[] =
  Object.entries(CUTS).map(([id, [from, to]]) => ({ id, from, to }))

/**
 * The hull's screen track, recomputed from a camera-relative offset. The
 * reference's hull measurements *are* screen measurements, so this is the form
 * a numeric diff against them takes.
 */
export function screenPositionOf(offset: Vec3): {
  x: number
  y: number
  range: number
} {
  const range = Vec.length(offset)
  if (range < 1e-9) return { x: 0.5, y: 0.5, range: 0 }
  const tanHalf = Math.tan((FOV * Math.PI) / 360)
  const depth = -offset.z
  return {
    x: 0.5 + offset.x / depth / (2 * tanHalf * ASPECT),
    y: 0.5 - offset.y / depth / (2 * tanHalf),
    range,
  }
}

/** The authored screen beats, in their measured form. */
export const TNG_SHIP_BEATS = {
  cruise: SHIP_CRUISE,
  wipe: WIPE,
  return: SHIP_RETURN,
}

/** `screenDirection` at this script's lens, for tests. */
export const tngScreenDirection = (x: number, y: number): Vec3 =>
  screenDirection(x, y, FOV, ASPECT)
