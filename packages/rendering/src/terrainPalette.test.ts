import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  type Body,
  catalogStub,
  generateSystem,
  MILKY_WAY,
  TEST_CATALOG,
  walkBodies,
} from '@inertialref/universe'
import {
  REFLECTANCE_CEILING,
  type SurfaceMaterial,
  terrainPalette,
} from './terrainPalette.ts'

/*
 * The palette is *data* — a function from a body to a set of reflectances — so
 * it is testable in Node and it is tested here. Nothing in this file describes
 * the shader that reads it: a scalar mirror of a node graph passes while the
 * graph drifts, which is the trap `.claude/rules/rendering.md` names.
 */

const SOL = generateSystem(
  rootSeed('inertialref'),
  MILKY_WAY,
  catalogStub(TEST_CATALOG.stars[0] as (typeof TEST_CATALOG.stars)[number]),
)

const find = (name: string): Body => {
  for (const body of walkBodies(SOL)) if (body.name === name) return body
  throw new Error(`no ${name} in Sol`)
}

const grey = (m: SurfaceMaterial): number =>
  0.2126 * m.albedo.r + 0.7152 * m.albedo.g + 0.0722 * m.albedo.b

describe('the terrain palette', () => {
  /*
   * The one published ratio in the file, and the largest albedo contrast on any
   * airless body: lunar mare is 0.07 geometric albedo against 0.13 for the
   * highlands. Everything else is scaled beside it, so if this drifts the whole
   * palette has.
   */
  it('puts a mare at 0.54 of the ground around it, where nothing else says so', () => {
    for (const name of ['Iapetus', 'Enceladus']) {
      const palette = terrainPalette(find(name))
      const ratio = grey(palette.basalt) / grey(palette.regolith)
      expect(`${name}: ${ratio.toFixed(2)}`).toBe(`${name}: 0.54`)
    }
  })

  /*
   * And half as far where a photograph already knows. The archive's map of Luna
   * has its maria in it; a full-strength ratio on top is the same claim made
   * twice, and it multiplied — an evaporite at 1.9 over ground the map had
   * already drawn pale turned every lowland on Earth to snow.
   */
  it('halves a deposit\'s own brightness where a map carries it', () => {
    for (const name of ['Luna', 'Mercury', 'Mars']) {
      const palette = terrainPalette(find(name))
      const ratio = grey(palette.basalt) / grey(palette.regolith)
      expect(`${name}: ${ratio.toFixed(2)}`).toBe(`${name}: 0.77`)
    }
  })

  it('exposes bedrock brighter than the mantle over it', () => {
    // Space weathering darkens and reddens an exposed surface over hundreds of
    // millions of years; a slope steep enough to shed its regolith is
    // resurfaced by mass wasting and stays fresh. Crater walls are the bright
    // streaks on the Moon for this reason.
    for (const name of ['Luna', 'Mars', 'Enceladus', 'Iapetus']) {
      const palette = terrainPalette(find(name))
      expect(`${name}: ${grey(palette.rock) > grey(palette.regolith)}`).toBe(
        `${name}: true`,
      )
    }
  })

  /*
   * The two meanings of `BodyAppearance.colour`, which differ by a factor of
   * six and are the reason this function has a branch in it at all.
   */
  it('reads a mapless body as a reflectance and a mapped one as a ratio', () => {
    // Iapetus has no map, so its swatch is what its sphere draws and the
    // palette has to match it or the ground and the datum behind it are two
    // objects.
    const iapetus = find('Iapetus')
    expect(iapetus.appearance.texture).toBeNull()
    expect(grey(terrainPalette(iapetus).regolith)).toBeLessThanOrEqual(
      REFLECTANCE_CEILING,
    )

    /*
     * Luna's swatch is (1, 1, 1): a tint over a photograph that carries the
     * brightness itself. Read as a reflectance it makes lunar regolith 0.88
     * against a published 0.136 — a Moon that blows out to white on its lit
     * side, which is exactly what it did. The palette holds 1 and the material
     * multiplies by the map.
     */
    const luna = find('Luna')
    expect(luna.appearance.texture).not.toBeNull()
    expect(grey(terrainPalette(luna).regolith)).toBeCloseTo(1, 6)
  })

  /*
   * The ceiling is on the *reference*, not on each deposit, and this is the
   * body that says why. Enceladus reflects 1.375 at full phase — more than it
   * receives, because a geometric albedo is a ratio against a Lambert disk and
   * fresh ice backscatters. Clamped deposit by deposit its bedrock, its mantle
   * and its ice all land on the ceiling together and the surface has no
   * contrast left anywhere.
   */
  it('keeps its contrast on a body brighter than the ceiling', () => {
    const palette = terrainPalette(find('Enceladus'))
    expect(grey(palette.rock)).toBeLessThanOrEqual(REFLECTANCE_CEILING)
    expect(grey(palette.basalt) / grey(palette.regolith)).toBeCloseTo(0.54, 2)
    expect(grey(palette.rock) / grey(palette.regolith)).toBeCloseTo(1.18, 2)
  })

  it('widens the terminator by the relief the body actually has', () => {
    /*
     * A disk drawn from a photograph ends at 0.025 of a cosine because its
     * surface is smooth at the resolution of the map. Terrain is not: a peak of
     * height `h` catches the sun `√(2h/R)` past the geometric shadow line.
     */
    const luna = find('Luna')
    const expected = Math.sqrt(
      (2 * luna.surface.maxElevation) / luna.surface.grammar.meanRadius,
    )
    expect(terrainPalette(luna).terminator).toBeCloseTo(expected, 6)
    expect(expected).toBeGreaterThan(0.025 * 3)
  })

  it('gives an airless body a backscattering surface and an aired one a Lambert', () => {
    // The same split `Bodies.tsx` gives the body material, and it has to be the
    // same number or the ground and the sphere behind it shade differently at
    // the terminator.
    expect(terrainPalette(find('Luna')).lunarLambert).toBe(0.92)
    expect(terrainPalette(find('Mars')).lunarLambert).toBe(0.3)
  })

  it('needs a liquid that once stood to leave an evaporite behind', () => {
    // Air alone is not the condition: Venus has a hundred times Earth's column
    // and a surface at 920 K, where nothing has ever pooled and dried.
    expect(terrainPalette(find('Venus')).evaporitic).toBe(0)
    expect(terrainPalette(find('Luna')).evaporitic).toBe(0)
    expect(terrainPalette(find('Earth')).evaporitic).toBeGreaterThan(0.5)
  })

  it('carries the sky as a tint rather than as a brightness', () => {
    /*
     * How much light the sky delivers is `airThickness`; this is only what
     * colour it arrives in. Multiplied together instead, a thin warm sky is
     * dimmer than a thin blue one for no reason anybody could name.
     */
    for (const name of ['Earth', 'Mars', 'Titan', 'Luna']) {
      const sky = terrainPalette(find(name)).skyColour
      const lit = 0.2126 * sky.r + 0.7152 * sky.g + 0.0722 * sky.b
      expect(`${name}: ${lit.toFixed(4)}`).toBe(`${name}: 1.0000`)
    }
    expect(terrainPalette(find('Luna')).airThickness).toBe(0)
  })

  it('names the archive key for a mapped body and null for a generated one', () => {
    expect(terrainPalette(find('Mars')).textureKey).toBe('mars')
    expect(terrainPalette(find('Iapetus')).textureKey).toBeNull()
  })

  it('finds the ocean datum through the owner of the sea clamp', () => {
    // Not the formula copied out: physics and the mesh once disagreed about
    // where an ocean was because two call sites each typed the remap.
    const earth = terrainPalette(find('Earth'))
    expect(earth.seaLevel).not.toBeNull()
    expect(terrainPalette(find('Luna')).seaLevel).toBeNull()
  })
})
