import { Globe, type LucideIcon } from 'lucide-react'
import type { BodyKind } from '@inertialref/universe'
import type { TravelTarget } from '@inertialref/devtools'
import {
  Asteroid,
  Comet,
  DwarfPlanet,
  GasGiant,
  IceGiant,
  IceWorld,
  MoonBody,
  StarBody,
} from '../icons/index.tsx'

/*
 * What each class of object looks like, and how the catalog is filtered by it.
 *
 * Its own module because two panels read it and neither may export a constant
 * beside a component — the Fast Refresh rule `context.ts` and `presets.ts`
 * already follow, and in this app a full reload rebuilds the renderer and loses
 * the camera.
 *
 * It is also the one place the mapping is written down. The catalog row, the
 * object panel's header and the filter chips each drew their own conclusion
 * about what a `dwarf` is, and the row's version was not about the class at all
 * — it branched on how deep the *address* was, so Ganymede and Pluto came out
 * as the same glyph and Bennu came out as Earth.
 */

/**
 * The glyph for a body's class.
 *
 * A terrestrial planet is Lucide's own `Globe` rather than a tenth icon in
 * `icons/index.tsx`: a circle with a meridian and an equator already *is* the
 * drawing of a world with a surface, and it is drawn by the same hand as the
 * rest of the set. See that file's header for where the line is.
 */
const KIND_ICON: Readonly<Record<BodyKind, LucideIcon>> = {
  rocky: Globe,
  ice: IceWorld,
  'gas-giant': GasGiant,
  'ice-giant': IceGiant,
  moon: MoonBody,
  dwarf: DwarfPlanet,
  asteroid: Asteroid,
  comet: Comet,
}

/** The glyph for anything the catalog can list, star or body. */
export const iconForKind = (kind: BodyKind | null): LucideIcon =>
  // `?? StarBody` is unreachable against the table above, which is exhaustive
  // by its `Record<BodyKind, …>` type. It is here because `noUncheckedIndexedAccess`
  // is on and the alternative is a non-null assertion, which would also be the
  // thing that stopped compiling if a ninth class were added.
  kind === null ? StarBody : (KIND_ICON[kind] ?? StarBody)

/**
 * A filter the catalog offers, as a chip.
 *
 * Six rather than nine, and the grouping is the one a person browsing actually
 * makes: the four planet classes are one chip because "show me the planets" is
 * a question and "show me the ice giants but not the gas giants" is not. The
 * three that are separate — dwarfs, asteroids, comets — are separate because
 * they are fifty-nine of Sol's sixty-six bodies, and hiding them is the single
 * most useful thing this control does.
 */
export interface ObjectClass {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  readonly accepts: (row: TravelTarget) => boolean
}

const isPlanet = (kind: BodyKind | null): boolean =>
  kind === 'rocky' ||
  kind === 'ice' ||
  kind === 'gas-giant' ||
  kind === 'ice-giant'

export const OBJECT_CLASSES: readonly ObjectClass[] = [
  {
    id: 'stars',
    label: 'Stars',
    icon: StarBody,
    accepts: (row) => row.kind === 'system',
  },
  {
    id: 'planets',
    label: 'Planets',
    icon: Globe,
    accepts: (row) => isPlanet(row.bodyKind),
  },
  {
    id: 'moons',
    label: 'Moons',
    icon: MoonBody,
    accepts: (row) => row.bodyKind === 'moon',
  },
  {
    id: 'dwarfs',
    label: 'Dwarfs',
    icon: DwarfPlanet,
    accepts: (row) => row.bodyKind === 'dwarf',
  },
  {
    id: 'asteroids',
    label: 'Asteroids',
    icon: Asteroid,
    accepts: (row) => row.bodyKind === 'asteroid',
  },
  {
    id: 'comets',
    label: 'Comets',
    icon: Comet,
    accepts: (row) => row.bodyKind === 'comet',
  },
]

/** Every class, which is what "no filter" means. */
export const ALL_CLASSES: readonly string[] = OBJECT_CLASSES.map(
  (one) => one.id,
)

/**
 * Whether a row survives the chosen classes.
 *
 * An empty selection means *everything*, not nothing. A filter that could be
 * turned all the way off and leave an empty list is a control whose worst state
 * looks identical to a failed survey, and the way out of it is not discoverable
 * from the empty list itself.
 */
export function acceptsRow(
  row: TravelTarget,
  chosen: readonly string[],
): boolean {
  if (chosen.length === 0 || chosen.length === OBJECT_CLASSES.length)
    return true
  return OBJECT_CLASSES.some(
    (one) => chosen.includes(one.id) && one.accepts(row),
  )
}

/**
 * A star's own colour as a CSS string, or null for a body.
 *
 * The catalog carries **linear** sRGB — the value the renderer lights the sky
 * with — and CSS wants the gamma-encoded form, so this is the transfer function
 * and not a `Math.round` of three floats. Without it every star comes out
 * noticeably darker in the panel than it is in the frame: an M dwarf's blue
 * channel is 0.16 linear, which is 111 encoded and 41 not.
 *
 * **Nothing else is done to it.** A brightness floor was tried first, on the
 * argument that a saturated M-dwarf red at 12 px over slate is hard to see —
 * and lifting every channel toward white is *desaturation*, which is the one
 * move `docs/design/art.md` forbids by name: "A K dwarf is orange. It does not
 * get to be a nicer orange." At 0.45 it turned the whole neighborhood into pale
 * peach and Sirius into off-white, which is a rail of nine identical dots.
 *
 * It does not need one. `blackbodyColour` normalizes the brightest channel to
 * 1, so every star has a channel at full and no glyph can come out dim — the
 * legibility the floor was buying is already there, and the hue is what was
 * being spent for it.
 */
export function starColour(colour: TravelTarget['colour']): string | null {
  if (colour === null) return null
  const channel = (linear: number): number => {
    const value = Math.min(1, Math.max(0, linear))
    const encoded =
      value <= 0.003_130_8
        ? 12.92 * value
        : 1.055 * Math.pow(value, 1 / 2.4) - 0.055
    return Math.round(encoded * 255)
  }
  return `rgb(${channel(colour.r)} ${channel(colour.g)} ${channel(colour.b)})`
}
