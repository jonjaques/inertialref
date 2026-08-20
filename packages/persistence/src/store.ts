import { err, ok, type Result } from '@inertialref/shared'

/*
 * Where saves live.
 *
 * A port, not an implementation. The browser's IndexedDB adapter needs DOM
 * types and therefore lives in the app; Node tests and the headless runner use
 * the in-memory store below. Anything that persists a save talks to this
 * interface, so "offline-first" is a property of the app's wiring rather than
 * an assumption baked into the save code.
 */

export interface SaveStore {
  read(slot: string): Promise<Result<string, string>>
  write(slot: string, contents: string): Promise<Result<void, string>>
  list(): Promise<readonly string[]>
  remove(slot: string): Promise<void>
}

export class MemorySaveStore implements SaveStore {
  readonly #slots = new Map<string, string>()

  async read(slot: string): Promise<Result<string, string>> {
    const contents = this.#slots.get(slot)
    return contents === undefined
      ? err(`No save in slot "${slot}"`)
      : ok(contents)
  }

  async write(slot: string, contents: string): Promise<Result<void, string>> {
    this.#slots.set(slot, contents)
    return ok(undefined)
  }

  async list(): Promise<readonly string[]> {
    return [...this.#slots.keys()].sort()
  }

  async remove(slot: string): Promise<void> {
    this.#slots.delete(slot)
  }
}

export const DEFAULT_SLOT = 'autosave'
