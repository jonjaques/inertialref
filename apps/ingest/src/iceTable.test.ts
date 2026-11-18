import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  angleIndex,
  decodeIceTable,
  ICE_AGGREGATE,
} from '@inertialref/rendering'
import { describe, expect, it } from 'vitest'
import {
  BAUM_FILES,
  BAUM_MANIFEST,
  baumCache,
  baumCached,
  bandRow,
  checkReadme,
  generateIce,
  halfScale,
  iceBand,
  iceBands,
  type IceLayout,
  iceModel,
  iceRow,
  readBaum,
  readListed,
  readNetcdf,
  README_DATE,
  README_METHOD,
  resampleLog,
  sourceText,
  tableIntegral,
} from './iceTable.ts'
import { tableAngle } from './mieTable.ts'
import { BAUM_ICE } from './weatherSources.ts'

/* ------------------------------------------------------------------------- */
/* A NetCDF classic writer, for synthetic files                               */
/* ------------------------------------------------------------------------- */

interface SyntheticFile {
  readonly dimensions: readonly (readonly [string, number])[]
  readonly title?: string
  readonly variables: readonly {
    readonly name: string
    readonly dims: readonly string[]
    readonly values: ArrayLike<number>
  }[]
  /** The file's first four bytes, for refusals. */
  readonly magic?: readonly number[]
  readonly records?: number
}

/** A CDF-1 file: a fixed header, then every variable as big-endian float32 at its stated offset. */
function netcdfBytes(file: SyntheticFile): Uint8Array {
  const parts: number[] = []
  const int = (v: number) =>
    parts.push(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)
  const name = (s: string) => {
    const bytes = new TextEncoder().encode(s)
    int(bytes.length)
    parts.push(...bytes)
    while (parts.length % 4) parts.push(0)
  }
  parts.push(...(file.magic ?? [0x43, 0x44, 0x46, 1]))
  int(file.records ?? 0)
  int(10)
  int(file.dimensions.length)
  for (const [n, length] of file.dimensions) {
    name(n)
    int(length)
  }
  if (file.title === undefined) {
    int(0)
    int(0)
  } else {
    int(12)
    int(1)
    name('title')
    int(2)
    name(file.title)
  }
  int(11)
  int(file.variables.length)
  const ids = file.dimensions.map(([n]) => n)
  // Offsets are known only once the header's length is: lay it out with
  // placeholders, then patch each `begin`.
  const begins: number[] = []
  for (const v of file.variables) {
    name(v.name)
    int(v.dims.length)
    for (const d of v.dims) int(ids.indexOf(d))
    int(0)
    int(0)
    int(5)
    int(v.values.length * 4)
    begins.push(parts.length)
    int(0)
  }
  const bytes = new Uint8Array(
    parts.length + file.variables.reduce((n, v) => n + v.values.length * 4, 0),
  )
  bytes.set(parts)
  const view = new DataView(bytes.buffer)
  let at = parts.length
  file.variables.forEach((v, k) => {
    view.setInt32(begins[k]!, at)
    for (let i = 0; i < v.values.length; i += 1)
      view.setFloat32(at + 4 * i, v.values[i]!)
    at += v.values.length * 4
  })
  return bytes
}

/* ------------------------------------------------------------------------- */
/* A synthetic set: Henyey–Greenstein phases on Baum's layout, made small     */
/* ------------------------------------------------------------------------- */

const SMALL: IceLayout = {
  counts: { nDeff: 2, nScatAng: 38, nWaveLen: 12 },
  diameters: { least: 10, step: 5 },
}
const WAVELENGTHS = [
  0.4, 0.41, 0.44, 0.47, 0.48, 0.52, 0.55, 0.58, 0.65, 0.68, 0.71, 1.6,
]
/** 0° to 180°, dense at the forward end as Baum's are. */
const ANGLES = [
  0, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 25, 30, 40, 50,
  60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 165, 170, 172.5, 175, 177,
  178, 179, 179.5, 180,
]
/** g by row and wavelength: what a band's average of them should land between. */
const g = (row: number, l: number) => 0.6 + 0.1 * row + 0.01 * l
/** Baum's normalization, (1/2)∫P11 sin θ dθ = 1, is 4π times the HG phase. */
const hg = (asym: number, degrees: number) =>
  (1 - asym ** 2) /
  (1 + asym ** 2 - 2 * asym * Math.cos((degrees * Math.PI) / 180)) ** 1.5

interface SyntheticSet {
  readonly bulk?: (name: string, values: number[]) => number[]
  readonly angles?: readonly number[]
}

function syntheticFiles(options: SyntheticSet = {}) {
  const angles = options.angles ?? ANGLES
  const rows = SMALL.counts.nDeff
  const waves = WAVELENGTHS.length
  const grid = (f: (row: number, l: number) => number) =>
    Array.from({ length: rows * waves }, (_, k) =>
      f(Math.floor(k / waves), k % waves),
    )
  const bulk = {
    extinction_efficiency: grid((row, l) => 2 + 0.01 * row + 0.001 * l),
    single_scattering_albedo: grid((_, l) => 1 - 0.01 * l),
    asymmetry_parameter: grid(g),
    total_area: grid((row) => 100 * (row + 1)),
  }
  const shared = [
    { name: 'wavelengths', dims: ['nWaveLen'], values: WAVELENGTHS },
    { name: 'effective_diameter', dims: ['nDeff'], values: [10, 15] },
    ...Object.entries(bulk).map(([name, values]) => ({
      name,
      dims: ['nDeff', 'nWaveLen'],
      values,
    })),
  ]
  const dimensions = [
    ['nDeff', rows],
    ['nScatAng', angles.length],
    ['nWaveLen', waves],
  ] as const
  const p11 = Array.from({ length: angles.length * rows * waves }, (_, k) => {
    const l = k % waves
    const row = Math.floor(k / waves) % rows
    return hg(g(row, l), angles[Math.floor(k / (rows * waves))]!)
  })
  const phase = readNetcdf(
    netcdfBytes({
      dimensions,
      variables: [
        ...shared,
        {
          name: 'p11_phase_function',
          dims: ['nScatAng', 'nDeff', 'nWaveLen'],
          values: p11,
        },
        { name: 'phase_angles', dims: ['nScatAng'], values: angles },
      ],
    }),
  )
  const bulkFile = readNetcdf(
    netcdfBytes({
      dimensions,
      variables: shared.map((v) => ({
        ...v,
        values: options.bulk?.(v.name, [...v.values]) ?? v.values,
      })),
    }),
  )
  return { phase, bulk: bulkFile }
}

const smallModel = (options?: SyntheticSet) => {
  const files = syntheticFiles(options)
  return iceModel(files.phase, files.bulk, SMALL)
}

/* ------------------------------------------------------------------------- */

describe('the NetCDF classic reader', () => {
  it('reads back a file’s dimensions, attributes and float arrays', () => {
    const file = readNetcdf(
      netcdfBytes({
        dimensions: [
          ['a', 2],
          ['b', 3],
        ],
        title: 'ice',
        variables: [
          { name: 'x', dims: ['a', 'b'], values: [1, 2.5, -3, 0.1, 5e5, 6] },
        ],
      }),
    )
    expect([...file.dimensions]).toEqual([
      ['a', 2],
      ['b', 3],
    ])
    expect(file.attributes.get('title')).toBe('ice')
    expect(file.shape('x')).toEqual(['a', 'b'])
    expect([...file.read('x')]).toEqual([1, 2.5, -3, Math.fround(0.1), 5e5, 6])
    expect(() => file.read('y')).toThrow('no variable y')
  })

  it('refuses NetCDF-4, the 64-bit-data format and a record dimension rather than misreading them', () => {
    const plain = { dimensions: [['a', 1]] as const, variables: [] }
    expect(() =>
      readNetcdf(netcdfBytes({ ...plain, magic: [0x89, 0x48, 0x44, 0x46] })),
    ).toThrow('not a classic file')
    expect(() =>
      readNetcdf(netcdfBytes({ ...plain, magic: [0x43, 0x44, 0x46, 5] })),
    ).toThrow('version 5')
    expect(() => readNetcdf(netcdfBytes({ ...plain, records: 3 }))).toThrow(
      'record dimension',
    )
    expect(() =>
      readNetcdf(netcdfBytes({ dimensions: [['t', 0]], variables: [] })),
    ).toThrow('record dimension')
  })
})

describe('a set’s two files', () => {
  it('are read into one model, the bulk file’s properties held to the phase file’s copies', () => {
    const model = smallModel()
    expect(model.diameters).toEqual(Float64Array.from([10, 15]))
    expect(model.angles).toHaveLength(ANGLES.length)
    expect(model.p11).toHaveLength(ANGLES.length * 2 * WAVELENGTHS.length)
    expect(() =>
      smallModel({
        bulk: (name, values) =>
          name === 'asymmetry_parameter' ? values.map((v) => v + 0.01) : values,
      }),
    ).toThrow('asymmetry_parameter differ')
  })

  it('refuses counts the README does not give, and angles that stop short of either end', () => {
    const files = syntheticFiles()
    expect(() => iceModel(files.phase, files.bulk)).toThrow(
      'where the README says 23',
    )
    expect(() =>
      iceModel(files.phase, files.bulk, {
        ...SMALL,
        diameters: { least: 5, step: 5 },
      }),
    ).toThrow('effective diameters')
    // The reduction never extrapolates: a set that ends at 179.5° is refused.
    const short = ANGLES.slice(0, -1)
    const shortFiles = syntheticFiles({ angles: short })
    expect(() =>
      iceModel(shortFiles.phase, shortFiles.bulk, {
        ...SMALL,
        counts: { ...SMALL.counts, nScatAng: short.length },
      }),
    ).toThrow('0° to 179.5°, not 0° to 180°')
  })
})

describe('the reduction', () => {
  it('weights a band’s wavelengths under the droplets’ raised cosine, its edges out', () => {
    const grid = Float64Array.from({ length: 41 }, (_, k) => 0.4 + 0.01 * k)
    const band = iceBand(grid, 550)
    // 520 to 580 nm: 510 and 590 sit on the ±40 nm edge, where the weight is zero.
    expect(band.indices.map((k) => Math.round(grid[k]! * 1000))).toEqual([
      520, 530, 540, 550, 560, 570, 580,
    ])
    expect(band.nearest).toBe(false)
    const raw = [-30, -20, -10, 0, 10, 20, 30].map(
      (d) => Math.cos((Math.PI * d) / 80) ** 2,
    )
    const total = raw.reduce((s, w) => s + w, 0)
    band.weights.forEach((w, k) => expect(w).toBeCloseTo(raw[k]! / total, 14))
  })

  it('takes a sparse band’s two nearest wavelengths, linearly to its center, and says so', () => {
    const band = iceBand(Float64Array.from([0.4, 0.5, 0.6, 0.7]), 680)
    expect(band.nearest).toBe(true)
    expect(band.indices).toEqual([2, 3])
    expect(band.weights[0]).toBeCloseTo(0.2, 12)
    expect(band.weights[1]).toBeCloseTo(0.8, 12)
  })

  it('takes a band’s phase as its light’s, each wavelength weighted by what it scatters', () => {
    const model = smallModel()
    const band = {
      center: 550,
      indices: [5, 6],
      weights: [0.25, 0.75],
      nearest: false,
    }
    const row = bandRow(model, 1, band)
    // C_sca = w·A·Q_ext·ω a wavelength; the area is the row's, so it cancels.
    const sca = band.indices.map(
      (l, k) => band.weights[k]! * (2.01 + 0.001 * l) * (1 - 0.01 * l),
    )
    const total = sca[0]! + sca[1]!
    ANGLES.forEach((deg, i) => {
      const expected =
        (sca[0]! * Math.fround(hg(g(1, 5), deg)) +
          sca[1]! * Math.fround(hg(g(1, 6), deg))) /
        total /
        (4 * Math.PI)
      expect(row.phase[i]! / expected - 1).toBeCloseTo(0, 6)
    })
    const ext = band.indices.map(
      (l, k) => band.weights[k]! * (2.01 + 0.001 * l),
    )
    expect(row.extinction).toBeCloseTo(ext[0]! + ext[1]!, 6)
    expect(row.albedo).toBeCloseTo(total / (ext[0]! + ext[1]!), 6)
    expect(row.asymmetry).toBeCloseTo(
      (sca[0]! * Math.fround(g(1, 5)) + sca[1]! * Math.fround(g(1, 6))) / total,
      6,
    )
  })

  it('resamples in the logarithm, which is exact for a phase falling exponentially in θ', () => {
    const degrees = Float64Array.from(ANGLES)
    const phase = degrees.map((d) => Math.exp(3 - d / 20))
    const out = resampleLog(degrees, phase)
    expect(out).toHaveLength(1024)
    out.forEach((p, i) => {
      const d = (tableAngle(i) * 180) / Math.PI
      expect(p / Math.exp(3 - d / 20) - 1).toBeCloseTo(0, 12)
    })
    expect(() =>
      resampleLog(
        degrees,
        phase.map((p, i) => (i === 7 ? 0 : p)),
      ),
    ).toThrow('not positive')
    expect(() =>
      resampleLog(degrees.subarray(0, -1), phase.subarray(0, -1)),
    ).toThrow('outside the source')
  })

  it('renormalizes every row and band to one on the table’s own axis', () => {
    const model = smallModel()
    const bands = iceBands(model)
    for (const row of [0, 1]) {
      const reduced = iceRow(model, row, bands)
      for (let b = 0; b < 3; b += 1) {
        const band = Array.from(
          { length: 1024 },
          (_, i) => reduced.phase[3 * i + b]!,
        )
        expect(tableIntegral(band)).toBeCloseTo(1, 12)
        // The source's own trapezoid on 38 angles is coarse: renormalizing
        // moves it by under a few percent, never by a factor.
        expect(Math.abs(reduced.scale[b]! - 1)).toBeLessThan(0.05)
      }
    }
  })

  it('stores a row past half float’s 65504 halved or quartered, a power of two exactly', () => {
    expect(halfScale([1, 65503])).toBe(1)
    expect(halfScale([65519])).toBe(1)
    expect(halfScale([65520])).toBe(2)
    expect(halfScale([188_469])).toBe(4)
  })
})

describe('the generated file', () => {
  const files = [{ name: 'x.nc', bytes: 4, sha256: 'ab'.repeat(32) }]

  it('decodes to the rows it was made from, each scaled back by its power of two', () => {
    const model = smallModel()
    const source = generateIce(model, files)
    // A synthetic forward peak large enough to need a scale.
    const big = { ...source, scales: [1, 4] }
    const table = decodeIceTable(source)
    const scaled = decodeIceTable(big)
    expect(scaled.phase[1024 * 3 + 5]).toBe(4 * table.phase[1024 * 3 + 5]!)
    expect(scaled.phase[5]).toBe(table.phase[5])
    const rows = iceBands(model)
    const row = iceRow(model, 1, rows)
    for (const i of [0, 100, 511, 1023])
      for (let b = 0; b < 3; b += 1)
        expect(table.phase[(1024 + i) * 3 + b]!).toBe(
          Math.f16round(row.phase[3 * i + b]!),
        )
  })

  it('carries the citation, the license statement and the README’s date, and nothing that differs between runs', () => {
    const model = smallModel()
    const text = sourceText(generateIce(model, files))
    expect(text).toBe(sourceText(generateIce(model, files)))
    expect(text).toContain('Cite: Baum, B. A., P. Yang')
    expect(text).toContain('doi:10.1016/j.jqsrt.2014.02.029')
    expect(text).toContain('doi:10.1175/2010JAMC2608.1')
    expect(text).toContain('License: no license or terms of use are stated.')
    expect(text).toContain(`The README is dated "${README_DATE}".`)
    expect(text).toContain(`x.nc  4  ${'ab'.repeat(32)}`)
    expect(text).not.toMatch(/Node v|\d+\.\d s\b|darwin|Apple/)
  })
})

describe('the README', () => {
  it('is held to the words the record quotes, and to stating no terms', () => {
    const text = `Hope these models are useful -\n\nplease refer to the 2011 paper for details - the\nmethodology has not changed in the meantime.\n\n${README_DATE}\n`
    expect(() => checkReadme(text)).not.toThrow()
    expect(() =>
      checkReadme(text.replace(README_DATE, 'Last Updated: 1 May 2020')),
    ).toThrow(README_DATE)
    expect(() =>
      checkReadme(`${text}Distributed under the MIT License.`),
    ).toThrow('License')
    expect(() => checkReadme(text.replace('2011 paper', '2014 paper'))).toThrow(
      README_METHOD,
    )
  })

  it('and every file is held to the manifest’s bytes and hash', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ice-'))
    try {
      writeFileSync(join(directory, BAUM_FILES.readme), 'not the README')
      writeFileSync(join(directory, 'other.nc'), 'x')
      expect(() => readListed(directory, BAUM_FILES.readme)).toThrow(
        'the manifest records 2122',
      )
      expect(() => readListed(directory, 'other.nc')).toThrow(
        'not in the manifest',
      )
      expect(baumCached(directory)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true })
    }
  })
})

/*
 * The table recomputed from Baum's files, where they are extracted. CI has
 * no copy, so this block skips there: the archive is a registered download
 * and is never committed, and the skip says so by its name.
 */
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url))
const CACHE = baumCache(REPOSITORY)
const HAVE_SOURCE = baumCached(CACHE)

describe.skipIf(!HAVE_SOURCE)(
  `the committed table against Baum's own rows (skips without ${BAUM_ICE.cache})`,
  () => {
    const model = HAVE_SOURCE ? readBaum(CACHE) : undefined

    it('is what the generator makes from the extracted files, bit for bit', () => {
      expect(generateIce(model!, BAUM_MANIFEST)).toEqual(ICE_AGGREGATE)
    })

    it('equals the source at the source’s own angles, within the renormalization and a half float', () => {
      const table = decodeIceTable(ICE_AGGREGATE)
      const bands = iceBands(model!)
      let worst = 0
      for (let j = 0; j < table.diameters; j += 1)
        for (let b = 0; b < 3; b += 1) {
          const source = bandRow(model!, j, bands[b]!).phase
          model!.angles.forEach((deg, i) => {
            // Past the forward peak, where the table's texels are finer
            // than the source's curvature and a linear read is the
            // source's own value.
            if (deg < 1) return
            const a = angleIndex(table, (deg * Math.PI) / 180)
            const a0 = Math.min(Math.floor(a), table.angles - 2)
            const at = (i: number) =>
              table.phase[(j * table.angles + i) * 3 + b]!
            const read = at(a0) + (at(a0 + 1) - at(a0)) * (a - a0)
            worst = Math.max(worst, Math.abs(read / source[i]! - 1))
          })
        }
      // The renormalization moves a row by at most 0.28% (the 120 µm row in
      // blue) and a half float rounds by 2⁻¹¹.
      expect(worst).toBeLessThan(0.0035)
    })
  },
)
