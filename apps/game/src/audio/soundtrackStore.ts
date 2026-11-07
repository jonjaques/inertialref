import { useSyncExternalStore } from 'react'
import { createStore, type StoreApi } from 'zustand/vanilla'

/*
 * What the soundtrack is doing, as the interface reads it.
 *
 * The engine store's shape (`state/engineStore.ts`) for the same reasons: a
 * vanilla store, React's own `useSyncExternalStore` over it, and components
 * that select the narrowest slice they draw. It holds snapshots the player
 * publishes when something changes — a track starting, a pause, a download's
 * progress — and the playhead at the rate the element reports it, about four
 * times a second, which is the rate a clock reading is worth drawing.
 */

/**
 * The player's state, as one word.
 *
 * - `off`: not wanted here — switched off, or a mode the soundtrack does not
 *   play in.
 * - `waiting`: wanted, and waiting for the first gesture that lets a page make
 *   a sound.
 * - `loading`, `playing`, `paused`: what they say. `paused` is the listener's
 *   own pause, never the game's.
 * - `unavailable`: nothing can play, and `reason` says why.
 */
export type SoundtrackStatus =
  'off' | 'waiting' | 'loading' | 'playing' | 'paused' | 'unavailable'

export interface PlaybackSnapshot {
  readonly status: SoundtrackStatus
  /** The current track, playing or paused, or null before the first. */
  readonly trackId: string | null
  /** Seconds into the current track. */
  readonly position: number
  /** Seconds, of the current track. */
  readonly duration: number
  /** What plays next, in order: the head of the queue. */
  readonly upcoming: readonly string[]
  readonly canPrevious: boolean
  /** Whether two tracks are sounding at once. */
  readonly crossfading: boolean
  /** Whether the game is holding the music down for something of its own. */
  readonly ducked: boolean
  /** Why nothing is playing, as a sentence, when that is the state. */
  readonly reason: string | null
  readonly offline: boolean
}

export interface OfflineSnapshot {
  /** Whether this browser offers Cache Storage at all — a secure context does. */
  readonly supported: boolean
  /** The file names kept on this device. */
  readonly kept: readonly string[]
  /** Downloads in flight: file name to fraction done. */
  readonly downloading: Readonly<Record<string, number>>
  /** Files waiting behind the one downloading, from a keep of many at once. */
  readonly queued: number
  /** What the origin's storage holds and may hold, in bytes, when known. */
  readonly usage: { readonly used: number; readonly quota: number } | null
  /** Whether the browser has promised not to evict this origin's storage. */
  readonly persisted: boolean | null
  /** The last download that failed, as a sentence. */
  readonly failure: string | null
}

/** The credits card: which track it is for, and a count that re-raises it. */
export interface CardSnapshot {
  readonly trackId: string
  /** Incremented every time the card is asked for, so asking twice shows it twice. */
  readonly serial: number
}

export interface SoundtrackState {
  readonly playback: PlaybackSnapshot
  readonly offline: OfflineSnapshot
  readonly card: CardSnapshot | null
}

export const IDLE_PLAYBACK: PlaybackSnapshot = {
  status: 'off',
  trackId: null,
  position: 0,
  duration: 0,
  upcoming: [],
  canPrevious: false,
  crossfading: false,
  ducked: false,
  reason: null,
  offline: false,
}

export const NO_OFFLINE: OfflineSnapshot = {
  supported: false,
  kept: [],
  downloading: {},
  queued: 0,
  usage: null,
  persisted: null,
  failure: null,
}

export type SoundtrackStore = StoreApi<SoundtrackState>

export const createSoundtrackStore = (): SoundtrackStore =>
  createStore<SoundtrackState>(() => ({
    playback: IDLE_PLAYBACK,
    offline: NO_OFFLINE,
    card: null,
  }))

/** The store the app uses, alongside the player singleton. */
export const soundtrackStore = createSoundtrackStore()

/** A slice of the soundtrack's state, re-rendering only when it changes. */
export function useSoundtrack<T>(select: (state: SoundtrackState) => T): T {
  const read = (): T => select(soundtrackStore.getState())
  return useSyncExternalStore(soundtrackStore.subscribe, read, read)
}
