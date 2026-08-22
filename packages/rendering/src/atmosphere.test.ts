import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeTransmittance,
  sampleLut,
  TRANSMITTANCE_WIDTH,
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
  colour: { r: 0.28, g: 0.48, b: 0.95 },
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
    // sunset — no authored sunset colour exists anywhere downstream of it.
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

describe('the recipe', () => {
  it('splits the column by the authored colour', () => {
    // β·H must reproduce the vertical optical depth the colour describes:
    // Earth's authored blue-heavy zenith puts ~2.5 times the extinction in
    // blue that it puts in green, and the real spectrum is within a few
    // percent of that split — the fact that licenses colour-as-physics.
    const tau = earthRecipe.betaRayleigh.map(
      (beta) => beta * earthRecipe.hRayleigh,
    )
    expect((tau[2] as number) / (tau[1] as number)).toBeCloseTo(0.95 / 0.48, 1)
    expect(
      (tau[0] as number) + (tau[1] as number) + (tau[2] as number),
    ).toBeCloseTo(0.42, 2)
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
