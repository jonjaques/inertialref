import { createTaskRegistry, type TaskRegistry } from '@inertialref/workers'
import { bakeAtmosphereTask } from '../render/atmosphereTask.ts'

/**
 * What this client's workers serve: the shared registry, plus the tasks only
 * a browser client has.
 *
 * `createTaskRegistry` in `packages/workers` is what every host serves — the
 * game, the headless runner, the tests — and it stays exactly that. A task
 * the headless runner would never ask for, and that the layer graph could not
 * place in `packages/workers` anyway, is registered here by the one entry
 * point that will be asked for it. The worker (`universe.worker.ts`) and the
 * test engine (`engine/headlessEngine.ts`) both build from this, so the pool a
 * test drives serves the same names the browser's does. ADR-0028.
 */
export function createGameTaskRegistry(): TaskRegistry {
  const registry = createTaskRegistry()
  registry.register(bakeAtmosphereTask)
  return registry
}
