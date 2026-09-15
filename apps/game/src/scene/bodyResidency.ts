import type { WarmTicket } from '../render/warmup.ts'

/*
 * Which body visuals exist, and the two ways one comes to exist.
 *
 * A visual is created when the frame first draws its body, or ahead of need
 * by the build-ahead queue that spends one pipeline generation a frame behind
 * the boot cover and during the flight after a jump. Both paths share a
 * resident map, a cap on it, and boot's ticket in the census — and each of
 * those has a "must not come back" entry: past the cap, new arrivals silently
 * stopped rendering; a task shifted off the queue at the cap was dropped
 * rather than requeued, so every body past it paid its pipeline live on first
 * sight; and a queue that could not drain held the cover up forever. All
 * three lived inside a nine-hundred-line frame callback, reachable from no
 * test. Here they are the whole module, generic over the visual so the policy
 * runs in Node, with the materials, the compile and the retirement handed in.
 *
 * The map deliberately only grows between evictions: a body flickering across
 * the cull threshold must not rebuild its pipelines. Eviction is what makes
 * the cap graceful — at it, a resident this frame did not draw and that is
 * not on screen is retired to make room.
 */

export interface BuildTask {
  /** The key the frame will draw the body under. */
  readonly key: string
}

export interface BodyResidencyOptions<V> {
  /** How many visuals may be resident at once. */
  readonly cap: number
  /** Boot's half of the build-ahead queue, reported rather than driven. */
  readonly ticket: WarmTicket
  /** Whether a visual is drawn; a resident that is not and was not drawn this frame is stale. */
  readonly onScreen: (visual: V) => boolean
  /** Take a visual off screen, for every resident the frame did not draw. */
  readonly hide: (visual: V) => void
  /** Give a visual's resources back. */
  readonly retire: (visual: V) => void
}

export interface BodyResidency<V, T extends BuildTask> {
  readonly size: number
  readonly queued: number
  has(key: string): boolean
  /** Start a frame: nothing has been drawn yet. */
  begin(): void
  /**
   * The visual the frame draws under `key`: the resident one, or a new one
   * when there is room — after evicting a stale resident at the cap. Null
   * when the cap is full of visuals this frame drew, which is the one case
   * nothing can be retired for.
   */
  draw(key: string, create: () => V): V | null
  /** End the frame: hide every resident it did not draw. */
  end(): void
  /** Replace the build-ahead queue and declare its length to the census. */
  plan(tasks: readonly T[]): void
  /**
   * Build one queued visual ahead of need, when there is room. Tasks whose
   * body already has a visual are skipped; at a cap nothing can be evicted
   * from, the task is put back and the ticket is finished so boot does not
   * wait on a queue that cannot drain. Returns what it built, for the caller
   * to compile.
   */
  buildAhead(create: (task: T) => V): V | null
  /** Retire every resident. The queue and the ticket are left for a remount. */
  dispose(): void
}

export function createBodyResidency<V, T extends BuildTask>(
  options: BodyResidencyOptions<V>,
): BodyResidency<V, T> {
  const visuals = new Map<string, V>()
  let seen = new Set<string>()
  let queue: T[] = []

  /**
   * Retire one resident this frame did not draw and that is off screen.
   * Materials only; the caller's geometries are shared tiers.
   */
  const evictStale = (): boolean => {
    for (const [key, visual] of visuals) {
      if (seen.has(key) || options.onScreen(visual)) continue
      options.retire(visual)
      visuals.delete(key)
      return true
    }
    return false
  }

  return {
    get size() {
      return visuals.size
    },
    get queued() {
      return queue.length
    },
    has: (key) => visuals.has(key),

    begin() {
      seen = new Set()
    },

    draw(key, create) {
      seen.add(key)
      const resident = visuals.get(key)
      if (resident !== undefined) return resident
      if (visuals.size >= options.cap && !evictStale()) return null
      const visual = create()
      visuals.set(key, visual)
      return visual
    },

    end() {
      for (const [key, visual] of visuals)
        if (!seen.has(key)) options.hide(visual)
    },

    plan(tasks) {
      queue = [...tasks]
      // Re-declared rather than added to: a mid-session jump replaces the
      // queue, and by then the ticket is the idle one and this is a no-op.
      options.ticket.expect(queue.length)
    },

    buildAhead(create) {
      let task = queue.shift()
      while (task !== undefined && visuals.has(task.key)) task = queue.shift()
      if (task === undefined) {
        // Every body the loaded systems could put on screen has a visual.
        // Boot is waiting on exactly this, so it has to be told.
        options.ticket.finish()
        return null
      }
      if (visuals.size >= options.cap && !evictStale()) {
        // Put back, not dropped: the queue is only rebuilt on a system
        // change, and a dropped task is a body that pays its pipeline live on
        // first sight until the next jump. Finished, because the queue cannot
        // drain while nothing is evictable and boot waits on it draining.
        queue.unshift(task)
        options.ticket.finish()
        return null
      }
      const visual = create(task)
      visuals.set(task.key, visual)
      options.ticket.done()
      if (queue.length === 0) options.ticket.finish()
      return visual
    },

    dispose() {
      for (const visual of visuals.values()) options.retire(visual)
      visuals.clear()
    },
  }
}
