import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  aerosolTint,
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeTransmittance,
  densityColumn,
  DISK_THROUGH_AIR_CEILING,
  diskThroughAir,
  multipleScatteringAt,
  MULTI_SCATTER_FLOOR,
  sampleLut,
  TRANSMITTANCE_WIDTH,
  transmittanceFrom,
  zenithSkyRadiance,
} from './atmosphere.ts'
import { airHeights, sunkSphereRadius } from './datum.ts'

/*
 * The physics of the scattering tables, held still in Node.
 *
 * The shader that consumes these is a TSL graph and cannot be evaluated here;
 * the tables can, and they are where the physics lives. Every property below
 * is a fact about light, not about this implementation — a rewrite of the
 * bake that breaks one of these has changed what the atmosphere *is*.
 */

/** Earth's authored haze, copied from `solar/bodies.ts`. */
const EARTH_HAZE = {
  color: { r: 0.28, g: 0.48, b: 0.95 },
  limb: { r: 0.92, g: 0.42, b: 0.2 },
  thickness: 1,
  aerosolAngstrom: 1.3,
}

/** Earth as `buildScene` draws it: the shell, the sunk sphere, the heights. */
const EARTH = {
  radius: 6_378_137,
  relief: 19_800,
  haze: 100_000,
  scaleHeight: 8_500,
  aerosolHeight: 1_200,
}
const EARTH_TOP =
  (EARTH.radius + EARTH.haze) / sunkSphereRadius(EARTH.radius, EARTH.relief)
const EARTH_HEIGHTS = airHeights(
  EARTH.radius,
  EARTH.relief,
  EARTH.haze,
  EARTH.scaleHeight,
  EARTH.aerosolHeight,
)

const earthRecipe = atmosphereRecipe(EARTH_HAZE, EARTH_TOP, EARTH_HEIGHTS)
const earthT = bakeTransmittance(earthRecipe)

const sampleT = (radius01: number, mu: number): [number, number, number] =>
  sampleLut(earthT, (mu + 1) / 2, radius01)

describe('transmittance', () => {
  it('is a fraction of light, everywhere', () => {
    for (let i = 0; i < earthT.data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const value = earthT.data[i + c] as number
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })

  it('passes most of a zenith column and reddens a grazing one', () => {
    const [zr, , zb] = sampleT(0, 1)
    // Bodhaine's Rayleigh column and MACv2's aerosol: e^−(0.06 + 0.13) ≈ 0.83
    // red and e^−(0.21 + 0.13) ≈ 0.71 blue straight up.
    expect(zr).toBeGreaterThan(0.8)
    expect(zb).toBeGreaterThan(0.6)
    expect(zr).toBeGreaterThan(zb)

    // A 2° sun from sea level crosses some twenty vertical columns: red
    // survives, blue does not. This asymmetry IS the sunset — no authored
    // sunset color exists anywhere downstream of it.
    const [hr, , hb] = sampleT(0, Math.sin((2 * Math.PI) / 180))
    expect(hr).toBeGreaterThan(hb * 2)
  })

  it('is extinguished by the ground', () => {
    // Looking down from low altitude: the ray ends in rock, nothing reaches
    // space, and the table says so rather than leaving callers to re-derive
    // the horizon test.
    const [r, g, b] = sampleT(0.05, -0.5)
    expect(r + g + b).toBeLessThan(1e-3)
  })

  it('never brightens as the sun drops', () => {
    // Monotone in μ above the horizon: a lower sun always crosses more air.
    // Sampled on the grid itself so bilinear blending cannot fake a bump.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 63 }),
        fc.integer({ min: Math.ceil(TRANSMITTANCE_WIDTH * 0.55), max: 510 }),
        (row, column) => {
          const v = row / 63
          const higher = sampleLut(earthT, (column + 1) / 511, v)
          const lower = sampleLut(earthT, column / 511, v)
          for (let c = 0; c < 3; c += 1) {
            expect(higher[c]).toBeGreaterThanOrEqual(
              (lower[c] as number) - 1e-9,
            )
          }
        },
      ),
    )
  })

  it('thins with a thinner atmosphere', () => {
    // Mars at thickness 0.15 must pass more light than Earth at 1 along the
    // same geometry — scaled to the same shell so only the column differs.
    const mars = atmosphereRecipe(
      { ...EARTH_HAZE, thickness: 0.15 },
      EARTH_TOP,
      EARTH_HEIGHTS,
    )
    const marsT = bakeTransmittance(mars)
    const [er] = sampleT(0, 0.1)
    const [mr] = sampleLut(marsT, (0.1 + 1) / 2, 0)
    expect(mr).toBeGreaterThan(er)
  })
})

describe('multiple scattering', () => {
  const psi = bakeMultipleScattering(earthRecipe, earthT)

  // The table is float32, so its floor is the float32 nearest ln 1e-30.
  const floor = Math.fround(Math.log(MULTI_SCATTER_FLOOR))

  it('is a finite logarithm everywhere, floored rather than −∞', () => {
    for (let i = 0; i < psi.data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const value = psi.data[i + c] as number
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(floor)
      }
    }
  })

  it('carries light past the terminator', () => {
    // The whole point of Ψ: with the sun a little below the horizon, single
    // scattering is extinguished but the twilight sky is not. Compare low sun
    // against deep night at ground level.
    const dusk = multipleScatteringAt(psi, earthRecipe, 1, -0.05)
    const night = multipleScatteringAt(psi, earthRecipe, 1, -0.8)
    const sum = (v: readonly number[]) =>
      (v[0] as number) + (v[1] as number) + (v[2] as number)
    expect(sum(dusk)).toBeGreaterThan(sum(night))
    expect(sum(dusk)).toBeGreaterThan(1e3 * MULTI_SCATTER_FLOOR)
  })

  it('is converged where it is baked, at the ground most of all', () => {
    // Refining the march eightfold moves a daylit texel by 2% at most. The
    // ground row is where it failed: a ray aimed down from the ground crossed
    // the planet at the surface's density, and Ψ there grew sixfold as the
    // steps were refined. Under twilight Ψ is lit through a narrow wedge of
    // sunlit air and moves by up to 31% at −13°; below −15° it is under the
    // night sky's floor and not claimed.
    const fine = bakeMultipleScattering(earthRecipe, earthT, 128)
    const { width, height } = psi
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const muSun = (x / (width - 1)) * 2 - 1
        if (muSun < Math.sin((-15 * Math.PI) / 180)) continue
        const bound = muSun >= 0 ? 0.03 : 0.35
        for (let c = 0; c < 3; c += 1) {
          const index = (y * width + x) * 4 + c
          const moved = Math.abs(
            (psi.data[index] as number) - (fine.data[index] as number),
          )
          expect(moved).toBeLessThan(bound)
        }
      }
    }
  })

  it('vanishes with the atmosphere', () => {
    const vacuum = atmosphereRecipe(
      { ...EARTH_HAZE, thickness: 0 },
      EARTH_TOP,
      EARTH_HEIGHTS,
    )
    const none = bakeMultipleScattering(vacuum, bakeTransmittance(vacuum))
    for (let i = 0; i < none.data.length; i += 4) {
      expect(none.data[i]).toBe(floor)
    }
  })
})

describe('the sky overhead', () => {
  const psi = bakeMultipleScattering(earthRecipe, earthT)
  const luminance = (rgb: readonly number[]): number =>
    0.2126 * (rgb[0] as number) +
    0.7152 * (rgb[1] as number) +
    0.0722 * (rgb[2] as number)
  const overhead = (radius: number, sunDegrees: number): number =>
    luminance(
      zenithSkyRadiance(
        earthRecipe,
        psi,
        radius,
        Math.sin((sunDegrees * Math.PI) / 180),
      ),
    )

  /*
   * A scene unit is an albedo-one surface under the sun, the sun's normal
   * irradiance over π, so a measured sky in cd/m² is π·L/E⊥ in scene units,
   * with E⊥ the extraterrestrial normal illuminance of 133.8 klx that Darula
   * and Kittler state the CIE skies against. The sky keeps its ratio to the
   * sun that lights it, which is the ratio a photograph records.
   */
  const EXTRATERRESTRIAL_LUX = 133_800
  const toScene = (candelas: number): number =>
    (Math.PI * candelas) / EXTRATERRESTRIAL_LUX

  /** The model's luminous turbidity: Kittler's Tv, vertical, at m = 1. */
  const turbidity = (() => {
    const ceiling = earthRecipe.topRatio - 1
    const rayleigh = densityColumn(earthRecipe.hRayleigh, ceiling)
    const aerosol = densityColumn(earthRecipe.hMie, ceiling)
    const tau =
      luminance(earthRecipe.betaRayleigh.map((beta) => beta * rayleigh)) +
      luminance(earthRecipe.mieExtinction.map((sigma) => sigma * aerosol))
    // Kittler's a_v = 1/(9.9 + 0.043·m), the clean dry air's luminous depth.
    return tau * (9.9 + 0.043)
  })()

  /** CIE standard clear sky (type 12) zenith, cd/m² (Darula and Kittler 2002). */
  const cieClearZenith = (sunDegrees: number, tv: number): number => {
    const gamma = (sunDegrees * Math.PI) / 180
    const a = 1.036 * tv + 0.71
    return (
      1000 *
      (a * Math.sin(gamma) +
        (0.7 * (tv + 1) * Math.sin(gamma) ** 4.43) / Math.cos(gamma) ** 0.74 +
        0.04 * tv)
    )
  }

  it('is a standard clear sky at its own turbidity', () => {
    // The anchor: the CIE clear sky's zenith at a 60° sun, at the luminous
    // turbidity the model's own column has. CIE type 12 is "low turbidity"
    // with Tv typically 2.5; MACv2's global aerosol puts the model at 2.3.
    // The gain is π and nothing else, and the zenith comes out at 1.07.
    // Shell-fraction heights under a gain of 24 drew 0.42 in the browser at
    // a 59° sun, 3.8 times this sky.
    expect(turbidity).toBeGreaterThan(2)
    expect(turbidity).toBeLessThan(2.6)
    const at = (sun: number) =>
      overhead(1, sun) / toScene(cieClearZenith(sun, turbidity))
    expect(Math.abs(at(60) - 1)).toBeLessThan(0.1)
    // And its shape across the high sky, which a gain alone cannot fit:
    // 1.08 at 30°, 0.98 at 45°, 1.29 at 70°.
    for (const sun of [30, 45, 70])
      expect(Math.abs(at(sun) - 1)).toBeLessThan(0.35)
    // Under 20° the model's zenith runs bright, 1.6 times the CIE sky at 10°
    // and 1.5 times Koomen's measured one at 5° — the limit, named, of a
    // model with no ozone and no ground: what it misses grows with the
    // airmass. The bound is the measured excess with room, so a model that
    // gets worse here fails.
    expect(at(10)).toBeLessThan(2)
    expect(at(10)).toBeGreaterThan(1)
    expect(overhead(EARTH_TOP, 60)).toBe(0)
    expect(overhead(EARTH_TOP + 1, 60)).toBe(0)
  })

  it('falls through twilight as a measured sky does, and never brightens', () => {
    let previous = Infinity
    for (let sun = 60; sun >= -25; sun -= 1) {
      const sky = overhead(1, sun)
      expect(sky).toBeLessThanOrEqual(previous * (1 + 1e-9))
      previous = sky
    }
    // Koomen et al. (1952), photopic zenith at sea level, Maryland, converted
    // from candles per square foot. The model is 1.4 to 3.0 times brighter
    // from the horizon to −12° and 1.1 times at −15°; the bound is a factor
    // of four either way. Read linearly off a 32-column Ψ with 16
    // directions, the model's −12° was 27 times the measured sky.
    const koomen: readonly (readonly [number, number])[] = [
      [5, 463],
      [0, 161],
      [-3, 21.5],
      [-6, 0.65],
      [-9, 0.016],
      [-12, 1.3e-3],
      [-15, 4.3e-4],
    ]
    for (const [sun, candelas] of koomen) {
      const ratio = overhead(1, sun) / toScene(candelas)
      expect(ratio).toBeGreaterThan(1 / 4)
      expect(ratio).toBeLessThan(4)
    }
    expect(overhead(1, -25)).toBeLessThan(overhead(1, 60) * 1e-10)
  })

  it('thins as the observer climbs', () => {
    const ground = overhead(1, 45)
    const high = overhead(1 + (EARTH_TOP - 1) * 0.5, 45)
    expect(high).toBeLessThan(ground)
    expect(high).toBeGreaterThan(0)
  })
})

describe('a star seen through the air', () => {
  const mean = (rgb: readonly number[]): number =>
    ((rgb[0] as number) + (rgb[1] as number) + (rgb[2] as number)) / 3
  const luminance = (rgb: readonly number[]): number =>
    0.2126 * (rgb[0] as number) +
    0.7152 * (rgb[1] as number) +
    0.0722 * (rgb[2] as number)
  const lowSun = Math.sin((2 * Math.PI) / 180)
  /** ln 8 over ln 53,333: the Sun's disk at 1 AU, drawn at eight. */
  const enhanced = Math.log(8) / Math.log(1.6e9 / 30_000)
  /** What reaches the eye: the drawn disk, after the shell's gray mean. */
  const arrives = (compression: number): number[] => {
    const shell = mean(sampleT(0, lowSun))
    return diskThroughAir(earthRecipe, 1, lowSun, compression).map(
      (value) => value * shell,
    )
  }

  it('arrives in the column’s own color, physically, in a photograph', () => {
    // The table is the bilinear read of the same march, hence two places.
    const column = sampleT(0, lowSun)
    const passed = arrives(1)
    for (let c = 0; c < 3; c += 1)
      expect(passed[c]).toBeCloseTo(column[c] as number, 2)
  })

  it('keeps a setting sun above the surface white, and orange, under Enhanced', () => {
    // Gray extinction took the calibrated disk to 8·T̄, under 1 at a 2° sun,
    // beside an aureole brighter than that. Compressed by the law that drew
    // it, it arrives at several times the surface white in the column's hue.
    const column = sampleT(0, lowSun)
    expect(8 * mean(column)).toBeLessThan(1)
    // Measured 3.1 through MACv2's aerosol.
    const disk = arrives(enhanced).map((value) => value * 8)
    expect(luminance(disk)).toBeGreaterThan(2.5)
    for (let c = 1; c < 3; c += 1)
      // The column is the table's bilinear read of the same march.
      expect((disk[c] as number) / (disk[0] as number)).toBeCloseTo(
        (column[c] as number) / (column[0] as number),
        2,
      )
  })

  it('is nothing behind the planet, and never brighter than in a vacuum', () => {
    expect(diskThroughAir(earthRecipe, 1, -0.2, enhanced)).toEqual([0, 0, 0])
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: EARTH_TOP, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        (radius, mu, compression) => {
          const drawn = diskThroughAir(earthRecipe, radius, mu, compression)
          for (const value of drawn) {
            expect(Number.isFinite(value)).toBe(true)
            expect(value).toBeGreaterThanOrEqual(0)
          }
          // Luminance after the shell's gray mean is L_T^k, which no column
          // raises past 1 — or less, where the ceiling holds the disk.
          const passed = transmittanceFrom(radius, mu, earthRecipe)
          const after = luminance(drawn) * mean(passed)
          expect(after).toBeLessThanOrEqual(
            luminance(passed) ** compression * (1 + 1e-9),
          )
        },
      ),
    )
  })

  it('stays inside the half-float target however low the sun', () => {
    // The disk is drawn before the shell divides it down, so it is the disk
    // over the column's transmittance. A sun on a sea-level horizon drew at
    // 10⁵ times the surface white and more under Enhanced, past half-float's
    // 65,504, and an infinity is not something the shell can extinguish.
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: EARTH_TOP, noNaN: true }),
        fc.double({ min: -0.05, max: 0.1, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        (radius, mu, compression) => {
          const drawn = diskThroughAir(earthRecipe, radius, mu, compression)
          expect(luminance(drawn)).toBeLessThanOrEqual(
            DISK_THROUGH_AIR_CEILING * (1 + 1e-9),
          )
        },
      ),
    )
  })
})

describe('the recipe', () => {
  it('splits the column by the authored color', () => {
    // β over the column must reproduce the vertical optical depth the color
    // describes: Earth's authored blue-heavy zenith puts twice the extinction
    // in blue that it puts in green, and Bodhaine's sea-level spectrum is
    // within a few percent of that split — the fact that licenses
    // color-as-physics. The sum is Bodhaine's 0.381 at 680, 550 and 440 nm.
    const column = densityColumn(
      earthRecipe.hRayleigh,
      earthRecipe.topRatio - 1,
    )
    const tau = earthRecipe.betaRayleigh.map((beta) => beta * column)
    expect((tau[2] as number) / (tau[1] as number)).toBeCloseTo(0.95 / 0.48, 1)
    expect(
      (tau[0] as number) + (tau[1] as number) + (tau[2] as number),
    ).toBeCloseTo(0.38, 3)
  })

  it('falls off over the body’s own scale heights, not the shell’s', () => {
    // Earth's gas over 8.5 km and its aerosol over 1.2, whatever the shell:
    // a shell-sized falloff put the gas at 22 km and the aerosol at 9, half
    // the air over a beach above the beach.
    const sphere = sunkSphereRadius(EARTH.radius, EARTH.relief)
    expect(earthRecipe.hRayleigh * sphere).toBeCloseTo(8_500, 6)
    expect(earthRecipe.hMie * sphere).toBeCloseTo(1_200, 6)
  })

  it('holds the measured optical depth whatever the heights', () => {
    // The fade to zero at the ceiling takes H/C of the column; the
    // coefficients are scaled for it, so the vertical depth is the one
    // measured however close a haze's height comes to its shell.
    fc.assert(
      fc.property(
        fc.double({ min: 0.02, max: 1.5, noNaN: true }),
        fc.double({ min: 0.02, max: 1.5, noNaN: true }),
        (rayleighShare, aerosolShare) => {
          const ceiling = EARTH_TOP - 1
          const recipe = atmosphereRecipe(EARTH_HAZE, EARTH_TOP, {
            rayleigh: rayleighShare * ceiling,
            aerosol: aerosolShare * ceiling,
          })
          // A midpoint march of the profile itself, against the closed form.
          const steps = 4000
          let rayleigh = 0
          let aerosol = 0
          for (let i = 0; i < steps; i += 1) {
            const h = ((i + 0.5) / steps) * ceiling
            const fade = 1 - h / ceiling
            rayleigh += Math.exp(-h / recipe.hRayleigh) * fade
            aerosol += Math.exp(-h / recipe.hMie) * fade
          }
          rayleigh *= ceiling / steps
          aerosol *= ceiling / steps
          const tau = recipe.betaRayleigh.reduce(
            (sum, beta) => sum + beta * rayleigh,
            0,
          )
          expect(tau).toBeCloseTo(0.38, 4)
          // MACv2's 0.12 at 550 nm, scattered at an albedo of 0.94.
          expect(recipe.mieExtinction[1] * aerosol * 0.94).toBeCloseTo(0.12, 4)
        },
      ),
    )
  })

  it('leaves the aerosol gray where the column already makes the limb', () => {
    // Earth's orange terminator is its Rayleigh column at a grazing airmass.
    // Tinting the aerosol with it as well painted the noon aureole salmon.
    // The aerosol's own color is its albedo per band — scattering over
    // extinction, with the Ångström slope the two share divided out.
    const albedo = earthRecipe.mieScatter.map(
      (scatter, c) => scatter / earthRecipe.mieExtinction[c]!,
    )
    expect(albedo[0]).toBeCloseTo(albedo[1]!, 12)
    expect(albedo[1]).toBeCloseTo(albedo[2]!, 12)
  })

  it('scatters blue over red along its Ångström slope', () => {
    // Ångström's 1.3 for Earth: the aerosol's depth at 440 nm is 1.33 times
    // its depth at 550, and at 680 nm 0.76 of it.
    const [r, g, b] = earthRecipe.mieExtinction
    expect(b / g).toBeCloseTo((440 / 550) ** -1.3, 9)
    expect(r / g).toBeCloseTo((680 / 550) ** -1.3, 9)
  })

  it('keeps a limb the column cannot make on the aerosol', () => {
    // Mars: 600 Pa cannot turn anything blue, so the blue dusk is the dust's.
    const mars = atmosphereRecipe(
      {
        color: { r: 0.78, g: 0.6, b: 0.48 },
        limb: { r: 0.62, g: 0.66, b: 0.9 },
        thickness: 0.15,
        aerosolAngstrom: 0,
      },
      1 + 60 / 3396.2,
      { rayleigh: 11.1 / 3396.2, aerosol: 11.1 / 3396.2 },
    )
    const [r, , b] = mars.mieScatter
    expect(b).toBeGreaterThan(r * 1.15)
    expect(b / r).toBeLessThan(0.9 / 0.62)
    // Titan: an orange haze whose limb is its own sky keeps the whole tint.
    const titanLimb = { r: 0.95, g: 0.7, b: 0.35 }
    const titan = atmosphereRecipe(
      {
        color: { r: 0.86, g: 0.6, b: 0.3 },
        limb: titanLimb,
        thickness: 1,
        aerosolAngstrom: 0,
      },
      1 + 400 / 2574.7,
      { rayleigh: 21 / 2574.7, aerosol: 60 / 2574.7 },
    )
    expect(titan.mieScatter[0] / titan.mieScatter[2]).toBeCloseTo(
      titanLimb.r / titanLimb.b,
      9,
    )
  })

  it('tints the aerosol between gray and the limb, at the same column', () => {
    const channel = fc.double({ min: 0.02, max: 1, noNaN: true })
    const rgb = fc.record({ r: channel, g: channel, b: channel })
    fc.assert(
      fc.property(
        rgb,
        fc.tuple(channel, channel, channel),
        fc.double({ min: 1e-4, max: 0.05, noNaN: true }),
        (limb, beta, height) => {
          const tint = aerosolTint(limb, beta, height)
          // A tint redistributes the column; it does not add or remove any.
          expect((tint[0] + tint[1] + tint[2]) / 3).toBeCloseTo(1, 9)
          // Each channel's log departure from the mean is the limb's, scaled
          // by one common fraction in [0, 1] — never past the limb, never
          // turned against it.
          const departure = (values: number[]): number[] => {
            const mean = (values[0]! + values[1]! + values[2]!) / 3
            return values.map((value) => value - mean)
          }
          const authored = departure([limb.r, limb.g, limb.b].map(Math.log))
          const kept = departure(tint.map(Math.log))
          // The fraction is read off the channel that departs furthest, where
          // it is best conditioned; the other two must agree with it.
          let widest = 0
          for (let c = 1; c < 3; c += 1)
            if (Math.abs(authored[c]!) > Math.abs(authored[widest]!)) widest = c
          if (Math.abs(authored[widest]!) < 1e-6) return
          const fraction = kept[widest]! / authored[widest]!
          expect(fraction).toBeGreaterThanOrEqual(-1e-9)
          expect(fraction).toBeLessThanOrEqual(1 + 1e-9)
          for (let c = 0; c < 3; c += 1)
            expect(kept[c]).toBeCloseTo(fraction * authored[c]!, 6)
        },
      ),
    )
  })

  it('scales every coefficient with thickness', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 4, noNaN: true }),
        (thickness) => {
          const scaled = atmosphereRecipe(
            { ...EARTH_HAZE, thickness },
            EARTH_TOP,
            EARTH_HEIGHTS,
          )
          expect(scaled.betaRayleigh[2]).toBeCloseTo(
            earthRecipe.betaRayleigh[2] * thickness,
            6,
          )
          for (let c = 0; c < 3; c += 1)
            expect(scaled.mieExtinction[c]).toBeCloseTo(
              earthRecipe.mieExtinction[c]! * thickness,
              6,
            )
        },
      ),
    )
  })
})
