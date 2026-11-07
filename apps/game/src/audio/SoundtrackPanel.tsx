import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import {
  Music,
  Pause,
  Play,
  Shuffle,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import { licenseOf, SOUNDTRACK_CATEGORY_TITLES } from '@inertialref/protocol'
import { FOCUS_RING } from '../hud/focus.ts'
import { OptionGroup } from '../hud/OptionGroup.tsx'
import { Section } from '../hud/Section.tsx'
import { SliderControl } from '../hud/SliderControl.tsx'
import { SwitchRow } from '../hud/SwitchRow.tsx'
import { TransportButton } from '../hud/TransportButton.tsx'
import { useActionTitle } from '../input/useKeymap.ts'
import { CREDITS, overlayState, settingsSection } from '../pages/paths.ts'
import {
  AUDIO_MUSIC,
  MUSIC_ENABLED,
  MUSIC_MUTED_CATEGORIES,
  MUSIC_REPEAT,
  MUSIC_SHUFFLE,
  usePersistentState,
} from '../state/preferences.ts'
import {
  byline,
  CATEGORIES_PRESENT,
  categorySize,
  clock,
  describeSize,
  trackById,
} from './catalog.ts'
import { readLevel, speakLevel } from './levels.ts'
import { PlaybackStatus } from './PlaybackStatus.tsx'
import { soundtrackPlayer } from './player.ts'
import { REPEATS, withMember } from './playlist.ts'
import { SeekBar } from './SeekBar.tsx'
import { useSoundtrack } from './soundtrackStore.ts'
import { UpNextRow } from './UpNextRow.tsx'

/*
 * The soundtrack, in the Planetarium's dock.
 *
 * What is playing and the three controls a listener reaches for — previous,
 * play or pause, next — then what comes after it, then the playlist's few
 * switches. The arranging (the order, a track switched off, keeping tracks
 * for offline) is the settings page's, where there is room for a list of
 * fifty tracks; this panel links there rather than drawing a second editor
 * for the same preferences in a 19rem column.
 *
 * Every switch here is a preference the settings page also draws, read and
 * written through `usePersistentState`, so the two cannot disagree: changing
 * one in either place is heard by the player through `audio/settings.ts`.
 */

const REPEAT_LABELS: Readonly<Record<string, string>> = {
  all: 'all',
  one: 'one',
  off: 'off',
}

/** How many of the queue's next tracks the panel lists. */
const UP_NEXT = 3

export function SoundtrackPanel() {
  const [player] = useState(soundtrackPlayer)
  const location = useLocation()
  const playback = useSoundtrack((state) => state.playback)
  const [enabled, setEnabled] = usePersistentState(MUSIC_ENABLED)
  const [shuffle, setShuffle] = usePersistentState(MUSIC_SHUFFLE)
  const [repeat, setRepeat] = usePersistentState(MUSIC_REPEAT)
  const [muted, setMuted] = usePersistentState(MUSIC_MUTED_CATEGORIES)
  const [level, setLevel] = usePersistentState(AUDIO_MUSIC)
  const previous = useActionTitle('music.previous', 'Previous track')
  const next = useActionTitle('music.next', 'Next track')
  const pause = useActionTitle('music.toggle', 'Pause')
  const play = useActionTitle('music.toggle', 'Play')
  const card = useActionTitle('music.card', 'Show the credit again')

  /*
   * Off is one switch and nothing else. A transport for a player that will
   * not play is a row of controls that do nothing, which reads as broken.
   */
  if (!enabled) {
    return (
      <SwitchRow
        icon={Music}
        label="Play the soundtrack"
        detail="Ambient and lofi under the sky, with every track credited as it starts."
        on={false}
        onChange={setEnabled}
      />
    )
  }

  const track = trackById(playback.trackId)
  const playing = playback.status === 'playing' || playback.status === 'loading'
  const upcoming = playback.upcoming
    .slice(0, UP_NEXT)
    .map(trackById)
    .filter((one) => one !== null)

  return (
    <div className="flex flex-col gap-2">
      {/*
       * The title is a button: the card is the credit, and a credit missed
       * while looking at something else is one press away rather than a track
       * away. The panel's own line under it is the same credit, shorter.
       */}
      <div className="flex min-w-0 flex-col gap-0.5">
        {track === null ? (
          <p className="type-body text-slate-300">
            {playback.status === 'unavailable'
              ? 'Nothing can play'
              : 'Nothing playing yet'}
          </p>
        ) : (
          <button
            type="button"
            title={card}
            onClick={() => player.showCard()}
            className={`type-body -mx-1 truncate rounded px-1 text-left text-slate-200 hover:text-sky-200 ${FOCUS_RING}`}
          >
            {track.title}
          </button>
        )}
        {track !== null && (
          <p className="type-ui truncate text-slate-400">
            {byline(track)} · {track.release}
          </p>
        )}
        <PlaybackStatus
          status={playback.status}
          reason={playback.reason}
          offline={playback.offline}
          crossfading={playback.crossfading}
          license={track === null ? null : licenseOf(track).name}
          category={
            track === null
              ? null
              : SOUNDTRACK_CATEGORY_TITLES[track.category].title
          }
        />
      </div>

      <SeekBar
        position={playback.position}
        duration={track?.duration ?? 0}
        disabled={track === null}
        onSeek={(seconds) => player.seek(seconds)}
      />

      <div className="flex items-center gap-1.5">
        <TransportButton
          label={previous}
          icon={SkipBack}
          disabled={track === null}
          onClick={() => player.previous()}
        />
        <TransportButton
          label={playing ? pause : play}
          icon={playing ? Pause : Play}
          primary
          disabled={playback.status === 'unavailable'}
          onClick={() => player.toggle()}
        />
        <TransportButton
          label={next}
          icon={SkipForward}
          disabled={playback.status === 'unavailable'}
          onClick={() => player.next()}
        />
        {track !== null && (
          <span className="type-readout ml-auto text-slate-400">
            {clock(track.duration)}
          </span>
        )}
      </div>

      {upcoming.length > 0 && (
        <Section id="planetarium.soundtrack.next" title="Up next">
          <div className="-mx-1.5 flex flex-col">
            {upcoming.map((one) => (
              <UpNextRow
                key={one.id}
                track={one}
                onPlay={() => player.select(one.id)}
              />
            ))}
          </div>
        </Section>
      )}

      <Section id="planetarium.soundtrack.playlist" title="Playlist">
        <SwitchRow
          icon={Shuffle}
          label="Shuffle"
          detail="Every track once before any plays twice."
          on={shuffle}
          onChange={setShuffle}
        />
        <div className="flex items-center justify-between gap-2 px-1 py-1.5">
          <span className="type-ui text-slate-300">Repeat</span>
          <OptionGroup
            label="Repeat"
            value={repeat}
            values={REPEATS}
            labels={REPEAT_LABELS}
            onChange={setRepeat}
          />
        </div>
        {CATEGORIES_PRESENT.map((category) => (
          <SwitchRow
            key={category}
            label={SOUNDTRACK_CATEGORY_TITLES[category].title}
            detail={describeSize(categorySize(category))}
            on={!muted.includes(category)}
            onChange={(on) =>
              setMuted((held) => withMember(held, category, !on))
            }
          />
        ))}
        <div className="flex flex-col gap-0.5 px-1 pt-1">
          <span className="type-ui text-slate-300">Music volume</span>
          <SliderControl
            label="Music volume"
            min={0}
            max={1}
            step={0.01}
            value={level}
            reading={readLevel(level)}
            spoken={speakLevel(level)}
            onChange={setLevel}
          />
        </div>
      </Section>

      <p className="type-ui flex flex-wrap gap-x-3 gap-y-1 border-t border-slate-800/70 pt-2">
        <Link
          to={settingsSection('audio')}
          state={overlayState(location)}
          className={`rounded text-sky-300 underline-offset-2 hover:text-sky-200 hover:underline ${FOCUS_RING}`}
        >
          Arrange the playlist
        </Link>
        <Link
          to={CREDITS}
          state={overlayState(location)}
          className={`rounded text-sky-300 underline-offset-2 hover:text-sky-200 hover:underline ${FOCUS_RING}`}
        >
          Credits
        </Link>
      </p>
    </div>
  )
}
