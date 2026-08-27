/*
 * Morgan-Keenan spectral type parsing.
 *
 * This exists because published catalogs do not contain MK strings; they
 * contain whatever the compiler of each source catalog wrote down. Within
 * 150 ly HYG v4.4 carries 796 distinct spectral strings across 7,529 stars, and
 * `spect[0]` classifies 87% of them — quietly wrong about the rest:
 *
 *   G2V      ordinary MK                          the case everyone tests
 *   dM4      Yale/Gliese luminosity *prefix*      `d` is "dwarf", not class D
 *   sdM4     subdwarf prefix                      Barnard's Star is one
 *   gK5      giant prefix
 *   m        Gliese shorthand, lowercase, no subclass — 571 of them
 *   k-m      a range between two classes
 *   DA2      a white dwarf; `D` is a real class and must not fall through to M
 *   A0m...   peculiarity suffix, and the `m` is not a class either
 *   F5IV-V   a luminosity range
 *
 * The parser is total: anything it cannot read returns a type with a null class
 * rather than throwing, because "no usable spectral type" is an ordinary answer
 * for 8% of the catalog and the caller has a fallback for it.
 */

/**
 * Spectral classes, hot to cool, then the ones that are not on that sequence.
 *
 * `D` is a white dwarf and `L`/`T`/`Y` are brown dwarfs — neither belongs on the
 * OBAFGKM temperature ladder, which is why `classIndex` returns null for them
 * and interpolating a temperature from the ladder is not a thing callers may do.
 */
export type SpectralClass =
  | 'O'
  | 'B'
  | 'A'
  | 'F'
  | 'G'
  | 'K'
  | 'M'
  | 'L'
  | 'T'
  | 'Y'
  | 'W'
  | 'C'
  | 'S'
  | 'D'

/** Yerkes luminosity classes. `VII` is the white-dwarf convention. */
export type LuminosityClass = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | 'VII'

export interface SpectralType {
  /** Null when the source string carried nothing usable. */
  readonly spectralClass: SpectralClass | null
  /** 0–9.5, or null when the source gave a bare class such as `m` or `K`. */
  readonly subclass: number | null
  readonly luminosity: LuminosityClass | null
  /** The string this was read from, verbatim. Kept so the panel can cite it. */
  readonly source: string
}

export const UNKNOWN_SPECTRAL_TYPE: SpectralType = Object.freeze({
  spectralClass: null,
  subclass: null,
  luminosity: null,
  source: '',
})

const MAIN_SEQUENCE_LADDER = ['O', 'B', 'A', 'F', 'G', 'K', 'M'] as const

const CLASS_LETTERS = new Set<string>([
  ...MAIN_SEQUENCE_LADDER,
  'L',
  'T',
  'Y',
  'W',
  'C',
  'S',
  'D',
])

/**
 * Position on the OBAFGKM ladder as a continuous number: O0 = 0, M9 = 69.
 *
 * Null off the ladder. Every temperature and color fallback keys off this, so
 * a brown dwarf or a white dwarf reaching one of them would be interpolated
 * against stars it has nothing in common with.
 */
export function ladderIndex(type: SpectralType): number | null {
  if (type.spectralClass === null) return null
  const rung = MAIN_SEQUENCE_LADDER.indexOf(
    type.spectralClass as (typeof MAIN_SEQUENCE_LADDER)[number],
  )
  if (rung < 0) return null
  return rung * 10 + (type.subclass ?? 5)
}

/**
 * Luminosity-class prefixes from the Yale and Gliese conventions.
 *
 * Longest first: `sd` must be tried before `d`, or every subdwarf is read as an
 * `s`-class carbon star followed by a dwarf prefix.
 */
const PREFIXES: readonly (readonly [string, LuminosityClass])[] = [
  ['esd', 'VI'],
  ['usd', 'VI'],
  ['sd', 'VI'],
  ['sg', 'I'],
  ['d', 'V'],
  ['g', 'III'],
  ['c', 'I'],
]

const ROMAN: readonly (readonly [string, LuminosityClass])[] = [
  ['VII', 'VII'],
  ['VI', 'VI'],
  ['IV', 'IV'],
  ['V', 'V'],
  ['III', 'III'],
  ['II', 'II'],
  ['I', 'I'],
]

/**
 * Parse one catalog spectral string.
 *
 * Ranges (`k-m`, `F5IV-V`, `G8/K0`) resolve to their first member rather than a
 * midpoint: the first is what the observer led with, and a midpoint invents a
 * classification nobody assigned.
 */
export function parseSpectralType(raw: string): SpectralType {
  const source = raw.trim()
  if (source === '') return UNKNOWN_SPECTRAL_TYPE

  // Take the first member of a range or an alternative before anything else, so
  // `k-m` and `G8/K0` reduce to the single-class problem below.
  let rest = source.split(/[-/]/)[0] ?? source
  if (rest === '') rest = source

  let luminosity: LuminosityClass | null = null

  // A leading uppercase D is a white dwarf and is not a prefix. Test it first;
  // `DA2` would otherwise survive the prefix loop unchanged and then read `D` as
  // a class with `A2` as a subclass, which parses but means nothing.
  if (/^D[ABCOQZXV]?/.test(rest)) {
    const digits = /^D[ABCOQZXV]*([0-9]+(?:\.[0-9])?)/.exec(rest)?.[1]
    const index = digits === undefined ? null : Number.parseFloat(digits)
    return {
      spectralClass: 'D',
      // A white dwarf's temperature index is 50400/Teff, which runs past 9 for
      // the coolest ones — a legitimate catalog string the subclass field's
      // 0–9.9 contract cannot hold. Keep the class, drop the index, the same
      // degradation the ladder below applies.
      subclass: index !== null && index <= 9.9 ? index : null,
      luminosity: 'VII',
      source,
    }
  }

  for (const [prefix, implied] of PREFIXES) {
    // Prefixes are lowercase in the catalogs; matching case-insensitively
    // would eat the `C` of a carbon star and the `D` handled above.
    if (rest.startsWith(prefix) && rest.length > prefix.length) {
      luminosity = implied
      rest = rest.slice(prefix.length)
      break
    }
  }

  const letter = rest.charAt(0).toUpperCase()
  if (!CLASS_LETTERS.has(letter)) return { ...UNKNOWN_SPECTRAL_TYPE, source }
  const spectralClass = letter as SpectralClass
  rest = rest.slice(1)

  const subclassMatch = /^([0-9]+(?:\.[0-9]+)?)/.exec(rest)
  const subclass =
    subclassMatch === null
      ? null
      : Number.parseFloat(subclassMatch[1] as string)
  if (subclassMatch !== null) rest = rest.slice(subclassMatch[0].length)

  if (luminosity === null) {
    // Only a roman numeral at the very start of what is left is a luminosity
    // class. `A0Vvar` gives V; `A0m...` must not give the `m` of a peculiarity
    // any meaning at all.
    for (const [numeral, value] of ROMAN) {
      if (rest.startsWith(numeral)) {
        luminosity = value
        break
      }
    }
  }

  return {
    spectralClass,
    subclass: subclass !== null && subclass <= 9.9 ? subclass : null,
    luminosity,
    source,
  }
}

/** `G2V`, `M5`, `D` — the type written back as a canonical MK string. */
export function formatSpectralType(type: SpectralType): string {
  if (type.spectralClass === null) return ''
  const subclass =
    type.subclass === null
      ? ''
      : Number.isInteger(type.subclass)
        ? String(type.subclass)
        : type.subclass.toFixed(1)
  // A white dwarf's `VII` is a bookkeeping convention, not something anybody
  // writes after the class, so it is not printed.
  const luminosity =
    type.luminosity === null || type.spectralClass === 'D'
      ? ''
      : type.luminosity
  return `${type.spectralClass}${subclass}${luminosity}`
}

export const isGiant = (type: SpectralType): boolean =>
  type.luminosity === 'I' ||
  type.luminosity === 'II' ||
  type.luminosity === 'III'

export const isWhiteDwarf = (type: SpectralType): boolean =>
  type.spectralClass === 'D'

/**
 * Whether a star can be fuel-scooped: hydrogen-rich, and hot enough that a ramscoop
 * gets anything out of the wind. Used by the star map filters and the router.
 */
export const isScoopable = (type: SpectralType): boolean =>
  type.spectralClass !== null &&
  ['O', 'B', 'A', 'F', 'G', 'K', 'M'].includes(type.spectralClass)
