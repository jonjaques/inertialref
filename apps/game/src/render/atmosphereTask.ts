import { defineTask } from '@inertialref/workers'
import {
  type AirHeights,
  type AtmosphereRecipe,
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeSkyMoments,
  bakeTransmittance,
  type HazeAuthoring,
  type IceTable,
  iceAggregate,
  type MieTable,
  mieDroplets,
  phaseAtlas,
  type ScatteringLut,
  toHalves,
} from '@inertialref/rendering'

/*
 * The atmosphere bake as a pool task.
 *
 * The bake is pure arithmetic in `@inertialref/rendering` — a recipe from the
 * authored haze, then two tables marched from it and the sky table summed
 * from those two where the page has clouds to read it — and it is the
 * largest single thing left in an arrival: a jump to a generated system
 * landed a 39.7 ms bake inside a 43.3 ms frame the first time one of its
 * hazes was seen, before the sky table, which costs about 1.2 times the
 * other two together. Nothing in it needs
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
  /**
   * The derived tables the caller will read (`AIR_TABLE_JOBS`). A page
   * without clouds reads none of them, so it asks for none and the bake is
   * the two tables it always was.
   */
  readonly wanted: readonly AirTableName[]
}

/*
 * The tables a bake derives from the air's own two, as named jobs. Each is a
 * function of the recipe and the two tables and nothing else, so it runs
 * wherever they are made, on the pool and on the main thread alike
 * (`bakeAirTables`), and lands in the response under its name when the
 * request names it in `wanted`. A job of this kind is one entry here and
 * one member where `atmosphereLuts.ts` uploads it: the response's type, its
 * transfers and both bakes follow from this record.
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

/** A derived table's name. */
export type AirTableName = keyof typeof AIR_TABLE_JOBS

/** The derived tables a bake made, by job name: those it was asked for. */
export type AirTableSet = {
  readonly [Name in AirTableName]?: ScatteringLut
}

/**
 * The derived tables `wanted` names, for an air, from its recipe and its
 * own two tables. A job not named is not run and allocates nothing.
 */
export function bakeAirTables(
  recipe: AtmosphereRecipe,
  transmittance: ScatteringLut,
  multiScatter: ScatteringLut,
  wanted: readonly AirTableName[],
): AirTableSet {
  return Object.fromEntries(
    wanted.map((name) => [
      name,
      AIR_TABLE_JOBS[name](recipe, transmittance, multiScatter),
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
  /** What `AIR_TABLE_JOBS` derives from the two, for the names `wanted` gave. */
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
  run({ haze, topRatio, heights, wanted }) {
    const recipe = atmosphereRecipe(haze, topRatio, heights)
    const transmittance = bakeTransmittance(recipe)
    const multiScatter = bakeMultipleScattering(recipe, transmittance)
    const tables = bakeAirTables(recipe, transmittance, multiScatter, wanted)
    return { recipe, transmittance, multiScatter, tables }
  },
  // 512×64 and 32×16 RGBA32F, 520 KB, and the sky's 102×16, 26 KB, when it
  // was asked for.
  transfers: (response) =>
    tableTransfers([
      response.transmittance,
      response.multiScatter,
      ...Object.values(response.tables).filter((table) => table !== undefined),
    ]),
})

/* ------------------------------------------------------------------------- */
/* The phase atlas under a sun's disk                                         */
/* ------------------------------------------------------------------------- */

/*
 * The clouds' phase atlas convolved with the served sun's disk, as a pool
 * task of its own (phase 1 design §4.7). Its one input is the sun's angular
 * radius, which no haze's key holds, so it is not a job of the bake above.
 * The convolution is 11 to 20 ms warm and about 40 ms cold on this Mac
 * mini's main thread (Mac18,5, Apple M6), on a frame that is already an
 * event's; the rubric holds an event's frame inside one 60 Hz frame.
 *
 * The request carries the radius alone: the tables it convolves are the
 * committed droplet and ice tables, decoded here on the first ask and kept,
 * so nothing crosses the boundary but a number one way and the atlas's
 * texels the other, already half floats (`toHalves`), 512 KB moved. Unlike
 * the bake's tables, whose conversion stays on the main thread, the atlas
 * converts here: 262,144 values are 1.2 to 2.3 ms of the main thread's on
 * this machine under load, four times the upload, so `CloudPhase` copies
 * the halves and uploads them. That is why the response is not a
 * `ScatteringLut` and its one buffer is moved by hand where
 * `tableTransfers` would take a table of floats.
 */

export interface ConvolvePhaseRequest {
  /** Radians: the served sun's angular radius. */
  readonly angularRadius: number
}

export interface ConvolvePhaseResponse {
  /** The radius asked for, so the consumer can tell an answer it still wants from a stale one. */
  readonly angularRadius: number
  /** The atlas's texels as RGBA16F, [row][angle][rgba] (`phaseAtlas`, `toHalves`). */
  readonly halves: Uint16Array
}

/** The committed tables, decoded on the first ask a worker serves. */
let committed: readonly [MieTable, IceTable] | null = null

export const convolvePhaseTask = defineTask<
  ConvolvePhaseRequest,
  ConvolvePhaseResponse
>({
  name: 'render.convolvePhase',
  version: 1,
  run({ angularRadius }) {
    committed ??= [mieDroplets(), iceAggregate()]
    const { texels } = phaseAtlas(...committed, angularRadius)
    return { angularRadius, halves: toHalves(texels) }
  },
  transfers: (response) => [response.halves.buffer],
})
