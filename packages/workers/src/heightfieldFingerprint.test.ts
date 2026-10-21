import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  drains,
  type HeightfieldRequest,
  regionAddress,
  type SurfaceParameters,
  surfaceGrammar,
  TERRAIN_ALGORITHM,
} from '@inertialref/universe'
import { heightfieldCacheRecord } from './heightfieldCache.ts'
import { runInline } from './task.ts'
import { encodeSurface, generateHeightfieldTask } from './tasks.ts'

/*
 * The CPU tile, pinned beside the version the archive keeps it under.
 *
 * The heightfield archive keys the pool's tiles on the task's version
 * (`POOL_ARCHIVE`), and CI restores `.data/heightfields` keyed on it. A
 * change to the tile arithmetic that no version covers — the drawn tail is
 * not canon, so ADR-0023 leaves it out of the terrain version — would be
 * answered from stale tiles, and the slow descent suite would pass on them.
 * This is the check that it cannot: a few tiles from a dry body and a wet one
 * with a drainage graph, hashed, and compared with the hashes the current
 * version produced.
 *
 * It is a golden vector on purpose. `micro.test.ts` avoids them because they
 * go stale; here going stale is the signal. When this fails, the arithmetic
 * moved: spend a version of `generateHeightfieldTask` and re-pin.
 */

const PINNED = {
  version: 7,
  /*
   * A canonical terrain bump moves every key already, so it re-pins the
   * tiles without spending a task version; this is how the test tells the two
   * apart.
   */
  terrain: 5,
  tiles: {
    'dry/2': '955add4b -3856.736083984375 1290.2174072265625',
    'dry/10': 'e8aef271 -4264.93359375 -4108.31689453125',
    'dry/18': '77a7ec23 -3464.112548828125 -3459.65234375',
    'wet/2 coast': 'a18369c5 -31.58431053161621 1831.0166015625',
    'wet/10 land': '79e86a7f 967.5690307617188 1855.2930908203125',
    'wet/18 lake': '8fee5544 908.8423461914062 910.24560546875',
    'wet/2 seabed': '532d8c36 -3651.404296875 679.8135375976562',
  } as Record<string, string>,
}

const air = { surfaceDensity: 1.225, scaleHeight: 8500, ceiling: 100_000 }

function body(name: string, wet: boolean): SurfaceParameters {
  const seed = rootSeed(`heightfield-fingerprint-${name}`)
  return {
    seed,
    maxElevation: 8000,
    roughness: 3,
    seaLevel: wet ? 0.5 : null,
    grammar: surfaceGrammar(seed, {
      mass: 5.97e24,
      meanRadius: 6.371e6,
      atmosphere: wet ? air : null,
      temperature: wet ? 288 : 250,
      tidalProxy: 0,
      hasOcean: wet,
      hadOcean: wet,
      reliefSpent: 1,
      publishedRelief: 8000,
    }),
  }
}

const DRY = body('dry', false)
const WET = body('wet', true)

/*
 * A coarse tile, a middle one, and one deep in the drawn tail, per body. The
 * wet body's are chosen to carry what only it has: a coast and rivers at
 * level 2, a lake under the deep tile, and the seabed under a coastal one.
 */
const TILES: readonly (readonly [
  string,
  SurfaceParameters,
  HeightfieldRequest,
])[] = [
  ['dry/2', DRY, { region: regionAddress(0, 2, 1, 2), resolution: 9 }],
  ['dry/10', DRY, { region: regionAddress(3, 10, 517, 300), resolution: 9 }],
  [
    'dry/18',
    DRY,
    { region: regionAddress(4, 18, 131_000, 70_001), resolution: 9 },
  ],
  ['wet/2 coast', WET, { region: regionAddress(0, 2, 1, 2), resolution: 9 }],
  [
    'wet/10 land',
    WET,
    { region: regionAddress(0, 10, 300, 400), resolution: 9 },
  ],
  [
    'wet/18 lake',
    WET,
    { region: regionAddress(0, 18, 25_000, 30_000), resolution: 9 },
  ],
  [
    'wet/2 seabed',
    WET,
    { region: regionAddress(0, 2, 0, 3), resolution: 9, seabed: true },
  ],
]

/** Every byte of a tile, as the archive's own checksum, in hex, and its extremes. */
async function fingerprint(
  surface: SurfaceParameters,
  request: HeightfieldRequest,
): Promise<string> {
  // Through the task, which is the arithmetic the pool executes.
  const field = await runInline(generateHeightfieldTask, {
    ...request,
    surface: encodeSurface(surface),
  })
  const { checksum } = heightfieldCacheRecord('', field)
  return `${checksum.toString(16).padStart(8, '0')} ${field.minElevation} ${field.maxElevation}`
}

describe('the CPU tile fingerprint', () => {
  it('covers a dry body and a wet one with a drainage graph', () => {
    expect(drains(DRY)).toBe(false)
    expect(drains(WET)).toBe(true)
  })

  it('is pinned for the current task version', () => {
    expect(
      generateHeightfieldTask.version,
      'generateHeightfieldTask.version moved: re-pin PINNED.tiles to the ' +
        'fingerprints this version produces, and PINNED.version with them.',
    ).toBe(PINNED.version)
  })

  it('is pinned for the current canonical terrain version', () => {
    expect(
      TERRAIN_ALGORITHM.version,
      'TERRAIN_ALGORITHM.version moved, which moves every archive key with ' +
        'it: re-pin PINNED.tiles and PINNED.terrain without spending a ' +
        'version of generateHeightfieldTask.',
    ).toBe(PINNED.terrain)
  })

  it('matches the tiles the current version produces', async () => {
    const now = Object.fromEntries(
      await Promise.all(
        TILES.map(async ([name, surface, request]) => [
          name,
          await fingerprint(surface, request),
        ]),
      ),
    )
    expect(
      now,
      TERRAIN_ALGORITHM.version === PINNED.terrain
        ? 'The CPU tile arithmetic changed without a version, so the archive ' +
            'would answer it with stale tiles. Spend a version: bump ' +
            'generateHeightfieldTask.version in packages/workers/src/tasks.ts ' +
            'and re-pin PINNED here to the fingerprints below.'
        : 'The canonical terrain version moved, and every key with it: ' +
            're-pin PINNED.tiles to the fingerprints below and PINNED.terrain ' +
            'to TERRAIN_ALGORITHM.version, without spending a task version.',
    ).toEqual(PINNED.tiles)
  })
})
