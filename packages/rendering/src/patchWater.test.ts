import { describe, expect, it } from 'vitest'
import { World } from '@inertialref/simulation'
import {
  type Body,
  COVER_CHANNELS,
  drains,
  regionAddress,
  systemId,
  TEST_CATALOG,
  walkBodies,
} from '@inertialref/universe'
import { buildPatch, type RenderPatch } from './terrainMesh.ts'
import { patchWater, sheetInput } from './terrainPalette.ts'

/*
 * The sheet `buildPatch` builds, under the decision `patchWater` makes.
 *
 * One synthetic field — flat ground, a lake standing over part of the grid
 * and a river across it — handed to `buildPatch` the way the streamer and
 * the orbital bake hand it, once per class of body. The field is the same
 * every time; what changes is whether a sheet is drawn and what it stands
 * at, which is the decision under test, and the sheet's vertex levels and
 * depths, which is the geometry under test.
 */

const RESOLUTION = 9
const BORDER = 2
const STRIDE = RESOLUTION + 2 * BORDER
const GROUND = 100
const LAKE = 120
/** The river runs down this column, half a meter deep. */
const RIVER_COLUMN = 6
const RIVER_DEPTH = 0.5
const region = regionAddress(2, 10, 300, 400)

/** Rows 1–3, columns 1–3 of the interior: the lake. */
const inLake = (row: number, col: number) =>
  row >= 1 && row <= 3 && col >= 1 && col <= 3

function field() {
  const elevations = new Float32Array(STRIDE * STRIDE).fill(GROUND)
  const water = new Float32Array(RESOLUTION * RESOLUTION).fill(Number.NaN)
  for (let row = 0; row < RESOLUTION; row += 1)
    for (let col = 0; col < RESOLUTION; col += 1) {
      const at = row * RESOLUTION + col
      if (inLake(row, col)) water[at] = LAKE
      else if (col === RIVER_COLUMN) water[at] = GROUND + RIVER_DEPTH
    }
  return {
    elevations,
    water,
    cover: new Uint8Array(RESOLUTION * RESOLUTION * COVER_CHANNELS),
  }
}

function patchFor(body: Body): RenderPatch {
  const { elevations, water, cover } = field()
  return buildPatch({
    region,
    resolution: RESOLUTION,
    border: BORDER,
    elevations,
    cover,
    bodyRadius: body.radius,
    ...sheetInput(patchWater(body), water),
  })
}

/** A sheet vertex's height over the datum sphere, meters. */
function levelOf(patch: RenderPatch, body: Body, vertex: number): number {
  const sheet = patch.water!
  const x = patch.anchor.x + (sheet.positions[vertex * 3] as number)
  const y = patch.anchor.y + (sheet.positions[vertex * 3 + 1] as number)
  const z = patch.anchor.z + (sheet.positions[vertex * 3 + 2] as number)
  return Math.hypot(x, y, z) - body.radius
}

/* -- One body of each class, found rather than named --------------------- */

const world = new World({ seed: 'inertialref', catalog: TEST_CATALOG })
const sol = [...walkBodies(world.loadSystem(systemId('SOL')))]
const solBody = (name: string): Body => {
  const body = sol.find((candidate) => candidate.name === name)
  if (body === undefined) throw new Error(`no ${name} in Sol`)
  return body
}

function generated(test: (body: Body) => boolean, what: string): Body {
  for (const star of TEST_CATALOG.stars.slice(1)) {
    const system = world.loadSystem(systemId(star.id))
    for (const body of walkBodies(system))
      if (
        body.appearance.texture === null &&
        body.surface.maxElevation > 0 &&
        test(body)
      )
        return body
  }
  throw new Error(`no ${what} in the fixture catalog`)
}

const MAPPED_WET = solBody('Earth')
const MAPPED_DRY = solBody('Mars')
const GENERATED_DRY = generated(
  (body) => body.appearance.liquid === null,
  'generated dry world',
)
const LAKES_ONLY = generated(
  (body) =>
    body.appearance.liquid !== null &&
    body.surface.seaLevel === null &&
    drains(body.surface),
  'generated world with lakes and no sea',
)
/*
 * The fixture catalog generates no world with both a sea and a graph at this
 * seed, so the lakes-only world is given a sea. The decision reads four
 * things — a photograph, a liquid, a sea datum, a graph — and this body has
 * every one of them a sea world has.
 */
const GENERATED_WET = {
  ...LAKES_ONLY,
  surface: { ...LAKES_ONLY.surface, seaLevel: 0.5 },
} as Body

describe('the water decision for a patch', () => {
  it('finds a body of each class', () => {
    expect(MAPPED_WET.appearance.texture).not.toBeNull()
    expect(MAPPED_WET.appearance.liquid).not.toBeNull()
    expect(MAPPED_DRY.appearance.texture).not.toBeNull()
    expect(GENERATED_DRY.appearance.liquid).toBeNull()
    expect(drains(GENERATED_WET.surface)).toBe(true)
    expect(LAKES_ONLY.surface.seaLevel).toBeNull()
  })

  it('draws no sheet where the sea is clamped or there is no water, whatever the field holds', () => {
    for (const body of [MAPPED_WET, MAPPED_DRY, GENERATED_DRY]) {
      expect(patchWater(body)).toEqual({
        seabed: false,
        seaLevel: null,
        sampled: false,
      })
      // The lake and the river are in the field, and are not a sheet here.
      expect(patchFor(body).water).toBeNull()
    }
  })

  it('asks for the seabed on a generated wet body and draws the field’s own water', () => {
    const decision = patchWater(GENERATED_WET)
    expect(decision).toEqual({ seabed: true, seaLevel: null, sampled: true })
    const patch = patchFor(GENERATED_WET)
    const sheet = patch.water
    expect(sheet).not.toBeNull()
    expect(sheet!.positions.length).toBe(patch.positions.length)
    const tolerance = 1e-2
    for (let row = 0; row < RESOLUTION; row += 1)
      for (let col = 0; col < RESOLUTION; col += 1) {
        const vertex = row * RESOLUTION + col
        const level = levelOf(patch, GENERATED_WET, vertex)
        const depth = sheet!.depths[vertex] as number
        if (inLake(row, col)) {
          expect(level).toBeCloseTo(LAKE, 2)
          expect(Math.abs(depth - (LAKE - GROUND))).toBeLessThan(tolerance)
        } else if (col === RIVER_COLUMN) {
          expect(level).toBeCloseTo(GROUND + RIVER_DEPTH, 2)
          expect(Math.abs(depth - RIVER_DEPTH)).toBeLessThan(tolerance)
        } else {
          // Dry ground: the sheet drops under it, so it hides rather than
          // z-fighting, and holds no depth.
          expect(level).toBeLessThan(GROUND - 0.99)
          expect(depth).toBe(0)
        }
      }
  })

  it('draws the lakes of a world with no sea, whose ground has no clamp', () => {
    expect(patchWater(LAKES_ONLY)).toEqual({
      seabed: false,
      seaLevel: null,
      sampled: true,
    })
    const patch = patchFor(LAKES_ONLY)
    expect(patch.water).not.toBeNull()
    expect(levelOf(patch, LAKES_ONLY, 2 * RESOLUTION + 2)).toBeCloseTo(LAKE, 2)
  })

  it('draws a sheet for a river half a meter deep and nothing else', () => {
    // The gate that decides whether a patch has a sheet at all, at its
    // shallowest: no lake, no sea, one river down one column.
    const { elevations, water, cover } = field()
    for (let i = 0; i < water.length; i += 1)
      if (i % RESOLUTION !== RIVER_COLUMN) water[i] = Number.NaN
      else water[i] = GROUND + RIVER_DEPTH
    const patch = buildPatch({
      region,
      resolution: RESOLUTION,
      border: BORDER,
      elevations,
      cover,
      bodyRadius: GENERATED_WET.radius,
      ...sheetInput(patchWater(GENERATED_WET), water),
    })
    expect(patch.water).not.toBeNull()
    expect(levelOf(patch, GENERATED_WET, RIVER_COLUMN)).toBeCloseTo(
      GROUND + RIVER_DEPTH,
      2,
    )
  })

  it('draws a sea datum on its own where it is the only water there is', () => {
    // A generated wet body with no graph stands its sea at one datum: the
    // decision hands `buildPatch` the datum and not the field's water, so a
    // lake the field carried would not be drawn.
    const body = {
      ...GENERATED_WET,
      surface: {
        ...GENERATED_WET.surface,
        grammar: { ...GENERATED_WET.surface.grammar, drainage: 0 },
      },
    } as Body
    expect(drains(body.surface)).toBe(false)
    const decision = patchWater(body)
    expect(decision.seabed).toBe(true)
    expect(decision.sampled).toBe(false)
    expect(decision.seaLevel).not.toBeNull()
    const { elevations, water, cover } = field()
    // Ground under the datum everywhere: the sheet covers the patch at it.
    elevations.fill(decision.seaLevel! - 10)
    const patch = buildPatch({
      region,
      resolution: RESOLUTION,
      border: BORDER,
      elevations,
      cover,
      bodyRadius: body.radius,
      ...sheetInput(decision, water),
    })
    expect(patch.water).not.toBeNull()
    for (const vertex of [0, 20, 40, 80])
      expect(levelOf(patch, body, vertex)).toBeCloseTo(decision.seaLevel!, 2)
  })
})
