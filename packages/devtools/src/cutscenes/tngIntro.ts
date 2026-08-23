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
 * the language the measurement speaks: a tracked bounding box gives a centre
 * and a width, and a width *is* a range once the hull's length and the lens
 * are known. Beats written this way can be read straight off the analysis.
 *
 * The structural facts, in the analysis's own terms:
 *
 * - The camera never moves while text is visible. Every credit is a pure 4–8
 *   frame opacity fade, horizontally centred, with its label line flush left
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
 * compositions measure out at: at that field the eclipsed disc's 440-pixel
 * diameter at f272 puts the camera 6.0 planet radii out, and the hull's
 * bounding box at f872 puts it 630 m away — both sane numbers for the shots
 * they describe, which is the test that fixes the field.
 */
const FOV = 45
/** Compositions are solved for the reference frame's shape. */
const ASPECT = 16 / 9

/** The hero hull's overall length, metres. Ranges below are derived from it. */
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
 * - A name's cap band is 79–81 px of 1080, centred on y 0.5032. Every name is
 *   horizontally centred at x 0.498–0.510; the per-credit centroids in the
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
  // rows (name centres y 0.2486, 0.5125, 0.8074).
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

  // Shot 09 — the outro card, crediting the reference this was measured from.
  {
    id: 'o1',
    style: 'name',
    label: 'After The Recreation By',
    text: 'JASON T',
    x: 0.4222,
    y: NAME_Y,
    window: fade(2637, 2700, 2712, 13),
  },
  {
    id: 'o1-accent',
    style: 'accent',
    // Clear of the name beside it: the reference's blue portion ends at 0.491
    // and this face sets the same name wider, so the measured 0.611 puts the
    // opening parenthesis hard against the T.
    text: '(JTVFX)',
    x: 0.658,
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
 * f1136, which is why the tight colour mask first sees them — dim, because
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
 * run off the frame for the first ten frames, so a bounding box's centre is a
 * measurement of where the frame ends. Reconstructing the centre from the
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
 * positions are box centres; ranges come from the box width through
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
  { frame: 856, x: 0.321, y: 0.568, range: atWidth(0.568) },
  { frame: 872, x: 0.354, y: 0.512, range: atWidth(0.695) },
  { frame: 896, x: 0.4, y: 0.43, range: atWidth(0.95) },
  /*
   * The close pass runs far tighter than the first authoring guessed. Captured
   * against the reference, f1005–1020 had the hull filling the frame there
   * (measured width 1.000, mean luminance 40–45) against a render showing the
   * whole ship at half that size and a mean of 11–14. The reference is *inside
   * the ship's envelope* through this stretch — hull plating and window rows,
   * not a silhouette — so the ranges close by roughly two thirds.
   */
  /*
   * The hull rides LOW through the close pass, and that is a measurement
   * before it is a lighting decision: the reference's box centre is at y 0.60
   * at f944, 0.62 at f960 and 0.64 through f990–1000 before rising again. The
   * first authoring had it near the frame's centre, and the two facts turn out
   * to be one fact — a hull below the centre shows the camera its dorsal,
   * which is the surface an overhead key lights. Riding it high showed the
   * belly instead, and the render's mean luminance collapsed from the
   * reference's 50–58 to 15–20 across the best hundred frames in the piece.
   *
   * Screen position barely tips the view angle once the hull is this close,
   * which is worth knowing before reaching for it: at 145 metres from a
   * 642-metre ship the camera is inside the envelope, and a mark 14 metres
   * under the axis leaves it a tenth of a radian off the saucer's own plane —
   * edge-on, seeing neither surface. Measured in the browser,
   * `camOnDorsalSide` read −0.097 while the key sat a healthy 0.80 normal to
   * the dorsal. Which face the camera sees here is settled by the *cut*, not
   * by the framing; see `cruise-close`.
   */
  { frame: 928, x: 0.45, y: 0.55, range: atWidth(1.5) },
  { frame: 960, x: 0.47, y: 0.62, range: atWidth(1.9) },
  { frame: 990, x: 0.44, y: 0.64, range: atWidth(2.1) },
  { frame: 1015, x: 0.46, y: 0.58, range: atWidth(1.8) },
  { frame: 1045, x: 0.54, y: 0.46, range: atWidth(1.2) },
  { frame: 1080, x: 0.617, y: 0.42, range: atWidth(0.62) },
  // The warp-out: hurled down its own axis under the flash.
  { frame: 1092, x: 0.63, y: 0.39, range: atWidth(0.02) },
  { frame: 1108, x: 0.64, y: 0.39, range: atWidth(0.004) },
  { frame: 1120, x: 0.645, y: 0.39, range: atWidth(0.0008) },
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
/** Frame offsets of the three wipes, and their measured occlusion frames. */
const WIPE_OFFSETS = [0, 128, 247] as const
const WIPE_OCCLUSIONS = [1317, 1445, 1564] as const

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
 * and descends through the last six credits — measured box centres and widths
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
  { frame: 2000, x: 0.394, y: 0.418, range: atWidth(0.45) },
  { frame: 2040, x: 0.368, y: 0.48, range: atWidth(0.575) },
  { frame: 2070, x: 0.35, y: 0.528, range: atWidth(0.672) },
  { frame: 2100, x: 0.33, y: 0.578, range: atWidth(0.94) },
  { frame: 2130, x: 0.35, y: 0.72, range: atWidth(1.8) },
  // The skim: close enough that the saucer is a landscape, drifting aft.
  { frame: 2180, x: 0.45, y: 0.74, range: atWidth(3.1) },
  { frame: 2230, x: 0.53, y: 0.74, range: atWidth(3.2) },
  { frame: 2280, x: 0.6, y: 0.73, range: atWidth(2.6) },
  { frame: 2330, x: 0.62, y: 0.66, range: atWidth(1.6) },
  { frame: 2380, x: 0.6, y: 0.58, range: atWidth(1.0) },
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
 * out right for free — a level ship below the frame's centre shows its dorsal,
 * above it shows its belly, which is exactly what the reference does at f820
 * and f892.
 */
interface FacingBeat {
  readonly frame: number
  readonly forward: Vec3
  readonly bankDeg?: number
}

const FACING_CRUISE: readonly FacingBeat[] = [
  { frame: 676, forward: vec3(0.26, 0.02, 0.96) },
  { frame: 900, forward: vec3(0.16, -0.04, 0.98) },
  // Nose-up through the low stretch: the hull sits below the frame's centre
  // and pitching it down would tip the dorsal away from the lens again.
  { frame: 960, forward: vec3(-0.1, 0.18, 0.98), bankDeg: -8 },
  { frame: 1000, forward: vec3(-0.45, 0.1, 0.88), bankDeg: -18 },
  { frame: 1035, forward: vec3(-0.62, -0.15, -0.77), bankDeg: -14 },
  { frame: 1120, forward: vec3(-0.6, -0.14, -0.79) },
]

const FACING_TITLES: readonly FacingBeat[] = [
  // Nose-*down* through the wipes. The hull crosses above the frame's centre,
  // so a level ship shows the camera its belly — and the reference's wipe
  // frames plainly show the saucer's top, lit, right up to the occlusion. It
  // is diving at the lens, not flying level past it.
  { frame: 1280, forward: vec3(0.06, -0.2, 0.98) },
  { frame: 1600, forward: vec3(0.06, -0.2, 0.98) },
  { frame: 1755, forward: vec3(-0.02, 0.3, 0.95) },
  { frame: 2000, forward: vec3(-0.04, 0.22, 0.97) },
  { frame: 2130, forward: vec3(-0.16, 0.06, 0.98), bankDeg: 5 },
  { frame: 2280, forward: vec3(-0.3, -0.05, 0.95), bankDeg: 8 },
  { frame: 2380, forward: vec3(-0.42, -0.1, 0.9), bankDeg: 4 },
  { frame: 2420, forward: vec3(-0.42, -0.1, 0.9) },
]

const facingBeats = (list: readonly FacingBeat[]): AimBeat[] =>
  list.map((beat) => ({
    frame: beat.frame,
    orientation: Q.multiply(
      lookAlong(beat.forward, POLE),
      Q.fromAxisAngle(vec3(0, 0, 1), ((beat.bankDeg ?? 0) * Math.PI) / 180),
    ),
  }))

/** Ship visibility windows, frames inclusive. */
const SHIP_WINDOWS: readonly (readonly [number, number])[] = [
  [676, 1118],
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
  cruise: [532, 937],
  'cruise-close': [938, 1091],
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
   * A low sweep, not a framed disc: the reference's limb slashes down the
   * frame at x≈0.22 at f150 with terrain filling everything to its right, and
   * the pull-back only closes the disc in the last third. It ends on the
   * composition the f240 cut answers — disc centred (0.634, 0.555) at 4.30
   * radii with the star 15.7° away, 2.3° outside the left limb.
   *
   * One thing the reference does here cannot be reproduced honestly, and it is
   * worth naming rather than chasing. Its opening has *both* broadly lit
   * terrain and the sun in frame beside the planet, and those two facts
   * contradict each other: the sun's measured screen position puts it 72° from
   * the disc's centre, which for a camera 1.2 radii up means the entire
   * visible cap sits past the terminator. It is a CG render whose key light
   * and whose sun sprite were placed independently. Staged against a real
   * ephemeris you get one or the other.
   *
   * So the phase *ramps*: 78° at f125, where the cap is broadly lit and the
   * star is behind the lens, opening to 164° by f239, where the disc is the
   * thin crescent the match cut needs and the star has swung into frame beside
   * it. The shot the reference is trying to be, told in an order that is true.
   */
  const earthPos = positionOf(earth)
  const earthShot: Shot = (() => {
    // Measured widths at f140 and f160: 0.97 and 0.93 of the frame against
    // 0.67 and 0.54 in the first capture — the opening stood a third too far
    // off its planet the whole way down.
    const e125 = at(earth, earthPos, 1.1, 78, 4)
    const e165 = at(earth, earthPos, 1.24, 92, 5)
    const e195 = at(earth, earthPos, 1.9, 118, 6)
    const e220 = at(earth, earthPos, 3.2, 142, 6)
    const e239 = at(earth, earthPos, 4.3, 164.3, 6)
    const aimAt = (from: UniverseVector, x: number, y: number): Quat =>
      frameTarget(from, { at: earthPos, x, y }, FOV, ASPECT, POLE)
    return {
      id: 'earth',
      from: CUTS.earth[0],
      to: CUTS.earth[1],
      camera: [
        { frame: 125, position: e125 },
        { frame: 165, position: e165 },
        { frame: 195, position: e195 },
        { frame: 220, position: e220 },
        { frame: 239, position: e239 },
      ],
      aim: [
        { frame: 125, orientation: aimAt(e125, 1.05, 0.62) },
        { frame: 165, orientation: aimAt(e165, 0.98, 0.6) },
        { frame: 195, orientation: aimAt(e195, 0.84, 0.585) },
        { frame: 220, orientation: aimAt(e220, 0.72, 0.57) },
        // Both marks, because the f240 cut lands invisibly only if the two
        // sides agree on the star *and* the disc; eyeballing a roll gets one.
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
   * The measured schedule: 15.7° of separation at f240 with the disc 13.4°
   * across, so the star sits 2.3° clear of the limb; zero at f272 with the
   * disc down to 9.6°; then out the other side as the camera keeps pulling
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
     * The standoff schedule is measured, and it is violent. The disc's height
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
        // so the disc alone sets the frame.
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
   * frame is twenty thousand kilometres off the line that *is* the shot.
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
    // Same correction as Jupiter, one stop gentler: the reference's terminator
    // runs down x≈0.60 at f432 with the lit half to its left, which is a
    // camera near quadrature rather than over the day side.
    // Measured at f423: the reference has Saturn 0.664 of the frame wide and
    // means 91 there, against 0.356 and 33 in the first capture — the approach
    // was arriving half a second late. 3.4 radii rather than 5.2 at the cut.
    const s413 = at(saturn, saturnPos, 3.4, 74, -12)
    const s432 = at(saturn, saturnPos, 1.9, 88, -30)
    const s460 = at(saturn, saturnPos, 2.6, 100, -26)
    const s500 = at(saturn, saturnPos, 6.5, 116, -30)
    const s531 = at(saturn, saturnPos, 13, 128, -32)
    const aimAt = (from: UniverseVector, x: number, y: number): Quat =>
      frameTarget(from, { at: saturnPos, x, y }, FOV, ASPECT, POLE)
    return {
      id: 'saturn',
      from: CUTS.saturn[0],
      to: CUTS.saturn[1],
      camera: [
        { frame: 413, position: s413 },
        { frame: 432, position: s432 },
        { frame: 460, position: s460 },
        { frame: 500, position: s500 },
        { frame: 531, position: s531 },
      ],
      aim: [
        { frame: 413, orientation: aimAt(s413, 1.25, 0.62) },
        { frame: 432, orientation: aimAt(s432, 0.62, 0.5) },
        { frame: 460, orientation: aimAt(s460, 0.3, 0.42) },
        { frame: 500, orientation: aimAt(s500, 0.06, 0.36) },
        { frame: 531, orientation: aimAt(s531, -0.06, 0.34) },
      ],
    }
  })()

  /* --------------------- Shot: the cruise, f532–1091 --------------------- */

  /*
   * The camera does not move. The starfield sits on the star shell, so
   * translation moves nothing in frame and only rotation would; the hull is
   * authored camera-relative anyway. A static camera is therefore not a
   * simplification but the *accurate* description of what the reference shows
   * — and it is what makes "never track a hull crossing metres from the lens"
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
   * sits at f938 — the first frame where the hull is wider than the lens, and
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
   * seconds of credits over a star's disc is not a title sequence.
   *
   * This one looks across the sun line with the star up and behind, so the
   * hull doing the fly-bys and the descent catches a strong dorsal key — the
   * reference's light exactly, where the saucer's top surface is the brightest
   * thing in the frame from f1920 to the second flash — while the star stays
   * ~115° off the view axis, outside both the frame and the flare's edge fade.
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
    // The same overhead key as the cruise, and for the same reason: the hull
    // spends this shot nose-on and then dorsal-up under the camera, and both
    // want the light almost normal to the saucer. Rolled the other way round
    // the sun line so the starfield behind the credits is not the starfield
    // behind the approach.
    const orientation = lookAlong(
      Vec.normalize(
        Vec.add(
          Vec.add(Vec.scale(side, 0.2), Vec.scale(toStar, -0.4)),
          Vec.scale(poleward, 0.89),
        ),
      ),
      POLE,
    )
    const pitch = (deg: number): Quat =>
      Q.multiply(
        orientation,
        Q.fromAxisAngle(vec3(1, 0, 0), (deg * Math.PI) / 180),
      )
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
 * The two lens spikes. Measured centres and windows: the first grows from
 * f1118 at (0.645, 0.665), the second from f2412 at (0.688, 0.43), both on the
 * 24-frame envelope. They are the same artefact — a warp point receding down
 * the axis — and each is the bridge into the card that follows it.
 */
const SPARKS: readonly { start: number; x: number; y: number }[] = [
  { start: 1118, x: 0.645, y: 0.665 },
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
   * The residual streak carrying the hull out of each flash, and it has to
   * outlast the flash by a good margin: measured, the reference still means
   * 10.3 at f1100 and 8.4 at f2400, where the first capture had 1.7 and 0.1.
   * The frames after a warp-out are not empty — the ship is still leaving.
   */
  streaks = Math.max(
    streaks,
    0.8 * (1 - smooth((frame - 1100) / 26)) * (frame >= 1096 ? 1 : 0),
  )
  streaks = Math.max(
    streaks,
    0.8 * (1 - smooth((frame - 2396) / 26)) * (frame >= 2392 ? 1 : 0),
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
 * — the camera used to cover thousands of kilometres a frame, so the ship's
 * spline and the camera's ran through beats far enough apart to diverge
 * mid-segment by tens of kilometres, and the hero hull rendered as a dot on
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
export const TNG_LENS = { fov: FOV, aspect: ASPECT } as const

/** The measured wipe occlusions. */
export const TNG_WIPE_OCCLUSIONS = WIPE_OCCLUSIONS

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
