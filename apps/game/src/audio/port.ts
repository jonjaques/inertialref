import type {
  SoundtrackHostPort,
  SoundtrackStatus,
  SoundtrackVerb,
} from '@inertialref/devtools'
import {
  SOUNDTRACK_CATEGORIES,
  type SoundtrackCategory,
} from '@inertialref/protocol'
import { trackById } from './catalog.ts'
import type { Soundtrack } from './soundtrack.ts'
import type { SoundtrackStore } from './soundtrackStore.ts'

/*
 * The soundtrack as the harness sees it: `ir.soundtrackStatus()` and
 * `ir.soundtrack(verb)`.
 *
 * The driver rig has no ears, so this is how a run proves the player does what
 * the panel claims — a track id that changes after `next`, a position that
 * advances, a state that reads `waiting` until a gesture and `playing` after.
 * Plain data out, because the harness returns JSON across CDP.
 */

const isCategory = (value: string): value is SoundtrackCategory =>
  (SOUNDTRACK_CATEGORIES as readonly string[]).includes(value)

export function soundtrackPort(
  player: Soundtrack,
  store: SoundtrackStore,
): SoundtrackHostPort {
  const status = (): SoundtrackStatus => {
    const { playback, offline } = store.getState()
    const track = trackById(playback.trackId)
    return {
      available: true,
      state: playback.status,
      track:
        track === null
          ? null
          : {
              id: track.id,
              title: track.title,
              artist: track.artist,
              category: track.category,
            },
      position: playback.position,
      duration: playback.duration,
      upcoming: playback.upcoming,
      crossfading: playback.crossfading,
      ducked: playback.ducked,
      context: player.contextState(),
      kept: offline.kept.length,
      reason: playback.reason,
    }
  }
  const command = (
    verb: SoundtrackVerb,
    argument?: string | number,
  ): SoundtrackStatus => {
    switch (verb) {
      case 'play':
        player.play()
        break
      case 'pause':
        player.pause()
        break
      case 'next':
        player.next()
        break
      case 'previous':
        player.previous()
        break
      case 'seek':
        if (typeof argument === 'number') player.seek(argument)
        break
      case 'select':
        if (typeof argument === 'string') player.select(argument)
        break
      case 'cue':
        if (typeof argument === 'string') {
          player.cue(
            isCategory(argument) ? { category: argument } : { id: argument },
          )
        }
        break
      case 'card':
        player.showCard()
        break
    }
    return status()
  }
  return { status, command }
}
