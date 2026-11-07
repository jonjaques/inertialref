import { byline, trackById } from './catalog.ts'
import type { Soundtrack } from './soundtrack.ts'
import type { SoundtrackStore } from './soundtrackStore.ts'

/*
 * The operating system's media controls: the keyboard's play and skip keys,
 * the lock screen, the headset's button, the browser's own media hub.
 *
 * The Media Session API is how a page says what it is playing and what each
 * of those controls should do. The keys reach the page through it rather than
 * as key events — a hardware Play key goes to the media session the operating
 * system thinks is active, not to the focused document — so without this the
 * player has no answer to the one key built for it.
 *
 * **The artwork is the game's own.** An album cover carries a license of its
 * own that nobody checked, and every track here was cleared as audio, not as
 * a picture. The app's icon is the project's, and it is what the lock screen
 * shows for every track.
 *
 * Position is told on the events that change it — a track starting, a pause,
 * a seek — and the platform extrapolates in between, which is what the
 * specification asks for; telling it four times a second is work the
 * platform then has to reconcile.
 */

const ARTWORK: MediaImage[] = [
  { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
]

/** How far the seek-backward and seek-forward controls move. */
const SEEK_STEP = 10

export function bindMediaSession(
  player: Soundtrack,
  store: SoundtrackStore,
): () => void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return () => {}
  }
  const session = navigator.mediaSession
  const handle = (
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null,
  ): void => {
    try {
      session.setActionHandler(action, handler)
    } catch {
      // An action this browser does not offer; the rest still work.
    }
  }
  handle('play', () => player.play())
  handle('pause', () => player.pause())
  handle('stop', () => player.pause())
  handle('nexttrack', () => player.next())
  handle('previoustrack', () => player.previous())
  handle('seekto', (details) => {
    if (details.seekTime !== undefined) player.seek(details.seekTime)
  })
  handle('seekbackward', (details) =>
    player.seek(
      store.getState().playback.position - (details.seekOffset ?? SEEK_STEP),
    ),
  )
  handle('seekforward', (details) =>
    player.seek(
      store.getState().playback.position + (details.seekOffset ?? SEEK_STEP),
    ),
  )

  let shownTrack: string | null = null
  let shownStatus = ''
  const unsubscribe = store.subscribe((state) => {
    const { trackId, status, position, duration } = state.playback
    const track = trackById(trackId)
    if (trackId !== shownTrack) {
      shownTrack = trackId
      session.metadata =
        track === null
          ? null
          : new MediaMetadata({
              title: track.title,
              artist: byline(track),
              album: track.release,
              artwork: ARTWORK,
            })
    }
    const playing = status === 'playing'
    const next = status === 'off' ? 'none' : playing ? 'playing' : 'paused'
    if (`${next}:${trackId}` !== shownStatus) {
      shownStatus = `${next}:${trackId}`
      session.playbackState = next
      if (track !== null && duration > 0 && 'setPositionState' in session) {
        try {
          session.setPositionState({
            duration,
            position: Math.min(position, duration),
            playbackRate: 1,
          })
        } catch {
          // A position past the duration, mid-transition: the next event
          // tells it again.
        }
      }
    }
  })

  return () => {
    unsubscribe()
    for (const action of [
      'play',
      'pause',
      'stop',
      'nexttrack',
      'previoustrack',
      'seekto',
      'seekbackward',
      'seekforward',
    ] as const) {
      handle(action, null)
    }
    session.metadata = null
    session.playbackState = 'none'
  }
}
