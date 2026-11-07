import { MUSIC_RESUME, read, write } from '../state/preferences.ts'
import { SOUNDTRACK } from './catalog.ts'
import type { SoundtrackFile, SoundtrackTrack } from '@inertialref/protocol'
import { browserCanPlay, type CanPlay, playableFile } from './files.ts'
import { OfflineLibrary } from './offline.ts'
import type { Random } from './playlist.ts'
import { Soundtrack, type SoundtrackHost } from './soundtrack.ts'
import { soundtrackStore } from './soundtrackStore.ts'

/*
 * The one player and the one offline library, for the life of the page.
 *
 * A module singleton beside the store, for the reason the engine is one in
 * `App.tsx`: the music has to outlive every route and every remount, and the
 * two `<audio>` elements it owns can each be routed into the graph exactly
 * once. Built on first use, so a page that never plays music never makes an
 * `AudioContext`.
 */

export const offlineLibrary = new OfflineLibrary(soundtrackStore)

/**
 * Uniform draws from the operating system's generator.
 *
 * The shuffle is presentation and nothing canonical reads it, so the
 * determinism rule does not apply — but `Math.random` is the spelling that
 * rule greps for, and a shuffle that is not seeded on purpose should say so.
 */
const random: Random = () => {
  const draw = new Uint32Array(1)
  crypto.getRandomValues(draw)
  return draw[0]! / 2 ** 32
}

let probe: CanPlay | null = null

/** The browser's codec answers, asked of one detached element for the page. */
const canPlay: CanPlay = (type) => (probe ??= browserCanPlay())(type)

/**
 * The encoding this browser plays for a track: the file the player streams,
 * and so the one a keep downloads. Keeping the other would be keeping a file
 * that is never read.
 */
export const fileFor = (
  track: Pick<SoundtrackTrack, 'files'>,
): SoundtrackFile | null => playableFile(track, canPlay)

function browserHost(): SoundtrackHost {
  return {
    // `playback` asks for a larger output buffer than the interactive
    // default: a soundtrack has no latency to keep down, and a bigger buffer
    // is fewer glitches on a busy main thread.
    createContext: () => new AudioContext({ latencyHint: 'playback' }),
    createElement: () => new Audio(),
    canPlay,
    random,
    online: () => navigator.onLine,
    kept: (name) => offlineLibrary.isKept(name),
    readResume: () => read(MUSIC_RESUME),
    writeResume: (point) => write(MUSIC_RESUME, point),
  }
}

let instance: Soundtrack | null = null

export function soundtrackPlayer(): Soundtrack {
  instance ??= new Soundtrack(SOUNDTRACK, soundtrackStore, browserHost())
  return instance
}
