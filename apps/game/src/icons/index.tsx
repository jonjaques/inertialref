import { createLucideIcon } from 'lucide-react'

/*
 * The icons Lucide does not have, drawn to Lucide's own rules.
 *
 * Lucide covers this interface almost completely — `Orbit`, `Telescope`,
 * `Radar`, `Satellite`, `Globe`, `Compass`, `Clapperboard`, `PanelLeft` — and
 * where it does, using it is not a compromise but the point: a set drawn by one
 * hand reads as one instrument. What it does not have is the handful of
 * concepts that are specific to *this* game's physics, and those are here.
 *
 * `createLucideIcon` rather than hand-written SVG components, so these take the
 * same props as every Lucide icon (`size`, `strokeWidth`, `absoluteStrokeWidth`,
 * `className`, `color`) and can sit in the same import list at a call site
 * without anyone having to know which is which. That interchangeability is the
 * whole reason not to invent a second icon component.
 *
 * The rules, from Lucide's contributor guide, and each one is load-bearing at
 * the 14–20 px these are actually drawn at:
 *
 *   - 24 × 24 canvas, at least 1 px of padding — nothing touches the edge
 *   - 2 px stroke, centered, round caps and round joins
 *   - 2 px corner radius on anything 8 px or larger, 1 px below that
 *   - **2 px of clear space between distinct elements** — the one that is
 *     easiest to violate and the one that decides whether an icon survives
 *     being drawn at 16 px
 *
 * The stroke and cap attributes are supplied by `createLucideIcon` itself, so
 * the nodes below carry geometry only. Coordinates are written out rather than
 * computed: an icon is a drawing, and a drawing with arithmetic in it is a
 * drawing nobody can adjust by eye.
 */

/* ------------------------------------------------------------------------- */
/* Phase — the terminator across a disk                                       */
/* ------------------------------------------------------------------------- */

/*
 * The planetarium's lighting presets are photographic terms — full, gibbous,
 * half, crescent — and they are the *only* control in the interface whose
 * effect is a picture rather than a number. Words alone make four buttons that
 * look identical; the glyph is the specification.
 *
 * All three are the same disk (r = 9, so 3 px of padding) with the terminator
 * drawn as an elliptical arc from pole to pole. The arc's x-radius is the whole
 * difference between them, which is also literally what a phase *is*: the
 * projected width of the terminator ellipse. Full phase has no terminator at
 * all, so it is Lucide's own `Circle` at the call site rather than a fourth
 * icon here that would draw a line nobody can see.
 *
 * The lit limb is on the right in all three, matching the convention that the
 * star is off to the right of the frame — and matching `anglesForPhase`, whose
 * azimuth runs from the sun line.
 */

/** Three-quarters lit: the terminator bows into the dark side. */
export const PhaseGibbous = createLucideIcon('PhaseGibbous', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'disc' }],
  ['path', { d: 'M12 3a4 9 0 0 0 0 18', key: 'terminator' }],
])

/** Exactly half lit: the terminator is edge-on and projects to a straight line. */
export const PhaseHalf = createLucideIcon('PhaseHalf', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'disc' }],
  ['path', { d: 'M12 3v18', key: 'terminator' }],
])

/** A sliver: the terminator bows toward the lit limb. */
export const PhaseCrescent = createLucideIcon('PhaseCrescent', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'disc' }],
  ['path', { d: 'M12 3a5 9 0 0 1 0 18', key: 'terminator' }],
])

/**
 * The star behind the body: an unlit disk inside a ring of its own atmosphere.
 *
 * The odd one out of the four, and it has to be. At full phase the terminator
 * has no width and at new phase it has all of it — so drawn to the same recipe
 * as the three above, this glyph would be the bare circle that already means
 * *full*, which is the opposite composition. What is actually on screen at 170°
 * is a dark body ringed by scattered light, so that is what this draws: a disk
 * at r = 5.5 inside a ring at r = 9, which is 3.5 px apart and clears the 2 px
 * rule at 16 px.
 */
export const PhaseRim = createLucideIcon('PhaseRim', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'ring' }],
  ['circle', { cx: '12', cy: '12', r: '5.5', key: 'disc' }],
])

/* ------------------------------------------------------------------------- */
/* Sphere of influence                                                        */
/* ------------------------------------------------------------------------- */

/**
 * A body, the volume it dominates, and the limb of the primary it belongs to.
 *
 * The single most important invisible thing in this engine — ADR-0002's frame
 * transitions happen at exactly this boundary — and there is no established
 * glyph for it anywhere, because no other interface has to show it.
 *
 * The three elements are laid out for the 2 px clearance rule at 16 px: the
 * body's disk ends at r = 2 and the influence ring starts at r = 5, and the
 * primary's arc sits in the opposite corner about 8 px clear of the ring at its
 * nearest approach.
 */
export const SphereOfInfluence = createLucideIcon('SphereOfInfluence', [
  ['circle', { cx: '8', cy: '16', r: '2', key: 'body' }],
  ['circle', { cx: '8', cy: '16', r: '5', key: 'influence' }],
  ['path', { d: 'M14 3a10 10 0 0 1 7 7', key: 'primary' }],
])

/* ------------------------------------------------------------------------- */
/* Interstellar distance                                                      */
/* ------------------------------------------------------------------------- */

/**
 * The measure between two stars.
 *
 * A ruler would be wrong: nothing in this game measures a light year with a
 * ruler, and Lucide's `Ruler` already means "dimension" in the surface tools.
 * Two disks with a span between them is what a light year *is* in the only
 * place the player meets one — the gap between two points in the galaxy map —
 * and it survives being drawn at 14 px because it has only three parts.
 */
export const StellarSpan = createLucideIcon('StellarSpan', [
  ['circle', { cx: '4', cy: '12', r: '2', key: 'here' }],
  ['circle', { cx: '20', cy: '12', r: '2', key: 'there' }],
  ['path', { d: 'M8 12h8', key: 'span' }],
  ['path', { d: 'M10 10 8 12l2 2', key: 'head-left' }],
  ['path', { d: 'M14 10l2 2-2 2', key: 'head-right' }],
])

/* ------------------------------------------------------------------------- */
/* The burn                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The brachistochrone profile: accelerate, flip, decelerate.
 *
 * This is the game's central mechanic (`docs/design/flight.md`) and its shape
 * is a triangle — speed against time — divided down the middle at the flip.
 * The median is what stops it reading as Lucide's own `Triangle`, and it is
 * also the only part of the glyph that carries information: the flip is the
 * one decision the burn plan asks the player to make.
 */
export const FlipAndBurn = createLucideIcon('FlipAndBurn', [
  ['path', { d: 'M3 19 12 6l9 13Z', key: 'profile' }],
  ['path', { d: 'M12 6v13', key: 'flip' }],
])

/**
 * Delta-v: the budget a maneuver spends.
 *
 * The delta is the mathematician's, the arrow is the velocity it applies to,
 * and the 3 px between them is what keeps the pair from fusing into one blob at
 * small sizes. Written as two elements rather than a clever combined path for
 * exactly that reason.
 */
export const DeltaV = createLucideIcon('DeltaV', [
  ['path', { d: 'M4 18 8.5 8 13 18Z', key: 'delta' }],
  ['path', { d: 'M16 13h5', key: 'v' }],
  ['path', { d: 'M18.5 10.5 21 13l-2.5 2.5', key: 'head' }],
])

/* ------------------------------------------------------------------------- */
/* The planetarium itself                                                     */
/* ------------------------------------------------------------------------- */

/**
 * A dome with its shutter open.
 *
 * Lucide's `Telescope` is the instrument and this is the building, and the
 * planetarium wants the building: the mode is not "look through an eyepiece",
 * it is "the sky, indoors, under your control". It is also the one icon in this
 * file that has to work as a 40 px mode card on the home screen as well as a
 * 16 px tab, which is why it is three long strokes and nothing small.
 */
export const Observatory = createLucideIcon('Observatory', [
  ['path', { d: 'M4 17a8 8 0 0 1 16 0', key: 'dome' }],
  ['path', { d: 'M2 17h20', key: 'base' }],
  ['path', { d: 'M12 17V9.5', key: 'shutter' }],
])

/* ------------------------------------------------------------------------- */
/* What a thing is                                                            */
/* ------------------------------------------------------------------------- */

/*
 * Nine classes of object, nine glyphs, one visual grammar.
 *
 * The catalog lists a hundred and twenty-nine bodies in Sol alone, and it used
 * to draw three shapes across all of them: a five-pointed star for a system, a
 * circle for anything two levels deep, and a globe for everything else. So a
 * comet, a dwarf planet, an asteroid and Jupiter were the same glyph, and the
 * one distinction the interface *did* draw — circle against globe — was about
 * how deep the address was rather than about what the thing is.
 *
 * The grammar, and it is worth stating because it is what makes the set
 * readable at 14 px rather than merely different:
 *
 *   the disk's size    says how big a class of object it is. A giant fills the
 *                      canvas, a planet is smaller, a moon smaller again.
 *   the mark inside    says what it is made of. Bands are a fluid envelope,
 *                      caps are ice, a crater is airless rock.
 *   what is outside    says what it is doing. Rays are a star's own light; the
 *                      two specks beside a dwarf are the neighborhood it never
 *                      cleared, which is the whole of the 2006 definition.
 *
 * A terrestrial planet is Lucide's own `Globe` at the call site rather than a
 * tenth icon here. A circle with a meridian and an equator *is* the glyph for
 * a world with a surface, it is drawn by the same hand as the rest of the set,
 * and inventing a near-copy of it would be the one kind of addition this file's
 * header argues against.
 */

/**
 * A star: its own light source, which is the only thing that distinguishes one
 * from a planet at this size.
 *
 * The disk is small — r = 4 — because the rays are the glyph and a large disk
 * pushes them off the canvas. Four rather than eight: at 14 px, eight 3 px
 * strokes around a 8 px disk close into a ring and the shape stops reading as
 * a star at all.
 */
export const StarBody = createLucideIcon('StarBody', [
  ['circle', { cx: '12', cy: '12', r: '4', key: 'photosphere' }],
  ['path', { d: 'M12 2v3', key: 'north' }],
  ['path', { d: 'M12 19v3', key: 'south' }],
  ['path', { d: 'M2 12h3', key: 'west' }],
  ['path', { d: 'M19 12h3', key: 'east' }],
])

/**
 * A gas giant: two bands across a disk that fills the canvas.
 *
 * Bands are the one feature every gas giant in every photograph has, and they
 * are also the only interior mark that survives being drawn at 14 px — a Great
 * Red Spot at this scale is a smudge. Two rather than three, spaced 6 px, which
 * is what keeps them from fusing into a grey block on a low-DPI display.
 */
export const GasGiant = createLucideIcon('GasGiant', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'disc' }],
  ['path', { d: 'M6 9h12', key: 'band-north' }],
  ['path', { d: 'M6 15h12', key: 'band-south' }],
])

/**
 * An ice giant: one band, and it is tilted.
 *
 * The tilt is the distinction and it is not decoration — Uranus is 98° over,
 * which is the single fact anybody knows about an ice giant, and a horizontal
 * band would make this glyph a gas giant with one band missing. 30° is as
 * shallow as the difference reads at 14 px.
 */
export const IceGiant = createLucideIcon('IceGiant', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'disc' }],
  ['path', { d: 'M6.8 15 17.2 9', key: 'band' }],
])

/**
 * An ice world: a disk with two caps.
 *
 * Chords rather than filled polar regions, because a fill is not in this set's
 * vocabulary — every glyph here is a stroke — and because two short horizontal
 * strokes near the poles is exactly how a planetary chart draws an ice cap.
 */
export const IceWorld = createLucideIcon('IceWorld', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'disc' }],
  ['path', { d: 'M7.5 6.6h9', key: 'cap-north' }],
  ['path', { d: 'M7.5 17.4h9', key: 'cap-south' }],
])

/**
 * A moon: a smaller disk with a crater in it.
 *
 * Not a crescent, which is what every icon set reaches for and would be wrong
 * twice here: Lucide's `Moon` already means *night* across the whole web, and
 * this interface has four phase glyphs two sections up whose entire subject is
 * how much of a disk is lit. A crescent in the catalog would read as one of
 * those. A cratered disk is airless rock and nothing else.
 */
export const MoonBody = createLucideIcon('MoonBody', [
  ['circle', { cx: '12', cy: '12', r: '7', key: 'disc' }],
  ['circle', { cx: '14.5', cy: '9.5', r: '1.5', key: 'crater' }],
])

/**
 * A dwarf planet: round, and sharing its orbit.
 *
 * The two specks are the definition. Since 2006 the line between a planet and a
 * dwarf is not size, shape or composition — Ceres and Pluto are both round —
 * it is whether the body has cleared its neighborhood, and everything that has
 * not is still traveling with the rubble it formed from. Drawing that is the
 * only way this glyph says anything a smaller circle would not.
 */
export const DwarfPlanet = createLucideIcon('DwarfPlanet', [
  ['circle', { cx: '12', cy: '12', r: '5', key: 'disc' }],
  ['circle', { cx: '3', cy: '12', r: '1', key: 'neighbour-west' }],
  ['circle', { cx: '21', cy: '12', r: '1', key: 'neighbour-east' }],
])

/**
 * An asteroid: the shape gravity never rounded off.
 *
 * Six vertices, deliberately unequal, and no interior mark — an irregular
 * outline is the whole statement and anything inside it competes with the one
 * thing this glyph has to say. It is also literally what `BodyFigure` means:
 * present exactly when a body is not a spheroid.
 */
export const Asteroid = createLucideIcon('Asteroid', [
  ['path', { d: 'M12 3 19 7 20 15 13 21 5 17 4 8Z', key: 'body' }],
])

/**
 * A comet: a nucleus with two tails.
 *
 * Two, because one is an arrow. They are also two different things — the ion
 * tail is straight and points dead away from the star, the dust tail curves
 * along the orbit — and that pair is what makes a shape read as a comet rather
 * than as a shooting star. The nucleus sits low-left so both tails have the
 * full diagonal to run along.
 */
export const Comet = createLucideIcon('Comet', [
  ['circle', { cx: '8', cy: '16', r: '3', key: 'nucleus' }],
  ['path', { d: 'm12.5 12.5 8.5-8.5', key: 'ion-tail' }],
  ['path', { d: 'M13.5 15.5c3-.5 5.5-2 7-4', key: 'dust-tail' }],
])

/**
 * The neighborhood: what is out there within a few light years.
 *
 * `StellarSpan` above is the *measure* between two stars — a span with arrow
 * heads, which is a dimension. This is the volume: a handful of stars at
 * different distances around one that is here. It is the catalog's "near"
 * heading and the shape of the question that heading answers.
 */
export const Neighbourhood = createLucideIcon('Neighbourhood', [
  ['circle', { cx: '12', cy: '12', r: '2.5', key: 'here' }],
  ['circle', { cx: '4', cy: '6', r: '1', key: 'near' }],
  ['circle', { cx: '20', cy: '8', r: '1', key: 'far' }],
  ['circle', { cx: '18', cy: '19', r: '1', key: 'further' }],
  ['circle', { cx: '5', cy: '17', r: '1', key: 'furthest' }],
])

/* ------------------------------------------------------------------------- */
/* Brands Lucide no longer ships                                              */
/* ------------------------------------------------------------------------- */

/*
 * Lucide dropped brand icons; the Octocat is still the recognisable mark for
 * "this repository on GitHub", and the geometry is the one Lucide used to ship
 * — stroke, round caps, 24×24 — so it sits next to every other icon here.
 */
export const Github = createLucideIcon('Github', [
  [
    'path',
    {
      d: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4',
      key: 'body',
    },
  ],
  ['path', { d: 'M9 18c-4.51 2-5-2-7-2', key: 'arm' }],
])
