/** Browser-only ownership; the controller receives input without knowing the DOM. */
export interface PointerLockDocument extends EventTarget {
  readonly pointerLockElement: object | null
  readonly hidden: boolean
  exitPointerLock(): void
}

export interface PointerLockTarget {
  requestPointerLock?: () => Promise<void> | void
}

export interface PointerLockCallbacks {
  /** Called only after an explicit request succeeds. False declines gameplay. */
  readonly enter: () => boolean
  readonly changed: (locked: boolean) => void
  readonly error: (message: string | null) => void
  readonly look: (dx: number, dy: number) => void
}

/** Keeps request failure, browser Escape, focus loss, and cleanup on one path. */
export class PointerLock {
  readonly #callbacks: PointerLockCallbacks
  #document: PointerLockDocument | null = null
  #target: PointerLockTarget | null = null
  #requested = false
  #locked = false
  #generation = 0

  constructor(callbacks: PointerLockCallbacks) {
    this.#callbacks = callbacks
  }

  get locked(): boolean {
    return this.#locked
  }

  request(): void {
    const target = this.#target
    if (this.#locked || this.#requested) return
    if (target?.requestPointerLock === undefined) {
      this.#callbacks.error(
        'Pointer lock is unavailable in this browser. Free look remains available.',
      )
      return
    }
    this.#callbacks.error(null)
    this.#requested = true
    const generation = ++this.#generation
    try {
      const request = target.requestPointerLock()
      // Older browsers grant through the change event and return no promise.
      if (request !== undefined)
        void request.catch(() => this.#failed(generation))
    } catch {
      this.#failed(generation)
    }
  }

  #failed(generation: number): void {
    if (generation !== this.#generation) return
    this.release()
    this.#callbacks.error(
      'Pointer lock was not granted. Activate Lock to walk again when ready.',
    )
  }

  release(): void {
    ++this.#generation
    this.#requested = false
    this.#locked = false
    this.#callbacks.changed(false)
    if (this.#document?.pointerLockElement === this.#target)
      this.#document?.exitPointerLock()
  }

  attach(
    document: PointerLockDocument,
    target: PointerLockTarget,
    window: EventTarget,
  ): () => void {
    this.#document = document
    this.#target = target
    const change = (): void => {
      if (document.pointerLockElement !== target) {
        this.#requested = false
        this.#locked = false
        this.#callbacks.changed(false)
        return
      }
      if (this.#locked) return
      // A delayed browser grant after a route change must not restart input.
      if (!this.#requested) {
        this.release()
        return
      }
      this.#requested = false
      let entered = false
      try {
        entered = this.#callbacks.enter()
      } catch {
        this.#callbacks.error(
          'Unable to enter character controls at this location.',
        )
      }
      if (!entered) {
        this.release()
        return
      }
      this.#locked = true
      this.#callbacks.changed(true)
    }
    const error = (): void => {
      if (this.#requested) this.#failed(this.#generation)
    }
    const move = (event: Event): void => {
      if (!this.#locked || document.pointerLockElement !== target) return
      const mouse = event as MouseEvent
      if (
        Number.isFinite(mouse.movementX) &&
        Number.isFinite(mouse.movementY)
      ) {
        this.#callbacks.look(mouse.movementX, mouse.movementY)
      }
    }
    const blur = (): void => this.release()
    const visibility = (): void => {
      if (document.hidden) this.release()
    }
    document.addEventListener('pointerlockchange', change)
    document.addEventListener('pointerlockerror', error)
    document.addEventListener('mousemove', move)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('blur', blur)
    return () => {
      this.release()
      document.removeEventListener('pointerlockchange', change)
      document.removeEventListener('pointerlockerror', error)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('blur', blur)
      this.#document = null
      this.#target = null
    }
  }
}
