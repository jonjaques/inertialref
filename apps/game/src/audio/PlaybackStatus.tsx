import type { SoundtrackStatus } from './soundtrackStore.ts'

/**
 * One line under the title: what kind of music this is, and anything about
 * the player a listener would otherwise have to guess.
 *
 * The category and the license when all is well, because those are what the
 * title and the byline above do not say. Otherwise the line is the reason —
 * waiting for the first gesture a page may make a sound on, offline with only
 * the kept tracks to choose from — set in amber when it is a reason nothing is
 * playing, since that is the case somebody opened the panel to understand.
 */
export function PlaybackStatus({
  status,
  reason,
  offline,
  crossfading,
  category,
  license,
}: {
  status: SoundtrackStatus
  reason: string | null
  offline: boolean
  crossfading: boolean
  category: string | null
  license: string | null
}) {
  const [line, warn] = describe(status, reason, offline, crossfading, [
    category,
    license,
  ])
  if (line === '') return null
  return (
    <p
      className={`type-micro truncate ${warn ? 'text-amber-300/90' : 'text-slate-400'}`}
      title={line}
    >
      {line}
    </p>
  )
}

function describe(
  status: SoundtrackStatus,
  reason: string | null,
  offline: boolean,
  crossfading: boolean,
  about: readonly (string | null)[],
): readonly [string, boolean] {
  if (status === 'unavailable') return [reason ?? 'Nothing can play.', true]
  if (status === 'waiting')
    return ['Starts with your first click or key.', false]
  const facts = about.filter((fact) => fact !== null)
  if (status === 'loading') facts.unshift('Loading')
  else if (status === 'paused') facts.unshift('Paused')
  else if (crossfading) facts.unshift('Crossfading')
  if (offline) facts.push('offline: kept tracks only')
  return [facts.join(' · '), false]
}
