import {
  AUDIO_MASTER,
  AUDIO_MONO,
  AUDIO_MUSIC,
  MUSIC_CROSSFADE,
  MUSIC_DISABLED,
  MUSIC_ENABLED,
  MUSIC_MUTED_CATEGORIES,
  MUSIC_ORDER,
  MUSIC_REPEAT,
  MUSIC_SHUFFLE,
  type Preference,
  read,
  subscribe,
} from '../state/preferences.ts'
import type { SoundtrackSettings } from './soundtrack.ts'

/*
 * The listener's choices, carried from the preferences to the player.
 *
 * `state/engineKnobs.ts`'s shape for the soundtrack: one subscription per key,
 * each writing its own field, so a slider dragged across the music level
 * moves the level and nothing else is re-derived. The values come from the
 * subscription rather than from storage, because storage can lag what the
 * hooks hold — a browser with site data blocked refuses every write and still
 * announces the value — and the player should hear what the panel shows.
 */

/** Every setting, read once. */
export function readSettings(): SoundtrackSettings {
  return {
    enabled: read(MUSIC_ENABLED),
    order: read(MUSIC_ORDER),
    disabled: read(MUSIC_DISABLED),
    mutedCategories: read(MUSIC_MUTED_CATEGORIES),
    shuffle: read(MUSIC_SHUFFLE),
    repeat: read(MUSIC_REPEAT),
    crossfade: read(MUSIC_CROSSFADE),
    master: read(AUDIO_MASTER),
    music: read(AUDIO_MUSIC),
    mono: read(AUDIO_MONO),
  }
}

/**
 * Hand `apply` the settings now, and again whenever one of them changes.
 * Returns the teardown.
 */
export function bindSettings(
  apply: (settings: SoundtrackSettings) => void,
): () => void {
  let current = readSettings()
  apply(current)
  const on = <K extends keyof SoundtrackSettings>(
    field: K,
    preference: Preference<SoundtrackSettings[K]>,
  ): (() => void) =>
    subscribe(preference, (value) => {
      current = { ...current, [field]: value }
      apply(current)
    })
  const unsubscribes = [
    on('enabled', MUSIC_ENABLED),
    on('order', MUSIC_ORDER),
    on('disabled', MUSIC_DISABLED),
    on('mutedCategories', MUSIC_MUTED_CATEGORIES),
    on('shuffle', MUSIC_SHUFFLE),
    on('repeat', MUSIC_REPEAT),
    on('crossfade', MUSIC_CROSSFADE),
    on('master', AUDIO_MASTER),
    on('music', AUDIO_MUSIC),
    on('mono', AUDIO_MONO),
  ]
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}
