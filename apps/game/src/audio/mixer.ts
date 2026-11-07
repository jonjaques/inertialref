import { scheduleFade } from './crossfade.ts'
import { gainOf } from './levels.ts'

/*
 * The game's one audio graph.
 *
 *     deck ─┐
 *     deck ─┴─ music ── duck ─┐
 *              ambience ──────┼── master ── destination
 *              interface ─────┘
 *
 * **Buses, and two of them empty.** The soundtrack is the only thing that
 * plays today, through `music`. `ambience` and `interface` exist so that the
 * atmospheric bed and the annunciator `docs/design/audio.md` describes arrive
 * as a connection to a bus that is already there, under the master level a
 * player has already set, rather than as a second graph.
 *
 * **Ducking is its own gain, not the music level.** The level is the player's
 * and is a preference; a duck is the game making room for something — the
 * guide's voice — and must come back to exactly where the player left it,
 * which a write to their level could not.
 *
 * **Mono is the master's channel count.** A gain node told to produce one
 * channel, with `speakers` interpretation, mixes stereo down as
 * `0.5 · (L + R)`, and the destination spreads that one channel back over
 * both speakers. One switch for everything the graph will ever carry, which
 * is what somebody listening on one earbud needs it to be.
 *
 * **Levels move on a 30 ms time constant.** A gain written directly jumps
 * between two samples, and a slider dragged across its travel writes forty
 * of those a second: a zipper of clicks, loudest on the bass.
 */

const SMOOTHING = 0.03

export class Mixer {
  readonly context: AudioContext
  /** Where a deck connects. */
  readonly music: GainNode
  readonly ambience: GainNode
  readonly interface: GainNode
  readonly #duck: GainNode
  readonly #master: GainNode

  constructor(context: AudioContext) {
    this.context = context
    this.music = context.createGain()
    this.ambience = context.createGain()
    this.interface = context.createGain()
    this.#duck = context.createGain()
    this.#master = context.createGain()
    this.music.connect(this.#duck)
    this.#duck.connect(this.#master)
    this.ambience.connect(this.#master)
    this.interface.connect(this.#master)
    this.#master.connect(context.destination)
  }

  /** The player's two levels, as slider positions. */
  setLevels(master: number, music: number): void {
    const now = this.context.currentTime
    this.#master.gain.setTargetAtTime(gainOf(master), now, SMOOTHING)
    this.music.gain.setTargetAtTime(gainOf(music), now, SMOOTHING)
  }

  setMono(mono: boolean): void {
    this.#master.channelCount = mono ? 1 : 2
    this.#master.channelCountMode = 'explicit'
    this.#master.channelInterpretation = 'speakers'
  }

  /** Move the duck to `level` (1 is no duck) over `seconds`. */
  duck(level: number, seconds: number): void {
    scheduleFade(this.#duck.gain, level, seconds, this.context.currentTime)
  }
}
