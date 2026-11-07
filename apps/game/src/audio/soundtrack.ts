import type {
  SoundtrackCatalog,
  SoundtrackCategory,
  SoundtrackTrack,
} from '@inertialref/protocol'
import { getLogger } from '@inertialref/shared'
import { transitionSeconds } from './crossfade.ts'
import { Deck, LoadError } from './deck.ts'
import { type CanPlay, fileUrl, playableFile } from './files.ts'
import { Mixer } from './mixer.ts'
import {
  currentOf,
  EMPTY_QUEUE,
  jumpQueue,
  nextQueue,
  playable,
  type PlaylistSettings,
  previousQueue,
  type Queue,
  type Random,
  reconcileQueue,
  startQueue,
} from './playlist.ts'
import { silence } from './silence.ts'
import type { PlaybackSnapshot, SoundtrackStore } from './soundtrackStore.ts'

/*
 * The soundtrack player: one queue, two decks, one graph, and the rules for
 * when it sounds.
 *
 * **Whether it sounds is three questions, kept apart.** Whether the game
 * wants music here (`presence`: the mode, a cutscene with a track of its own,
 * a hidden tab), whether the listener has paused it (`held`), and whether the
 * browser has let the page make a sound yet (`unlocked`). Each is changed by
 * a different thing, and folding any two together loses an answer: a pause
 * that survived a cutscene ending, or a cutscene that cleared a pause the
 * listener meant.
 *
 * **Every transition is a crossfade, including the short ones.** The next
 * track is loaded on the idle deck twenty seconds before the outgoing one's
 * music ends — `cues.end`, the last moment above the silence floor, not the
 * end of the file — so it is buffered when the fade begins. A skip fades too,
 * over a second and a bit, because a hard cut on a pad at full level is a
 * click. Only a fade of zero, which the listener can ask for, cuts.
 *
 * **A track that will not play is passed over, not fatal.** Offline with
 * nothing kept, a deployment whose bucket lacks the files, a codec the browser
 * refuses: each marks the track failed for this session and the player moves
 * to the next candidate. When there are none left the state says why, and a
 * return of the network or a press of Play clears the slate and tries again.
 *
 * Nothing here reads a preference or a route. `SoundtrackRuntime.tsx` hands
 * it the settings (through `settings.ts`), the presence and the voice, so this
 * file is the whole of the behavior and `soundtrack.test.ts` drives it with
 * fake elements and a fake graph.
 */

const log = getLogger('game.soundtrack')

/** Everything the player is told about the listener's choices. */
export interface SoundtrackSettings extends PlaylistSettings {
  /** The soundtrack's own switch. */
  readonly enabled: boolean
  /** The longest a transition between tracks may take, in seconds. */
  readonly crossfade: number
  /** Slider positions, 0 to 1. */
  readonly master: number
  readonly music: number
  readonly mono: boolean
}

/** What the game says about whether music belongs here and now. */
export interface Presence {
  /** The mode on screen plays the soundtrack. */
  readonly here: boolean
  /** A scene with a track of its own is playing. */
  readonly scene: boolean
  /** The tab is hidden and the listener did not ask for background play. */
  readonly away: boolean
}

/** The browser, as the player needs it. A test supplies fakes. */
export interface SoundtrackHost {
  createContext(): AudioContext
  createElement(): HTMLAudioElement
  canPlay: CanPlay
  random: Random
  online(): boolean
  /** Whether a file is kept on this device; offline, only those can play. */
  kept(name: string): boolean
  /** Where a reload resumes. */
  readResume(): { readonly id: string; readonly at: number } | null
  writeResume(point: { readonly id: string; readonly at: number }): void
}

/** How a transition is asked to place the incoming track. */
export interface Cue {
  readonly id?: string
  readonly category?: SoundtrackCategory
  /** Seconds into the track, or its first audible moment when absent. */
  readonly at?: number
  /** Seconds of fade, or the listener's crossfade when absent. */
  readonly fade?: number
}

/** How long a skip's crossfade may take. */
const SKIP_FADE = 1.2
/**
 * How far the music steps down under a voice, as a gain: −12 dB. Far enough
 * that words never compete with a melody, near enough that the room does not
 * go dead between one sentence and the next. Down quickly, so the first word
 * is clear; back slowly, so the end of a conversation is not a swell.
 */
const VOICE_DUCK = 0.25
const VOICE_DOWN = 0.4
const VOICE_UP = 1.5
/** The fade on a pause, and on the game taking the music away. */
const PAUSE_FADE = 0.3
const AWAY_FADE = 1.2
/**
 * How long after the audio unlocks a toggle is not taken as a pause, in ms.
 *
 * The gesture that unlocks is very often the Play button or the play key
 * itself, and it arrives twice: the unlock starts the music as the pointer
 * or the key goes down, and the click or the key's action then reaches
 * `toggle`, which finds the music started and would stop it again. Half a
 * second covers a click held down; a deliberate pause that soon after a
 * deliberate play is not something a listener does. An explicit `pause()` —
 * the operating system's control, the harness — is never held back.
 */
const UNLOCK_GRACE = 500
/** The fade a first track and a resume come up on. */
const ENTRY_FADE = 2
/** How far ahead of its transition the next track is loaded. */
const PRELOAD_LEAD = 20
/** Previous restarts the current track if more than this has played. */
const RESTART_AFTER = 3

export const DEFAULT_SETTINGS: SoundtrackSettings = {
  enabled: true,
  order: [],
  disabled: [],
  mutedCategories: [],
  shuffle: true,
  repeat: 'all',
  crossfade: 6,
  master: 0.8,
  music: 0.7,
  mono: false,
}

interface Preload {
  readonly id: string
  readonly deck: Deck
  readonly ready: Promise<boolean>
  /**
   * The queue the preload was drawn from, and the queue it leads to. At the
   * end of a shuffled cycle the next queue is a fresh random draw, and a
   * second draw at the transition would almost never name the track this one
   * buffered.
   */
  readonly from: Queue
  readonly next: Queue
}

export class Soundtrack {
  readonly #catalog: SoundtrackCatalog
  readonly #byId: ReadonlyMap<string, SoundtrackTrack>
  readonly #store: SoundtrackStore
  readonly #host: SoundtrackHost
  #settings: SoundtrackSettings = DEFAULT_SETTINGS
  #presence: Presence = { here: false, scene: false, away: false }
  /** A voice the visitor is listening to is live (`voice.ts`). */
  #voice = false
  #held = false
  #unlocked = false
  #mixer: Mixer | null = null
  #decks: readonly [Deck, Deck] | null = null
  #active: 0 | 1 = 0
  #queue: Queue = EMPTY_QUEUE
  #ids: readonly string[] = []
  #failed = new Set<string>()
  #preload: Preload | null = null
  /** Incremented by everything that changes what should be playing. */
  #generation = 0
  /** Whether two tracks are sounding at once, for the interface to say so. */
  #crossfading = false
  /**
   * The track whose ending has already started the next one.
   *
   * Its own field rather than a reading of `#crossfading`: when the ending
   * finds nothing to follow it — repeat off, last track — no crossfade
   * begins, and a flag shared with the crossfade would stay set, so the track
   * would play out with its `ended` believing a fade was already handling it.
   * Cleared by a seek, which can put the ending ahead of the playhead again,
   * and by the swap to the next deck — repeat-one and a one-track playlist
   * play the same track object again, and a stale mark would hold it at its
   * end.
   */
  #ended: SoundtrackTrack | null = null
  /** The generation of the `#change` whose incoming load is in flight. */
  #changing: number | null = null
  /**
   * The active deck is fading out on its way to a pause. It is still playing,
   * so a return before the pause lands has to fade it back up itself: the
   * resume path starts only a deck that is paused.
   */
  #quieting = false
  /**
   * The deck and track the card was last raised for. A resume after a pause,
   * a scene or a hidden tab is not a track beginning.
   */
  #announced: { readonly deck: Deck; readonly track: SoundtrackTrack } | null =
    null
  /** Inside `UNLOCK_GRACE` of the unlock: a toggle does not pause. */
  #settling = false
  #settleTimer: ReturnType<typeof setTimeout> | undefined
  #quietTimer: ReturnType<typeof setTimeout> | undefined
  #releaseTimer: ReturnType<typeof setTimeout> | undefined
  #reason: string | null = null

  constructor(
    catalog: SoundtrackCatalog,
    store: SoundtrackStore,
    host: SoundtrackHost,
  ) {
    this.#catalog = catalog
    this.#byId = new Map(catalog.tracks.map((track) => [track.id, track]))
    this.#store = store
    this.#host = host
  }

  get catalog(): SoundtrackCatalog {
    return this.#catalog
  }

  track(id: string | null): SoundtrackTrack | null {
    return id === null ? null : (this.#byId.get(id) ?? null)
  }

  /* --------------------------------------------------------------------- */
  /* What it is told                                                        */
  /* --------------------------------------------------------------------- */

  configure(settings: SoundtrackSettings): void {
    const before = this.#settings
    this.#settings = settings
    this.#mixer?.setLevels(settings.master, settings.music)
    this.#mixer?.setMono(settings.mono)
    const ids = playable(this.#catalog.tracks, settings)
    if (
      ids.join() !== this.#ids.join() ||
      settings.shuffle !== before.shuffle
    ) {
      const previous = this.#ids
      this.#ids = ids
      if (this.#queue !== EMPTY_QUEUE) {
        this.#queue = reconcileQueue(
          this.#queue,
          this.#candidates(),
          previous,
          { shuffle: settings.shuffle, wasShuffled: before.shuffle },
          this.#host.random,
        )
      }
      this.#dropPreload()
    }
    this.#reconcile()
  }

  /**
   * Duck under a voice, or come back up from one.
   *
   * A duck rather than a pause, unlike a scene: a cutscene brings a track of
   * its own, and two pieces of music at once is a clash, but a guide speaking
   * over music held well down is a radio program — and stopping the music
   * for every exchange would make a tour lurch between silence and sound.
   */
  setVoice(live: boolean): void {
    if (live === this.#voice) return
    this.#voice = live
    this.#mixer?.duck(live ? VOICE_DUCK : 1, live ? VOICE_DOWN : VOICE_UP)
    this.#publish()
  }

  setPresence(presence: Presence): void {
    const was = this.#presence
    this.#presence = presence
    if (
      was.here !== presence.here ||
      was.scene !== presence.scene ||
      was.away !== presence.away
    )
      this.#reconcile()
  }

  /**
   * Inside a user gesture: build the graph if it is not built, resume the
   * context, and let both decks play.
   *
   * Synchronous by contract — `audio/activation.ts` calls it from inside the
   * gesture's own task, and an `await` before `resume()` would lose the
   * activation on Safari, which is the whole reason it is called from there.
   */
  unlock(): void {
    // Every later gesture lands here too; once the context is running there
    // is nothing left to unlock.
    if (this.#unlocked && this.#mixer?.context.state === 'running') return
    const graph = this.#graph()
    void graph.context.resume().catch(() => {})
    // iOS mutes Web Audio under the ring/silent switch unless the page says
    // its sound is playback, the category a music app's sound has.
    const session = (navigator as { audioSession?: { type: string } })
      .audioSession
    if (session !== undefined) session.type = 'playback'
    const [, idle] = this.#decksInPlay()
    // The deck that holds nothing yet plays a moment of silence, so it may
    // play the second track of a crossfade later without a gesture of its own.
    if (idle.track === null) {
      idle.element.src = silence()
      void idle
        .start()
        .then(() => idle.pause())
        .catch(() => {})
    }
    this.#unlocked = true
    this.#settling = true
    clearTimeout(this.#settleTimer)
    this.#settleTimer = setTimeout(() => {
      this.#settling = false
    }, UNLOCK_GRACE)
    this.#reconcile()
  }

  /* --------------------------------------------------------------------- */
  /* Transport                                                              */
  /* --------------------------------------------------------------------- */

  play(): void {
    this.#held = false
    // A press of Play is somebody asking again: forget what failed.
    if (this.#store.getState().playback.status === 'unavailable')
      this.#failed.clear()
    this.#reconcile()
  }

  pause(): void {
    this.#held = true
    this.#reconcile()
  }

  /**
   * Pause what is playing or loading; play anything else.
   *
   * Keyed to the published status, which is what the panel's button draws,
   * rather than to whether an element is sounding: a track still loading has
   * no sounding element, and a Pause pressed then would otherwise be a Play.
   */
  toggle(): void {
    const status = this.#store.getState().playback.status
    if (status === 'playing' || status === 'loading') {
      // The unlocking press itself, arriving after its unlock started the
      // music (`UNLOCK_GRACE`): it was a Play, and it has been answered.
      if (this.#settling) return
      this.pause()
    } else this.play()
  }

  next(): void {
    this.#advance('skip')
  }

  previous(): void {
    const deck = this.#activeDeck()
    const track = deck?.track ?? null
    if (
      deck !== null &&
      track !== null &&
      deck.position > track.cues.start + RESTART_AFTER
    ) {
      this.seek(track.cues.start)
      return
    }
    const back = previousQueue(this.#queue)
    if (back === null) {
      if (track !== null) this.seek(track.cues.start)
      return
    }
    this.#queue = back
    this.#change(this.track(currentOf(back)), 'skip')
  }

  /** Play `id` now, crossfading from whatever is playing. */
  select(id: string): void {
    const track = this.track(id)
    if (track === null) return
    this.#held = false
    this.#queue = jumpQueue(
      this.#queue,
      this.#candidates(),
      this.#settings.shuffle,
      id,
    )
    this.#change(track, 'skip')
  }

  seek(seconds: number): void {
    const deck = this.#activeDeck()
    if (deck === null || deck.track === null) return
    const end = Math.max(0, deck.track.duration - 0.25)
    deck.element.currentTime = Math.min(end, Math.max(0, seconds))
    this.#ended = null
    this.#publish()
  }

  /**
   * A transition the game asks for: to a track, or to the next track of a
   * category, placed and faded as asked.
   *
   * What an arrival in a new system will call. Nothing calls it yet but the
   * harness; it is here so that rigging the soundtrack to the world is a
   * caller, not a change to the player.
   */
  cue(cue: Cue): void {
    const id =
      cue.id ??
      (cue.category === undefined
        ? undefined
        : (this.#queue.upcoming.find(
            (one) => this.track(one)?.category === cue.category,
          ) ??
          this.#candidates().find(
            (one) => this.track(one)?.category === cue.category,
          )))
    const track = id === undefined ? null : this.track(id)
    if (track === null) return
    this.#held = false
    this.#queue = jumpQueue(
      this.#queue,
      this.#candidates(),
      this.#settings.shuffle,
      track.id,
    )
    this.#change(track, 'cue', cue)
  }

  /** Raise the credits card for what is playing. */
  showCard(): void {
    const id = this.#activeDeck()?.track?.id ?? null
    if (id === null) return
    this.#store.setState((held) => ({
      card: { trackId: id, serial: (held.card?.serial ?? 0) + 1 },
    }))
  }

  /** Remember where to resume, for a reload. */
  persist(): void {
    const deck = this.#activeDeck()
    const track = deck?.track ?? null
    if (deck !== null && track !== null) {
      this.#host.writeResume({ id: track.id, at: deck.position })
    }
  }

  /** The network came back: what failed for want of it may play now. */
  online(): void {
    this.#failed.clear()
    this.#reconcile()
  }

  /* --------------------------------------------------------------------- */
  /* Policy                                                                 */
  /* --------------------------------------------------------------------- */

  #wanted(): boolean {
    const presence = this.#presence
    return (
      this.#settings.enabled &&
      presence.here &&
      !presence.scene &&
      !presence.away
    )
  }

  /** Bring what is playing into line with what should be. */
  #reconcile(): void {
    const wanted = this.#wanted()
    if (!wanted || this.#held) {
      this.#quiet(wanted ? PAUSE_FADE : AWAY_FADE)
      this.#publish()
      return
    }
    clearTimeout(this.#quietTimer)
    if (this.#quieting) {
      // Wanted again inside the fade-out — a pause undone at once, a scene or
      // a hidden tab that lasted under a second. The deck never paused, so the
      // resume below would not start it, and it would play on at silence.
      this.#quieting = false
      const deck = this.#activeDeck()
      if (deck !== null && deck.playing) deck.fade(1, ENTRY_FADE)
    }
    if (!this.#unlocked) {
      // Load the first track now, so the first gesture starts it at once.
      this.#ensureLoaded()
      this.#publish()
      return
    }
    const deck = this.#activeDeck()
    if (deck === null || deck.track === null) {
      this.#ensureLoaded()
    } else if (deck.ready && !deck.playing) {
      // A deck still loading is started by its load, not from here.
      void this.#sound(deck, ENTRY_FADE)
    }
    this.#publish()
  }

  /** Fade the playing deck out and pause it, keeping its place. */
  #quiet(seconds: number): void {
    const deck = this.#activeDeck()
    if (deck === null || !deck.playing) return
    deck.fade(0, seconds)
    this.#quieting = true
    clearTimeout(this.#quietTimer)
    this.#quietTimer = setTimeout(() => {
      if (this.#wanted() && !this.#held) return
      this.#quieting = false
      deck.pause()
      this.persist()
      this.#publish()
    }, seconds * 1000)
  }

  /* --------------------------------------------------------------------- */
  /* Loading and transitions                                                */
  /* --------------------------------------------------------------------- */

  /** The ids that may play now: playable, not failed, reachable. */
  #candidates(): readonly string[] {
    const offline = !this.#host.online()
    return this.#ids.filter((id) => {
      if (this.#failed.has(id)) return false
      const track = this.#byId.get(id)
      if (track === undefined) return false
      const file = playableFile(track, this.#host.canPlay)
      if (file === null) return false
      return !offline || this.#host.kept(file.name)
    })
  }

  /** Load the queue's current track on the active deck if nothing is there. */
  #ensureLoaded(): void {
    const deck = this.#activeDeck()
    if (deck?.track !== null && deck !== null) return
    if (this.#queue === EMPTY_QUEUE || currentOf(this.#queue) === null) {
      const candidates = this.#candidates()
      if (candidates.length === 0) {
        this.#unavailable()
        return
      }
      const resume = this.#host.readResume()
      this.#queue = startQueue(
        candidates,
        this.#settings.shuffle,
        this.#host.random,
        resume?.id ?? null,
      )
    }
    const track = this.track(currentOf(this.#queue))
    if (track === null) return
    const resume = this.#host.readResume()
    const at =
      resume?.id === track.id && resume.at < track.cues.end - 10
        ? resume.at
        : track.cues.start
    void this.#load(this.#decksInPlay()[0], track, at, 'start')
  }

  /**
   * Load `track` on `deck` and, if it should be sounding, start it.
   *
   * `start` is the first track and a resume: it comes up on the entry fade.
   * `transition` is the incoming half of a crossfade, started by `#change`.
   */
  async #load(
    deck: Deck,
    track: SoundtrackTrack,
    at: number,
    kind: 'start' | 'preload',
  ): Promise<boolean> {
    const file = playableFile(track, this.#host.canPlay)
    if (file === null) {
      this.#fail(track, 'unsupported')
      return false
    }
    const generation = this.#generation
    // A start is a track beginning, even on a deck that played it before.
    if (this.#announced?.deck === deck) this.#announced = null
    this.#publish({ status: kind === 'start' ? 'loading' : undefined })
    try {
      const ready = await deck.load(track, fileUrl(file), at)
      if (!ready || generation !== this.#generation) return false
    } catch (cause) {
      if (generation !== this.#generation) return false
      this.#fail(track, cause instanceof LoadError ? cause.reason : 'network')
      if (kind === 'start') {
        deck.release()
        this.#queue = EMPTY_QUEUE
        this.#ensureLoaded()
      }
      return false
    }
    if (kind === 'start' && this.#wanted() && !this.#held && this.#unlocked) {
      await this.#sound(deck, ENTRY_FADE)
    }
    this.#publish()
    return true
  }

  /** Start `deck` on a fade from silence. */
  async #sound(deck: Deck, fade: number): Promise<void> {
    try {
      await deck.start()
    } catch (cause) {
      // Refused for want of a gesture: wait for one. Anything else is the
      // file, and `error` on the element will say so.
      if ((cause as { name?: string }).name === 'NotAllowedError') {
        this.#unlocked = false
      }
      this.#publish()
      return
    }
    deck.fade(1, fade)
    // The first sound of this track on this deck, or a resume of it.
    if (this.#announced?.deck !== deck || this.#announced.track !== deck.track)
      this.#announce(deck)
    this.#publish()
  }

  /**
   * Move to the next track: the natural end of one, or a skip.
   *
   * The next track is the one the preload already holds when the two agree,
   * which they do unless the playlist changed in the last twenty seconds.
   */
  #advance(reason: 'ended' | 'skip'): void {
    // Nothing left that can play is not the end of the playlist: say why.
    if (this.#candidates().length === 0) {
      this.#unavailable()
      return
    }
    // An ending follows the preload's own draw while the queue it was drawn
    // from still stands; a skip, or a queue changed since, draws again.
    const preload = this.#preload
    const next =
      reason === 'ended' && preload !== null && preload.from === this.#queue
        ? preload.next
        : nextQueue(
            this.#queue,
            this.#candidates(),
            this.#settings,
            this.#host.random,
            reason,
          )
    if (next === null) {
      // The playlist ran out with repeat off: hold, and say so.
      this.#held = true
      this.#reason = 'the playlist has ended'
      this.#quiet(AWAY_FADE)
      this.#publish()
      return
    }
    if (next.played.length === 0) return
    this.#queue = next
    this.#change(this.track(currentOf(next)), reason)
  }

  /** Crossfade from the active deck to `track` on the other one. */
  #change(
    track: SoundtrackTrack | null,
    reason: 'ended' | 'skip' | 'cue',
    cue: Cue = {},
  ): void {
    if (track === null) return
    const generation = ++this.#generation
    const [outgoing, incoming] = this.#decksInPlay()
    // A release still pending from the last crossfade is for `incoming`, the
    // deck this change is about to load: firing mid-load, it would drop the
    // change — a second Next inside the first one's fade.
    if (this.#releaseTimer !== undefined) {
      clearTimeout(this.#releaseTimer)
      this.#releaseTimer = undefined
      this.#crossfading = false
    }
    const at = cue.at ?? track.cues.start
    const preloaded =
      this.#preload !== null &&
      this.#preload.id === track.id &&
      this.#preload.deck === incoming &&
      cue.at === undefined
        ? this.#preload.ready
        : null
    this.#preload = null
    // Until the swap, `incoming` is still the idle deck, and the outgoing
    // deck's `timeupdate` would otherwise preload the track after this one
    // onto it, superseding this load.
    this.#changing = generation
    void (async () => {
      try {
        const ready =
          preloaded !== null
            ? await preloaded
            : await this.#loadIncoming(incoming, track, at)
        if (generation !== this.#generation) return
        if (!ready) {
          // A preload that failed marked the track failed in its own catch,
          // but passing over it is this transition's to do, as
          // `#loadIncoming` does for a load of its own.
          if (preloaded !== null && this.#failed.has(track.id))
            this.#advance('skip')
          return
        }
        if (!this.#wanted() || this.#held || !this.#unlocked) {
          // Staged, not sounding: the swap happens and the next Play starts it.
          outgoing.release()
          this.#swap()
          this.#publish()
          return
        }
        const left =
          outgoing.track === null
            ? 0
            : outgoing.track.cues.end - outgoing.position
        const fade =
          reason === 'cue' && cue.fade !== undefined
            ? cue.fade
            : transitionSeconds(
                this.#settings.crossfade,
                Math.max(0, left),
                track.cues.end - track.cues.start,
                reason === 'ended' ? null : SKIP_FADE,
              )
        try {
          await incoming.start()
        } catch {
          this.#publish()
          return
        }
        if (generation !== this.#generation) return
        this.#swap()
        // Sounding now, so a fade-out still running toward a pause is over.
        this.#quieting = false
        clearTimeout(this.#quietTimer)
        incoming.fade(1, fade)
        outgoing.fade(0, fade)
        this.#crossfading = fade > 0
        this.#releaseTimer = setTimeout(
          () => {
            this.#releaseTimer = undefined
            if (this.#activeDeck() !== outgoing) outgoing.release()
            this.#crossfading = false
            this.#publish()
          },
          fade * 1000 + 100,
        )
        this.#announce(incoming)
        this.#publish()
      } finally {
        if (this.#changing === generation) this.#changing = null
      }
    })()
  }

  /** Make the other deck the active one. Its ending has not begun. */
  #swap(): void {
    this.#active = this.#active === 0 ? 1 : 0
    this.#ended = null
  }

  async #loadIncoming(
    deck: Deck,
    track: SoundtrackTrack,
    at: number,
  ): Promise<boolean> {
    const file = playableFile(track, this.#host.canPlay)
    if (file === null) {
      this.#fail(track, 'unsupported')
      this.#advance('skip')
      return false
    }
    try {
      return await deck.load(track, fileUrl(file), at)
    } catch (cause) {
      this.#fail(track, cause instanceof LoadError ? cause.reason : 'network')
      // Pass over it to the one after.
      this.#advance('skip')
      return false
    }
  }

  /** Load the next track on the idle deck, ahead of its transition. */
  #preloadNext(): void {
    // A change in flight is loading the idle deck already.
    if (this.#preload !== null || this.#changing !== null) return
    const from = this.#queue
    const next = nextQueue(
      from,
      this.#candidates(),
      this.#settings,
      this.#host.random,
      'ended',
    )
    if (next === null) return
    const id = currentOf(next)
    const track = this.track(id)
    if (track === null || id === currentOf(from)) return
    const [, idle] = this.#decksInPlay()
    const file = playableFile(track, this.#host.canPlay)
    if (file === null) return
    const ready: Promise<boolean> = idle
      .load(track, fileUrl(file), track.cues.start)
      .catch(() => {
        this.#fail(track, 'network')
        // Only this preload's own slot: a later one may hold it by now.
        if (this.#preload?.ready === ready) this.#preload = null
        return false
      })
    this.#preload = { id: track.id, deck: idle, ready, from, next }
  }

  #dropPreload(): void {
    if (this.#preload === null) return
    const { deck } = this.#preload
    this.#preload = null
    if (deck !== this.#activeDeck()) deck.release()
  }

  #fail(track: SoundtrackTrack, reason: string): void {
    log.warn('a soundtrack file would not play; passing over it', {
      track: track.id,
      reason,
    })
    this.#failed.add(track.id)
    this.#reason = !this.#host.online()
      ? 'offline, and no kept track can play'
      : reason === 'unsupported'
        ? 'the soundtrack is not served here'
        : 'the soundtrack could not be reached'
    if (this.#candidates().length === 0) this.#unavailable()
  }

  #unavailable(): void {
    if (this.#ids.length === 0) this.#reason = 'every track is switched off'
    else if (this.#reason === null) {
      this.#reason = this.#host.online()
        ? 'no track can play in this browser'
        : 'offline, and no track is kept on this device'
    }
    this.#publish({ status: 'unavailable' })
  }

  /* --------------------------------------------------------------------- */
  /* The graph                                                              */
  /* --------------------------------------------------------------------- */

  #graph(): Mixer {
    if (this.#mixer !== null) return this.#mixer
    const mixer = new Mixer(this.#host.createContext())
    mixer.setLevels(this.#settings.master, this.#settings.music)
    mixer.setMono(this.#settings.mono)
    // A voice that went live before the first gesture built the graph.
    if (this.#voice) mixer.duck(VOICE_DUCK, 0)
    this.#mixer = mixer
    return mixer
  }

  /** The two decks, active first, built on first use. */
  #decksInPlay(): readonly [Deck, Deck] {
    if (this.#decks === null) {
      const mixer = this.#graph()
      const decks = [
        new Deck(mixer.context, mixer.music, this.#host.createElement()),
        new Deck(mixer.context, mixer.music, this.#host.createElement()),
      ] as const
      for (const deck of decks) this.#watch(deck)
      this.#decks = decks
    }
    const decks = this.#decks
    return this.#active === 0 ? [decks[0], decks[1]] : [decks[1], decks[0]]
  }

  #activeDeck(): Deck | null {
    return this.#decks === null ? null : this.#decks[this.#active]
  }

  /** What a deck's element reports, and what the player does about it. */
  #watch(deck: Deck): void {
    const element = deck.element
    element.addEventListener('timeupdate', () => {
      if (deck !== this.#activeDeck() || deck.track === null) return
      const end = Math.min(deck.track.cues.end, deck.track.duration)
      const fade = this.#settings.crossfade
      if (deck.position >= end - fade - PRELOAD_LEAD) this.#preloadNext()
      if (
        fade > 0 &&
        deck.position >= end - fade &&
        this.#ended !== deck.track
      ) {
        this.#ended = deck.track
        this.#advance('ended')
      }
      this.#publish()
    })
    element.addEventListener('ended', () => {
      if (deck !== this.#activeDeck() || deck.track === null) return
      if (this.#ended === deck.track) return
      this.#ended = deck.track
      this.#advance('ended')
    })
    element.addEventListener('error', () => {
      // An error during a load is the load's to report; this is one during
      // playback — a connection dropped mid-track.
      if (deck !== this.#activeDeck() || deck.track === null || !deck.ready)
        return
      const track = deck.track
      this.#fail(track, 'network')
      this.#advance('skip')
    })
    element.addEventListener('play', () => this.#publish())
    element.addEventListener('pause', () => this.#publish())
    element.addEventListener('waiting', () =>
      this.#publish({ status: 'loading' }),
    )
  }

  /**
   * A track has started: the card, and the place a reload resumes — the
   * deck's own position, which is the track's start unless this is a reload
   * resuming partway through.
   */
  #announce(deck: Deck): void {
    const track = deck.track
    if (track === null) return
    this.#announced = { deck, track }
    this.#reason = null
    this.#host.writeResume({ id: track.id, at: deck.position })
    this.#store.setState((held) => ({
      card: { trackId: track.id, serial: (held.card?.serial ?? 0) + 1 },
    }))
  }

  /* --------------------------------------------------------------------- */
  /* What it says                                                           */
  /* --------------------------------------------------------------------- */

  #publish(override: Partial<PlaybackSnapshot> = {}): void {
    const deck = this.#activeDeck()
    const track = deck?.track ?? null
    const wanted = this.#wanted()
    const status =
      override.status ??
      (!wanted
        ? 'off'
        : this.#store.getState().playback.status === 'unavailable' &&
            track === null
          ? 'unavailable'
          : !this.#unlocked
            ? 'waiting'
            : this.#held
              ? 'paused'
              : deck !== null && deck.playing
                ? 'playing'
                : 'loading')
    const playback: PlaybackSnapshot = {
      status,
      trackId: track?.id ?? currentOf(this.#queue),
      position: deck?.position ?? 0,
      duration: track?.duration ?? 0,
      upcoming: this.#queue.upcoming.slice(0, 8),
      canPrevious: this.#queue.played.length > 1 || (deck?.position ?? 0) > 3,
      crossfading: this.#crossfading,
      ducked: this.#presence.scene || this.#voice,
      reason: status === 'unavailable' || this.#held ? this.#reason : null,
      offline: !this.#host.online(),
    }
    this.#store.setState({ playback })
  }

  /** For the harness: the snapshot, as the store holds it. */
  snapshot(): PlaybackSnapshot {
    return this.#store.getState().playback
  }

  /** Whether the context exists and what it says of itself. */
  contextState(): AudioContextState | 'none' {
    return this.#mixer?.context.state ?? 'none'
  }
}
