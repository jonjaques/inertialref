import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  aerosolTint,
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeTransmittance,
  sampleLut,
  TRANSMITTANCE_WIDTH,
  zenithSkyRadiance,
} from './atmosphere.ts'

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
}

/** 100 km of shell on 6371 km of planet. */
const EARTH_TOP = 1 + 100 / 6371

const earthRecipe = atmosphereRecipe(EARTH_HAZE, EARTH_TOP)
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
    // Real Earth: e^−0.046 ≈ 0.955 red, e^−0.265 ≈ 0.77 blue at the zenith.
    expect(zr).toBeGreaterThan(0.85)
    expect(zb).toBeGreaterThan(0.6)
    expect(zr).toBeGreaterThan(zb)

    // Near the horizon from a mid-shell altitude the path runs tens of times
    // the vertical column: red survives, blue does not. This asymmetry IS the
    // sunset — no authored sunset color exists anywhere downstream of it.
    const [hr, , hb] = sampleT(0.15, 0.02)
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
    const mars = atmosphereRecipe({ ...EARTH_HAZE, thickness: 0.15 }, EARTH_TOP)
    const marsT = bakeTransmittance(mars)
    const [er] = sampleT(0, 0.1)
    const [mr] = sampleLut(marsT, (0.1 + 1) / 2, 0)
    expect(mr).toBeGreaterThan(er)
  })
})

describe('multiple scattering', () => {
  const psi = bakeMultipleScattering(earthRecipe, earthT)

  it('is non-negative and finite everywhere', () => {
    for (let i = 0; i < psi.data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const value = psi.data[i + c] as number
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('carries light past the terminator', () => {
    // The whole point of Ψ: with the sun a little below the horizon, single
    // scattering is extinguished but the twilight sky is not. Compare low sun
    // against deep night at ground level.
    const dusk = sampleLut(psi, (1 - 0.05) / 2, 0)
    const night = sampleLut(psi, (1 - 0.8) / 2, 0)
    const sum = (v: readonly number[]) =>
      (v[0] as number) + (v[1] as number) + (v[2] as number)
    expect(sum(dusk)).toBeGreaterThan(sum(night))
    expect(sum(dusk)).toBeGreaterThan(0)
  })

  it('vanishes with the atmosphere', () => {
    const vacuum = atmosphereRecipe({ ...EARTH_HAZE, thickness: 0 }, EARTH_TOP)
    const none = bakeMultipleScattering(vacuum, bakeTransmittance(vacuum))
    for (let i = 0; i < none.data.length; i += 4) {
      expect(none.data[i]).toBe(0)
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

  it('is a daylit sky at noon and nothing above the air', () => {
    // A clear zenith under a high sun is a few thousand cd/m², a tenth of
    // the 30,000 cd/m² surface white or more; the shell's artistic gain
    // puts it at roughly twice that. Bounded loosely on both sides because
    // the claim is the order of magnitude, which is what the veil uses.
    const noon = overhead(1, 60)
    expect(noon).toBeGreaterThan(0.1)
    expect(noon).toBeLessThan(1)
    expect(overhead(EARTH_TOP, 60)).toBe(0)
    expect(overhead(EARTH_TOP + 1, 60)).toBe(0)
  })

  it('darkens by orders of magnitude through twilight, and never brightens', () => {
    let previous = Infinity
    for (let sun = 60; sun >= -25; sun -= 1) {
      const sky = overhead(1, sun)
      expect(sky).toBeLessThanOrEqual(previous * (1 + 1e-9))
      previous = sky
    }
    // A real zenith is near 1 cd/m² at −6° and 0.003 cd/m² at −12°. The
    // model's is 75 and 1.6 — Ψ keeps lighting the column for some degrees
    // after the whole of it is in shadow — so the bound is where the model
    // actually reaches night: five and a half decades under noon by −18°,
    // which is where the Milky Way comes back out from under the veil, and
    // nothing by −25°.
    expect(overhead(1, -18)).toBeLessThan(overhead(1, 60) * 1e-5)
    expect(overhead(1, -25)).toBeLessThan(overhead(1, 60) * 1e-12)
  })

  it('thins as the observer climbs', () => {
    const ground = overhead(1, 45)
    const high = overhead(1 + (EARTH_TOP - 1) * 0.5, 45)
    expect(high).toBeLessThan(ground)
    expect(high).toBeGreaterThan(0)
  })
})

describe('the recipe', () => {
  it('splits the column by the authored color', () => {
    // β·H must reproduce the vertical optical depth the color describes:
    // Earth's authored blue-heavy zenith puts ~2.5 times the extinction in
    // blue that it puts in green, and the real spectrum is within a few
    // percent of that split — the fact that licenses color-as-physics.
    const tau = earthRecipe.betaRayleigh.map(
      (beta) => beta * earthRecipe.hRayleigh,
    )
    expect((tau[2] as number) / (tau[1] as number)).toBeCloseTo(0.95 / 0.48, 1)
    expect(
      (tau[0] as number) + (tau[1] as number) + (tau[2] as number),
    ).toBeCloseTo(0.42, 2)
  })

  it('leaves the aerosol gray where the column already makes the limb', () => {
    // Earth's orange terminator is its Rayleigh column at a grazing airmass.
    // Tinting the aerosol with it as well painted the noon aureole salmon.
    const [r, g, b] = earthRecipe.mieScatter
    expect(r).toBeCloseTo(g, 12)
    expect(g).toBeCloseTo(b, 12)
  })

  it('keeps a limb the column cannot make on the aerosol', () => {
    // Mars: 600 Pa cannot turn anything blue, so the blue dusk is the dust's.
    const mars = atmosphereRecipe(
      {
        color: { r: 0.78, g: 0.6, b: 0.48 },
        limb: { r: 0.62, g: 0.66, b: 0.9 },
        thickness: 0.15,
      },
      1 + 60 / 3396.2,
    )
    const [r, , b] = mars.mieScatter
    expect(b).toBeGreaterThan(r * 1.15)
    expect(b / r).toBeLessThan(0.9 / 0.62)
    // Titan: an orange haze whose limb is its own sky keeps the whole tint.
    const titanLimb = { r: 0.95, g: 0.7, b: 0.35 }
    const titan = atmosphereRecipe(
      { color: { r: 0.86, g: 0.6, b: 0.3 }, limb: titanLimb, thickness: 1 },
      1 + 300 / 2574.7,
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
          )
          expect(scaled.betaRayleigh[2]).toBeCloseTo(
            earthRecipe.betaRayleigh[2] * thickness,
            6,
          )
          expect(scaled.mieExtinction).toBeCloseTo(
            earthRecipe.mieExtinction * thickness,
            6,
          )
        },
      ),
    )
  })
})
