/*
 * Names.
 *
 * One star carries as many names as there are catalogues that recorded it, and
 * none of them is *the* name:
 *
 *   Rigil Kentaurus · Alpha Centauri A · α¹ Cen · HIP 71683 · HD 128620 ·
 *   HR 5459 · GJ 559 A
 *
 * All seven refer to the same object, a player might type any of them, and
 * exactly one of them should appear on the HUD. That makes three separate jobs,
 * and conflating them is how a star ends up displayed as "HIP71683":
 *
 *   1. **Canonicalise** — pick one stable `SystemId` per system, so the address
 *      of a place does not change when the catalogue is rebuilt.
 *   2. **Choose a common name** — the one that goes on screen. Almost always the
 *      most familiar, which is almost never the catalogue key.
 *   3. **Keep the alternates** — so search finds the star by any of them, and so
 *      the system panel can cite what it is claiming and from where.
 *
 * The `SystemId` is *not* the display name and the display name is *not*
 * stable — a catalogue revision may give a star an IAU proper name it did not
 * have, and that must change what is on screen without changing any address.
 */

/** Which catalogue or convention a name comes from. */
export type DesignationKind =
  | 'proper'
  | 'bayer'
  | 'flamsteed'
  | 'gliese'
  | 'hipparcos'
  | 'henry-draper'
  | 'harvard-revised'
  | 'variable'

export interface Designation {
  readonly kind: DesignationKind
  /** Written out the way a person would say it: `Alpha Centauri`, `HIP 71683`. */
  readonly text: string
}

/*
 * Bayer letters as HYG abbreviates them, with the spelled and the Greek forms.
 *
 * Both forms are indexed for search: somebody will paste `α Cen` out of
 * Wikipedia and somebody else will type `alpha centauri`, and neither should
 * come back empty.
 */
const GREEK: Readonly<Record<string, readonly [string, string]>> = {
  Alp: ['Alpha', 'α'],
  Bet: ['Beta', 'β'],
  Gam: ['Gamma', 'γ'],
  Del: ['Delta', 'δ'],
  Eps: ['Epsilon', 'ε'],
  Zet: ['Zeta', 'ζ'],
  Eta: ['Eta', 'η'],
  The: ['Theta', 'θ'],
  Iot: ['Iota', 'ι'],
  Kap: ['Kappa', 'κ'],
  Lam: ['Lambda', 'λ'],
  Mu: ['Mu', 'μ'],
  Nu: ['Nu', 'ν'],
  Xi: ['Xi', 'ξ'],
  Omi: ['Omicron', 'ο'],
  Pi: ['Pi', 'π'],
  Rho: ['Rho', 'ρ'],
  Sig: ['Sigma', 'σ'],
  Tau: ['Tau', 'τ'],
  Ups: ['Upsilon', 'υ'],
  Phi: ['Phi', 'φ'],
  Chi: ['Chi', 'χ'],
  Psi: ['Psi', 'ψ'],
  Ome: ['Omega', 'ω'],
}

/**
 * The 88 constellations, abbreviation to genitive.
 *
 * The genitive is the whole point: a Bayer designation means "the alpha *of*
 * Centaurus", and `Cen` → `Centauri` is what turns `Tau Cet` into `Tau Ceti`
 * and `61 Cyg` into `61 Cygni`. Those are the names players actually know —
 * within 150 ly only 221 stars of 7,529 carry an IAU proper name, while 649
 * carry a Bayer or Flamsteed designation, so this table roughly quadruples the
 * number of stars with a name a human recognises.
 */
const CONSTELLATIONS: Readonly<Record<string, string>> = {
  And: 'Andromedae',
  Ant: 'Antliae',
  Aps: 'Apodis',
  Aqr: 'Aquarii',
  Aql: 'Aquilae',
  Ara: 'Arae',
  Ari: 'Arietis',
  Aur: 'Aurigae',
  Boo: 'Boötis',
  Cae: 'Caeli',
  Cam: 'Camelopardalis',
  Cnc: 'Cancri',
  CVn: 'Canum Venaticorum',
  CMa: 'Canis Majoris',
  CMi: 'Canis Minoris',
  Cap: 'Capricorni',
  Car: 'Carinae',
  Cas: 'Cassiopeiae',
  Cen: 'Centauri',
  Cep: 'Cephei',
  Cet: 'Ceti',
  Cha: 'Chamaeleontis',
  Cir: 'Circini',
  Col: 'Columbae',
  Com: 'Comae Berenices',
  CrA: 'Coronae Australis',
  CrB: 'Coronae Borealis',
  Crv: 'Corvi',
  Crt: 'Crateris',
  Cru: 'Crucis',
  Cyg: 'Cygni',
  Del: 'Delphini',
  Dor: 'Doradus',
  Dra: 'Draconis',
  Equ: 'Equulei',
  Eri: 'Eridani',
  For: 'Fornacis',
  Gem: 'Geminorum',
  Gru: 'Gruis',
  Her: 'Herculis',
  Hor: 'Horologii',
  Hya: 'Hydrae',
  Hyi: 'Hydri',
  Ind: 'Indi',
  Lac: 'Lacertae',
  Leo: 'Leonis',
  LMi: 'Leonis Minoris',
  Lep: 'Leporis',
  Lib: 'Librae',
  Lup: 'Lupi',
  Lyn: 'Lyncis',
  Lyr: 'Lyrae',
  Men: 'Mensae',
  Mic: 'Microscopii',
  Mon: 'Monocerotis',
  Mus: 'Muscae',
  Nor: 'Normae',
  Oct: 'Octantis',
  Oph: 'Ophiuchi',
  Ori: 'Orionis',
  Pav: 'Pavonis',
  Peg: 'Pegasi',
  Per: 'Persei',
  Phe: 'Phoenicis',
  Pic: 'Pictoris',
  Psc: 'Piscium',
  PsA: 'Piscis Austrini',
  Pup: 'Puppis',
  Pyx: 'Pyxidis',
  Ret: 'Reticuli',
  Sge: 'Sagittae',
  Sgr: 'Sagittarii',
  Sco: 'Scorpii',
  Scl: 'Sculptoris',
  Sct: 'Scuti',
  Ser: 'Serpentis',
  Sex: 'Sextantis',
  Tau: 'Tauri',
  Tel: 'Telescopii',
  Tri: 'Trianguli',
  TrA: 'Trianguli Australis',
  Tuc: 'Tucanae',
  UMa: 'Ursae Majoris',
  UMi: 'Ursae Minoris',
  Vel: 'Velorum',
  Vir: 'Virginis',
  Vol: 'Volantis',
  Vul: 'Vulpeculae',
}

export const constellationGenitive = (abbreviation: string): string | null =>
  CONSTELLATIONS[abbreviation.trim()] ?? null

const SUPERSCRIPTS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'] as const

const superscript = (digits: string): string =>
  [...digits].map((d) => SUPERSCRIPTS[Number.parseInt(d, 10)] ?? d).join('')

export interface BayerName {
  /** `Alpha Centauri`, or `Alpha¹ Centauri` when the superscript is kept. */
  readonly text: string
  /** `α Cen` — the form that gets pasted out of a paper. */
  readonly greek: string
  /** True when this star shares its letter with a sibling (α¹ and α² Cen). */
  readonly hasSuperscript: boolean
}

/**
 * Expand HYG's `bayer` field against its `con` field.
 *
 * `bayer` arrives as `Alp`, `Alp-1`, `Kap-1`. The superscript distinguishes
 * stars that share a Greek letter — sometimes two components of one system
 * (α¹/α² Cen), sometimes two unrelated stars that happen to sit near each other
 * (κ¹/κ² Scl). `keepSuperscript` is the caller's decision because only the
 * caller knows which case it has; dropping it always would collide two
 * different systems onto one name.
 */
export function bayerName(
  bayer: string,
  constellation: string,
  keepSuperscript = true,
): BayerName | null {
  const match = /^([A-Za-z]+)(?:-([0-9]+))?$/.exec(bayer.trim())
  if (match === null) return null
  const letter = GREEK[match[1] as string]
  const genitive = constellationGenitive(constellation)
  if (letter === undefined || genitive === null) return null
  const index = match[2]
  const mark = index !== undefined && keepSuperscript ? superscript(index) : ''
  return {
    text: `${letter[0]}${mark} ${genitive}`,
    greek: `${letter[1]}${mark} ${constellation.trim()}`,
    hasSuperscript: index !== undefined,
  }
}

/** `61` + `Cyg` → `61 Cygni`. */
export function flamsteedName(
  flamsteed: string,
  constellation: string,
): string | null {
  const number = flamsteed.trim()
  if (!/^[0-9]+$/.test(number)) return null
  const genitive = constellationGenitive(constellation)
  return genitive === null ? null : `${number} ${genitive}`
}

/**
 * `Gl 551` and `GJ 3063` and `NN 3005` → `Gliese 551`, `Gliese 3063`,
 * `NN 3005`.
 *
 * `Gl` and `GJ` are the same catalogue under two prefixes and both expand;
 * `NN` and `Wo` are the un-numbered supplements and keep their prefix, because
 * "Gliese NN 3005" is not a thing anybody writes.
 */
export function glieseName(gl: string): string | null {
  const text = gl.trim()
  if (text === '') return null
  const match = /^(Gl|GJ)\s*(.+)$/.exec(text)
  return match === null ? text : `Gliese ${match[2] as string}`
}

/* ------------------------------------------------------------------------- */
/* Search                                                                     */
/* ------------------------------------------------------------------------- */

// Built from SUPERSCRIPTS so the fold below and `superscript()` can never
// disagree about which marks exist.
const SUPERSCRIPT_PATTERN = new RegExp(`[${SUPERSCRIPTS.join('')}]`, 'g')

/**
 * Fold a name to the form the index is keyed by.
 *
 * Everything that is punctuation, spacing, case or diacritic is noise a player
 * should not have to reproduce: `HIP 71683`, `hip71683` and `Hip-71683` are the
 * same query, and `Boötis` must be reachable by typing `bootis`.
 *
 * Superscript digits fold to their ASCII forms rather than being stripped:
 * NFD does not decompose them, and dropping them keyed `Zeta¹ Reticuli` and
 * `Zeta² Reticuli` — two unrelated systems — to the same string, while the
 * typeable `zeta2 reticuli` matched nothing at all.
 */
export function searchKey(text: string): string {
  return text
    .replace(SUPERSCRIPT_PATTERN, (mark) =>
      String(SUPERSCRIPTS.indexOf(mark as (typeof SUPERSCRIPTS)[number])),
    )
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9α-ω]+/g, '')
}

/** Every string a star should be findable by, deduplicated. */
export function searchKeysFor(
  names: readonly Designation[],
  extra: readonly string[] = [],
): readonly string[] {
  const keys = new Set<string>()
  for (const name of names) {
    const key = searchKey(name.text)
    if (key !== '') keys.add(key)
  }
  for (const text of extra) {
    const key = searchKey(text)
    if (key !== '') keys.add(key)
  }
  return [...keys].sort()
}
