import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openSession, type Session, terrainZoo } from '@inertialref/devtools'
import { fbm3 } from '@inertialref/procedural'
import { vec3 } from '@inertialref/spatial'
import {
  beltBand,
  type Body,
  coastRemap,
  coastWidth,
  craterField,
  drainageCarve,
  drainageDatum,
  findBody,
  GRIT_OCTAVES,
  gritCycles,
  gritRelief,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  heightfieldStride,
  hypsometryBand,
  iceBand,
  ladderField,
  MICRO_CRATER_CEILING,
  parseAddress,
  plateContext,
  type RegionAddress,
  regionDirection,
  regionForDirection,
  regionSize,
  reliefBand,
  SCALAR,
  SCALARS_AT,
  seaDatumElevation,
  softLimit,
  SOL,
  surfaceKernel,
  terrainSketch,
  tributaryValley,
  trunkValley,
  volcanicBand,
  walkBodies,
  writeTileFrame,
} from '@inertialref/universe'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { createTerrainKernel, type TerrainKernel } from './terrainKernel.ts'

/*
 * The band stack, one band at a time.
 *
 * `terrainKernel.gpu.test.ts` holds the whole field to one bound, which is the
 * claim the plan makes and the number a reader wants. What it cannot say is
 * *which* band drifted when it goes red, and a stack of seven terms summed in
 * one float is a poor place to look for that. So each band is held on its own
 * here: the kernel is handed a body whose every other share is zero, and the
 * CPU reference is that band's own function, called the way `evaluate` calls
 * it. The bounds are per band and named where each is measured.
 */

let gpu: GpuSession
let session: Session
let kernel: TerrainKernel

const MAX_TILES = 4

beforeAll(async () => {
  gpu = await openGpu()
  session = openSession({ seed: 'inertialref', workers: null })
  kernel = createTerrainKernel({
    resolution: HEIGHTFIELD_RESOLUTION,
    border: HEIGHTFIELD_BORDER,
    maxTiles: MAX_TILES,
  })
})

afterAll(() => {
  kernel.dispose()
  session.dispose()
  gpu.dispose()
})

function bodyAt(address: string): Body {
  const parsed = parseAddress(address)
  if (parsed.kind !== 'body') throw new Error(`not a body: ${address}`)
  const body = findBody(session.world.loadSystem(parsed.system), parsed.body)
  if (body === undefined) throw new Error(`no body at ${address}`)
  return body
}

function solBody(name: string): Body {
  for (const body of walkBodies(session.world.loadSystem(SOL))) {
    if (body.name === name) return body
  }
  throw new Error(`no ${name} in Sol`)
}

type Band =
  | 'hypsometry'
  | 'belts'
  | 'volcanism'
  | 'relief'
  | 'ice'
  | 'craters'
  | 'tail'
  | 'grit'
  | 'drainage'
  | 'coast'

/**
 * The kernel's view of a body with every share but `band`'s zeroed, and the
 * sea clamp off, so what comes back is one band scaled by its share.
 */
function isolate(body: Body, band: Band): void {
  const packed = surfaceKernel(body.surface)
  const records = new Float32Array(packed.records)
  const words = new Uint32Array(packed.words)
  const zero = (index: number): void => {
    records[SCALARS_AT * 4 + index] = 0
  }
  const shares: Record<Band, number | null> = {
    hypsometry: SCALAR.SHARE_HYPSOMETRY,
    belts: SCALAR.SHARE_BELTS,
    volcanism: SCALAR.SHARE_VOLCANISM,
    relief: SCALAR.SHARE_RELIEF,
    ice: SCALAR.SHARE_ICE,
    craters: null,
    tail: null,
    grit: null,
    drainage: null,
    coast: null,
  }
  for (const [name, index] of Object.entries(shares)) {
    if (index !== null && name !== band) zero(index)
  }
  /*
   * The drainage and the coast are not bands with shares: one carves the
   * landform the others made and the other remaps it. Isolated, each runs
   * over the *hypsometry* alone — a landform to carve, a datum to meet —
   * and the CPU reference is that band plus the term under test.
   */
  if (band === 'drainage' || band === 'coast') {
    records[SCALARS_AT * 4 + SCALAR.SHARE_HYPSOMETRY] =
      body.surface.grammar.bands.hypsometry
  }
  if (band !== 'drainage') zero(SCALAR.DRAINAGE)
  if (band !== 'coast') zero(SCALAR.COAST_WIDTH)
  if (band !== 'craters') {
    /*
     * The canonical ladder stays in the list and its ceiling goes to zero, so
     * `softLimit` returns nothing for it: dropping the rungs instead would
     * move the tail's rungs down the list while their frames stayed put, and
     * the tail would be walked against the wrong lattice.
     */
    zero(SCALAR.CRATER_LIMIT)
  }
  if (band !== 'tail') zero(SCALAR.MICRO_CEILING)
  if (band !== 'grit') zero(SCALAR.GRIT_RELIEF)
  zero(SCALAR.SEA_ENABLED)
  ;(kernel.records.array as Float32Array).set(records)
  ;(kernel.words.array as Uint32Array).set(words)
  kernel.records.needsUpdate = true
  kernel.words.needsUpdate = true
}

async function gpuTile(
  body: Body,
  region: RegionAddress,
): Promise<Float32Array> {
  const packed = surfaceKernel(body.surface)
  writeTileFrame(packed, region, kernel.tiles.array as Float32Array, 0)
  kernel.tiles.needsUpdate = true
  kernel.total.value = kernel.samples
  await gpu.compute(kernel.compute)
  return new Float32Array(await gpu.readBuffer(kernel.elevations)).slice(
    0,
    kernel.samples,
  )
}

/** The CPU's value for one band at one direction, as `evaluate` scales it. */
function cpuBand(body: Body, band: Band, direction: ReturnType<typeof vec3>) {
  const surface = body.surface
  const grammar = surface.grammar
  const sketch = terrainSketch(surface)
  const budget = surface.maxElevation
  const bands = grammar.bands
  const plates = plateContext(sketch, direction)
  switch (band) {
    case 'hypsometry':
      return (
        bands.hypsometry *
        hypsometryBand(
          sketch,
          grammar,
          plates,
          direction,
          bands.hypsometry * budget,
        ) *
        budget
      )
    case 'belts':
      return (
        bands.belts *
        beltBand(sketch, grammar, plates, direction, bands.belts * budget) *
        budget
      )
    case 'volcanism':
      return (
        bands.volcanism *
        volcanicBand(
          sketch,
          grammar,
          plates,
          direction,
          bands.volcanism * budget,
        ) *
        budget
      )
    case 'relief':
      return (
        bands.relief *
        reliefBand(
          sketch,
          grammar,
          surface.roughness,
          direction,
          bands.relief * budget,
        ) *
        budget
      )
    case 'ice':
      return bands.ice > 0
        ? bands.ice *
            iceBand(sketch, grammar, direction, bands.ice * budget) *
            budget
        : 0
    case 'craters':
      return sketch.craterLevels.length > 0
        ? softLimit(
            craterField(sketch, grammar, direction),
            bands.craters * budget,
          )
        : 0
    case 'tail':
      return sketch.microLevels.length > 0
        ? softLimit(
            ladderField(
              sketch.latticeSeed,
              sketch.microLevels,
              sketch.microFirstRung,
              grammar,
              direction,
              0,
              'exact',
            ),
            MICRO_CRATER_CEILING,
          )
        : 0
    case 'grit': {
      const cycles = gritCycles(grammar)
      return (
        gritRelief(grammar) *
        fbm3(
          sketch.seeds.grit,
          direction.x * cycles,
          direction.y * cycles,
          direction.z * cycles,
          { octaves: GRIT_OCTAVES },
        )
      )
    }
    case 'drainage': {
      const landform =
        bands.hypsometry *
        hypsometryBand(
          sketch,
          grammar,
          plates,
          direction,
          bands.hypsometry * budget,
        ) *
        budget
      return (
        landform +
        drainageCarve(
          grammar,
          trunkValley(sketch, direction),
          tributaryValley(sketch, direction),
          landform - drainageDatum(surface),
          budget,
        )
      )
    }
    case 'coast': {
      const landform =
        bands.hypsometry *
        hypsometryBand(
          sketch,
          grammar,
          plates,
          direction,
          bands.hypsometry * budget,
        ) *
        budget
      const sea = seaDatumElevation(surface)
      return sea === null || grammar.liquid <= 0
        ? landform
        : coastRemap(landform, sea, coastWidth(surface))
    }
  }
}

async function worstGap(
  body: Body,
  band: Band,
  level: number,
): Promise<number> {
  isolate(body, band)
  const region = regionForDirection(vec3(0.3, 0.8, 0.5), level)
  const got = await gpuTile(body, region)
  const stride = heightfieldStride({
    resolution: HEIGHTFIELD_RESOLUTION,
    border: HEIGHTFIELD_BORDER,
  })
  const step = HEIGHTFIELD_RESOLUTION - 1
  let worst = 0
  for (
    let row = -HEIGHTFIELD_BORDER;
    row < HEIGHTFIELD_RESOLUTION + HEIGHTFIELD_BORDER;
    row += 1
  ) {
    for (
      let col = -HEIGHTFIELD_BORDER;
      col < HEIGHTFIELD_RESOLUTION + HEIGHTFIELD_BORDER;
      col += 1
    ) {
      const direction = regionDirection(region, col / step, row / step)
      const expected = cpuBand(body, band, direction)
      const index =
        (row + HEIGHTFIELD_BORDER) * stride + (col + HEIGHTFIELD_BORDER)
      worst = Math.max(worst, Math.abs((got[index] as number) - expected))
    }
  }
  return worst
}

/** Half a region's side on the ground, meters. See `terrainKernel.gpu.test.ts`. */
const halfWidth = (body: Body, level: number): number =>
  regionSize(body.surface.grammar.meanRadius, level) / 2

/**
 * Each band's bound, named from the measurement that set it.
 *
 * The noise bands are float32 arithmetic on a coordinate that is exact to a
 * thousandth of a lattice cell, so their gap is a fraction of the budget:
 * hypsometry measures under 10⁻⁶ of it, belts and volcanism under 10⁻⁵, the
 * ice set under 10⁻⁵, and the relief 2.5 × 10⁻⁵ on the eroded world where
 * twelve damped octaves accumulate a slope in float32.
 *
 * The lattice bands carry the sample offset as well — the crater rungs at up
 * to eight offsets (fifteen rungs on Earth at level 0 measured four), the tail
 * at the same, the grit at two, because two octaves at eight and four meters
 * are the whole of it. The offset is `halfWidth · 2⁻²⁴`, and it is the term
 * that vanishes at depth.
 */
function bound(band: Band, body: Body, level: number): number {
  const budget = body.surface.maxElevation
  const offset = halfWidth(body, level) * 2 ** -24
  switch (band) {
    case 'hypsometry':
      return 2e-6 * budget
    case 'belts':
    case 'volcanism':
      return 1e-5 * budget
    case 'relief':
      return 3e-5 * budget
    case 'ice':
      return 2e-5 * budget
    case 'craters':
      return 2e-5 * budget + 8 * offset
    case 'tail':
      return 0.01 + 8 * offset
    case 'grit':
      return 0.005 + 2 * offset
    // The hypsometry's own bound, plus the carve and the remap on top of
    // it. The carve is the worse: a warped three-octave fBm sharpened by
    // 2.6 and raised to the sixth power, so a float32 step in the warp is
    // amplified before it is capped — measured at 9.8 × 10⁻⁶ of the budget
    // on Earth at level 0, and 2.5 × 10⁻⁵ is that with room.
    case 'drainage':
      return 2.5e-5 * budget
    case 'coast':
      return 4e-6 * budget
  }
}

describe('each band, on its own', () => {
  it('holds every band to its own bound, on every body, at four levels', async () => {
    const zoo = terrainZoo(session.world)
    const bodies = [
      ...zoo.map((entry) => bodyAt(entry.address)),
      solBody('Luna'),
      solBody('Earth'),
      solBody('Mercury'),
    ]
    const bands: Band[] = [
      'hypsometry',
      'belts',
      'volcanism',
      'relief',
      'ice',
      'craters',
      'tail',
      'grit',
      'drainage',
      'coast',
    ]
    const rows: string[] = []
    const failures: string[] = []
    for (const body of bodies) {
      for (const level of [0, 3, 6, 12]) {
        const cells: string[] = []
        for (const band of bands) {
          const gap = await worstGap(body, band, level)
          const limit = bound(band, body, level)
          cells.push(`${band} ${gap.toExponential(1)}`)
          if (gap >= limit) {
            failures.push(
              `${body.name} L${level} ${band}: ${gap} m against ${limit}`,
            )
          }
        }
        rows.push(
          `${body.name.padEnd(16)} L${String(level).padStart(2)}  ${cells.join('  ')}`,
        )
      }
    }
    console.info(`\n${rows.join('\n')}\n`)
    expect(failures).toEqual([])
  }, 300_000)
})
