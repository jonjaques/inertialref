/*
 * Where every planetary texture comes from.
 *
 * Same discipline as the star catalog: pinned URLs, recorded licenses, and a
 * manifest beside the output saying exactly what produced each file. A texture
 * with no provenance is a texture nobody can relicense, replace or defend.
 *
 * ## Two licenses, and why not one
 *
 * **NASA and USGS imagery is public domain** and is used wherever a global map
 * exists in a form this pipeline can read. That is the whole of Earth, the Moon
 * at LRO/LOLA resolution, and the four Galilean moons from Voyager and Galileo.
 * It is the right default: it is the actual measurement, it carries no
 * obligation, and `docs/design/art.md` is emphatic that what a player can check
 * must be true.
 *
 * **Solar System Scope is CC BY 4.0** and covers the rest. The gap it fills is
 * real rather than lazy: USGS publishes Mars at 232 m/px and Mercury at
 * 166 m/px, which are 12 GB and 4 GB GeoTIFFs, and the gas giants have no
 * single authoritative global map at all — Jupiter's cloud belts move, so every
 * "map of Jupiter" is a mosaic from one particular week. One attribution line
 * buys a complete, consistent set.
 *
 * ## What is missing
 *
 * Titan, Enceladus, Iapetus, Triton, the Uranian moons and every small body
 * below Bennu have no vendored map and fall back to their measured albedo and
 * color. For the moons that is a size-versus-return judgment. For the small
 * bodies it is that no global mosaic of them exists in a public archive: Eros,
 * Itokawa and Ryugu were mapped by NEAR, Hayabusa and Hayabusa2, and what is
 * archived is images and shape models rather than a projected map.
 *
 * That is also why it matters less than it sounds. A body a few kilometers
 * across is a *silhouette* long before it is a texture, and the silhouettes are
 * vendored: `data/shapes/` has twenty-five measured figures, including all
 * three of those.
 */

export type MapKind = 'albedo' | 'normal' | 'night' | 'clouds' | 'ring'

export type Licence = 'public-domain' | 'cc-by-4.0'

export interface TextureSource {
  /** Body key, matching `BodyAppearance.texture`. */
  readonly body: string
  readonly map: MapKind
  readonly url: string
  /** Cache filename under `.data/textures/`. */
  readonly file: string
  readonly licence: Licence
  readonly credit: string
  /**
   * `image` copies pixels through.
   * `elevation` turns a height field into a tangent-space normal map, and packs
   * an ocean mask into its alpha where the body has one.
   * `luminance` moves brightness into alpha, for a layer that has to be
   * transparent where it is dark — a cloud map is a coverage mask, not a color.
   */
  readonly transform: 'image' | 'elevation' | 'luminance'
  /** Output width. Height is always half, because everything here is equirectangular. */
  readonly width: number
  /**
   * Elevation only: the peak-to-trough relief the height field spans, in meters.
   *
   * The pipeline finds the field's own minimum and maximum and stretches this
   * across them, rather than trusting a documented unit. That is not laziness,
   * it is the fix for a real bug: LOLA ships 16-bit half-meters, sharp quietly
   * downcast it to 8 bits, and the resulting normal map was *perfectly flat*
   * because every gradient was 256 times too small — a failure that produces a
   * valid file and a featureless Moon. A self-calibrating scale cannot have a
   * unit bug, and the relief is a number `solar/bodies.ts` already knows.
   */
  readonly relief?: number
  /** Elevation only: the body's radius, for meters per pixel on the ground. */
  readonly radius?: number
  /**
   * Elevation only: the fraction of the range at or below which this is ocean.
   *
   * Emitted into the normal map's alpha. Only Earth has one, and only Earth
   * needs one — sun-glint has to land on water and not on the Sahara.
   */
  readonly oceanBelow?: number
}

const NASA = 'NASA Earth Observatory / NASA Scientific Visualization Studio'
const USGS = 'NASA / JPL / USGS Astrogeology Science Center'
const SSS = 'Solar System Scope (solarsystemscope.com), CC BY 4.0'
const USGS_ASC = 'NASA / USGS Astrogeology Science Center'
const OREX_MAP =
  'NASA / Goddard / University of Arizona (OSIRIS-REx), via USGS Astrogeology'

const sss = (
  body: string,
  file: string,
  width = 4_096,
  map: MapKind = 'albedo',
): TextureSource => ({
  body,
  map,
  url: `https://www.solarsystemscope.com/textures/download/${file}`,
  file,
  licence: 'cc-by-4.0',
  credit: SSS,
  transform: 'image',
  width,
})

export const TEXTURE_SOURCES: readonly TextureSource[] = [
  /* --- Earth. The most looked-at object in the game, and the best documented. */
  {
    body: 'earth',
    map: 'albedo',
    // Blue Marble Next Generation, December 2004, with topography and
    // bathymetry shaded in. 5400x2700 is the single-file product; the same
    // imagery exists as eight 21600x21600 tiles for a true 86400x43200 mosaic,
    // which is 438 MB of download to feed a 4096-wide output.
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg',
    file: 'earth_albedo.jpg',
    licence: 'public-domain',
    credit: NASA,
    transform: 'image',
    width: 4_096,
  },
  {
    body: 'earth',
    map: 'night',
    // Black Marble 2016, VIIRS day/night band. The single most recognisable
    // thing about Earth from orbit at night, and nothing else in the system has
    // an equivalent.
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg',
    file: 'earth_night.jpg',
    licence: 'public-domain',
    credit: NASA,
    transform: 'image',
    width: 4_096,
  },
  {
    body: 'earth',
    map: 'clouds',
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_2048.jpg',
    file: 'earth_clouds.jpg',
    licence: 'public-domain',
    credit: NASA,
    transform: 'luminance',
    width: 2_048,
  },
  {
    body: 'earth',
    map: 'normal',
    // GEBCO_08 elevation at 21600x10800. Measured rather than assumed: 77.5% of
    // it is exactly zero and the rest ramps up to Everest, so it is a *land*
    // height field with no bathymetry — the ocean is flat, which is what makes
    // the ocean mask a threshold rather than a sign test.
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73934/gebco_08_rev_elev_21600x10800.png',
    file: 'earth_elevation.png',
    licence: 'public-domain',
    credit: NASA,
    transform: 'elevation',
    width: 4_096,
    relief: 8_848,
    radius: 6_378_137,
    // Coastlines blur when 21600 pixels become 4096, so the threshold is a hair
    // above zero rather than at it; below that and every shoreline is a fringe of
    // land-shaded sea.
    oceanBelow: 0.008,
  },

  /* --- The Moon. Real LRO color and real LOLA topography. */
  {
    body: 'luna',
    map: 'albedo',
    url: 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.tif',
    file: 'luna_albedo.tif',
    licence: 'public-domain',
    credit: `${NASA} / LRO LROC`,
    transform: 'image',
    width: 4_096,
  },
  {
    body: 'luna',
    map: 'normal',
    // LOLA global elevation, 16-bit unsigned, half-meters above a 1737.4 km
    // datum. This is a *measurement* of the Moon's shape, not a bump map — the
    // terminator relief it produces is where craters actually are.
    url: 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16_uint.tif',
    file: 'luna_elevation.tif',
    licence: 'public-domain',
    credit: `${NASA} / LRO LOLA`,
    transform: 'elevation',
    width: 4_096,
    // Selenean summit to the floor of the South Pole–Aitken basin.
    relief: 19_200,
    radius: 1_737_400,
  },

  /* --- The Galilean moons, from Voyager and Galileo. */
  {
    body: 'io',
    map: 'albedo',
    url: 'https://planetarymaps.usgs.gov/mosaic/Io_GalileoSSI-Voyager_Global_Mosaic_1km.tif',
    file: 'io_albedo.tif',
    licence: 'public-domain',
    credit: USGS,
    transform: 'image',
    width: 4_096,
  },
  {
    body: 'europa',
    map: 'albedo',
    url: 'https://planetarymaps.usgs.gov/mosaic/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif',
    file: 'europa_albedo.tif',
    licence: 'public-domain',
    credit: USGS,
    transform: 'image',
    width: 4_096,
  },
  {
    body: 'ganymede',
    map: 'albedo',
    url: 'https://planetarymaps.usgs.gov/mosaic/Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif',
    file: 'ganymede_albedo.tif',
    licence: 'public-domain',
    credit: USGS,
    transform: 'image',
    width: 4_096,
  },
  {
    body: 'callisto',
    map: 'albedo',
    url: 'https://planetarymaps.usgs.gov/mosaic/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif',
    file: 'callisto_albedo.tif',
    licence: 'public-domain',
    credit: USGS,
    transform: 'image',
    width: 4_096,
  },

  /* --- The small bodies anybody has photographed the whole of.
   *
   * These arrived with the dwarf planets and the asteroids, and they come from
   * the USGS Astrogeology mosaic archive — the same public-domain collection the
   * Galilean moons above do, served from `planetarymaps.usgs.gov`, which
   * redirects to the bucket the products actually live in.
   *
   * They are large. Pluto's global mosaic is 310 MB and Vesta's is 357, because
   * both are 300 m and 74 pixels-per-degree products of bodies a spacecraft
   * spent a year mapping. That is a one-time download into `.data/`, and it is
   * worth it for the same reason the Moon's LOLA map is: these are the bodies
   * whose *appearance* is the thing people know. Pluto's heart is the most
   * recognisable feature in the outer Solar System, and there is no way to get
   * it except from the map that has it in.
   *
   * Deimos, Eros, Itokawa and Ryugu have no global mosaic in this archive and
   * fall back to their measured albedo and color. Their *shapes* are vendored,
   * which is the half that matters more for a body a few kilometers across.
   */
  {
    body: 'pluto',
    map: 'albedo',
    // The July 2017 New Horizons global mosaic: LORRI and MVIC, 300 m/px on the
    // encounter hemisphere and much coarser on the far side, which is honest —
    // half of Pluto was in the dark when the only spacecraft ever to go there
    // went past at 14 km/s.
    url: 'https://planetarymaps.usgs.gov/mosaic/Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif',
    file: 'pluto_albedo.tif',
    licence: 'public-domain',
    credit: USGS_ASC,
    transform: 'image',
    width: 4_096,
  },
  {
    body: 'charon',
    map: 'albedo',
    url: 'https://planetarymaps.usgs.gov/mosaic/Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif',
    file: 'charon_albedo.tif',
    licence: 'public-domain',
    credit: USGS_ASC,
    transform: 'image',
    width: 4_096,
  },
  {
    body: 'ceres',
    map: 'albedo',
    // Dawn Framing Camera, 20 pixels per degree. The bright spots in Occator
    // are salt deposits and they are the whole reason anybody looks at Ceres.
    url: 'https://planetarymaps.usgs.gov/mosaic/Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif',
    file: 'ceres_albedo.tif',
    licence: 'public-domain',
    credit: USGS_ASC,
    transform: 'image',
    width: 4_096,
  },
  {
    body: 'vesta',
    map: 'albedo',
    url: 'https://planetarymaps.usgs.gov/mosaic/Vesta_Dawn_FC_HAMO_Mosaic_Global_74ppd.tif',
    file: 'vesta_albedo.tif',
    licence: 'public-domain',
    credit: USGS_ASC,
    transform: 'image',
    width: 4_096,
  },
  {
    body: 'phobos',
    map: 'albedo',
    // Mars Express SRC rather than the 104 MB Viking mosaic beside it: newer,
    // six times smaller, and it has Stickney lit.
    url: 'https://planetarymaps.usgs.gov/mosaic/Phobos_ME_SRC_Mosaic_Global_16ppd.tif',
    file: 'phobos_albedo.tif',
    licence: 'public-domain',
    credit: USGS_ASC,
    transform: 'image',
    width: 2_048,
  },
  {
    body: 'bennu',
    map: 'albedo',
    // OSIRIS-REx OCAMS, 25 cm per pixel. On a body 500 m across that is a map
    // with individual boulders in it, and it is the highest-resolution global
    // map of anything, anywhere.
    url: 'https://planetarymaps.usgs.gov/mosaic/Bennu/Bennu_OSIRIS-REx_OCAMS_color_mosaic_25cm.tif',
    file: 'bennu_albedo.tif',
    licence: 'public-domain',
    credit: OREX_MAP,
    transform: 'image',
    width: 2_048,
  },

  /* --- Everything else. */
  sss('mercury', '8k_mercury.jpg'),
  sss('venus', '8k_venus_surface.jpg'),
  // Venus's surface is never seen; its cloud deck is. Carried as the body's
  // *cloud* map so that it lands on the shell above the surface — which is where
  // it belongs, and which is what lets it superrotate at its own four-day rate
  // against a surface that takes 243.
  sss('venus', '4k_venus_atmosphere.jpg', 4_096, 'clouds'),
  sss('mars', '8k_mars.jpg'),
  sss('jupiter', '8k_jupiter.jpg'),
  sss('saturn', '8k_saturn.jpg'),
  sss('saturn-ring', '8k_saturn_ring_alpha.png', 2_048, 'ring'),
  sss('uranus', '2k_uranus.jpg', 2_048),
  sss('neptune', '2k_neptune.jpg', 2_048),
]
