import { describe, expect, it } from 'vitest'
import {
  bulkDensity,
  hasSolidSurface,
  surfaceArchetype,
  tidalProxy,
  volumetricMeanRadius,
} from './archetype.ts'
import { directionToGeodetic, geodeticDirection } from './frames.ts'
import { rootSeed } from '@inertialref/procedural'
import { SOL_ONLY_CATALOG } from './catalog/index.ts'
import { catalogStub, MILKY_WAY } from './galaxy.ts'
import { solarSystem, SOL } from './solar/system.ts'
import type { CatalogStar } from './catalog/index.ts'
import type { Body } from './system.ts'
import {
  elevationAt,
  faceToDirection,
  groundElevation,
  regionForDirection,
} from './terrain.ts'
import {
  findSurveySite,
  SURVEY_LEVEL,
  type SurveySite,
  surveySites,
} from './surveySites.ts'

/*
 * Archetypes and survey sites, against the Solar System.
 *
 * Sol is the right fixture for both, and not because it is convenient: every
 * number the archetype classifier reads is a published measurement there, so a
 * threshold that puts Callisto with the ice and Europa with the rock can be
 * checked against what those bodies are rather than against what this code
 * does. The sites are the opposite kind of test — nothing published says where
 * the highest ground on Iapetus is, because this generator invented it — so
 * what is asserted is that the search is reproducible, self-consistent, and
 * addresses the ground it claims to.
 */

const sol = solarSystem(
  rootSeed('inertialref'),
  MILKY_WAY,
  catalogStub(SOL_ONLY_CATALOG.get(SOL) as CatalogStar),
)
const find = (name: string): Body => {
  for (const planet of sol.planets) {
    if (planet.name === name) return planet
    for (const moon of planet.moons) if (moon.name === name) return moon
  }
  throw new Error(`no ${name} in the Solar System`)
}

describe('surface archetypes', () => {
  it('divides rock from ice where the published densities do', () => {
    /*
     * The line at 2,000 kg/m³, checked against bodies rather than against
     * itself. Luna and Mercury are silicate and land far above it; Callisto,
     * Titan and Enceladus are half water and land below. Europa is the case the
     * threshold is *supposed* to get "wrong" and does not: at 3,013 it is a
     * silicate body with a hundred kilometers of water on top, and it behaves
     * like rock for everything terrain cares about.
     */
    expect(bulkDensity(find('Luna'))).toBeGreaterThan(3_000)
    expect(bulkDensity(find('Europa'))).toBeGreaterThan(2_000)
    expect(bulkDensity(find('Callisto'))).toBeLessThan(2_000)
    expect(bulkDensity(find('Enceladus'))).toBeLessThan(2_000)

    expect(surfaceArchetype(find('Luna'))).toBe('rocky-airless')
    expect(surfaceArchetype(find('Earth'))).toBe('rocky-atmosphered')
    expect(surfaceArchetype(find('Mars'))).toBe('rocky-atmosphered')
  })

  it('separates the moons with plumes from the ones without', () => {
    /*
     * The tidal proxy's whole job, and the reason the threshold can be a single
     * number: there is an order of magnitude of clear air between the dead
     * Galileans and the active ones. Ganymede and Callisto sit near 2.5e-7,
     * Europa at 4.5e-6, Enceladus at 2.9e-5 — and Enceladus is the one with a
     * plume you can fly a spacecraft through.
     */
    const jupiter = find('Jupiter')
    const saturn = find('Saturn')
    expect(tidalProxy(find('Callisto'), jupiter.mass)).toBeLessThan(1e-6)
    expect(tidalProxy(find('Ganymede'), jupiter.mass)).toBeLessThan(1e-6)
    expect(tidalProxy(find('Europa'), jupiter.mass)).toBeGreaterThan(1e-6)
    expect(tidalProxy(find('Enceladus'), saturn.mass)).toBeGreaterThan(1e-5)

    expect(surfaceArchetype(find('Callisto'), jupiter.mass)).toBe('icy-dead')
    expect(surfaceArchetype(find('Enceladus'), saturn.mass)).toBe('icy-active')
  })

  it('under-calls Triton, and the docstring says why', () => {
    /*
     * A known limit of an eccentricity proxy, asserted so that it stays a known
     * one. Triton's orbit is circular to five places, so nothing here can see
     * that its surface is ten million years old — its heat comes from an
     * obliquity tide and a capture it is still recovering from, and neither is
     * derivable from six orbital elements. It classifies as rock anyway (2,060
     * kg/m³, two-thirds silicate) so the mis-call costs the zoo nothing.
     */
    expect(tidalProxy(find('Triton'), find('Neptune').mass)).toBeLessThan(1e-6)
    expect(bulkDensity(find('Triton'))).toBeGreaterThan(2_000)
  })

  it('refuses to give a giant a surface', () => {
    // Density alone calls Jupiter (1,326) and Saturn (687) icy worlds. They
    // would classify, enter a zoo, and send a descent to a datum radius chosen
    // by where the drag model stops integrating.
    for (const name of ['Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
      expect(`${name}: ${hasSolidSurface(find(name))}`).toBe(`${name}: false`)
    }
    for (const name of ['Earth', 'Luna', 'Enceladus', 'Pluto']) {
      expect(`${name}: ${hasSolidSurface(find(name))}`).toBe(`${name}: true`)
    }
  })

  it('divides a mass by the radius the body actually has', () => {
    /*
     * `body.radius` is `a`, the largest half-extent, and every quantity derived
     * from a volume cubes it. The dossier shipped this exact error once, and
     * the size of it is the assertion: on Phobos a sphere of `a` is `a²/(b·c)`
     * = 1.52× the true volume, so a density taken from it is a third low.
     *
     * Not asserted against the published 1.88 g/cm³, because this build cannot
     * reach it and the reason is data rather than arithmetic: the vendored
     * half-extents are 13.3 × 11.9 × 9.8 km against a published
     * 13.0 × 11.4 × 9.1, which is 13% more volume for the same mass. That is a
     * catalog question, not a terrain one, and pinning 1.88 here would make
     * this test fail for something it does not test.
     */
    const phobos = find('Phobos')
    const naive = phobos.mass / ((4 / 3) * Math.PI * phobos.radius ** 3) / 1000
    const proper = bulkDensity(phobos) / 1000
    expect(volumetricMeanRadius(phobos)).toBeLessThan(phobos.radius)
    expect(proper / naive).toBeCloseTo(1.517, 2)
    expect(proper).toBeCloseTo(1.64, 2)
  })
})

describe('survey sites', () => {
  const bodies = ['Iapetus', 'Miranda', 'Titania', 'Rhea']

  it('key their cache on everything the answer depends on', () => {
    /*
     * What this can honestly test, and what it cannot.
     *
     * It was written as "are a pure function of the body" — two calls with
     * another body's derivation in between — and that assertion is defeated by
     * the memo it is standing in front of: the second call is a `CACHE.get`
     * hit returning the *same array reference*, so `derive` never runs twice
     * and a shared-stream draw inside it would sail through. `derive`'s purity
     * is structural instead: it takes only `body` and calls field functions
     * that are themselves pure, and `terrain.test.ts` owns those.
     *
     * The live risk is the cache *key*, which is hand-written and would fail
     * silently — a body whose seed changed would get the previous body's
     * mountains, with nothing to see. So that is what is checked: every field
     * the derivation reads, moved one at a time.
     */
    const body = find('Iapetus')
    const baseline = surveySites(body)
    expect(surveySites(body)).toEqual(baseline)

    const moved = {
      seed: {
        ...body,
        surface: { ...body.surface, seed: find('Rhea').surface.seed },
      },
      maxElevation: {
        ...body,
        surface: {
          ...body.surface,
          maxElevation: body.surface.maxElevation * 2,
        },
      },
      roughness: {
        ...body,
        surface: { ...body.surface, roughness: body.surface.roughness * 1.5 },
      },
      seaLevel: { ...body, surface: { ...body.surface, seaLevel: 0.4 } },
      radius: { ...body, radius: body.radius * 1.1 },
    }
    for (const [field, variant] of Object.entries(moved)) {
      // A fresh array is what "the key discriminated" looks like from out here;
      // a shared key would return `baseline` by reference.
      expect(`${field}: ${surveySites(variant) === baseline}`).toBe(
        `${field}: false`,
      )
    }

    /*
     * And for the four the field function actually reads, the sites move.
     *
     * `radius` is deliberately not in this list. It is in the key because a
     * datum that came to matter would be a silent wrong answer, and it is not
     * here because `derive` reads only `body.surface` — so a body scaled by 10%
     * has the same sites in the same places, and asserting otherwise would be
     * asserting a bug.
     */
    for (const field of [
      'seed',
      'maxElevation',
      'roughness',
      'seaLevel',
    ] as const) {
      expect(`${field}: ${JSON.stringify(surveySites(moved[field]))}`).not.toBe(
        `${field}: ${JSON.stringify(baseline)}`,
      )
    }
  })

  it('address the ground they name', () => {
    /*
     * The site's region and its latitude/longitude have to be the same place.
     * They are computed from opposite ends — the region comes out of the beam
     * search and the coordinates come from `directionToGeodetic` of that
     * region's center — so a rounding error or a transposed axis anywhere in
     * the round trip shows up here rather than as a camera two hundred
     * kilometers from the mountain the panel named.
     */
    for (const name of bodies) {
      const body = find(name)
      for (const site of surveySites(body)) {
        const direction = geodeticDirection(site.latitude, site.longitude)
        // The label goes *into* the assertion rather than beside it. Written as
        // its own `expect`, it compared a string to itself — twenty-four
        // guaranteed passes that no defect could turn red.
        const where = `${name}/${site.id}`
        expect({
          where,
          region: regionForDirection(direction, SURVEY_LEVEL),
        }).toEqual({ where, region: site.region })
      }
    }
  })

  it('quote the elevation the mesh and the contact test agree on', () => {
    for (const name of bodies) {
      const body = find(name)
      for (const site of surveySites(body)) {
        const direction = geodeticDirection(site.latitude, site.longitude)
        // `groundElevation`, not `elevationAt`: the sea clamp has one owner and
        // a site that quoted the seabed under an ocean would be a site the
        // camera cannot stand at.
        expect(site.elevation).toBeCloseTo(
          groundElevation(body.surface, direction),
          6,
        )
      }
    }
  })

  it('find higher ground than the basin and lower ground than the summit', () => {
    for (const name of bodies) {
      const body = find(name)
      const summit = findSurveySite(body, 'summit')
      const basin = findSurveySite(body, 'basin')
      expect(summit).toBeDefined()
      expect(basin).toBeDefined()
      expect(
        `${name}: ${(summit?.elevation ?? 0) > (basin?.elevation ?? 0)}`,
      ).toBe(`${name}: true`)
      // And the search is doing work rather than returning its seed grid: the
      // spread it finds is a real fraction of the relief the body is allowed.
      const spread = (summit?.elevation ?? 0) - (basin?.elevation ?? 0)
      expect(`${name}: ${spread > body.surface.maxElevation * 0.5}`).toBe(
        `${name}: true`,
      )
    }
  })

  it('find a real basin on a body with an ocean', () => {
    /*
     * The case the four dry moons above cannot reach, and it was broken.
     *
     * `groundElevation` clamps the whole ocean onto one value, so scoring the
     * basin search on it ties every ocean cell exactly. `refine`'s sort is
     * stable, so a fully-tied beam keeps the first child of the first parent at
     * every level and walks to the `(i·2, j·2)` corner — Earth's "Abyss" came
     * back at 0.00°, −45.00°, +545 m: above the datum, and at the same
     * coordinates as `shore`, `corner` and `pole`. `summit − basin` stopped
     * measuring relief, and the terrain baseline descends into `basin`
     * precisely because it is supposed to be the low one.
     *
     * Asserted against the other sites rather than against a coordinate,
     * because what went wrong is that they collapsed onto each other.
     */
    const earth = find('Earth')
    expect(earth.surface.seaLevel).not.toBeNull()
    const sites = surveySites(earth)
    const at = (id: string): SurveySite =>
      sites.find((one) => one.id === id) as SurveySite

    for (const other of ['shore', 'corner', 'pole']) {
      expect(
        `basin vs ${other}: ${at('basin').latitude === at(other).latitude}`,
      ).toBe(`basin vs ${other}: false`)
    }
    // And it is genuinely the deepest *landform*, which is what the search now
    // scores. The ground above it is the sea surface, and that is a fact about
    // the site rather than a defect.
    const deepest = elevationAt(
      earth.surface,
      geodeticDirection(at('basin').latitude, at('basin').longitude),
    )
    for (const other of ['summit', 'shore', 'rough', 'corner', 'pole']) {
      const land = elevationAt(
        earth.surface,
        geodeticDirection(at(other).latitude, at(other).longitude),
      )
      expect(`${other}: ${deepest < land}`).toBe(`${other}: true`)
    }
  })

  it('stand at the pole and at a cube-face corner exactly', () => {
    /*
     * The two sites that exist for the renderer rather than the geology, and
     * both are checked against the coordinate they claim rather than against
     * "somewhere near". The pole is where `localTriad` falls back and where a
     * latitude/longitude control is most likely to be quietly wrong; the corner
     * is where three faces meet and today's window loses five of nine patches.
     */
    const body = find('Iapetus')
    const pole = findSurveySite(body, 'pole')
    /*
     * Half a region's diagonal off the pole, exactly — not "close to 90°".
     *
     * A site *is* a patch of ground, and its coordinates are that patch's
     * center. The pole sits at (u, v) = (0, 0) on face 2, which at an even
     * level is the shared corner of four regions, so the one that contains it
     * has its center half a cell away along both axes. In face coordinates
     * that is `√2 / 2^level`, and near a face center the gnomonic projection is
     * locally an identity, so it is also the angle. On Iapetus at level 14 that
     * is 8.6e-5 rad — 63 m, which is what a 70 m patch's half-diagonal should
     * be. Asserting the exact geometry rather than a decimal place is what
     * makes this fail if the addressing ever loses the pole.
     */
    const halfDiagonal = Math.SQRT2 / 2 ** SURVEY_LEVEL
    expect((Math.PI / 2 - (pole?.latitude ?? 0)) / halfDiagonal).toBeCloseTo(
      1,
      3,
    )
    expect(pole?.region).toEqual(
      regionForDirection(faceToDirection(2, 0, 0), SURVEY_LEVEL),
    )

    const corner = findSurveySite(body, 'corner')
    const direction = geodeticDirection(
      corner?.latitude ?? 0,
      corner?.longitude ?? 0,
    )
    // A cube corner is where all three components have equal magnitude —
    // within half a cell, for the same reason the pole is: the site is the
    // *patch* containing the corner, and its coordinates are its center.
    const { x, y, z } = direction
    expect(Math.abs(x)).toBeCloseTo(Math.abs(y), 3)
    expect(Math.abs(y)).toBeCloseTo(Math.abs(z), 3)
  })

  it('round-trip a direction through latitude and longitude', () => {
    // The producer rule in one line: every site is reachable through
    // `geodeticDirection`, which is one of the three branded producers.
    const body = find('Miranda')
    for (const site of surveySites(body)) {
      const back = directionToGeodetic(
        geodeticDirection(site.latitude, site.longitude),
      )
      expect(back.latitude).toBeCloseTo(site.latitude, 9)
      // Longitude is undefined at the poles, where every meridian is the same
      // point — the one place the round trip legitimately does not hold.
      if (Math.abs(site.latitude) < Math.PI / 2 - 1e-6) {
        expect(back.longitude).toBeCloseTo(site.longitude, 9)
      }
    }
  })
})
