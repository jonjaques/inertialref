/*
 * Where the shapes come from.
 *
 * Same discipline as the textures: pinned URLs, recorded credit, and a manifest
 * beside the output saying what produced each file. The difference is that
 * every one of these is **public domain NASA/PDS material**, so there is no
 * license to comply with — only provenance, which matters more here than it
 * does for a picture. A surface map that is slightly wrong is a slightly wrong
 * picture. A shape model that is slightly wrong is a different asteroid.
 *
 * ## The three formats, and why there are three
 *
 * Nobody publishes shape models in one format, because the people who make them
 * are measuring different things.
 *
 *   - **`grid`** — a latitude/longitude table of radii, one line per sample.
 *     Peter Thomas's models of the small satellites and Philip Stooke's
 *     small-body atlas are both this. It is already the format this project
 *     ships, so ingesting one is a resample and nothing else.
 *   - **`obj`** — `v x y z` and `f a b c`. Radar inversions and the OSIRIS-REx
 *     altimetry both come this way.
 *   - **`vertex`** — Robert Gaskell's stereophotoclinometry output: a count
 *     line, then numbered vertices, then numbered facets. A mesh with a
 *     different preamble.
 *
 * The last two are converted by casting a ray per output sample, which is
 * exact for the sample and says nothing about what is between samples — hence
 * the volume check in `shapes.ts`.
 *
 * ## Resolution
 *
 * Output width is chosen to match what the source actually resolves, not to
 * fill a budget. Thomas's Deimos is a 5° grid: 2,701 numbers, and asking for
 * 512 columns would interpolate 130,000 of them out of it and ship the
 * interpolation as if it were data. Phobos is a 2° grid and earns 256. Bennu
 * was mapped at six meters on a body 500 across, and earns everything.
 */

export type ShapeFormat = 'grid' | 'obj' | 'vertex'

export interface ShapeSource {
  /** Shape-model key, matching `BodyFigure.model`. */
  readonly key: string
  /** The body, for the manifest and the report. */
  readonly name: string
  readonly url: string
  /** Cache filename under `.data/shapes/`. */
  readonly file: string
  readonly format: ShapeFormat
  /** Column order for `grid`. Everything else ignores it. */
  readonly columns?: 'lat-lon-radius' | 'lon-lat-radius'
  /** Multiply source lengths by this to get meters. Every source here is km. */
  readonly scale: number
  readonly credit: string
  readonly reference: string
  /** Output longitude samples. Latitude is half this, plus the pole row. */
  readonly width: number
  readonly minimumBytes: number
}

const KM = 1_000

const THOMAS =
  'P. C. Thomas, PDS Small Bodies Node (ast-sat.thomas.shape-models)'
const STOOKE =
  'P. J. Stooke, PDS Small Bodies Node (small_bodies.stooke.shape-models)'
const GASKELL = 'R. W. Gaskell, PDS Small Bodies Node'
const RADAR = 'PDS Small Bodies Node radar shape model compilation'
const OREX = 'NASA / OSIRIS-REx / University of Arizona (PDS Small Bodies Node)'

const SBN = 'https://sbnarchive.psi.edu/pds4/non_mission'

const thomas = (
  key: string,
  name: string,
  file: string,
  width: number,
  reference: string,
): ShapeSource => ({
  key,
  name,
  url: `${SBN}/ast-sat.thomas.shape-models_V1_0/data/${file}`,
  file,
  format: 'grid',
  columns: 'lat-lon-radius',
  scale: KM,
  credit: THOMAS,
  reference,
  width,
  minimumBytes: 40_000,
})

const stooke = (
  key: string,
  name: string,
  file: string,
  reference: string,
): ShapeSource => ({
  key,
  name,
  url: `${SBN}/small_bodies.stooke.shape-models/data/${file}`,
  file,
  format: 'grid',
  columns: 'lon-lat-radius',
  scale: KM,
  credit: STOOKE,
  reference,
  // Stooke's atlas is a uniform 5° grid — 73 × 37 samples. 128 columns is
  // already a slight upsample and 256 would be inventing three quarters of it.
  width: 128,
  minimumBytes: 40_000,
})

const radar = (
  key: string,
  name: string,
  file: string,
  width: number,
  reference: string,
): ShapeSource => ({
  key,
  name,
  url: `${SBN}/compil.ast.radar.shape-models/data/${file}`,
  file,
  format: 'obj',
  scale: KM,
  credit: RADAR,
  reference,
  width,
  minimumBytes: 100_000,
})

export const SHAPE_SOURCES: readonly ShapeSource[] = [
  /* --- The Martian moons. Viking, and still the best data anyone has. */
  thomas(
    'phobos',
    'Phobos',
    'm1phobos.tab',
    256,
    'Thomas, P.C., Icarus 105, 326–344 (1993) — 2° grid from Viking Orbiter imaging',
  ),
  thomas(
    'deimos',
    'Deimos',
    'm2deimos.tab',
    128,
    'Thomas, P.C., Icarus 105, 326–344 (1993) — 5° grid from Viking Orbiter imaging',
  ),

  /* --- Bennu, at six meters. The best-resolved shape of anything, anywhere. */
  {
    key: 'bennu',
    name: 'Bennu',
    // SPO v54: the OSIRIS-REx stereophotoclinometry model tied to OLA
    // altimetry. 6.32 m per facet on a body 500 m across; the 0.8 m product
    // exists and is 225 MB for detail three times finer than the output grid.
    url: 'https://sbnarchive.psi.edu/pds4/orex/orex.altimetry/data_derived_altimetry_global_models/global_digital_terrain_models/SPOv54/g_06320mm_spo_obj_0000n00000_v054.obj',
    file: 'bennu_spo_v054.obj',
    format: 'obj',
    scale: KM,
    credit: OREX,
    reference:
      'Barnouin, O.S. et al., Planet. Space Sci. 180, 104764 (2020); Daly, M.G. et al., Sci. Adv. 6, eabd3649 (2020)',
    width: 512,
    minimumBytes: 1_000_000,
  },

  /* --- Visited asteroids. */
  {
    key: 'eros',
    name: '433 Eros',
    url: `${SBN}/gaskell.ast-eros.shape-model_V1_1/data/vertex/ver64q.tab`,
    file: 'eros_ver64q.tab',
    format: 'vertex',
    scale: KM,
    credit: GASKELL,
    reference:
      'Gaskell, R.W. (2008), NEAR MSI stereophotoclinometry — 25,350 vertices',
    width: 256,
    minimumBytes: 1_000_000,
  },
  {
    key: 'itokawa',
    name: '25143 Itokawa',
    // Gaskell's Hayabusa model rather than the radar one in the compilation
    // beside it. Both are archived and they disagree: the 2004 radar inversion
    // makes Itokawa 535 × 294 × 280 m, and the spacecraft that went there
    // measured 535 × 294 × 209. A pre-encounter model is a prediction, and
    // this project does not ship predictions of things that have been visited.
    url: `${SBN}/gaskell.ast-itokawa.shape-model_V1_1/data/vertex/ver64q.tab`,
    file: 'itokawa_ver64q.tab',
    format: 'vertex',
    scale: KM,
    credit: GASKELL,
    reference:
      'Gaskell, R.W. et al. (2008), Hayabusa AMICA stereophotoclinometry — 25,350 vertices',
    width: 256,
    minimumBytes: 1_000_000,
  },
  thomas(
    'vesta',
    '4 Vesta',
    '4vesta.tab',
    128,
    'Thomas, P.C. et al., Icarus 128, 88–94 (1997) — HST limb profiles',
  ),
  thomas(
    'ida',
    '243 Ida',
    '243ida.tab',
    256,
    'Thomas, P.C. et al., Icarus 120, 20–32 (1996) — Galileo SSI',
  ),
  thomas(
    'gaspra',
    '951 Gaspra',
    '951gaspra.tab',
    256,
    'Thomas, P.C. et al., Icarus 107, 23–36 (1994) — Galileo SSI',
  ),
  thomas(
    'mathilde',
    '253 Mathilde',
    '253mathilde.tab',
    128,
    'Thomas, P.C. et al., Icarus 140, 17–27 (1999) — NEAR MSI',
  ),
  radar(
    'toutatis',
    '4179 Toutatis',
    '4179toutatis.tab',
    256,
    'Hudson, R.S. & Ostro, S.J., Science 270, 84–86 (1995) — Goldstone/Arecibo radar',
  ),
  radar(
    'kleopatra',
    '216 Kleopatra',
    '216kleopatra.tab',
    128,
    'Ostro, S.J. et al., Science 288, 836–839 (2000) — Arecibo radar',
  ),
  radar(
    'geographos',
    '1620 Geographos',
    '1620geographos.tab',
    128,
    'Hudson, R.S. & Ostro, S.J., Icarus 140, 369–378 (1999) — Goldstone radar',
  ),
  radar(
    'golevka',
    '6489 Golevka',
    '6489golevka.tab',
    128,
    'Hudson, R.S. et al., Icarus 148, 37–51 (2000) — Goldstone/Evpatoria/Arecibo radar',
  ),
  radar(
    'castalia',
    '4769 Castalia',
    '4769castalia.tab',
    128,
    'Hudson, R.S. & Ostro, S.J., Science 263, 940–943 (1994) — the first resolved contact binary',
  ),
  radar(
    'ky26',
    '1998 KY26',
    '1998ky26.tab',
    128,
    'Ostro, S.J. et al., Science 285, 557–559 (1999) — a 30 m rock, and a Hayabusa2 target',
  ),

  /* --- Small moons: the ones with a measured figure rather than a diameter. */
  thomas(
    'hyperion',
    'Hyperion',
    's7hyperion.tab',
    128,
    'Thomas, P.C. et al., Icarus 190, 573–584 (2007) — Cassini ISS',
  ),
  thomas(
    'janus',
    'Janus',
    's10janus.tab',
    128,
    'Thomas, P.C., Icarus 105, 326–344 (1993); Cassini ISS',
  ),
  thomas(
    'epimetheus',
    'Epimetheus',
    's11epimetheus.tab',
    128,
    'Thomas, P.C., Icarus 105, 326–344 (1993); Cassini ISS',
  ),
  stooke(
    'amalthea',
    'Amalthea',
    'j5amalthea.tab',
    'Stooke, P.J., PDS small-body maps V3.0 — Voyager and Galileo',
  ),
  stooke(
    'thebe',
    'Thebe',
    'j14thebe.tab',
    'Stooke, P.J., PDS small-body maps V3.0 — Galileo SSI',
  ),
  stooke(
    'proteus',
    'Proteus',
    'n8proteus.tab',
    'Stooke, P.J., PDS small-body maps V3.0 — Voyager 2',
  ),
  stooke(
    'larissa',
    'Larissa',
    'n7larissa.tab',
    'Stooke, P.J., PDS small-body maps V3.0 — Voyager 2',
  ),
  stooke(
    'prometheus',
    'Prometheus',
    's16prometheus.tab',
    'Stooke, P.J., PDS small-body maps V3.0 — Voyager and Cassini',
  ),
  stooke(
    'pandora',
    'Pandora',
    's17pandora.tab',
    'Stooke, P.J., PDS small-body maps V3.0 — Voyager and Cassini',
  ),

  /* --- A comet nucleus, from the only fleet that ever flew through one. */
  stooke(
    'halley',
    '1P/Halley',
    '1682q1halley.tab',
    'Stooke, P.J., PDS small-body maps V3.0 — Giotto and Vega imaging, 1986',
  ),
]
