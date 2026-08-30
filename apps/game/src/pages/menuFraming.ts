/*
 * The front door's composition, as numbers.
 *
 * Shared by the menu page (which holds the type) and `stanceForPath` (which
 * the persisted backdrop reads on a navigation). They are one picture: a
 * disagreement here is a menu that says Earth and a camera that shows
 * something else.
 *
 * `anglesForPhase` solves the camera against the sun line: phase 0 is the
 * fully lit face with the star behind the lens, 180 is dead anti-sun. The
 * numbers were read off the running page, not derived:
 *
 *   MENU_PHASE  −112°  a broad lit disk turned three-quarters away from the
 *                      star, still the blue marble and not yet a crescent,
 *                      with the star just past the right edge. Negative so
 *                      the star sits in the empty right of the poster
 *                      rather than under the type.
 *   MENU_TILT     16°  the orbit is tipped off the star's own plane, so the
 *                      star sits above the limb rather than on it.
 *   MENU_FILL    0.66  a hair smaller than 0.78. The extra sky is what the
 *                      streak has to cross.
 */

/** Earth. The body the front door is a picture of. */
export const MENU_ADDRESS = 's:SOL/b:2'

/** Sun-body-camera angle in degrees. Negative: star in the empty right. */
export const MENU_PHASE = -112

/** Roll of the swing plane out of the star's own, in degrees. */
export const MENU_TILT = 16

/** Fraction of the band's height the body subtends. */
export const MENU_FILL = 0.66

/**
 * How much of the lens's ghost chain a content page shows. About a third.
 *
 * The ghosts run along the line from the star through the center of the
 * frame, and at full strength the red aperture ring lands on the type. A
 * third is where the anamorphic streak still reads and the ring has become
 * two faint smudges on empty sky. The reading room uses the same third, for
 * the same reason, in a band rather than a poster.
 */
export const MENU_FLARE_ARTIFACTS = 0.35
