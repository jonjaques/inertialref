import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import h5wasm from 'h5wasm/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  combineMonths,
  decodePacked,
  depthOfReflectance,
  formatIsccpTable,
  type IsccpProvenance,
  type IsccpTable,
  ISCCP_LABELS,
  ISCCP_TYPES,
  type MonthSums,
  packingOf,
  readIsccp,
  reduceMonth,
  reflectance,
  typeIndices,
} from './isccp.ts'
import {
  isccpCache,
  isccpCached,
  ISCCP_MANIFEST,
  manifestDigest,
} from './isccpSources.ts'
import { ISCCP_H, isccpMonths } from './weatherSources.ts'

/*
 * ISCCP-H's reader and reduction. Most of this file holds them on a file it
 * writes itself, laid out as a Basic HGM month and packed as one is, so
 * the gate needs no download. The last block holds the decoder to values
 * read straight from the real files, and runs only where they are cached.
 */

const root = new URL('../../../', import.meta.url).pathname
const LAT = 180
const LON = 360
const CELLS = LAT * LON

/** A percent packed as `cldamt` packs it: scale 0.1, offset 50. */
const packPercent = (percent: number): number => Math.round((percent - 50) * 10)
const packDepth = (depth: number): number => Math.round((depth - 225) * 100)
const packPressure = (hPa: number): number => Math.round(hPa - 500)

describe('the packed decode', () => {
  const cldamt = packingOf({
    scale_factor: { value: Float32Array.of(0.1) },
    add_offset: { value: 50 },
    _FillValue: { value: Int16Array.of(32767) },
    valid_min: { value: -500 },
    valid_max: { value: 500 },
  })

  it('applies each variable’s own offset: a raw 234 of `cldamt` is 73.4%, not 23.4', () => {
    const [value] = decodePacked([234], cldamt)
    expect(value).toBeCloseTo(73.4, 5)
  })

  it('masks the declared fill and anything outside the declared range', () => {
    const values = decodePacked([32767, 501, -501, 0], cldamt)
    expect(Number.isNaN(values[0]!)).toBe(true)
    expect(Number.isNaN(values[1]!)).toBe(true)
    expect(Number.isNaN(values[2]!)).toBe(true)
    expect(values[3]).toBeCloseTo(50, 5)
  })

  it('masks the undeclared −32767 of a property array, which decodes to τ −102.7', () => {
    const tau = packingOf({
      scale_factor: { value: 0.01 },
      add_offset: { value: 225 },
    })
    // No fill and no range declared: the value is masked by name alone.
    expect(Number.isNaN(decodePacked([-32767], tau)[0]!)).toBe(true)
    const admitting = { ...tau, least: -40000, greatest: 40000 }
    expect(Number.isNaN(decodePacked([-32767], admitting)[0]!)).toBe(true)
    expect(decodePacked([-22121], tau)[0]).toBeCloseTo(3.79, 9)
  })
})

describe('the radiative mean', () => {
  it('inverts its own reflectance at every depth ISCCP retrieves', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.02, max: 450, noNaN: true }), (depth) => {
        const back = depthOfReflectance(reflectance(depth))
        expect(Math.abs(back - depth) / depth).toBeLessThan(1e-9)
      }),
    )
  })

  it('lies between the logarithmic and the linear mean of two depths', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 300, noNaN: true }),
        fc.double({ min: 0.05, max: 300, noNaN: true }),
        (a, b) => {
          const radiative = depthOfReflectance(
            (reflectance(a) + reflectance(b)) / 2,
          )
          const tolerance = 1e-9 * Math.max(a, b)
          expect(radiative).toBeLessThanOrEqual((a + b) / 2 + tolerance)
          expect(radiative).toBeGreaterThanOrEqual(Math.min(a, b) - tolerance)
        },
      ),
    )
  })
})

describe('the type labels', () => {
  it('are the files’ eighteen, liquid’s three before ice’s at each level', () => {
    expect(ISCCP_LABELS).toHaveLength(18)
    expect(ISCCP_LABELS.slice(0, 6)).toEqual([
      'cumulus_liquid',
      'stratocumulus_liquid',
      'stratus_liquid',
      'cumulus_ice',
      'stratocumulus_ice',
      'stratus_ice',
    ])
    expect(ISCCP_LABELS[14]).toBe('deep_convective_liquid')
    expect(typeIndices(ISCCP_TYPES.indexOf('cirrus'))).toEqual([12, 15])
  })
})

/*
 * The synthetic month. A quarter of the longitudes are land under 40%
 * cloud and the rest ocean under 60%. North of 80° S the types are
 * cumulus 20%, stratocumulus 10% and cirrus 30%, so the low and high
 * levels share the total evenly; in the southernmost band they are
 * missing, as in polar night, and the infrared types split it evenly
 * instead. Cumulus is τ 2 in even columns and 3 in odd ones. Cirrus's
 * depth and pressure carry the undeclared fill in odd columns.
 */
const LAND_COLUMNS = 90
const POLAR_ROWS = 10

function synthetic(): Record<string, Int16Array> {
  const cover = new Int16Array(CELLS)
  const land = new Int16Array(CELLS)
  const types = new Int16Array(18 * CELLS).fill(packPercent(0))
  const ir = new Int16Array(3 * CELLS).fill(packPercent(0))
  const depth = new Int16Array(18 * CELLS).fill(-32767)
  const pressure = new Int16Array(18 * CELLS).fill(-32767)
  for (let row = 0; row < LAT; row += 1)
    for (let column = 0; column < LON; column += 1) {
      const cell = row * LON + column
      const isLand = column < LAND_COLUMNS
      land[cell] = isLand ? 100 : 0
      cover[cell] = packPercent(isLand ? 40 : 60)
      ir[cell] = packPercent(30)
      ir[2 * CELLS + cell] = packPercent(30)
      const odd = column % 2 === 1
      if (row < POLAR_ROWS) {
        for (let k = 0; k < 18; k += 1) types[k * CELLS + cell] = 32767
        continue
      }
      types[0 * CELLS + cell] = packPercent(20)
      types[4 * CELLS + cell] = packPercent(10)
      types[12 * CELLS + cell] = packPercent(30)
      depth[0 * CELLS + cell] = packDepth(odd ? 3 : 2)
      pressure[0 * CELLS + cell] = packPressure(800)
      depth[4 * CELLS + cell] = packDepth(10)
      pressure[4 * CELLS + cell] = packPressure(750)
      depth[12 * CELLS + cell] = odd ? -32767 : packDepth(0.5)
      pressure[12 * CELLS + cell] = odd ? -32767 : packPressure(200)
    }
  return { cover, land, types, ir, depth, pressure }
}

const PERCENT = {
  scale_factor: 0.1,
  add_offset: 50,
  _FillValue: 32767,
  valid_min: -500,
  valid_max: 500,
}

function writeSynthetic(file: string): void {
  const grids = synthetic()
  const made = new h5wasm.File(file, 'w')
  const put = (
    name: string,
    data: Int16Array,
    shape: number[],
    attrs: Record<string, number>,
  ): void => {
    const set = made.create_dataset({ name, data, shape })
    for (const [key, value] of Object.entries(attrs))
      set.create_attribute(key, value)
  }
  made.create_dataset({
    name: 'lat',
    data: Float32Array.from({ length: LAT }, (_, k) => k - 89.5),
    shape: [LAT],
  })
  made.create_dataset({
    name: 'cloud_type_label',
    data: ISCCP_LABELS.flatMap((label) =>
      Array.from({ length: 80 }, (_, k) => label[k] ?? ' '),
    ),
    shape: [18, 80],
  })
  put('cldamt', grids.cover!, [1, LAT, LON], PERCENT)
  put('eqland', grids.land!, [1, LAT, LON], {})
  put('cldamt_types', grids.types!, [1, 18, LAT, LON], PERCENT)
  put('cldamt_irtypes', grids.ir!, [1, 3, LAT, LON], PERCENT)
  // As the real files: no fill declared on the properties.
  put('tau_types', grids.depth!, [1, 18, LAT, LON], {
    scale_factor: 0.01,
    add_offset: 225,
  })
  put('pc_types', grids.pressure!, [1, 18, LAT, LON], {
    scale_factor: 1,
    add_offset: 500,
  })
  made.close()
}

describe('the reduction, on a month it writes itself', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'inertialref-isccp-'))
  const file = path.join(directory, 'month.nc')
  let table: IsccpTable
  let month: MonthSums

  beforeAll(async () => {
    await h5wasm.ready
    writeSynthetic(file)
    month = reduceMonth(await readIsccp(file), 1)
    // One month read as all twelve: the table holds every month or none.
    table = combineMonths(
      Array.from({ length: 12 }, (_, k) => ({ ...month, month: k + 1 })),
    )
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('weights by area and splits land from ocean by the land fraction', () => {
    expect(table.global.land).toBeCloseTo(0.4, 9)
    expect(table.global.ocean).toBeCloseTo(0.6, 9)
    expect(table.global.cover).toBeCloseTo(0.25 * 0.4 + 0.75 * 0.6, 9)
    for (const band of table.annual.cover) expect(band).toBeCloseTo(0.55, 9)
    expect(table.monthly.cover).toHaveLength(12 * 18)
  })

  it('splits the total by the types, and by the infrared types where the types are missing', () => {
    for (let k = 0; k < 12 * 18; k += 1) {
      expect(table.monthly.low[k]).toBeCloseTo(0.275, 9)
      expect(table.monthly.middle[k]).toBeCloseTo(0, 9)
      expect(table.monthly.high[k]).toBeCloseTo(0.275, 9)
    }
    // The infrared share is the southernmost band's area.
    let polar = 0
    let all = 0
    for (let row = 0; row < LAT; row += 1) {
      const area = Math.cos(((row - 89.5) * Math.PI) / 180) * LON
      all += area
      if (row < POLAR_ROWS) polar += area
    }
    expect(table.infrared).toBeCloseTo(polar / all, 12)
    expect(table.unsplit).toBeCloseTo(0, 12)
  })

  it('takes a type’s cover over the area where types are retrieved', () => {
    const cover = Object.fromEntries(
      table.types.map((row) => [row.type, row.cover]),
    )
    expect(cover.cumulus).toBeCloseTo(0.2, 9)
    expect(cover.stratocumulus).toBeCloseTo(0.1, 9)
    expect(cover.cirrus).toBeCloseTo(0.3, 9)
    expect(cover.stratus).toBeCloseTo(0, 9)
  })

  it('averages a type’s depth radiatively, and its pressure without the undeclared fill', () => {
    const row = (type: string) => table.types.find((r) => r.type === type)!
    const cumulus = row('cumulus')
    expect(cumulus.depth).toBeCloseTo(
      depthOfReflectance((reflectance(2) + reflectance(3)) / 2),
      9,
    )
    expect(cumulus.linearDepth).toBeCloseTo(2.5, 9)
    expect(cumulus.logDepth).toBeCloseTo(Math.sqrt(6), 9)
    expect(cumulus.pressure).toBeCloseTo(800, 9)
    // −32767 read as a pressure is −32267 hPa; one such cell in two would
    // pull the mean far below zero.
    expect(row('cirrus').pressure).toBeCloseTo(200, 9)
    expect(row('cirrus').depth).toBeCloseTo(0.5, 9)
  })

  it('refuses a year with a month missing, and a table with a figure that is not a number', () => {
    expect(() => combineMonths([month])).toThrow(/month 2/)
    const provenance: IsccpProvenance = {
      generator: 'test',
      name: ISCCP_H.name,
      files: 1,
      bytes: 1,
      digest: '0',
      citations: ISCCP_H.citations,
      license: ISCCP_H.license,
    }
    // Stratus has no cover here, so it has no depth to write.
    expect(() => formatIsccpTable(table, provenance)).toThrow(/NaN/)
  })

  it('refuses a file whose types are labeled otherwise', async () => {
    const other = path.join(directory, 'other.nc')
    const made = new h5wasm.File(other, 'w')
    made.create_dataset({
      name: 'cloud_type_label',
      data: Array.from({ length: 18 * 80 }, () => 'x'),
      shape: [18, 80],
    })
    made.close()
    await expect(readIsccp(other)).rejects.toThrow(/labels its types/)
  })
})

describe('the manifest and the committed table', () => {
  it('lists each of the 120 months once, in month order', () => {
    expect(ISCCP_MANIFEST.map((entry) => entry.file)).toEqual(
      isccpMonths().map((month) => month.file),
    )
    for (const entry of ISCCP_MANIFEST) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.bytes).toBeGreaterThan(4_000_000)
    }
  })

  it('is the manifest the committed table names, and the header says nothing that differs between runs', () => {
    const text = readFileSync(path.join(root, ISCCP_H.table), 'utf8')
    expect(text).toContain(manifestDigest(ISCCP_MANIFEST))
    const bytes = ISCCP_MANIFEST.reduce((n, entry) => n + entry.bytes, 0)
    expect(text).toContain(`${bytes} bytes`)
    expect(text).toContain('10.7289/V5QZ281S')
    expect(text).toContain('No constraints on data access or use.')
    expect(text).not.toMatch(
      /Node v?\d|\d+(\.\d+)? s\b|seconds|20\d\d-\d\d-\d\dT/,
    )
  })
})

/*
 * Values read from two cached months with nothing but h5wasm and the
 * files' own attributes, by hand, on 2026-11-10: a raw integer and what it
 * decodes to. They hold the reader to the files, not to itself. The
 * files are 518 MB and not committed, so this block runs where they are
 * cached and says it is skipped everywhere else.
 */
const cache = isccpCache(root)
const cached = isccpCached(cache)
if (!cached)
  console.info(
    `isccp.test: the source values are skipped, because ${cache} does not hold the 120 months (pnpm isccp:build fetches them)`,
  )

describe.skipIf(!cached)('the reader, on the real files', () => {
  const at = (grid: Float64Array, row: number, column: number, layer = 0) =>
    grid[layer * CELLS + row * LON + column]!
  const file = (month: string) =>
    path.join(
      cache,
      `ISCCP-Basic.HGM.v01r00.GLOBAL.${month}.99.9999.GPC.10KM.CS00.EA1.00.nc`,
    )

  it('decodes 2009-01 at 30.5° N, 200.5° E as the file packs it', async () => {
    const grids = await readIsccp(file('2009.01'))
    // cldamt 301, eqland 0, cldamt_types[1] −463, tau_types[1] −21901, pc_types[1] 292.
    expect(at(grids.cover, 120, 200)).toBeCloseTo(301 * 0.1 + 50, 5)
    expect(at(grids.land, 120, 200)).toBe(0)
    expect(at(grids.types, 120, 200, 1)).toBeCloseTo(-463 * 0.1 + 50, 5)
    expect(at(grids.depth, 120, 200, 1)).toBeCloseTo(-21901 * 0.01 + 225, 5)
    expect(at(grids.pressure, 120, 200, 1)).toBe(292 + 500)
    // cirrus_liquid: cldamt_types[12] −494, tau_types[12] −22317.
    expect(at(grids.depth, 120, 200, 12)).toBeCloseTo(-22317 * 0.01 + 225, 5)
    expect(at(grids.irTypes, 120, 200, 0)).toBeCloseTo(-208 * 0.1 + 50, 5)
  })

  it('reads the undeclared fill as missing where a type has no cloud: 2009-01 at 50.5° N, 10.5° E', async () => {
    const grids = await readIsccp(file('2009.01'))
    // cldamt 23, eqland 100, cldamt_types[12] −500 (0%), tau_types[12] −32767.
    expect(at(grids.cover, 140, 10)).toBeCloseTo(52.3, 5)
    expect(at(grids.land, 140, 10)).toBe(100)
    expect(at(grids.types, 140, 10, 12)).toBeCloseTo(0, 5)
    expect(Number.isNaN(at(grids.depth, 140, 10, 12))).toBe(true)
    expect(at(grids.depth, 140, 10, 1)).toBeCloseTo(-21610 * 0.01 + 225, 5)
  })

  it('finds the types missing in polar night and the total present: 2009-07 at 84.5° S, 100.5° E', async () => {
    const grids = await readIsccp(file('2009.07'))
    // cldamt −151, cldamt_types 32767, tau_types and pc_types −32767, cldamt_irtypes[0] −500.
    expect(at(grids.cover, 5, 100)).toBeCloseTo(34.9, 5)
    expect(Number.isNaN(at(grids.types, 5, 100, 1))).toBe(true)
    expect(Number.isNaN(at(grids.depth, 5, 100, 1))).toBe(true)
    expect(Number.isNaN(at(grids.pressure, 5, 100, 1))).toBe(true)
    expect(at(grids.irTypes, 5, 100, 0)).toBeCloseTo(0, 5)
  })
})
