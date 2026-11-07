import type { SoundtrackTrack } from '@inertialref/protocol'
import { scheduleFade } from './crossfade.ts'

/*
 * One voice: an `<audio>` element, routed through the graph by a gain of its
 * own. Two of them make a crossfade.
 *
 * **An element, not a decoded buffer.** A buffer is sample-accurate and has to
 * be decoded whole before it plays: an eighteen-minute track is 400 MB of
 * float PCM in memory. An element streams, seeks by byte range, and is what
 * the operating system's media controls attach to. Its start is a few
 * milliseconds loose, which a multi-second crossfade does not hear.
 *
 * **Same origin, or silence.** `createMediaElementSource` outputs zeros for a
 * cross-origin element served without CORS headers — no error, just a
 * soundtrack that plays as nothing. The files are under `/media/` on the
 * page's own origin, so the element needs no `crossOrigin` and must not be
 * pointed anywhere else.
 *
 * **An element can be routed once.** `createMediaElementSource` throws the
 * second time it is asked about the same element, so a deck keeps its element
 * for the life of the page and changes what it points at.
 */

/** Why a load failed, in the terms the player recovers by. */
export type LoadFailure = 'network' | 'decode' | 'unsupported' | 'timeout'

export class LoadError extends Error {
  readonly reason: LoadFailure
  constructor(reason: LoadFailure, detail: string) {
    super(detail)
    this.reason = reason
  }
}

/** How long a load may take before the track is treated as unreachable. */
const LOAD_TIMEOUT_MS = 20_000

/** `MediaError.code` in the player's terms. */
function failureOf(element: HTMLMediaElement): LoadFailure {
  switch (element.error?.code) {
    case 3: // MEDIA_ERR_DECODE
      return 'decode'
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED — also what a 404 or an HTML body reads as
      return 'unsupported'
    default:
      return 'network'
  }
}

export class Deck {
  readonly element: HTMLAudioElement
  readonly gain: GainNode
  readonly #context: AudioContext
  #track: SoundtrackTrack | null = null
  /** Incremented by every load and release; a stale load's events are ignored. */
  #generation = 0
  #ready = false

  constructor(
    context: AudioContext,
    output: AudioNode,
    element: HTMLAudioElement,
  ) {
    this.#context = context
    this.element = element
    element.preload = 'auto'
    // A media element's own controls are not this game's: the transport is
    // the panel, the keys and the operating system's session.
    element.controls = false
    this.gain = context.createGain()
    this.gain.gain.value = 0
    context.createMediaElementSource(element).connect(this.gain)
    this.gain.connect(output)
  }

  get track(): SoundtrackTrack | null {
    return this.#track
  }

  get position(): number {
    return this.element.currentTime
  }

  /** Whether the current track has loaded far enough to play. */
  get ready(): boolean {
    return this.#ready
  }

  get playing(): boolean {
    return !this.element.paused
  }

  /**
   * Point the element at `url`, positioned at `at` seconds, and resolve when
   * it can play from there.
   *
   * Resolves `false` when a newer load or a release superseded this one —
   * which is the ordinary result of a second skip during the first one's
   * load, not a failure. Rejects with a `LoadError` saying why otherwise.
   */
  load(track: SoundtrackTrack, url: string, at: number): Promise<boolean> {
    const generation = ++this.#generation
    this.#ready = false
    const element = this.element
    this.#track = track
    element.pause()
    return new Promise<boolean>((resolve, reject) => {
      let settled = false
      const cleanups: (() => void)[] = []
      const finish = (outcome: () => void): void => {
        if (settled) return
        settled = true
        for (const cleanup of cleanups) cleanup()
        outcome()
      }
      const listen = (type: string, handler: () => void): void => {
        element.addEventListener(type, handler)
        cleanups.push(() => element.removeEventListener(type, handler))
      }
      const stale = (): boolean => {
        if (generation === this.#generation) return false
        finish(() => resolve(false))
        return true
      }
      const ready = (): void => {
        if (stale()) return
        // HAVE_FUTURE_DATA: enough to play forward from here.
        if (element.readyState < 3) return
        this.#ready = true
        finish(() => resolve(true))
      }
      const timer = setTimeout(() => {
        if (stale()) return
        finish(() =>
          reject(new LoadError('timeout', `${track.id} did not load in time`)),
        )
      }, LOAD_TIMEOUT_MS)
      cleanups.push(() => clearTimeout(timer))
      listen('error', () => {
        if (stale()) return
        finish(() =>
          reject(
            new LoadError(
              failureOf(element),
              `${track.id}: ${element.error?.message || 'the file could not be played'}`,
            ),
          ),
        )
      })
      listen('loadedmetadata', () => {
        if (stale()) return
        if (at > 0.01) element.currentTime = at
        else ready()
      })
      listen('seeked', ready)
      listen('canplay', ready)
      element.src = url
      element.load()
    })
  }

  /** Start from where it was loaded or paused. The promise is `play()`'s. */
  start(): Promise<void> {
    return this.element.play()
  }

  /** Fade the deck's own gain to `to` over `seconds` from now. */
  fade(to: number, seconds: number): void {
    scheduleFade(this.gain.gain, to, seconds, this.#context.currentTime)
  }

  pause(): void {
    this.element.pause()
  }

  /**
   * Let go of the file: pause, drop the source, and `load()` the empty
   * element so the browser closes the connection it was buffering on —
   * otherwise a skipped eighteen-minute track keeps downloading behind the
   * one that replaced it.
   */
  release(): void {
    this.#generation += 1
    this.#ready = false
    this.#track = null
    this.element.pause()
    this.element.removeAttribute('src')
    this.element.load()
    this.gain.gain.cancelScheduledValues(this.#context.currentTime)
    this.gain.gain.value = 0
  }
}
