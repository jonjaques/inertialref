import { useEffect, useState } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useActions } from '../input/useKeymap.ts'
import type { AppMode } from '../pages/paths.ts'
import { useEngine } from '../state/engineStore.ts'
import {
  MUSIC_BACKGROUND,
  MUSIC_ENABLED,
  usePersistentState,
} from '../state/preferences.ts'
import { onActivation } from './activation.ts'
import { bindMediaSession } from './mediaSession.ts'
import { NowPlayingCard } from './NowPlayingCard.tsx'
import { offlineLibrary, soundtrackPlayer } from './player.ts'
import { soundtrackPort } from './port.ts'
import { bindSettings } from './settings.ts'
import { soundtrackStore } from './soundtrackStore.ts'
import { onVoice, voiceLive } from './voice.ts'

/*
 * The soundtrack, joined to the app.
 *
 * Mounted once in `App`, beside the canvas, for the life of the session: the
 * player is a module singleton and outlives every route, and this is where
 * the app tells it what it needs to know — the listener's settings, whether
 * the mode on screen plays music, whether a cutscene with a track of its own
 * is running, whether the tab is hidden, whether the guide is talking — and
 * where the keys, the operating
 * system's media controls, the network and the harness reach it.
 *
 * **Where it plays is one set.** The Planetarium, for now; flight keeps the
 * silence `docs/design/audio.md` designs it around, and the cinema plays its
 * own scenes' tracks. Adding a mode is adding it here.
 *
 * Nothing it does touches canonical state: the player reads the engine's
 * published snapshot and writes only to its own store.
 */

const PLAYS_IN: ReadonlySet<AppMode> = new Set<AppMode>(['planetarium'])

const MUSIC_ACTIONS = [
  'music.toggle',
  'music.next',
  'music.previous',
  'music.card',
] as const

const hiddenNow = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden'

export function SoundtrackRuntime({
  engine,
  mode,
}: {
  engine: GameEngine
  mode: AppMode
}) {
  const [player] = useState(soundtrackPlayer)
  const scene = useEngine((snapshot) => snapshot.cinema)
  const [background] = usePersistentState(MUSIC_BACKGROUND)
  const [enabled] = usePersistentState(MUSIC_ENABLED)
  const [hidden, setHidden] = useState(hiddenNow)
  const here = PLAYS_IN.has(mode)

  useEffect(
    () => bindSettings((settings) => player.configure(settings)),
    [player],
  )
  useEffect(() => bindMediaSession(player, soundtrackStore), [player])
  useEffect(() => {
    player.setVoice(voiceLive())
    return onVoice((live) => player.setVoice(live))
  }, [player])
  useEffect(() => {
    engine.soundtrack = soundtrackPort(player, soundtrackStore)
    return () => {
      engine.soundtrack = null
    }
  }, [engine, player])

  useEffect(() => {
    void offlineLibrary.refresh()
    const visibility = (): void => setHidden(hiddenNow())
    const network = (): void => {
      player.online()
      void offlineLibrary.refresh()
    }
    const leaving = (): void => player.persist()
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('online', network)
    window.addEventListener('offline', network)
    window.addEventListener('pagehide', leaving)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('online', network)
      window.removeEventListener('offline', network)
      window.removeEventListener('pagehide', leaving)
    }
  }, [player])

  useEffect(() => {
    player.setPresence({ here, scene, away: hidden && !background })
  }, [player, here, scene, hidden, background])

  /*
   * The first gesture that may make a sound, wherever it lands — the click on
   * the Planetarium's door, the first drag across the sky. Only while music
   * is wanted here, so a page that never plays it never builds a graph.
   */
  useEffect(() => {
    if (!here || !enabled) return
    return onActivation(() => player.unlock())
  }, [player, here, enabled])

  useActions(
    MUSIC_ACTIONS,
    (id) => {
      if (id === 'music.toggle') player.toggle()
      else if (id === 'music.next') player.next()
      else if (id === 'music.previous') player.previous()
      else player.showCard()
    },
    here,
  )

  return <NowPlayingCard visible={here && !scene} />
}
