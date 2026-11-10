import { defineTask } from '@inertialref/workers'
import {
  type AirHeights,
  type AtmosphereRecipe,
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeSkyMoments,
  bakeTransmittance,
  type HazeAuthoring,
  type ScatteringLut,
} from '@inertialref/rendering'

/*
 * The atmosphere bake as a pool task.
 *
 * The bake is pure arithmetic in `@inertialref/rendering` — a recipe from the
 * authored haze, then two tables marched from it and the sky table summed
 * from those two — and it costs 20 to 40 ms per atmosphere on the main
 * thread before the sky table, which adds about 50 more, which is the largest single thing left
 * in an arrival: a jump to a generated system lands a 39.7 ms bake inside a
 * 43.3 ms frame the first time one of its hazes is seen. Nothing in it needs
 * the main thread; it reads only what the request carries and is the same
 * function wherever it runs. So it runs on the pool, the way
 * `universe.prepareSurface` does for the same reason.
 *
 * It is defined here rather than in `packages/workers` because it cannot be
 * defined there: `workers` and `rendering` are both layer 5, and the graph
 * allows dependencies on strictly lower layers only. Nor does it belong there.
 * The shared registry is what every host serves — the headless runner bakes no
 * atmospheres — and this is the client's own task, registered by the client's
 * own worker entry (`workers/registry.ts`). ADR-0028.
 *
 * The response carries arrays, not textures: a worker has no GPU, and the
 * half-float conversion and upload stay on the main thread in
 * `atmosphereLuts.ts`, which is the shape `universe.prepareSurface`'s consumer
 * has.
 * Nothing here may import `three/webgpu` — this file is part of the worker
 * bundle.
 */

export interface BakeAtmosphereRequest {
  readonly haze: HazeAuthoring
  readonly topRatio: number
  readonly heights: AirHeights
}

/*
 * The tables a bake derives from the air's own two, as named jobs. Each is a
 * function of the recipe and the two tables and nothing else, so it runs
 * wherever they are made, on the pool and on the main thread alike
 * (`bakeAirTables`), and lands in the response under its name. A job of
 * this kind is one entry here and one member where `atmosphereLuts.ts`
 * uploads it: the response's type, its transfers and both bakes follow from
 * this record.
 *
 * A table with inputs of its own, which the air's cache key does not hold,
 * is not a job here: an answer keyed by the haze cannot say which of its
 * inputs it was made for. It is a task of its own in this file, built the
 * way this one is, with its own key and `tableTransfers` for its response.
 */
const AIR_TABLE_JOBS = {
  /** The sky's light on a cloud (`bakeSkyMoments`). */
  sky: bakeSkyMoments,
} satisfies Record<
  string,
  (
    recipe: AtmosphereRecipe,
    transmittance: ScatteringLut,
    multiScatter: ScatteringLut,
  ) => ScatteringLut
>

/** The tables a bake derives from the air's own, by job name. */
export type AirTableSet = {
  readonly [Name in keyof typeof AIR_TABLE_JOBS]: ScatteringLut
}

/** Every derived table for an air, from its recipe and its own two tables. */
export function bakeAirTables(
  recipe: AtmosphereRecipe,
  transmittance: ScatteringLut,
  multiScatter: ScatteringLut,
): AirTableSet {
  return Object.fromEntries(
    Object.entries(AIR_TABLE_JOBS).map(([name, job]) => [
      name,
      job(recipe, transmittance, multiScatter),
    ]),
  ) as AirTableSet
}

/** The buffers of a response's tables, moved rather than copied. */
export function tableTransfers(
  tables: readonly ScatteringLut[],
): ArrayBufferLike[] {
  return tables.map((table) => table.data.buffer)
}

export interface BakeAtmosphereResponse {
  readonly recipe: AtmosphereRecipe
  readonly transmittance: ScatteringLut
  readonly multiScatter: ScatteringLut
  /** What `AIR_TABLE_JOBS` derives from the two. */
  readonly tables: AirTableSet
}

export const bakeAtmosphereTask = defineTask<
  BakeAtmosphereRequest,
  BakeAtmosphereResponse
>({
  name: 'render.bakeAtmosphere',
  // Spend a version whenever the response's shape moves, a job included: a
  // worker on the last version would answer without the table, and the
  // host refuses a mismatch rather than hand that answer back.
  version: 5,
  run({ haze, topRatio, heights }) {
    const recipe = atmosphereRecipe(haze, topRatio, heights)
    const transmittance = bakeTransmittance(recipe)
    const multiScatter = bakeMultipleScattering(recipe, transmittance)
    const tables = bakeAirTables(recipe, transmittance, multiScatter)
    return { recipe, transmittance, multiScatter, tables }
  },
  // 512×64, 32×16 and the sky's 102×16 RGBA32F: 546 KB a bake.
  transfers: (response) =>
    tableTransfers([
      response.transmittance,
      response.multiScatter,
      ...Object.values(response.tables),
    ]),
})
