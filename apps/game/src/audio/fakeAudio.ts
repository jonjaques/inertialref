/*
 * A media element and an audio graph that do what the player asks and say
 * what a browser would say back — for `soundtrack.test.ts`, which runs in
 * plain Node like every other test here.
 *
 * Only what the player touches is modeled. An element loads when told to and
 * reports `loadedmetadata`, then `canplay`, a microtask later, or `error` for
 * a URL the test has marked broken; it plays and pauses on request; and the
 * test moves its clock with `advance`, which reports `timeupdate` the way a
 * real one does about four times a second. A gain records the automation it
 * is given and takes the end value of a curve at once, which is the value a
 * test asks about.
 */

type Listener = () => void

export class FakeParam {
  value: number
  readonly calls: string[] = []
  constructor(value: number) {
    this.value = value
  }
  setTargetAtTime(target: number): void {
    this.calls.push(`target ${target.toFixed(3)}`)
    this.value = target
  }
  cancelScheduledValues(): void {
    this.calls.push('cancel')
  }
  cancelAndHoldAtTime(): void {
    this.calls.push('hold')
  }
  setValueAtTime(value: number): void {
    this.calls.push(`set ${value.toFixed(3)}`)
    this.value = value
  }
  setValueCurveAtTime(curve: Float32Array, _at: number, seconds: number): void {
    this.calls.push(`curve → ${curve.at(-1)?.toFixed(3)} over ${seconds}`)
    this.value = curve.at(-1) ?? this.value
  }
}

export class FakeNode {
  readonly gain = new FakeParam(1)
  channelCount = 2
  channelCountMode = 'max'
  channelInterpretation = 'speakers'
  readonly outputs: FakeNode[] = []
  connect(node: FakeNode): FakeNode {
    this.outputs.push(node)
    return node
  }
  disconnect(): void {
    this.outputs.length = 0
  }
}

export class FakeContext {
  currentTime = 0
  state: AudioContextState = 'suspended'
  readonly destination = new FakeNode()
  readonly gains: FakeNode[] = []
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
  createGain(): FakeNode {
    const node = new FakeNode()
    this.gains.push(node)
    return node
  }
  createMediaElementSource(): FakeNode {
    return new FakeNode()
  }
}

/** URLs a test has marked as failing to load, and how. */
export const broken = new Map<string, number>()

/** Whether `play()` is refused for want of a gesture. */
export const policy = { refuse: false }

export class FakeElement {
  #src = ''
  currentTime = 0
  duration = Number.NaN
  paused = true
  readyState = 0
  preload = ''
  controls = false
  error: { code: number; message: string } | null = null
  readonly #listeners = new Map<string, Set<Listener>>()

  get src(): string {
    return this.#src
  }
  set src(value: string) {
    this.#src = value
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.#listeners.get(type) ?? new Set()
    set.add(listener)
    this.#listeners.set(type, set)
  }
  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener)
  }
  emit(type: string): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener()
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.#src = ''
  }

  load(): void {
    const src = this.#src
    this.readyState = 0
    this.error = null
    this.currentTime = 0
    if (src === '') return
    queueMicrotask(() => {
      if (this.#src !== src) return
      const code = broken.get(src)
      if (code !== undefined) {
        this.error = { code, message: 'the file could not be played' }
        this.emit('error')
        return
      }
      this.duration = 300
      this.readyState = 1
      this.emit('loadedmetadata')
      // The real order after a seek: `seeked`, then enough data to play.
      queueMicrotask(() => {
        if (this.#src !== src) return
        this.readyState = 4
        this.emit('seeked')
        this.emit('canplay')
      })
    })
  }

  play(): Promise<void> {
    if (policy.refuse) {
      const refusal = new Error('play() needs a gesture')
      refusal.name = 'NotAllowedError'
      return Promise.reject(refusal)
    }
    this.paused = false
    this.emit('play')
    return Promise.resolve()
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.emit('pause')
  }

  /** Move the clock by `seconds`, reporting it as a real element would. */
  advance(seconds: number): void {
    if (this.paused) return
    this.currentTime += seconds
    this.emit('timeupdate')
  }
}

/** Let every pending microtask and the timers that are due run. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}
