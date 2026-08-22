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
 *   - 2 px stroke, centred, round caps and round joins
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
/* Phase — the terminator across a disc                                       */
/* ------------------------------------------------------------------------- */

/*
 * The planetarium's lighting presets are photographic terms — full, gibbous,
 * half, crescent — and they are the *only* control in the interface whose
 * effect is a picture rather than a number. Words alone make four buttons that
 * look identical; the glyph is the specification.
 *
 * All three are the same disc (r = 9, so 3 px of padding) with the terminator
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

/** A sliver: the terminator bows towards the lit limb. */
export const PhaseCrescent = createLucideIcon('PhaseCrescent', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'disc' }],
  ['path', { d: 'M12 3a5 9 0 0 1 0 18', key: 'terminator' }],
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
 * body's disc ends at r = 2 and the influence ring starts at r = 5, and the
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
 * Two discs with a span between them is what a light year *is* in the only
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
 * Delta-v: the budget a manoeuvre spends.
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
