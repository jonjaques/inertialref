import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import h5wasm from 'h5wasm/node'
import {
  BAUM_DIAMETERS,
  BAUM_ICE,
  ISCCP_H,
  isccpMonth,
  isccpMonths,
  WEATHER_SOURCES,
} from './weatherSources.ts'

/*
 * The weather's source records, and the one library both of its ingests
 * read their files with. No test here reaches the network or a source's
 * files: the records are what a generator prints, and the reader is held on
 * a file it writes itself.
 */

describe('the weather’s sources', () => {
  it('each carry a citation, a page, a license statement, a date and a cache outside the tree', () => {
    expect(WEATHER_SOURCES.map((source) => source.key)).toEqual([
      'baum-ice',
      'isccp-h',
    ])
    for (const source of WEATHER_SOURCES) {
      expect(source.url, source.key).toMatch(/^https:\/\//)
      expect(source.citations.length, source.key).toBeGreaterThan(0)
      for (const citation of source.citations)
        expect(citation.length).toBeGreaterThan(40)
      expect(source.license.length, source.key).toBeGreaterThan(0)
      expect(source.sourceDate, source.key).toMatch(/\d{4}/)
      // Fetched and extracted files live under `.data/`, which is ignored.
      expect(source.cache, source.key).toMatch(/^\.data\/weather\//)
      expect(source.table, source.key).toMatch(
        /^packages\/rendering\/src\/\w+\.generated\.ts$/,
      )
    }
  })

  it('say of Baum’s set that it states no license, quote its README’s date, and cite the paper its README points to', () => {
    expect(BAUM_ICE.license).toBe('no license or terms of use are stated')
    expect(BAUM_ICE.sourceDate).toBe('Last Updated: 25 July 2013')
    expect(BAUM_ICE.citations.join(' ')).toContain(
      'doi:10.1016/j.jqsrt.2014.02.029',
    )
    expect(BAUM_ICE.citations.join(' ')).toContain('doi:10.1175/2010JAMC2608.1')
    // 10 to 120 µm in steps of 5 is 23 diameters.
    const { least, greatest, step, count } = BAUM_DIAMETERS
    expect((greatest - least) / step + 1).toBe(count)
    // The README's counts are read from the files by the generator, which
    // refuses a file that differs: nothing of the record is taken unread.
    expect(BAUM_ICE.unread).toEqual([])
  })

  it('quote ISCCP-H’s own license attribute, and state no Creative Commons license for it', () => {
    expect(ISCCP_H.license).toContain('No constraints on data access or use.')
    expect(ISCCP_H.license).not.toMatch(/CC0|CC-BY|Creative Commons/i)
    expect(ISCCP_H.citations.join(' ')).toContain('10.7289/V5QZ281S')
    expect(ISCCP_H.citations.join(' ')).toContain('10.5194/essd-10-583-2018')
  })

  it('name ten years of monthly files, 120 of them, each once', () => {
    const months = isccpMonths()
    expect(months).toHaveLength(120)
    expect(new Set(months.map((month) => month.file)).size).toBe(120)
    expect(months[0]).toMatchObject({ year: 2007, month: 1 })
    expect(months.at(-1)).toMatchObject({ year: 2016, month: 12 })
    expect(isccpMonth(2009, 1).file).toBe(
      'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.01.99.9999.GPC.10KM.CS00.EA1.00.nc',
    )
    for (const month of months) {
      expect(month.url.endsWith(`/isccp-basic/hgm/${month.file}`)).toBe(true)
      expect(month.url).toMatch(/^https:\/\/www\.ncei\.noaa\.gov\//)
    }
    expect(() => isccpMonth(2009, 13)).toThrow()
    expect(() => isccpMonth(2009.5, 1)).toThrow()
  })
})

describe('the HDF5 reader both ingests share', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'inertialref-h5-'))

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  /*
   * Baum's files and ISCCP-H's NetCDF-4 are both HDF5. `h5wasm` is the
   * library in WebAssembly, so it reads them with no native build and no
   * Python beside the ingest; what it has to do here is what both ingests
   * ask of it: a float grid with a shape, a compressed one, a group, and an
   * attribute, read back as written.
   */
  it('writes a file and reads back a grid, its shape, a compressed copy and an attribute', async () => {
    await h5wasm.ready
    const file = path.join(directory, 'grid.h5')
    const values = Float32Array.from({ length: 6 * 4 }, (_, k) => k * 0.25 - 1)
    const made = new h5wasm.File(file, 'w')
    made.create_group('geolocation')
    made.create_dataset({ name: 'cldamt', data: values, shape: [6, 4] })
    made.create_dataset({
      name: 'geolocation/packed',
      data: values,
      shape: [6, 4],
      chunks: [3, 4],
      compression: 6,
    })
    made.create_attribute('license', 'No constraints on data access or use.')
    made.close()

    const read = new h5wasm.File(file, 'r')
    try {
      expect(read.keys().sort()).toEqual(['cldamt', 'geolocation'])
      const grid = read.get('cldamt') as InstanceType<typeof h5wasm.Dataset>
      expect(grid.shape).toEqual([6, 4])
      expect(grid.value).toEqual(values)
      const packed = read.get('geolocation/packed') as InstanceType<
        typeof h5wasm.Dataset
      >
      expect(packed.value).toEqual(values)
      // One row of the grid: what a zonal mean is taken over.
      expect(packed.slice([[2, 3]])).toEqual(values.subarray(8, 12))
      expect(read.attrs.license?.value).toBe(
        'No constraints on data access or use.',
      )
    } finally {
      read.close()
    }
  })
})
