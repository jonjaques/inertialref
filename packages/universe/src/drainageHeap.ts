/*
 * A binary heap of (level, node), lowest first, ties by node index.
 *
 * The tie-break is the determinism: two nodes at one level are popped in
 * index order whatever order they were pushed in, so the receiver a flat
 * hands its neighbors is a property of the lattice and not of the walk.
 */
export class Heap {
  readonly #level: Float64Array
  readonly #node: Int32Array
  #size = 0

  constructor(capacity: number) {
    this.#level = new Float64Array(capacity)
    this.#node = new Int32Array(capacity)
  }

  get size(): number {
    return this.#size
  }

  #less(a: number, b: number): boolean {
    const la = this.#level[a] as number
    const lb = this.#level[b] as number
    if (la !== lb) return la < lb
    return (this.#node[a] as number) < (this.#node[b] as number)
  }

  #swap(a: number, b: number): void {
    const level = this.#level[a] as number
    const node = this.#node[a] as number
    this.#level[a] = this.#level[b] as number
    this.#node[a] = this.#node[b] as number
    this.#level[b] = level
    this.#node[b] = node
  }

  push(level: number, node: number): void {
    let at = this.#size
    this.#size += 1
    this.#level[at] = level
    this.#node[at] = node
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (!this.#less(at, parent)) break
      this.#swap(at, parent)
      at = parent
    }
  }

  /** Removes the top and returns its node; the level is read by `topLevel` first. */
  topLevel(): number {
    return this.#level[0] as number
  }

  pop(): number {
    const node = this.#node[0] as number
    this.#size -= 1
    if (this.#size > 0) {
      this.#level[0] = this.#level[this.#size] as number
      this.#node[0] = this.#node[this.#size] as number
      let at = 0
      for (;;) {
        const left = at * 2 + 1
        const right = left + 1
        let best = at
        if (left < this.#size && this.#less(left, best)) best = left
        if (right < this.#size && this.#less(right, best)) best = right
        if (best === at) break
        this.#swap(at, best)
        at = best
      }
    }
    return node
  }
}
