/*
 * Where the weather's third-party data comes from.
 *
 * Two committed tables are reductions of somebody else's data: the ice
 * crystals' phase rows, from Baum's single-scattering set, and Earth's
 * zonal cloud statistics, from ISCCP-H. Neither source is committed. What
 * is committed is a few hundred kilobytes a generator reduces each to, and
 * this file is the record both generators write into their tables' headers:
 * the citation, the URL, the source's own words about its license, and the
 * date the source carries.
 *
 * The two differ in the one way that matters for a manifest.
 *
 * - **ISCCP-H says what may be done with it.** Its files carry
 *   `license = "No constraints on data access or use."`, and NOAA's CDR
 *   program asks for a citation and makes no condition of it. It states no
 *   Creative Commons license, and a manifest does not state one for it.
 * - **Baum's set says nothing.** Its README states no license and no terms
 *   of use, and its download is behind a registration. The reduced table is
 *   committed with that said in so many words, never with a license
 *   inferred from where the page is hosted.
 *
 * What is written here of each source's contents, its counts of
 * wavelengths, diameters, angles and files, is its own documentation's, and
 * a generator refuses a file that is not what this says.
 */

export interface WeatherSource {
  readonly key: 'baum-ice' | 'isccp-h'
  /** What the source is, as a header names it. */
  readonly name: string
  /** The committed table reduced from it. */
  readonly table: string
  /** The page a reader starts from. */
  readonly url: string
  /** Every citation the source asks for, as it gives them. */
  readonly citations: readonly string[]
  /** The source's own statement of its license, quoted, or that it makes none. */
  readonly license: string
  /** The date the source carries: its README's, or its version's. */
  readonly sourceDate: string
  /** Where its fetched or extracted files are kept: under `.data/`, never committed. */
  readonly cache: string
  /** What of this record is taken on another's word and not read at its source. */
  readonly unread: readonly string[]
}

/*
 * The severely roughened aggregate of solid columns: one habit of the set,
 * `P11` at 498 scattering angles for each of 445 wavelengths from 0.2 to
 * 100 µm and 23 effective diameters, in a pair of files, one with the phase
 * matrix and one with the bulk properties alone. The ice table's generator
 * reads those counts from the files and refuses a file that differs from
 * the README; it is the archive's only reader. The README points to the 2011
 * paper for the method, which the set's own paper extends, so both are
 * cited.
 */
export const BAUM_ICE = {
  key: 'baum-ice',
  name: 'Baum et al. ice cloud bulk single-scattering models: severely roughened aggregate of solid columns',
  table: 'packages/rendering/src/iceAggregate.generated.ts',
  url: 'https://www.ssec.wisc.edu/ice_models/polarization.html',
  citations: [
    'Baum, B. A., P. Yang, A. J. Heymsfield, A. Bansemer, B. H. Cole, A. Merrelli, C. Schmitt, and C. Wang (2014). Ice cloud single-scattering property models with the full phase matrix at wavelengths from 0.2 to 100 µm. Journal of Quantitative Spectroscopy and Radiative Transfer, 146, 123–139. doi:10.1016/j.jqsrt.2014.02.029',
    'Baum, B. A., P. Yang, A. J. Heymsfield, C. Schmitt, Y. Xie, A. Bansemer, Y.-X. Hu, and Z. Zhang (2011). Improvements in shortwave bulk scattering and absorption models for the remote sensing of ice clouds. Journal of Applied Meteorology and Climatology, 50, 1037–1056. doi:10.1175/2010JAMC2608.1',
  ],
  license: 'no license or terms of use are stated',
  // The README's own words, which the generator holds the README to.
  sourceDate: 'Last Updated: 25 July 2013',
  cache: '.data/weather/baum',
  unread: [],
} as const satisfies WeatherSource

/** The effective diameters the set is given at, µm: 10 to 120 in steps of 5, 23 of them. */
export const BAUM_DIAMETERS = {
  least: 10,
  greatest: 120,
  step: 5,
  count: 23,
} as const

/*
 * ISCCP-H's Basic HGM product: monthly means on a 1° equal-angle grid, one
 * NetCDF-4 file a month, read here for the ten years 2007 to 2016. HGM is
 * the mean of the eight three-hourly means, so it holds no hour of the day.
 */
export const ISCCP_H = {
  key: 'isccp-h',
  name: 'ISCCP H-Series climate data record, Basic HGM v01r00, 2007-01 to 2016-12',
  table: 'packages/rendering/src/isccpZonal.generated.ts',
  url: 'https://www.ncei.noaa.gov/products/international-satellite-cloud-climatology',
  citations: [
    'Rossow, W.B.; Walker, A.; Golea, V.; Knapp, K. R.; Young, A.; Inamdar A.; Hankins, B.; and NOAA’s Climate Data Record Program (2016). International Satellite Cloud Climatology Project Climate Data Record, H-Series, Basic HGM, 2007-01 to 2016-12. NOAA National Centers for Environmental Information. doi:10.7289/V5QZ281S',
    'Young, A. H., Knapp, K. R., Inamdar, A., Hankins, W., and Rossow, W. B. (2018). The International Satellite Cloud Climatology Project H-Series climate data record product. Earth System Science Data, 10, 583–593. https://doi.org/10.5194/essd-10-583-2018',
    'Rossow, W. B., and Schiffer, R. A. (1999). Advances in understanding clouds from ISCCP. Bulletin of the American Meteorological Society, 80, 2261–2287. doi:10.1175/1520-0477(1999)080<2261:AIUCFI>2.0.CO;2',
  ],
  license:
    '"No constraints on data access or use." (the files’ `license` attribute; NOAA CDR Program Open Data Policy)',
  sourceDate: 'v01r00, 2016',
  cache: '.data/weather/isccp',
  unread: [],
} as const satisfies WeatherSource

export const WEATHER_SOURCES: readonly WeatherSource[] = [BAUM_ICE, ISCCP_H]

/** The months the zonal table is made from: 2007-01 to 2016-12, 120 of them. */
export const ISCCP_YEARS = { first: 2007, last: 2016 } as const

const ISCCP_ROOT =
  'https://www.ncei.noaa.gov/data/international-satellite-cloud-climate-project-isccp-h-series-data/access/isccp-basic/hgm/'

/** A month's Basic HGM file: its name, and where NCEI serves it. `month` is 1 to 12. */
export function isccpMonth(
  year: number,
  month: number,
): { readonly file: string; readonly url: string } {
  if (!Number.isInteger(year) || !Number.isInteger(month))
    throw new Error(`isccpMonth: ${year}-${month} is no month`)
  if (month < 1 || month > 12)
    throw new Error(`isccpMonth: ${year}-${month} is no month`)
  const mm = String(month).padStart(2, '0')
  const file = `ISCCP-Basic.HGM.v01r00.GLOBAL.${year}.${mm}.99.9999.GPC.10KM.CS00.EA1.00.nc`
  return { file, url: `${ISCCP_ROOT}${file}` }
}

/** Every month of the table's ten years, in order. */
export function isccpMonths(): readonly {
  readonly year: number
  readonly month: number
  readonly file: string
  readonly url: string
}[] {
  const months = []
  for (let year = ISCCP_YEARS.first; year <= ISCCP_YEARS.last; year += 1)
    for (let month = 1; month <= 12; month += 1)
      months.push({ year, month, ...isccpMonth(year, month) })
  return months
}
