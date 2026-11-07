import type { OrbitalKind } from './stations.ts'
import type { BodyKind } from './system.ts'

/*
 * One taxonomy for everything the planetarium lists, names and picks.
 *
 * Four readers sort what they show by what it is: the navigator's class chips,
 * the names on the sky, the click targets and the orbit traces. Each reads the
 * class here and makes its own selection from it — what is listed and what is
 * written on the sky are different questions, so the selections stay separate
 * and the table does not.
 *
 * A `Record` over every kind rather than a set of strings at each site: an
 * untyped set compiles against a ninth `BodyKind` and puts it silently in the
 * wrong half of every copy. Here a new body class or a new placement kind is
 * a type error until it is given a class.
 */

/** Anything the planetarium can list, name or pick, by its own kind. */
export type ObjectKind = 'star' | BodyKind | OrbitalKind

/**
 * What a thing is, for every reader that sorts by it.
 *
 * - `planet` is the IAU's: round *and* clear of its neighborhood. Everything
 *   orbiting the star is in `system.planets`, so this is what separates the
 *   eight from the rest.
 * - `dwarf` is not `minor`. Pluto, Ceres, Eris, Haumea and Makemake are the
 *   bodies a planetarium reader most wants context for — "where does Pluto's
 *   orbit cross Neptune's" is the question the 2006 vote was about — and there
 *   are nine of them, not fifty-nine.
 * - `minor` is the rubble: asteroids and comets, fifty-nine of Sol's
 *   sixty-seven bodies, drawn and named only when they are the subject or go
 *   round it.
 * - `spacecraft` is built: a station now, a ship when ships are planetarium
 *   subjects. Below every natural body in the declutter, named nearby, and
 *   clickable only where something of it is on screen.
 */
export type ObjectClass =
  'star' | 'planet' | 'moon' | 'dwarf' | 'minor' | 'spacecraft'

const CLASS: Readonly<Record<ObjectKind, ObjectClass>> = {
  star: 'star',
  rocky: 'planet',
  ice: 'planet',
  'gas-giant': 'planet',
  'ice-giant': 'planet',
  moon: 'moon',
  dwarf: 'dwarf',
  asteroid: 'minor',
  comet: 'minor',
  station: 'spacecraft',
}

/** The class of a star, a body's kind or a placement's kind. */
export const objectClass = (kind: ObjectKind): ObjectClass => CLASS[kind]
