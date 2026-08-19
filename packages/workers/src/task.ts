import { invariant } from '@inertialref/shared'

/*
 * Task contracts.
 *
 * A task is a named, versioned, pure-ish function with a declared payload and
 * result. Both sides of the worker boundary import the same definition, so the
 * request shape cannot drift from the handler shape, and the whole thing runs
 * unchanged on the main thread — which is how these are unit-tested without a
 * worker at all.
 */

export interface TaskContext {
  /** Long tasks should poll this and bail out early. */
  readonly cancelled: () => boolean
}

export interface TaskDefinition<Request, Response> {
  readonly name: string
  /** Bumped when the payload or result shape changes, checked at dispatch. */
  readonly version: number
  run(payload: Request, context: TaskContext): Response | Promise<Response>
  /**
   * Buffers to transfer rather than copy. A 65×65 heightfield is 17 KB; a
   * planet's worth of them is not something to structured-clone twice.
   */
  transfers?(response: Response): readonly ArrayBufferLike[]
}

export function defineTask<Request, Response>(
  definition: TaskDefinition<Request, Response>,
): TaskDefinition<Request, Response> {
  invariant(definition.name.length > 0, 'A task needs a name')
  invariant(Number.isInteger(definition.version) && definition.version > 0, 'A task needs a version')
  return definition
}

export class TaskRegistry {
  readonly #tasks = new Map<string, TaskDefinition<never, unknown>>()

  register<Request, Response>(task: TaskDefinition<Request, Response>): void {
    invariant(!this.#tasks.has(task.name), `Task ${task.name} is already registered`)
    this.#tasks.set(task.name, task as unknown as TaskDefinition<never, unknown>)
  }

  get(name: string): TaskDefinition<never, unknown> | undefined {
    return this.#tasks.get(name)
  }

  names(): readonly string[] {
    return [...this.#tasks.keys()].sort()
  }
}

export const NEVER_CANCELLED: TaskContext = { cancelled: () => false }

/** Run a task in the calling thread. Tests, Node, and the no-worker fallback. */
export async function runInline<Request, Response>(
  task: TaskDefinition<Request, Response>,
  payload: Request,
  context: TaskContext = NEVER_CANCELLED,
): Promise<Response> {
  return await task.run(payload, context)
}
