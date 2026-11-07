import { useId } from 'react'
import { Link } from 'react-router'
import { SOUNDTRACK_CATEGORY_TITLES } from '@inertialref/protocol'
import {
  CATEGORIES_PRESENT,
  categorySize,
  describeSize,
  megabytes,
  SOUNDTRACK,
} from '../audio/catalog.ts'
import { readLevel, speakLevel } from '../audio/levels.ts'
import { fileFor, offlineLibrary } from '../audio/player.ts'
import { PlaylistEditor } from '../audio/PlaylistEditor.tsx'
import { REPEATS, withMember } from '../audio/playlist.ts'
import { useSoundtrack } from '../audio/soundtrackStore.ts'
import { Action } from '../hud/Action.tsx'
import { FOCUS_RING } from '../hud/focus.ts'
import { OptionGroup } from '../hud/OptionGroup.tsx'
import { Section } from '../hud/Section.tsx'
import { SettingRow } from '../hud/SettingRow.tsx'
import { SliderControl } from '../hud/SliderControl.tsx'
import { SwitchRow } from '../hud/SwitchRow.tsx'
import {
  AUDIO_MASTER,
  AUDIO_MONO,
  AUDIO_MUSIC,
  differs,
  MUSIC_BACKGROUND,
  MUSIC_CARD,
  MUSIC_CROSSFADE,
  MUSIC_DISABLED,
  MUSIC_ENABLED,
  MUSIC_MUTED_CATEGORIES,
  MUSIC_REPEAT,
  MUSIC_SHUFFLE,
  usePersistentState,
} from '../state/preferences.ts'
import { CREDITS } from './paths.ts'
import { useOverlay } from './useOverlay.ts'

/*
 * What the game plays and how loud: the levels, the soundtrack's behavior,
 * its categories, the playlist itself, and what is kept for offline.
 *
 * The Planetarium's Soundtrack panel draws the few of these a listener
 * reaches for mid-session — shuffle, repeat, the categories, the music level
 * — from the same preferences, so the two can never disagree. This page has
 * the rest, and the one thing the panel has no room for: the list.
 *
 * **Offline is a choice, with the size beside it.** The whole soundtrack is
 * hundreds of megabytes, which is too much to take from a phone unasked and
 * nothing to somebody who installed the game to play on a plane. Kept tracks
 * live in their own cache, which a new build does not clear.
 */

const REPEAT_LABELS: Readonly<Record<string, string>> = {
  all: 'all',
  one: 'one',
  off: 'off',
}

export function AudioSection() {
  const [master, setMaster] = usePersistentState(AUDIO_MASTER)
  const [music, setMusic] = usePersistentState(AUDIO_MUSIC)
  const [mono, setMono] = usePersistentState(AUDIO_MONO)
  const [enabled, setEnabled] = usePersistentState(MUSIC_ENABLED)
  const [shuffle, setShuffle] = usePersistentState(MUSIC_SHUFFLE)
  const [repeat, setRepeat] = usePersistentState(MUSIC_REPEAT)
  const [crossfade, setCrossfade] = usePersistentState(MUSIC_CROSSFADE)
  const [card, setCard] = usePersistentState(MUSIC_CARD)
  const [background, setBackground] = usePersistentState(MUSIC_BACKGROUND)
  const [muted, setMuted] = usePersistentState(MUSIC_MUTED_CATEGORIES)
  const [disabled] = usePersistentState(MUSIC_DISABLED)
  const offline = useSoundtrack((state) => state.offline)
  const { keep } = useOverlay()
  const masterId = useId()
  const musicId = useId()
  const fadeId = useId()

  const playable = SOUNDTRACK.tracks.filter(
    (track) => !disabled.includes(track.id) && !muted.includes(track.category),
  )
  const files = SOUNDTRACK.tracks.map(fileFor).filter((file) => file !== null)
  const keptBytes = files
    .filter((file) => offline.kept.includes(file.name))
    .reduce((sum, file) => sum + file.bytes, 0)
  const allBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const busy = offline.queued > 0 || Object.keys(offline.downloading).length > 0
  const keptCount = files.filter((file) =>
    offline.kept.includes(file.name),
  ).length

  return (
    <div className="@container flex flex-col gap-2">
      <Section id="settings.audio.levels" title="Levels">
        <SettingRow
          label="Everything"
          detail="The volume of all the game plays, over each level below it."
          detailId={masterId}
          changed={differs(master, AUDIO_MASTER.initial)}
        >
          <SliderControl
            label="Everything"
            min={0}
            max={1}
            step={0.01}
            value={master}
            reading={readLevel(master)}
            spoken={speakLevel(master)}
            describedBy={masterId}
            onChange={setMaster}
          />
        </SettingRow>
        <SettingRow
          label="Music"
          detail="The soundtrack, against everything else."
          detailId={musicId}
          changed={differs(music, AUDIO_MUSIC.initial)}
        >
          <SliderControl
            label="Music"
            min={0}
            max={1}
            step={0.01}
            value={music}
            reading={readLevel(music)}
            spoken={speakLevel(music)}
            describedBy={musicId}
            onChange={setMusic}
          />
        </SettingRow>
        <SwitchRow
          divided
          label="Mono"
          detail="Both channels in both ears — for one earbud, or for hearing in one ear."
          on={mono}
          changed={mono !== AUDIO_MONO.initial}
          onChange={setMono}
        />
      </Section>

      <Section id="settings.audio.soundtrack" title="Soundtrack">
        <SwitchRow
          divided
          label="Play the soundtrack"
          detail="Music under the sky in the Planetarium. Flight and the cinema keep their own sound."
          on={enabled}
          changed={enabled !== MUSIC_ENABLED.initial}
          onChange={setEnabled}
        />
        <SwitchRow
          divided
          label="Shuffle"
          detail="Every track once before any plays twice."
          on={shuffle}
          changed={shuffle !== MUSIC_SHUFFLE.initial}
          onChange={setShuffle}
        />
        <SettingRow
          label="Repeat"
          detail="At the end of the playlist: start it again, play the same track again, or stop."
          changed={repeat !== MUSIC_REPEAT.initial}
        >
          <OptionGroup
            label="Repeat"
            value={repeat}
            values={REPEATS}
            labels={REPEAT_LABELS}
            onChange={setRepeat}
          />
        </SettingRow>
        <SettingRow
          label="Crossfade"
          detail="How long one track takes to become the next. A skip is always quick."
          detailId={fadeId}
          changed={crossfade !== MUSIC_CROSSFADE.initial}
        >
          <SliderControl
            label="Crossfade"
            min={0}
            max={12}
            step={1}
            value={crossfade}
            reading={crossfade === 0 ? 'off' : `${crossfade} s`}
            spoken={
              crossfade === 0
                ? 'off'
                : `${crossfade} ${crossfade === 1 ? 'second' : 'seconds'}`
            }
            describedBy={fadeId}
            onChange={setCrossfade}
          />
        </SettingRow>
        <SwitchRow
          divided
          label="Credits card"
          detail="The title, the artist and the license, for a few seconds as each track starts."
          on={card}
          changed={card !== MUSIC_CARD.initial}
          onChange={setCard}
        />
        <SwitchRow
          divided
          label="Play in a background tab"
          detail="Keep the music going while another tab is on screen."
          on={background}
          changed={background !== MUSIC_BACKGROUND.initial}
          onChange={setBackground}
        />
      </Section>

      <Section id="settings.audio.categories" title="Categories">
        {CATEGORIES_PRESENT.map((category) => (
          <SwitchRow
            key={category}
            divided
            label={SOUNDTRACK_CATEGORY_TITLES[category].title}
            detail={`${SOUNDTRACK_CATEGORY_TITLES[category].about} ${describeSize(
              categorySize(category),
            )}.`}
            on={!muted.includes(category)}
            changed={
              muted.includes(category) !==
              MUSIC_MUTED_CATEGORIES.initial.includes(category)
            }
            onChange={(on) =>
              setMuted((held) => withMember(held, category, !on))
            }
          />
        ))}
      </Section>

      <Section
        id="settings.audio.playlist"
        title="Playlist"
        trailing={`${playable.length} of ${SOUNDTRACK.tracks.length} playing`}
      >
        <PlaylistEditor />
      </Section>

      <Section id="settings.audio.offline" title="Offline">
        {offline.supported ? (
          <>
            <SettingRow
              label="Kept on this device"
              detail={`${keptCount} of ${files.length} tracks, ${megabytes(keptBytes)} of ${megabytes(allBytes)}. Kept tracks play without a connection, and a new version of the game keeps them.`}
            >
              {busy ? (
                <Action
                  label={`Stop (${offline.queued + Object.keys(offline.downloading).length} left)`}
                  onClick={() => offlineLibrary.stop()}
                />
              ) : (
                <Action
                  label="Keep every track"
                  tone="primary"
                  disabled={keptCount === files.length}
                  title={`Download the whole soundtrack, ${megabytes(allBytes - keptBytes)}`}
                  onClick={() => offlineLibrary.keepAll(files)}
                />
              )}
              <Action
                label="Remove all"
                disabled={keptCount === 0 && !busy}
                title="Delete every kept track from this device"
                onClick={() => void offlineLibrary.releaseAll()}
              />
            </SettingRow>
            <p className="type-ui px-2.5 py-2 text-pretty text-slate-400">
              {storageLine(offline.usage, offline.persisted)}
            </p>
            {offline.failure !== null && (
              <p className="type-ui px-2.5 py-1 text-pretty text-amber-300/90">
                {offline.failure}
              </p>
            )}
          </>
        ) : (
          <p className="type-ui px-2.5 py-2 text-pretty text-slate-400">
            This browser keeps nothing for offline here — a private window, or
            site data blocked. The soundtrack still streams.
          </p>
        )}
      </Section>

      <p className="type-ui px-2.5 pt-1 text-slate-400">
        Who made each track, and under what license:{' '}
        <Link
          to={CREDITS}
          state={keep}
          className={`rounded text-sky-300 underline-offset-2 hover:text-sky-200 hover:underline ${FOCUS_RING}`}
        >
          the credits
        </Link>
        .
      </p>
    </div>
  )
}

function storageLine(
  usage: { readonly used: number; readonly quota: number } | null,
  persisted: boolean | null,
): string {
  const used =
    usage === null
      ? 'The browser does not say how much this site stores.'
      : `This site stores ${megabytes(usage.used)} of the ${megabytes(usage.quota)} the browser allows it.`
  const kept =
    persisted === true
      ? 'The browser has agreed not to clear it to free space.'
      : 'The browser may clear it when the disk runs short; keep a track again to ask it not to.'
  return `${used} ${kept}`
}
