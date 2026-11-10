import { describe, expect, it } from 'vitest'
import {
  angleIndex,
  angleOf,
  convolveDisk,
  decodeMieTable,
  diffractionShare,
  halfBitsOf,
  type MieTable,
  type MieTableSource,
  mieDroplets,
  PHASE_ATLAS,
  phaseAtlas,
  phaseIntegral,
  type PhaseRows,
  radiusIndex,
  radiusOf,
  sampleAtlas,
  samplePhase,
  toHalves,
} from './mieTable.ts'
import { MIE_DROPLETS } from './mieDroplets.generated.ts'
import { iceAggregate, type IceTable } from './iceTable.ts'

/*
 * These read the committed table, never the generator: a table that drifts
 * from what its decoder and its consumers assume fails here, in the gate,
 * whatever the series in apps/ingest says.
 */

const table = mieDroplets()
const DEGREE = Math.PI / 180
const at = (row: number, angle: number, band: number) =>
  table.phase[(row * table.angles + angle) * 3 + band]!

/** The texel spacing at θ, degrees. */
function texelStep(t: MieTable, theta: number): number {
  const i = Math.min(Math.floor(angleIndex(t, theta)), t.angles - 2)
  return (angleOf(t, i + 1) - angleOf(t, i)) / DEGREE
}

describe('the droplet table', () => {
  it('is 1024 angles × 32 rows × 3 bands of finite, positive phase', () => {
    expect(table.angles).toBe(1024)
    expect(table.radii).toBe(32)
    expect(table.bands).toEqual([680, 550, 440])
    expect(table.phase).toHaveLength(1024 * 32 * 3)
    // 0.0011 to 8560 sr⁻¹ measured: normal halves, under 65504.
    for (const p of table.phase) {
      expect(Number.isFinite(p)).toBe(true)
      expect(p).toBeGreaterThan(0)
    }
  })

  it('puts the glory’s first red ring where the series does (the Done-when’s second half)', () => {
    // The first maximum of the red band's p(π − ψ) after its first minimum
    // past ψ = 0, read through samplePhase at each row's own radius at 0.005°,
    // within one texel of the series' ring: 0.03° at the largest row's 0.64°,
    // 0.12° at the smallest's 9.1°. That holds the angle warp, the half floats
    // and the bilinear read to the series, which apps/ingest holds to Laven.
    // Half a texel at worst, measured.
    const step = 0.005
    for (let row = 0; row < table.radii; row += 1) {
      const radius = radiusOf(table, row)
      const values: number[] = []
      let ring = -1
      for (let k = 0; ring < 0 && k * step < 60 / radius; k += 1) {
        values.push(samplePhase(table, -Math.cos(k * step * DEGREE), radius)[0])
        ring = firstRing(values)
      }
      expect(ring).toBeGreaterThan(0)
      const psi = ring * step
      expect(Math.abs(psi - table.gloryRed[row]!)).toBeLessThanOrEqual(
        texelStep(table, Math.PI - psi * DEGREE),
      )
    }
  })

  it('normalizes every row and band to ∫p dΩ = 1 on its own grid', () => {
    // 6 × 10⁻⁵ at worst, measured: the trapezoid resolves even the largest
    // row's forward peak, 1/x = 0.13° wide in blue, across seventeen texels.
    for (let row = 0; row < table.radii; row += 1)
      for (let band = 0; band < 3; band += 1)
        expect(Math.abs(phaseIntegral(table, row, band) - 1)).toBeLessThan(1e-4)
  })

  it('peaks straight ahead and falls from there across 0.5·(10/r_e) degrees', () => {
    // Non-increasing rather than falling: texels a ten-thousandth of a degree
    // apart near 0° round to one half float.
    for (let row = 0; row < table.radii; row += 1) {
      const reach = 0.5 * (10 / radiusOf(table, row)) * DEGREE
      for (let band = 0; band < 3; band += 1) {
        const peak = at(row, 0, band)
        for (let i = 1; i < table.angles; i += 1)
          expect(at(row, i, band)).toBeLessThanOrEqual(peak)
        for (let i = 0; angleOf(table, i + 1) <= reach; i += 1)
          expect(at(row, i + 1, band)).toBeLessThanOrEqual(at(row, i, band))
      }
    }
  })

  it('draws the cloudbow between 135° and 150° for drops of 10 µm and more', () => {
    // A maximum strictly inside the window is above both its ends; 139.7° to
    // 142.0° measured.
    const lo = Math.ceil(angleIndex(table, 135 * DEGREE))
    const hi = Math.floor(angleIndex(table, 150 * DEGREE))
    for (let row = 0; row < table.radii; row += 1) {
      if (radiusOf(table, row) < 10 - 1e-9) continue
      for (let band = 0; band < 3; band += 1) {
        let best = lo
        for (let i = lo; i <= hi; i += 1)
          if (at(row, i, band) > at(row, best, band)) best = i
        expect(at(row, best, band)).toBeGreaterThan(at(row, lo, band))
        expect(at(row, best, band)).toBeGreaterThan(at(row, hi, band))
      }
    }
  })

  it('carries bulk properties a cloud of droplets has', () => {
    // From the series: the edge term and the ripple put Q_ext at 2.27 for
    // 2 µm, falling to 2.04 at 32 µm, where droplets ≫ λ alone would say 2;
    // g from 0.82 to 0.88. Water does not absorb in the visible here, κ = 0.
    for (const { extinction, albedo, asymmetry } of table.bulk) {
      expect(extinction).toBeGreaterThanOrEqual(1.9)
      expect(extinction).toBeLessThanOrEqual(2.5)
      expect(asymmetry).toBeGreaterThanOrEqual(0.8)
      expect(asymmetry).toBeLessThanOrEqual(0.9)
      expect(albedo).toBe(1)
    }
    expect(table.bulk).toHaveLength(table.radii)
    expect(table.gloryRed).toHaveLength(table.radii)
  })
})

describe('the table’s reads', () => {
  it('inverts its own angle and row maps', () => {
    for (const i of [0, 1, 2, 100, 511, 512, 900, 1022, 1023])
      expect(angleIndex(table, angleOf(table, i))).toBeCloseTo(i, 9)
    for (let j = 0; j < table.radii; j += 1)
      expect(radiusIndex(table, radiusOf(table, j))).toBeCloseTo(j, 9)
    expect(angleOf(table, 0)).toBe(0)
    expect(angleOf(table, 1023)).toBeCloseTo(Math.PI, 15)
  })

  it('reads a texel center exactly and clamps past both axes’ ends', () => {
    for (const [row, angle] of [
      [0, 0],
      [7, 300],
      [31, 1023],
      [20, 1000],
    ] as const) {
      const sampled = samplePhase(
        table,
        Math.cos(angleOf(table, angle)),
        radiusOf(table, row),
      )
      for (let band = 0; band < 3; band += 1)
        expect(sampled[band]).toBeCloseTo(at(row, angle, band), 6)
    }
    // Past the radius axis the edge rows answer, as a clamped texture does.
    expect(samplePhase(table, -1, 1)).toEqual(samplePhase(table, -1, 2))
    expect(samplePhase(table, 0.2, 64)).toEqual(samplePhase(table, 0.2, 32))
  })

  it('refuses a source that is not a table', () => {
    const good: MieTableSource = MIE_DROPLETS
    expect(() => decodeMieTable({ ...good, version: 2 } as never)).toThrow(
      'version 1',
    )
    expect(() => decodeMieTable({ ...good, radii: 31 })).toThrow('half floats')
    expect(() =>
      decodeMieTable({ ...good, phase: '!' + good.phase.slice(1) }),
    ).toThrow('not base64')
    expect(() => decodeMieTable({ ...good, bulk: good.bulk.slice(1) })).toThrow(
      'one bulk entry a row',
    )
    expect(() =>
      decodeMieTable({ ...good, gloryRed: good.gloryRed.slice(1) }),
    ).toThrow('one glory angle a row')
  })
})

/** The sample index of the first maximum after the first minimum past index 0, or −1. */
function firstRing(values: readonly number[]): number {
  let minimum = -1
  for (let i = 1; i + 1 < values.length; i += 1) {
    if (minimum < 0) {
      if (values[i - 1]! > values[i]! && values[i + 1]! >= values[i]!)
        minimum = i
    } else if (values[i - 1]! < values[i]! && values[i + 1]! <= values[i]!)
      return i
  }
  return -1
}

describe('the diffraction’s share', () => {
  it('is 1/Q_ext at each row’s own radius', () => {
    for (let row = 0; row < table.radii; row += 1)
      expect(diffractionShare(table, radiusOf(table, row))).toBeCloseTo(
        1 / table.bulk[row]!.extinction,
        12,
      )
  })

  it('runs from 0.44 at 2 µm to 0.49 at 32 µm: near half of a large droplet’s extinction is diffraction', () => {
    const small = diffractionShare(table, table.radiusMin)
    const large = diffractionShare(table, table.radiusMax)
    expect(small).toBeGreaterThan(0.43)
    expect(small).toBeLessThan(0.45)
    expect(large).toBeGreaterThan(0.48)
    expect(large).toBeLessThan(0.5)
  })

  it('is linear in the row between two rows, and holds at the table’s ends past them', () => {
    const share = (row: number) => 1 / table.bulk[row]!.extinction
    for (const row of [0, 7, 30]) {
      const between = radiusOf(table, row + 0.25)
      expect(diffractionShare(table, between)).toBeCloseTo(
        share(row) + 0.25 * (share(row + 1) - share(row)),
        12,
      )
    }
    expect(diffractionShare(table, 0.5)).toBe(share(0))
    expect(diffractionShare(table, 200)).toBe(share(table.radii - 1))
  })
})

/** The sun's angular radius from Earth, radians (phase 1 design §5.4). */
const EARTH_SUN = 0.265 * DEGREE

/** A table of one row on the table's axis, every band `p(θ)`. */
function rowOf(angles: number, p: (theta: number) => number): PhaseRows {
  const phase = new Float32Array(angles * 3)
  for (let i = 0; i < angles; i += 1)
    phase.fill(p(angleOf({ angles }, i)), 3 * i, 3 * i + 3)
  return { angles, phase }
}

/** Henyey–Greenstein, sr⁻¹. */
const henyeyGreenstein =
  (g: number) =>
  (theta: number): number =>
    (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * Math.cos(theta)) ** 1.5)

/**
 * Henyey–Greenstein averaged over a cap of angular radius α, by Funk–Hecke:
 * Σ (2l + 1)/(4π)·gˡ·k_l·P_l(cos Θ), with k_l = (P_{l−1}(cos α) −
 * P_{l+1}(cos α))/((2l + 1)(1 − cos α)) the cap's own mean of P_l. Summed
 * until gˡ is under 10⁻¹², every term in float64.
 */
function funkHecke(g: number, alpha: number, cosines: readonly number[]) {
  const terms = Math.ceil(Math.log(1e-12) / Math.log(g))
  const ca = Math.cos(alpha)
  const cap = new Float64Array(terms + 2)
  cap[0] = 1
  cap[1] = ca
  for (let l = 2; l <= terms + 1; l += 1)
    cap[l] = ((2 * l - 1) * ca * cap[l - 1]! - (l - 1) * cap[l - 2]!) / l
  return cosines.map((x) => {
    let sum = 1 / (4 * Math.PI)
    let p0 = 1
    let p1 = x
    let power = g
    for (let l = 1; l <= terms; l += 1) {
      if (l > 1) {
        const p2 = ((2 * l - 1) * x * p1 - (l - 1) * p0) / l
        p0 = p1
        p1 = p2
      }
      const k = (cap[l - 1]! - cap[l + 1]!) / ((2 * l + 1) * (1 - ca))
      sum += ((2 * l + 1) / (4 * Math.PI)) * power * k * p1
      power *= g
    }
    return sum
  })
}

/** The worst relative difference of band 0 from `expected`, texel by texel. */
function worstRelative(phase: Float32Array, expected: readonly number[]) {
  let worst = 0
  expected.forEach((value, i) => {
    worst = Math.max(worst, Math.abs(phase[3 * i]! / value - 1))
  })
  return worst
}

/**
 * The red glory's first ring of a table at a radius, read through
 * `samplePhase` at 0.005° out from the antisolar point: the trough is the
 * least value before the curve rises 0.2% over it, and the ring the greatest
 * before it falls 0.2% under that. A disk's average carries ripples of a
 * hundred-thousandth from the half floats' steps in the glory's flat core,
 * which a turn-by-turn search reads as the first ring.
 */
function gloryOf(
  t: MieTable,
  radius: number,
): { ring: number; contrast: number } {
  const step = 0.005
  const at = (k: number) =>
    samplePhase(t, -Math.cos(k * step * DEGREE), radius)[0]
  const reach = Math.ceil(60 / radius / step)
  let trough = 0
  let k = 1
  for (; k < reach; k += 1) {
    if (at(k) < at(trough)) trough = k
    else if (at(k) > at(trough) * 1.002) break
  }
  let ring = k
  for (; k < reach; k += 1) {
    if (at(k) > at(ring)) ring = k
    else if (at(k) < at(ring) / 1.002) break
  }
  return { ring: ring * step, contrast: at(ring) / at(trough) }
}

/**
 * Each row's red glory under Earth's sun, from the series: the red band's
 * p(π − ψ) at 0.005° on the generator's own radius grid, weights and
 * wavelengths (`apps/ingest/src/mieTable.ts`, `gloryRing`'s sum), averaged
 * over a 0.265° cap on the sphere by 48 equal-area rings of 96 points each,
 * its first ring and that ring's peak over its trough found as `gloryOf`
 * finds them. Taken once on this Mac mini (Mac18,5, Apple M6), 27 s for the
 * 32 rows. Against `gloryRed`, the disk moves the ring inward where the
 * ring is near the disk's own size, 0.065° at 32 µm, and all but erases it
 * there: peak over trough 1.651 under a point sun, 1.015 under the disk.
 */
const DISK_GLORY: readonly (readonly [ring: number, contrast: number])[] = [
  [9.12, 2.219],
  [8.425, 2.357],
  [7.705, 2.164],
  [6.96, 1.885],
  [6.27, 1.827],
  [5.735, 2.126],
  [5.315, 2.566],
  [4.92, 2.412],
  [4.515, 1.978],
  [4.14, 1.83],
  [3.805, 1.933],
  [3.475, 2.014],
  [3.175, 2.0],
  [2.935, 1.963],
  [2.69, 1.869],
  [2.455, 1.857],
  [2.255, 1.867],
  [2.075, 1.803],
  [1.9, 1.754],
  [1.74, 1.717],
  [1.595, 1.663],
  [1.465, 1.608],
  [1.34, 1.551],
  [1.23, 1.5],
  [1.125, 1.446],
  [1.03, 1.38],
  [0.945, 1.315],
  [0.865, 1.256],
  [0.79, 1.195],
  [0.72, 1.13],
  [0.65, 1.067],
  [0.575, 1.015],
]

describe('the phase under a sun’s disk', () => {
  const convolved: MieTable = {
    ...table,
    phase: convolveDisk(table, EARTH_SUN),
  }

  it('is the table’s own, texel for texel, under a point sun', () => {
    const own = convolveDisk(table, 0)
    expect(own).toHaveLength(table.phase.length)
    expect(own).toEqual(table.phase)
    expect(own).not.toBe(table.phase)
  })

  it('tends to the table’s own as the disk shrinks', () => {
    // First order in the radius, at the poles: there the axis is quadratic
    // in the texel index, so a phase smooth in the index has a slope in the
    // angle that a cap's mean sees at once. 1.5 × 10⁻⁵ at 10⁻⁶ rad,
    // 2.0 × 10⁻⁶ at 10⁻⁷ and 2.5 × 10⁻⁷ at 10⁻⁸, measured.
    const worst = (alpha: number): number => {
      const small = convolveDisk(table, alpha)
      let most = 0
      for (let k = 0; k < small.length; k += 1)
        most = Math.max(most, Math.abs(small[k]! / table.phase[k]! - 1))
      return most
    }
    expect(worst(1e-8)).toBeLessThan(1e-6)
    expect(worst(1e-7)).toBeLessThan(1e-5)
    expect(worst(1e-7)).toBeGreaterThan(worst(1e-8))
  })

  it('leaves an isotropic phase isotropic, exactly', () => {
    const isotropic = rowOf(1024, () => Math.fround(1 / (4 * Math.PI)))
    for (const alpha of [EARTH_SUN, 5 * DEGREE])
      expect(convolveDisk(isotropic, alpha)).toEqual(isotropic.phase)
  })

  it('keeps each row’s integral to 10⁻⁴', () => {
    // 1.4 × 10⁻⁵ at worst, measured, the largest row in blue: the disk
    // moves light out of the forward peak and makes none.
    for (let row = 0; row < table.radii; row += 1)
      for (let band = 0; band < 3; band += 1)
        expect(
          Math.abs(
            phaseIntegral(convolved, row, band) -
              phaseIntegral(table, row, band),
          ),
        ).toBeLessThan(1e-4)
  })

  it('equals the Funk–Hecke form on a Henyey–Greenstein phase to 10⁻⁴', () => {
    // Under 10⁻⁷ for g of 0.5 and 0.85, 1.8 × 10⁻⁶ and 5.7 × 10⁻⁶ at 0.99,
    // measured, where the unconvolved phase misses the form by 16% and by a
    // factor of 8. The control: at 2° the unconvolved phase misses it by
    // more than the bound for every g, so the bound sees the disk.
    const angles = 1024
    const cosines = Array.from({ length: angles }, (_, i) =>
      Math.cos(angleOf({ angles }, i)),
    )
    for (const g of [0.5, 0.85, 0.99])
      for (const alpha of [EARTH_SUN, 2 * DEGREE]) {
        const phase = rowOf(angles, henyeyGreenstein(g))
        const expected = funkHecke(g, alpha, cosines)
        expect(
          worstRelative(convolveDisk(phase, alpha), expected),
        ).toBeLessThan(1e-4)
        if (alpha > EARTH_SUN)
          expect(worstRelative(phase.phase, expected)).toBeGreaterThan(1e-4)
      }
  })

  it('puts the glory’s first red ring where the series does under the disk, within one texel, at its contrast to 1%', () => {
    // 0.04° and 0.3% at worst, measured. Under a point sun the largest rows
    // miss both: 0.07° out at 32 µm, two texels, at a contrast 63% high.
    for (let row = 0; row < table.radii; row += 1) {
      const [ring, contrast] = DISK_GLORY[row]!
      const glory = gloryOf(convolved, radiusOf(table, row))
      expect(Math.abs(glory.ring - ring)).toBeLessThanOrEqual(
        texelStep(table, Math.PI - ring * DEGREE),
      )
      expect(Math.abs(glory.contrast / contrast - 1)).toBeLessThan(0.01)
    }
    const point = gloryOf(table, table.radiusMax)
    const [ring, contrast] = DISK_GLORY[table.radii - 1]!
    expect(Math.abs(point.ring - ring)).toBeGreaterThan(
      texelStep(table, Math.PI - ring * DEGREE),
    )
    expect(point.contrast / contrast).toBeGreaterThan(1.5)
  })

  it('keeps `gloryRed` where the ring is six disk radii out or more', () => {
    // Rows 0 to 20, 12 µm and under: the disk is small beside the ring.
    for (let row = 0; row < table.radii; row += 1) {
      const red = table.gloryRed[row]!
      if (red < 6 * (EARTH_SUN / DEGREE)) continue
      expect(
        Math.abs(gloryOf(convolved, radiusOf(table, row)).ring - red),
      ).toBeLessThanOrEqual(texelStep(table, Math.PI - red * DEGREE))
    }
  })

  it('moves the cloudbow by one texel at most and keeps 98% of its peak over its trough', () => {
    // From 10 µm: 139.70° to 141.98° under the disk as under a point sun,
    // moved 0.23° at most (one texel), its contrast 98.5% kept at worst.
    const bow = (t: MieTable, row: number, band: number) => {
      const at = (i: number) => t.phase[(row * t.angles + i) * 3 + band]!
      const lo = Math.ceil(angleIndex(t, 135 * DEGREE))
      const hi = Math.floor(angleIndex(t, 150 * DEGREE))
      let peak = lo
      for (let i = lo; i <= hi; i += 1) if (at(i) > at(peak)) peak = i
      let trough = Math.ceil(angleIndex(t, 125 * DEGREE))
      for (let i = trough; i < peak; i += 1) if (at(i) < at(trough)) trough = i
      return { peak, contrast: at(peak) / at(trough) }
    }
    for (let row = 0; row < table.radii; row += 1) {
      if (radiusOf(table, row) < 10 - 1e-9) continue
      for (let band = 0; band < 3; band += 1) {
        const point = bow(table, row, band)
        const disk = bow(convolved, row, band)
        expect(Math.abs(disk.peak - point.peak)).toBeLessThanOrEqual(1)
        expect(disk.contrast / point.contrast).toBeGreaterThan(0.98)
        expect(angleOf(table, disk.peak) / DEGREE).toBeGreaterThan(139.6)
        expect(angleOf(table, disk.peak) / DEGREE).toBeLessThan(142.1)
      }
    }
  })

  it('refuses a radius that is not a disk', () => {
    expect(() => convolveDisk(table, -1e-3)).toThrow('not a disk')
    expect(() => convolveDisk(table, Math.PI / 2)).toThrow('not a disk')
    expect(() => convolveDisk(table, Number.NaN)).toThrow('not a disk')
  })
})

/** An ice table of `diameters` rows on the droplets' axis, every texel its own. */
function structuredIce(diameters: number): IceTable {
  const angles = table.angles
  const phase = new Float32Array(diameters * angles * 3)
  for (let row = 0; row < diameters; row += 1)
    for (let i = 0; i < angles; i += 1)
      for (let band = 0; band < 3; band += 1)
        phase[(row * angles + i) * 3 + band] =
          0.05 + 5 * Math.exp(-angleOf(table, i) * (4 + row)) + 0.01 * band
  return {
    angles,
    diameters,
    diameterMin: 10,
    diameterStep: 5,
    bands: table.bands,
    phase,
    bulk: Array.from({ length: diameters }, (_, row) => ({
      extinction: 2 + 0.01 * row,
      albedo: 1,
      asymmetry: 0.75,
    })),
  }
}

describe('the phase atlas', () => {
  const { rows, iceRow } = PHASE_ATLAS
  const texel = (
    atlas: { texels: Float32Array; width: number },
    row: number,
    i: number,
  ) =>
    Array.from(
      atlas.texels.subarray(
        (row * atlas.width + i) * 4,
        (row * atlas.width + i + 1) * 4,
      ),
    )

  it('is 1024 × 64: the droplets convolved, their gain beside them, the ice from row 32, nothing else', () => {
    const atlas = phaseAtlas(table, iceAggregate(), EARTH_SUN)
    expect([atlas.width, atlas.height]).toEqual([1024, rows])
    expect(atlas.texels).toHaveLength(1024 * 64 * 4)
    // The committed ice is Baum's 23 diameters, the whole of the block the
    // atlas holds for it.
    expect([atlas.dropletRows, atlas.iceRows]).toEqual([
      32,
      PHASE_ATLAS.iceRows,
    ])
    const droplets = convolveDisk(table, EARTH_SUN)
    for (let row = 0; row < table.radii; row += 1) {
      const gain = 1 / (1 - 1 / table.bulk[row]!.extinction)
      for (const i of [0, 7, 511, 1000, 1023])
        expect(texel(atlas, row, i)).toEqual([
          ...droplets.subarray((row * 1024 + i) * 3, (row * 1024 + i) * 3 + 3),
          Math.fround(gain),
        ])
    }
    // The ice is generated on the droplets' axis, so it is placed as it is,
    // convolved with the same sun, each row with its own Q_ext's gain.
    const ice = iceAggregate()
    const convolved = convolveDisk(ice, EARTH_SUN)
    for (let row = 0; row < ice.diameters; row += 1) {
      const gain = Math.fround(1 / (1 - 1 / ice.bulk[row]!.extinction))
      for (let i = 0; i < 1024; i += 1)
        expect(texel(atlas, iceRow + row, i)).toEqual([
          ...convolved.subarray((row * 1024 + i) * 3, (row * 1024 + i) * 3 + 3),
          gain,
        ])
    }
    for (let row = iceRow + ice.diameters; row < rows; row += 1)
      for (const i of [0, 512, 1023])
        expect(texel(atlas, row, i)).toEqual([0, 0, 0, 0])
    // Under Earth's sun the atlas is inside RGBA16F's range: the largest
    // crystal's forward peak, 188,416 sr⁻¹ in blue before the disk, is
    // 6,572 after it.
    expect(atlas.texels.every((v) => Number.isFinite(v) && v < 65504)).toBe(
      true,
    )
  })

  it('places a full ice table at rows 32 to 54, each row convolved and gained as its own', () => {
    const ice = structuredIce(PHASE_ATLAS.iceRows)
    const atlas = phaseAtlas(table, ice, EARTH_SUN)
    const convolved = convolveDisk(ice, EARTH_SUN)
    for (let row = 0; row < ice.diameters; row += 1) {
      const gain = Math.fround(1 / (1 - 1 / ice.bulk[row]!.extinction))
      for (const i of [0, 3, 300, 1023])
        expect(texel(atlas, iceRow + row, i)).toEqual([
          ...convolved.subarray((row * 1024 + i) * 3, (row * 1024 + i) * 3 + 3),
          gain,
        ])
    }
    expect(texel(atlas, iceRow + ice.diameters, 0)).toEqual([0, 0, 0, 0])
  })

  it('reads a texel center exactly, and between rows as the sampler does', () => {
    const atlas = phaseAtlas(
      table,
      structuredIce(PHASE_ATLAS.iceRows),
      EARTH_SUN,
    )
    for (const [row, i] of [
      [0, 0],
      [20, 600],
      [iceRow, 1023],
      [54, 17],
    ] as const) {
      const read = sampleAtlas(atlas, Math.cos(angleOf(table, i)), row)
      texel(atlas, row, i).forEach((value, c) =>
        expect(read[c]).toBeCloseTo(value, 6),
      )
    }
    const half = sampleAtlas(atlas, -1, 10.5)
    const low = texel(atlas, 10, 1023)
    const high = texel(atlas, 11, 1023)
    half.forEach((value, c) =>
      expect(value).toBeCloseTo((low[c]! + high[c]!) / 2, 6),
    )
  })

  it('refuses tables it cannot hold', () => {
    const ice = iceAggregate()
    expect(() => phaseAtlas({ ...table, radii: 33 }, ice, 0)).toThrow(
      'droplet rows',
    )
    expect(() => phaseAtlas(table, structuredIce(24), 0)).toThrow('ice rows')
    expect(() =>
      phaseAtlas(table, { ...ice, bands: [700, 550, 440] }, 0),
    ).toThrow('bands')
    expect(() =>
      phaseAtlas(
        table,
        { ...ice, bulk: ice.bulk.map((b) => ({ ...b, extinction: 1 })) },
        0,
      ),
    ).toThrow('no light past the diffraction')
  })
})

/*
 * Node's float16, which the core project's lib (ES2024) does not type: the
 * reference the converter is held to, present at runtime in Node 26.
 */
const f16 = {
  round: (Math as unknown as { f16round(x: number): number }).f16round,
  view: () =>
    new DataView(new ArrayBuffer(2)) as unknown as {
      setFloat16(at: number, value: number): void
      getFloat16(at: number): number
      setUint16(at: number, value: number): void
      getUint16(at: number): number
    },
}

describe('the atlas’s half floats', () => {
  /** `Math.f16round`'s rounding of a value, as bits. */
  const reference = (value: number): number => {
    const view = f16.view()
    view.setFloat16(0, f16.round(value))
    return view.getUint16(0)
  }

  it('round a float32 to nearest, ties to even, as `Math.f16round` does, across every exponent', () => {
    const float = new Float32Array(1)
    const bits = new Uint32Array(float.buffer)
    // A stride prime to 2³², so every exponent and both signs are crossed,
    // a quarter of a million patterns; NaN's payload is not compared.
    for (let pattern = 0; pattern < 2 ** 32; pattern += 16_411) {
      bits[0] = pattern
      if (Number.isNaN(float[0]!)) continue
      expect(halfBitsOf(float[0]!)).toBe(reference(float[0]!))
    }
    // The edges: ties at both ends of a binade and of the subnormals, the
    // largest half and the tie past it, and the least subnormal's half.
    for (const value of [
      0,
      -0,
      1,
      1 + 2 ** -11,
      1 + 3 * 2 ** -11,
      2 ** -24,
      2 ** -25,
      3 * 2 ** -26,
      2 ** -14 - 2 ** -25,
      65504,
      65519,
      65520,
      -65520,
      Infinity,
      -Infinity,
    ])
      expect(halfBitsOf(value), String(value)).toBe(
        reference(Math.fround(value)),
      )
    expect(halfBitsOf(Number.NaN) & 0x7c00).toBe(0x7c00)
    expect(halfBitsOf(Number.NaN) & 0x3ff).not.toBe(0)
  })

  it('leave a table already in half floats as it is, bit for bit', () => {
    // A half's value is exact in a float32, so a table decoded from halves
    // must convert back to the bits it was decoded from: the point sun's
    // atlas is the generated file's halves, whatever the rounding.
    const view = f16.view()
    const valueOf = (bits: number): number => {
      view.setUint16(0, bits)
      return view.getFloat16(0)
    }
    const halves = toHalves(table.phase)
    expect(halves).toHaveLength(table.phase.length)
    for (let k = 0; k < halves.length; k += 1)
      if (valueOf(halves[k]!) !== table.phase[k])
        expect(valueOf(halves[k]!)).toBe(table.phase[k])
  })
})
