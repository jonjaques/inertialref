import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataUtils } from 'three/webgpu'
import {
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeSkyMoments,
  bakeTransmittance,
  iceAggregate,
  mieDroplets,
  phaseAtlas,
  type RenderBody,
  toHalves,
  SKY_TABLE_HEIGHT,
  SKY_TABLE_WIDTH,
} from '@inertialref/rendering'
import {
  createInlineWorker,
  createTaskRegistry,
  runInline,
  WorkerPool,
} from '@inertialref/workers'
import {
  bakeAirTables,
  bakeAtmosphereTask,
  convolvePhaseTask,
} from './atmosphereTask.ts'
import {
  scatteringCensus,
  scatteringFor,
  scatteringOf,
  scatteringVia,
  warmScattering,
} from './atmosphereLuts.ts'
import { createGameTaskRegistry } from '../workers/registry.ts'

/*
 * The bake on the pool is the bake on the main thread, and a page without
 * clouds pays nothing for the sky table.
 *
 * The consumer trusts a worker's tables exactly as it trusts its own, so the
 * two have to be the same arrays — and the wire is the part that can differ:
 * a `Float32Array` that survives structured cloning is not the same claim as
 * one that survives a transfer list, and a registry that lacks the task fails
 * at dispatch, not at import.
 *
 * The sky table's cost is counted, not timed: `bakeSkyMoments` is wrapped
 * in a counter, so "the bake did not run it" is a count of zero, and the
 * bytes it would have held are read off the transfer list and the cache.
 */

const skyBakes = vi.hoisted(() => ({ count: 0 }))
/** The phase atlas's convolutions and the droplet table's decodes, counted as the sky's bakes are. */
const phaseWork = vi.hoisted(() => ({ atlases: 0, decodes: 0 }))
vi.mock('@inertialref/rendering', async (importOriginal) => {
  const real = await importOriginal<typeof import('@inertialref/rendering')>()
  return {
    ...real,
    bakeSkyMoments: (...args: Parameters<typeof real.bakeSkyMoments>) => {
      skyBakes.count += 1
      return real.bakeSkyMoments(...args)
    },
    phaseAtlas: (...args: Parameters<typeof real.phaseAtlas>) => {
      phaseWork.atlases += 1
      return real.phaseAtlas(...args)
    },
    mieDroplets: () => {
      phaseWork.decodes += 1
      return real.mieDroplets()
    },
  }
})

beforeEach(() => {
  skyBakes.count = 0
  phaseWork.atlases = 0
  phaseWork.decodes = 0
})

// Earth's authored haze, and the shell ratio and heights `buildScene` gives it.
const haze = {
  color: { r: 0.3, g: 0.55, b: 1 },
  limb: { r: 1, g: 0.6, b: 0.3 },
  thickness: 1,
  aerosolAngstrom: 1.3,
  ozone: 300,
}
const topRatio = 1.0157
const heights = { rayleigh: 8.5 / 6371, aerosol: 1.2 / 6371 }

/** Earth's haze at another thickness: a key of its own in the module's cache. */
const hazeAt = (thickness: number) => ({ ...haze, thickness })

/** The air's two tables, RGBA32F: what a bake moves when it is asked for nothing more. */
const AIR_BYTES = (512 * 64 + 32 * 16) * 16
/** The sky table, RGBA32F on the wire and RGBA16F in the cache. */
const SKY_WIRE_BYTES = SKY_TABLE_WIDTH * SKY_TABLE_HEIGHT * 16
const SKY_TEXTURE_BYTES = SKY_TABLE_WIDTH * SKY_TABLE_HEIGHT * 8

/** The sky table a whole bake of `h` makes, in half floats. */
function skyHalves(h: typeof haze): Uint16Array {
  const recipe = atmosphereRecipe(h, topRatio, heights)
  const transmittance = bakeTransmittance(recipe)
  const multiScatter = bakeMultipleScattering(recipe, transmittance)
  const sky = bakeSkyMoments(recipe, transmittance, multiScatter)
  return Uint16Array.from(sky.data, (v) => DataUtils.toHalfFloat(v))
}

function inlinePool(): WorkerPool {
  return new WorkerPool({
    factory: () => createInlineWorker(createGameTaskRegistry()),
    size: 1,
  })
}

describe('render.bakeAtmosphere', () => {
  it('bakes what the main thread bakes, the sky table when it is wanted', async () => {
    const recipe = atmosphereRecipe(haze, topRatio, heights)
    const transmittance = bakeTransmittance(recipe)
    const multiScatter = bakeMultipleScattering(recipe, transmittance)

    const response = await runInline(bakeAtmosphereTask, {
      haze,
      topRatio,
      heights,
      wanted: ['sky'],
    })
    expect(response.recipe).toEqual(recipe)
    expect(response.transmittance).toEqual(transmittance)
    expect(response.multiScatter).toEqual(multiScatter)
    expect(response.tables).toEqual(
      bakeAirTables(recipe, transmittance, multiScatter, ['sky']),
    )
    expect(response.tables.sky).toEqual(
      bakeSkyMoments(recipe, transmittance, multiScatter),
    )
  })

  it('bakes the two tables it always did, and nothing more, when nothing is wanted', async () => {
    const response = await runInline(bakeAtmosphereTask, {
      haze,
      topRatio,
      heights,
      wanted: [],
    })
    expect(response.tables).toEqual({})
    expect(skyBakes.count).toBe(0)
    const moved = bakeAtmosphereTask.transfers!(response)
    expect(moved.reduce((sum, buffer) => sum + buffer.byteLength, 0)).toBe(
      AIR_BYTES,
    )

    const wanted = await runInline(bakeAtmosphereTask, {
      haze,
      topRatio,
      heights,
      wanted: ['sky'],
    })
    expect(skyBakes.count).toBe(1)
    expect(
      bakeAtmosphereTask.transfers!(wanted).reduce(
        (sum, buffer) => sum + buffer.byteLength,
        0,
      ),
    ).toBe(AIR_BYTES + SKY_WIRE_BYTES)
  })

  it('crosses the worker boundary intact, through the game registry', async () => {
    const pool = inlinePool()
    try {
      for (const wanted of [[], ['sky']] as const) {
        const request = { haze, topRatio, heights, wanted }
        const expected = await runInline(bakeAtmosphereTask, request)
        const crossed = await pool.submit(bakeAtmosphereTask, request).result
        expect(crossed.transmittance.width).toBe(expected.transmittance.width)
        expect(crossed.transmittance.height).toBe(expected.transmittance.height)
        expect([...crossed.transmittance.data]).toEqual([
          ...expected.transmittance.data,
        ])
        expect([...crossed.multiScatter.data]).toEqual([
          ...expected.multiScatter.data,
        ])
        expect(crossed.recipe).toEqual(expected.recipe)
        expect(Object.keys(crossed.tables)).toEqual([...wanted])
        if (expected.tables.sky !== undefined) {
          expect([
            crossed.tables.sky?.width,
            crossed.tables.sky?.height,
          ]).toEqual([SKY_TABLE_WIDTH, SKY_TABLE_HEIGHT])
          expect([...crossed.tables.sky!.data]).toEqual([
            ...expected.tables.sky.data,
          ])
        }
      }
    } finally {
      pool.terminate()
    }
  })

  it('is the shared registry plus the client’s own tasks, and nothing shared is lost', () => {
    const shared = createTaskRegistry().names()
    const game = createGameTaskRegistry().names()
    expect(game).toEqual(
      [...shared, 'render.bakeAtmosphere', 'render.convolvePhase'].sort(),
    )
    // The shared registry does not know them: the layer graph forbids the
    // import and the headless runner would never ask.
    expect(shared).not.toContain('render.bakeAtmosphere')
    expect(shared).not.toContain('render.convolvePhase')
  })
})

describe('the scattering cache', () => {
  it('holds no sky table for a haze nothing wanted one of', () => {
    const before = scatteringCensus()
    const set = scatteringFor(hazeAt(1.01), topRatio, heights)
    expect(set.sky).toBeUndefined()
    expect(skyBakes.count).toBe(0)
    const after = scatteringCensus()
    expect(after.hazes).toBe(before.hazes + 1)
    expect([after.skies, after.skyBytes]).toEqual([
      before.skies,
      before.skyBytes,
    ])
  })

  it('bakes the sky table on the first ask that wants it, as a new set, once', () => {
    const h = hazeAt(1.02)
    const bare = scatteringFor(h, topRatio, heights)
    const before = scatteringCensus()
    const lit = scatteringFor(h, topRatio, heights, { sky: true })
    // A new object, so a reader that binds on a change of set binds the sky.
    expect(lit).not.toBe(bare)
    expect(lit.transmittance).toBe(bare.transmittance)
    expect(lit.multiScatter).toBe(bare.multiScatter)
    expect(skyBakes.count).toBe(1)
    const image = lit.sky!.image as { readonly data: Uint16Array }
    expect([...image.data]).toEqual([...skyHalves(h)])
    const after = scatteringCensus()
    expect(after.skies).toBe(before.skies + 1)
    expect(after.skyBytes).toBe(before.skyBytes + SKY_TEXTURE_BYTES)
    // Asked again, either way, it is the same set and no second bake.
    expect(scatteringFor(h, topRatio, heights, { sky: true })).toBe(lit)
    expect(scatteringFor(h, topRatio, heights)).toBe(lit)
    expect(skyBakes.count).toBe(2) // `skyHalves`' own bake is the second
  })

  it('bakes the sky on the pool for a haze cached without one, and binds it when it lands', async () => {
    const pool = inlinePool()
    try {
      const h = hazeAt(1.03)
      const bare = await warmScattering(pool, h, topRatio, heights)
      expect(bare.sky).toBeUndefined()
      expect(skyBakes.count).toBe(0)
      // The draw-time ask hands back the set it has and submits the sky.
      expect(scatteringVia(pool, h, topRatio, heights, { sky: true })).toBe(
        bare,
      )
      // A second ask while it is in flight submits nothing more.
      const landed = await warmScattering(pool, h, topRatio, heights, {
        sky: true,
      })
      expect(skyBakes.count).toBe(1)
      expect(landed).not.toBe(bare)
      expect(landed.transmittance).toBe(bare.transmittance)
      const image = landed.sky!.image as { readonly data: Uint16Array }
      expect([...image.data]).toEqual([...skyHalves(h)])
      expect(scatteringVia(pool, h, topRatio, heights, { sky: true })).toBe(
        landed,
      )
    } finally {
      pool.terminate()
    }
  })

  it('drops a sky that lands after the set has gained one', async () => {
    const pool = inlinePool()
    try {
      const h = hazeAt(1.04)
      await warmScattering(pool, h, topRatio, heights)
      const late = warmScattering(pool, h, topRatio, heights, { sky: true })
      // This thread bakes the sky while the pool's is in flight.
      const here = scatteringFor(h, topRatio, heights, { sky: true })
      expect(await late).toBe(here)
      expect(scatteringFor(h, topRatio, heights)).toBe(here)
    } finally {
      pool.terminate()
    }
  })

  it('wants the sky where the engine holds the cloud system’s factory, and nowhere else', () => {
    const body = (thickness: number) =>
      ({
        appearance: { haze: hazeAt(thickness) },
        airTop: topRatio,
        airHeights: heights,
      }) as unknown as RenderBody
    const noPool = () => null
    expect(scatteringOf({ pool: noPool }, body(1.05))?.sky).toBeUndefined()
    expect(
      scatteringOf({ pool: noPool, cloudSystemFactory: null }, body(1.06))?.sky,
    ).toBeUndefined()
    expect(skyBakes.count).toBe(0)
    expect(
      scatteringOf({ pool: noPool, cloudSystemFactory: () => null }, body(1.07))
        ?.sky,
    ).toBeDefined()
    expect(
      scatteringOf({ pool: noPool }, body(1.08), { sky: true })?.sky,
    ).toBeDefined()
    expect(skyBakes.count).toBe(2)
  })
})

/** Earth's sun's angular radius, radians (phase 1 design §5.4). */
const EARTH_SUN = 0.265 * (Math.PI / 180)

describe('render.convolvePhase', () => {
  it('convolves what the main thread convolves, and answers for the radius it was asked', async () => {
    const answer = await runInline(convolvePhaseTask, {
      angularRadius: EARTH_SUN,
    })
    const here = phaseAtlas(mieDroplets(), iceAggregate(), EARTH_SUN)
    expect(answer.angularRadius).toBe(EARTH_SUN)
    expect([here.width, here.height]).toEqual([1024, 64])
    expect(answer.halves).toEqual(toHalves(here.texels))
  })

  it('crosses the worker boundary intact through the game registry, its 512 KB moved rather than copied', async () => {
    const pool = inlinePool()
    try {
      const request = { angularRadius: 2 * EARTH_SUN }
      const expected = await runInline(convolvePhaseTask, request)
      const moved = convolvePhaseTask.transfers!(expected)
      expect(moved.map((buffer) => buffer.byteLength)).toEqual([
        1024 * 64 * 4 * 2,
      ])
      const crossed = await pool.submit(convolvePhaseTask, request).result
      expect(crossed.angularRadius).toBe(request.angularRadius)
      expect([...crossed.halves]).toEqual([
        ...toHalves(
          phaseAtlas(mieDroplets(), iceAggregate(), request.angularRadius)
            .texels,
        ),
      ])
    } finally {
      pool.terminate()
    }
  })

  it('decodes the committed tables once a worker, on its first ask', async () => {
    await runInline(convolvePhaseTask, { angularRadius: EARTH_SUN })
    const decoded = phaseWork.decodes
    // Once, or not at all where an earlier test's ask decoded them already.
    expect(decoded).toBeLessThanOrEqual(1)
    await runInline(convolvePhaseTask, { angularRadius: 3 * EARTH_SUN })
    expect(phaseWork.decodes).toBe(decoded)
    expect(phaseWork.atlases).toBe(2)
  })

  it('costs a page without clouds nothing: a registry served and a haze baked convolve and decode no table', async () => {
    // The page without `?clouds=1` builds no cloud system, so no `CloudPhase`
    // and no `serve` (`cloudSensor.gpu.test.ts`, "builds nothing of the
    // clouds"). What it does build is the worker's registry, which holds
    // this task, and the air's bake on the same pool.
    const pool = inlinePool()
    try {
      createGameTaskRegistry()
      await warmScattering(pool, hazeAt(1.09), topRatio, heights)
      expect(phaseWork).toEqual({ atlases: 0, decodes: 0 })
    } finally {
      pool.terminate()
    }
  })
})
