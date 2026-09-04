import { defineTask } from '@inertialref/workers'
import {
  type AtmosphereRecipe,
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeTransmittance,
  type HazeAuthoring,
  type ScatteringLut,
} from '@inertialref/rendering'

/*
 * The atmosphere bake as a pool task.
 *
 * The bake is pure arithmetic in `@inertialref/rendering` — a recipe from the
 * authored haze, then two tables marched from it — and it costs 20 to 40 ms
 * per atmosphere on the main thread, which is the largest single thing left
 * in an arrival: a jump to a generated system lands a 39.7 ms bake inside a
 * 43.3 ms frame the first time one of its hazes is seen. Nothing in it needs
 * the main thread; it reads only what the request carries and is the same
 * function wherever it runs. So it runs on the pool, the way
 * `universe.surfaceDetailFloor` does for the same reason.
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
 * `atmosphereLuts.ts`, which is the shape `surfaceDetailFloor`'s consumer has.
 * Nothing here may import `three/webgpu` — this file is part of the worker
 * bundle.
 */

export interface BakeAtmosphereRequest {
  readonly haze: HazeAuthoring
  readonly topRatio: number
}

export interface BakeAtmosphereResponse {
  readonly recipe: AtmosphereRecipe
  readonly transmittance: ScatteringLut
  readonly multiScatter: ScatteringLut
}

export const bakeAtmosphereTask = defineTask<
  BakeAtmosphereRequest,
  BakeAtmosphereResponse
>({
  name: 'render.bakeAtmosphere',
  version: 1,
  run({ haze, topRatio }) {
    const recipe = atmosphereRecipe(haze, topRatio)
    const transmittance = bakeTransmittance(recipe)
    const multiScatter = bakeMultipleScattering(recipe, transmittance)
    return { recipe, transmittance, multiScatter }
  },
  // 512×64 and 32×32 RGBA32F: 528 KB a bake, moved rather than copied.
  transfers: (response) => [
    response.transmittance.data.buffer,
    response.multiScatter.data.buffer,
  ],
})
