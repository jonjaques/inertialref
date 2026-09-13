/** A lazy runtime survives dock moves and StrictMode, and ends with its mode. */
export class GuideLifetime<T extends { end(): void }> {
  #claims = 0
  #generation = 0
  #pending: Promise<T> | null = null
  #runtime: T | null = null
  readonly #create: () => Promise<T>
  constructor(create: () => Promise<T>) {
    this.#create = create
  }

  acquire(): () => void {
    this.#claims++
    let released = false
    return () => {
      if (released) return
      released = true
      this.#claims--
      // StrictMode renews the claim in the same turn. A routed dialog never
      // releases it; only the mode's actual exit reaches this teardown.
      queueMicrotask(() => {
        if (this.#claims !== 0) return
        this.#generation++
        this.#runtime?.end()
        this.#runtime = null
        this.#pending = null
      })
    }
  }

  load(): Promise<T> {
    if (this.#pending !== null) return this.#pending
    const generation = this.#generation
    this.#pending = this.#create().then((runtime) => {
      if (generation !== this.#generation || this.#claims === 0) runtime.end()
      else this.#runtime = runtime
      return runtime
    })
    return this.#pending
  }
}
