import h5wasm from 'h5wasm/node'

/*
 * ISCCP-H's reader and its reduction: from a Basic HGM month to the sums a
 * zonal table is divided out of.
 *
 * A month is reduced alone, to sums and the weights they were taken over,
 * so the ten years can be read by file over processes and combined in
 * month order afterward, and the table does not depend on how the read was
 * split. Every sum is float64 and every weight is an area: the 1°
 * equal-angle grid copies ISCCP's equal-area cells across longitudes near a
 * pole, so a mean taken over cells and not over `cos φ` counts the polar
 * cap many times over.
 *
 * What the files do that a CF reader does not expect, all measured on
 * these files (design/plans/weather/isccp-h-research.md §2.3):
 *
 * - The property arrays, `tau_types` and `pc_types` among them, declare no
 *   `_FillValue` and mark a missing value with −32767. Decoded through
 *   their scale and offset, it is an optical depth of −102.7. It is masked
 *   twice over: by name, and because it falls outside the variable's own
 *   `valid_min`.
 * - `cldamt` is packed with an offset of 50, so a raw value over ten is not
 *   its percent. Every variable is decoded through its own attributes.
 * - The eighteen type amounts are missing where the sun did not rise all
 *   month, while the total is there. A level's share falls back to the
 *   three infrared types there, and the area that used it is counted.
 * - The type amounts do not sum to the total, by about a point. A cell's
 *   three levels are the total split in the types' proportions, so they
 *   sum to it; a type's own cover is the file's figure, unnormalized.
 */

/** ISCCP's nine types, each liquid and ice summed, in the files' order. */
export const ISCCP_TYPES = [
  'cumulus',
  'stratocumulus',
  'stratus',
  'altocumulus',
  'altostratus',
  'nimbostratus',
  'cirrus',
  'cirrostratus',
  'deep-convection',
] as const

export type IsccpType = (typeof ISCCP_TYPES)[number]

/*
 * The eighteen labels' leading words, in array order: at each level, the
 * three thicknesses liquid, then the three ice. A file whose labels differ
 * is not the product this reduction was written for, and is refused rather
 * than summed into the wrong types.
 */
export const ISCCP_LABELS: readonly string[] = [0, 1, 2].flatMap((level) =>
  ['liquid', 'ice'].flatMap((phase) =>
    [0, 1, 2].map((thickness) => {
      const type = ISCCP_TYPES[level * 3 + thickness]!
      return `${type === 'deep-convection' ? 'deep_convective' : type}_${phase}`
    }),
  ),
)

/** The array index of a type's liquid and ice amounts: 6 a level, liquid's three first. */
export function typeIndices(type: number): readonly [number, number] {
  const level = Math.floor(type / 3)
  const thickness = type % 3
  return [level * 6 + thickness, level * 6 + 3 + thickness]
}

const ISCCP_BANDS = 18
const LAT = 180
const LON = 360
const CELLS = LAT * LON

/*
 * The fill the property arrays use and do not declare. Kept by name as
 * well as by range, so a variable whose declared range happened to admit it
 * would still not read it as a measurement.
 */
const UNDECLARED_FILL = -32767

/** A variable's packing, as the file declares it. */
export interface Packing {
  readonly scale: number
  readonly offset: number
  readonly fill: number | null
  readonly least: number | null
  readonly greatest: number | null
}

const scalar = (value: unknown): number | null => {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (ArrayBuffer.isView(value) && 'length' in value) {
    const first = (value as unknown as ArrayLike<number | bigint>)[0]
    return first === undefined ? null : Number(first)
  }
  return null
}

/** The packing a dataset's attributes declare, with CF's defaults for what they leave out. */
export function packingOf(
  attrs: Readonly<Record<string, { readonly value: unknown }>>,
): Packing {
  return {
    scale: scalar(attrs.scale_factor?.value) ?? 1,
    offset: scalar(attrs.add_offset?.value) ?? 0,
    fill: scalar(attrs._FillValue?.value),
    least: scalar(attrs.valid_min?.value),
    greatest: scalar(attrs.valid_max?.value),
  }
}

/**
 * Raw packed values to physical ones, NaN where missing: the declared
 * fill, the undeclared −32767, and anything outside the declared valid
 * range, which CF states in packed units.
 */
export function decodePacked(
  raw: ArrayLike<number>,
  packing: Packing,
): Float64Array {
  const values = new Float64Array(raw.length)
  for (let k = 0; k < raw.length; k += 1) {
    const r = raw[k]!
    const missing =
      r === packing.fill ||
      r === UNDECLARED_FILL ||
      (packing.least !== null && r < packing.least) ||
      (packing.greatest !== null && r > packing.greatest)
    values[k] = missing ? Number.NaN : r * packing.scale + packing.offset
  }
  return values
}

/** The variables the reduction reads, decoded, each [type?][lat][lon] with latitude south first. */
export interface IsccpGrids {
  readonly cover: Float64Array
  readonly land: Float64Array
  readonly types: Float64Array
  readonly irTypes: Float64Array
  readonly depth: Float64Array
  readonly pressure: Float64Array
  readonly latitudes: Float64Array
}

const NAMES = {
  cover: 'cldamt',
  land: 'eqland',
  types: 'cldamt_types',
  irTypes: 'cldamt_irtypes',
  depth: 'tau_types',
  pressure: 'pc_types',
} as const

type H5File = InstanceType<typeof h5wasm.File>
type H5Dataset = InstanceType<typeof h5wasm.Dataset>

function dataset(file: H5File, name: string, length: number): H5Dataset {
  const found = file.get(name)
  if (!(found instanceof h5wasm.Dataset))
    throw new Error(`ISCCP-H: no dataset ${name}`)
  const size = found.shape?.reduce((n, d) => n * d, 1) ?? 0
  if (size !== length)
    throw new Error(`ISCCP-H: ${name} holds ${size} values, not ${length}`)
  return found
}

function decoded(file: H5File, name: string, length: number): Float64Array {
  const set = dataset(file, name, length)
  return decodePacked(set.value as ArrayLike<number>, packingOf(set.attrs))
}

function labels(file: H5File): readonly string[] {
  const set = dataset(file, 'cloud_type_label', 18 * 80)
  const chars = set.value as ArrayLike<string>
  return Array.from(
    { length: 18 },
    (_, row) =>
      Array.from({ length: 80 }, (_c, k) => chars[row * 80 + k] ?? '')
        .join('')
        .trim()
        .split(/\s+/)[0]!,
  )
}

/** Read one month's file into its decoded grids, refusing a file that is not the product. */
export async function readIsccp(path: string): Promise<IsccpGrids> {
  await h5wasm.ready
  const file = new h5wasm.File(path, 'r')
  try {
    const found = labels(file)
    if (found.join() !== ISCCP_LABELS.join())
      throw new Error(`ISCCP-H: ${path} labels its types ${found.join(', ')}`)
    const latitudes = Float64Array.from(
      dataset(file, 'lat', LAT).value as ArrayLike<number>,
    )
    if (latitudes[0] !== -89.5 || latitudes[LAT - 1] !== 89.5)
      throw new Error(`ISCCP-H: ${path} is not on the 1° grid, south first`)
    return {
      cover: decoded(file, NAMES.cover, CELLS),
      land: decoded(file, NAMES.land, CELLS),
      types: decoded(file, NAMES.types, 18 * CELLS),
      irTypes: decoded(file, NAMES.irTypes, 3 * CELLS),
      depth: decoded(file, NAMES.depth, 18 * CELLS),
      pressure: decoded(file, NAMES.pressure, 18 * CELLS),
      latitudes,
    }
  } finally {
    file.close()
  }
}

/*
 * The radiative mean of a type's depth. ISCCP averages a cell's depths in
 * reflectance, not linearly (User's Guide v5.0, p. 7), and a linear mean
 * of depths across cells is the error the plan forbids (plan §3), so the
 * months and cells are averaged the same way: each depth to a reflectance,
 * the mean of those, and back. The law is the two-stream reflectance of a
 * conservative slab over a black surface, `x/(2 + x)` with `x = (1 − g)·τ`
 * (the two-stream result of Bohren 1987, Am. J. Phys. 55, 524, quoted from
 * memory and not checked against the paper), at one asymmetry for liquid
 * and ice. It is not the slab oracle's `R(τ, μ₀)`, which this tree holds as
 * a stand-in. The linear and the logarithmic means are carried beside it,
 * so a reader sees how far the law can move the figure.
 */
export const REFLECTANCE_ASYMMETRY = 0.85

export function reflectance(depth: number, g = REFLECTANCE_ASYMMETRY): number {
  const x = (1 - g) * depth
  return x / (2 + x)
}

export function depthOfReflectance(
  r: number,
  g = REFLECTANCE_ASYMMETRY,
): number {
  return (2 * r) / ((1 - g) * (1 - r))
}

/** A sum and the weight it was taken over: a mean is the one over the other. */
export interface Mean {
  sum: number
  weight: number
}

/** One latitude band's sums for one month. Every weight is an area, in units of a cell at the equator. */
export interface BandSums {
  readonly total: Mean
  readonly land: Mean
  readonly ocean: Mean
  /** The total split into low, middle and high, summed over the cells that could be split. */
  readonly levels: [number, number, number]
  /** The area split by the eighteen types. */
  split: number
  /** The area split by the three infrared types, where the eighteen are missing. */
  infrared: number
}

/** One type's sums for one month, liquid and ice together. */
export interface TypeSums {
  /** Cover, over the area where the types were retrieved. */
  readonly cover: Mean
  /** Each depth weighted by its area and its amount: its reflectance, itself and its logarithm. */
  readonly depth: {
    weight: number
    reflectance: number
    linear: number
    log: number
  }
  readonly pressure: Mean
}

export interface MonthSums {
  /** 1 to 12. */
  readonly month: number
  readonly bands: readonly BandSums[]
  readonly types: readonly TypeSums[]
}

const mean = (): Mean => ({ sum: 0, weight: 0 })

function emptyMonth(month: number): MonthSums {
  return {
    month,
    bands: Array.from({ length: ISCCP_BANDS }, () => ({
      total: mean(),
      land: mean(),
      ocean: mean(),
      levels: [0, 0, 0],
      split: 0,
      infrared: 0,
    })),
    types: ISCCP_TYPES.map(() => ({
      cover: mean(),
      depth: { weight: 0, reflectance: 0, linear: 0, log: 0 },
      pressure: mean(),
    })),
  }
}

/** The values of a stacked variable at one cell, or null if any is missing. */
function stack(
  grid: Float64Array,
  cell: number,
  count: number,
): number[] | null {
  const values = []
  for (let k = 0; k < count; k += 1) {
    const value = grid[k * CELLS + cell]!
    if (Number.isNaN(value)) return null
    values.push(value)
  }
  return values
}

/*
 * A cell's total in its levels' proportions. The eighteen types first;
 * where they are missing, or name no cloud under a total that has some,
 * the three infrared types; and null where neither can split it.
 */
function levelShares(
  grids: IsccpGrids,
  cell: number,
  cover: number,
): { readonly shares: readonly number[]; readonly infrared: boolean } | null {
  const types = stack(grids.types, cell, 18)
  if (types !== null) {
    const levels = [0, 1, 2].map((level) =>
      types.slice(level * 6, level * 6 + 6).reduce((a, b) => a + b, 0),
    )
    const whole = levels[0]! + levels[1]! + levels[2]!
    if (whole > 0)
      return { shares: levels.map((l) => l / whole), infrared: false }
    if (cover === 0) return { shares: [0, 0, 0], infrared: false }
  }
  const ir = stack(grids.irTypes, cell, 3)
  if (ir === null) return null
  const whole = ir[0]! + ir[1]! + ir[2]!
  if (whole > 0) return { shares: ir.map((l) => l / whole), infrared: true }
  return cover === 0 ? { shares: [0, 0, 0], infrared: true } : null
}

function addTypes(
  sums: MonthSums,
  grids: IsccpGrids,
  cell: number,
  area: number,
): void {
  const amounts = stack(grids.types, cell, 18)
  if (amounts === null) return
  ISCCP_TYPES.forEach((_, type) => {
    const row = sums.types[type]!
    const [liquid, ice] = typeIndices(type)
    row.cover.sum += (area * (amounts[liquid]! + amounts[ice]!)) / 100
    row.cover.weight += area
    for (const index of [liquid, ice]) {
      const weight = (area * amounts[index]!) / 100
      const depth = grids.depth[index * CELLS + cell]!
      if (weight > 0 && depth > 0) {
        row.depth.weight += weight
        row.depth.reflectance += weight * reflectance(depth)
        row.depth.linear += weight * depth
        row.depth.log += weight * Math.log(depth)
      }
      const pressure = grids.pressure[index * CELLS + cell]!
      if (weight > 0 && !Number.isNaN(pressure)) {
        row.pressure.sum += weight * pressure
        row.pressure.weight += weight
      }
    }
  })
}

function addCell(
  sums: MonthSums,
  grids: IsccpGrids,
  cell: number,
  area: number,
): void {
  const percent = grids.cover[cell]!
  if (Number.isNaN(percent)) return
  const cover = percent / 100
  const band = sums.bands[Math.floor(Math.floor(cell / LON) / 10)]!
  const land = Number.isNaN(grids.land[cell]!) ? 0 : grids.land[cell]! / 100
  band.total.sum += area * cover
  band.total.weight += area
  band.land.sum += area * land * cover
  band.land.weight += area * land
  band.ocean.sum += area * (1 - land) * cover
  band.ocean.weight += area * (1 - land)
  const split = levelShares(grids, cell, percent)
  if (split !== null) {
    split.shares.forEach((share, level) => {
      band.levels[level]! += area * cover * share
    })
    if (split.infrared) band.infrared += area
    else band.split += area
  }
  addTypes(sums, grids, cell, area)
}

/** One month's grids to its sums. */
export function reduceMonth(grids: IsccpGrids, month: number): MonthSums {
  const sums = emptyMonth(month)
  for (let row = 0; row < LAT; row += 1) {
    const area = Math.cos((grids.latitudes[row]! * Math.PI) / 180)
    for (let column = 0; column < LON; column += 1)
      addCell(sums, grids, row * LON + column, area)
  }
  return sums
}

/** A cover's kinds: the total, its three levels, and the total over land and over ocean. */
export type IsccpCover = 'cover' | 'low' | 'middle' | 'high' | 'land' | 'ocean'

const COVERS: readonly IsccpCover[] = [
  'cover',
  'low',
  'middle',
  'high',
  'land',
  'ocean',
]

export interface IsccpTypeRow {
  readonly type: IsccpType
  readonly cover: number
  readonly depth: number
  readonly linearDepth: number
  readonly logDepth: number
  readonly pressure: number
}

/** The table, in fractions of the sky, before it is written. */
export interface IsccpTable {
  /** [month][band] for each of the total and its levels. */
  readonly monthly: Readonly<
    Record<'cover' | 'low' | 'middle' | 'high', readonly number[]>
  >
  /** The ten years' mean in each band, null where the band holds under a hundredth of its area of that surface. */
  readonly annual: Readonly<Record<IsccpCover, readonly (number | null)[]>>
  readonly global: Readonly<Record<IsccpCover, number>>
  readonly types: readonly IsccpTypeRow[]
  /** The shares of the cloud-measured area whose levels came from the infrared types, and from neither. */
  readonly infrared: number
  readonly unsplit: number
}

function emptyBand(): BandSums {
  return {
    total: mean(),
    land: mean(),
    ocean: mean(),
    levels: [0, 0, 0],
    split: 0,
    infrared: 0,
  }
}

function addBand(into: BandSums, from: BandSums): void {
  for (const key of ['total', 'land', 'ocean'] as const) {
    into[key].sum += from[key].sum
    into[key].weight += from[key].weight
  }
  from.levels.forEach((value, level) => {
    into.levels[level]! += value
  })
  into.split += from.split
  into.infrared += from.infrared
}

/*
 * A band's cover of one kind. A level is a share of the total over the
 * area that could be split, so the three sum to the band's total wherever
 * every cell could be.
 */
function coverOf(
  band: BandSums,
  kind: IsccpCover,
  floor: number,
): number | null {
  if (kind === 'land' || kind === 'ocean') {
    const part = band[kind]
    return part.weight > floor * band.total.weight
      ? part.sum / part.weight
      : null
  }
  if (kind === 'cover')
    return band.total.weight > 0 ? band.total.sum / band.total.weight : null
  const level = kind === 'low' ? 0 : kind === 'middle' ? 1 : 2
  const area = band.split + band.infrared
  return area > 0 ? band.levels[level]! / area : null
}

function byCover<T>(value: (kind: IsccpCover) => T): Record<IsccpCover, T> {
  return {
    cover: value('cover'),
    low: value('low'),
    middle: value('middle'),
    high: value('high'),
    land: value('land'),
    ocean: value('ocean'),
  }
}

/** The least share of a band's area that a land or ocean mean is taken over. */
const SURFACE_FLOOR = 0.01

function typeRow(type: number, sums: readonly TypeSums[]): IsccpTypeRow {
  const cover = mean()
  const depth = { weight: 0, reflectance: 0, linear: 0, log: 0 }
  const pressure = mean()
  for (const row of sums) {
    cover.sum += row.cover.sum
    cover.weight += row.cover.weight
    depth.weight += row.depth.weight
    depth.reflectance += row.depth.reflectance
    depth.linear += row.depth.linear
    depth.log += row.depth.log
    pressure.sum += row.pressure.sum
    pressure.weight += row.pressure.weight
  }
  return {
    type: ISCCP_TYPES[type]!,
    cover: cover.sum / cover.weight,
    depth: depthOfReflectance(depth.reflectance / depth.weight),
    linearDepth: depth.linear / depth.weight,
    logDepth: Math.exp(depth.log / depth.weight),
    pressure: pressure.sum / pressure.weight,
  }
}

/**
 * The months' sums to the table. `months` comes in the order the files
 * are listed, and is summed in that order, so a split read combines to the
 * same bytes as a whole one.
 */
export function combineMonths(months: readonly MonthSums[]): IsccpTable {
  const byMonth = Array.from({ length: 12 }, () =>
    Array.from({ length: ISCCP_BANDS }, emptyBand),
  )
  const annual = Array.from({ length: ISCCP_BANDS }, emptyBand)
  const whole = emptyBand()
  for (const sums of months)
    sums.bands.forEach((band, b) => {
      addBand(byMonth[sums.month - 1]![b]!, band)
      addBand(annual[b]!, band)
      addBand(whole, band)
    })
  const missing = byMonth.findIndex((bands) =>
    bands.every((band) => band.total.weight === 0),
  )
  if (missing >= 0)
    throw new Error(
      `isccp: no file holds month ${missing + 1}, and a zonal table holds every month`,
    )
  const monthly = (kind: 'cover' | 'low' | 'middle' | 'high'): number[] =>
    byMonth.flatMap((bands) => bands.map((band) => coverOf(band, kind, 0) ?? 0))
  const measured = whole.total.weight
  return {
    monthly: {
      cover: monthly('cover'),
      low: monthly('low'),
      middle: monthly('middle'),
      high: monthly('high'),
    },
    annual: byCover((kind) =>
      annual.map((band) => coverOf(band, kind, SURFACE_FLOOR)),
    ),
    global: byCover((kind) => coverOf(whole, kind, 0) ?? 0),
    types: ISCCP_TYPES.map((_, type) =>
      typeRow(
        type,
        months.map((sums) => sums.types[type]!),
      ),
    ),
    infrared: whole.infrared / measured,
    unsplit: (measured - whole.split - whole.infrared) / measured,
  }
}

/** The facts a header states: nothing that differs between two runs. */
export interface IsccpProvenance {
  readonly generator: string
  readonly name: string
  readonly files: number
  readonly bytes: number
  readonly digest: string
  readonly citations: readonly string[]
  readonly license: string
}

/*
 * A figure that is not a number is refused rather than written: the reader
 * answers null for what the table lacks, and a NaN in a committed table
 * would read as a measurement of nothing.
 */
const fixed = (value: number, digits: number): string => {
  if (!Number.isFinite(value))
    throw new Error(`isccp: a table figure is ${value}`)
  return String(Number(value.toFixed(digits)))
}

const list = (values: readonly (number | null)[], digits = 4): string =>
  `[${values.map((v) => (v === null ? 'null' : fixed(v, digits))).join(', ')}]`

const comment = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? ' *' : ` * ${line}`))
    .join('\n')

function header(table: IsccpTable, provenance: IsccpProvenance): string {
  return comment(`ISCCP-H's zonal means: cloud cover by 10° latitude band and month, total
and by level; each band's ten-year mean over all, over land and over ocean;
the global means; and each of ISCCP's nine types' mean cover, mean optical
depth and mean cloud-top pressure.

\`cover\`, \`low\`, \`middle\` and \`high\` are laid out [month][band], January
first, bands from the south pole north. Covers are fractions of the sky,
area-weighted by the cosine of latitude. A level is the cover whose top is
in it, as a satellite sees from above: the total split in the eighteen
types' proportions, or the three infrared types' where the eighteen are
missing (${fixed(100 * table.infrared, 2)}% of the measured area, polar night), and left out where
neither is present (${fixed(100 * table.unsplit, 3)}%). A type's cover is the file's own; the nine sum
to about a point over the total. A type's \`depth\` is its radiative
mean through \`x/(2 + x)\`, \`x = (1 − ${REFLECTANCE_ASYMMETRY})·τ\`, weighted by area and amount;
\`linearDepth\` and \`logDepth\` are the other two means of the same depths.
Depths and pressures are of daytime retrievals alone. \`null\` is a band
with under a hundredth of its area of that surface.

Source: ${provenance.name}, ${provenance.files} files, ${provenance.bytes} bytes, read with h5wasm.
The files' sizes and SHA-256 are \`ISCCP_MANIFEST\` in
apps/ingest/src/isccpSources.ts; their digest in month order is
${provenance.digest}.
License: ${provenance.license}

${provenance.citations.join('\n\n')}

Generated by ${provenance.generator}; rerun it rather than editing.`)
}

/** The generated file's text, before prettier. */
export function formatIsccpTable(
  table: IsccpTable,
  provenance: IsccpProvenance,
): string {
  const annual = COVERS.map(
    (kind) => `    ${kind}: ${list(table.annual[kind])},`,
  ).join('\n')
  const global = COVERS.map(
    (kind) => `    ${kind}: ${fixed(table.global[kind], 4)},`,
  ).join('\n')
  const types = table.types
    .map(
      (row) =>
        `    { type: '${row.type}', cover: ${fixed(row.cover, 4)}, depth: ${fixed(row.depth, 3)}, linearDepth: ${fixed(row.linearDepth, 3)}, logDepth: ${fixed(row.logDepth, 3)}, pressure: ${fixed(row.pressure, 1)} },`,
    )
    .join('\n')
  return `/*
${header(table, provenance)}
 */
export const ISCCP_ZONAL = {
  format: 'inertialref/isccp-zonal',
  version: 1,
  /** The product, its years, and how it is cited. */
  source: ${JSON.stringify(`${provenance.name}, doi:10.7289/V5QZ281S`)},
  bandDegrees: 10,
  months: 12,
  cover: ${list(table.monthly.cover)},
  low: ${list(table.monthly.low)},
  middle: ${list(table.monthly.middle)},
  high: ${list(table.monthly.high)},
  /** Each band's ten-year mean. */
  annual: {
${annual}
  },
  global: {
${global}
  },
  types: [
${types}
  ],
} as const
`
}
