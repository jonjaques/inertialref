import type { SoundtrackCategory, SoundtrackTrack } from '@inertialref/protocol'

/*
 * What plays next, as data.
 *
 * Two lists and nothing else: what has played, newest last, and what is to
 * come in this cycle. The current track is the last one played. Previous
 * walks back down the history rather than re-deriving a position — in a
 * shuffle the track before this one is the one that actually played, not its
 * neighbor in the arrangement — and "up next" is the head of the upcoming
 * list, so the panel and the player read the same answer.
 *
 * **A shuffle is a bag, not a die.** Every enabled track plays once before
 * any plays twice, and a refilled bag never opens with the track that just
 * ended. Random draws with replacement repeat a track inside ten minutes
 * about as often as they do anything else, which a listener hears as broken.
 *
 * Pure: every function returns a new queue, and randomness arrives as an
 * argument, so `playlist.test.ts` can hold the bag property over thousands of
 * draws and a failing case replays from its seed.
 */

export type Repeat = 'all' | 'one' | 'off'

export const REPEATS: readonly Repeat[] = ['all', 'one', 'off']

/** What the listener arranged, as the playlist reads it. */
export interface PlaylistSettings {
  /** Track ids in the listener's order. Unknown ids are ignored. */
  readonly order: readonly string[]
  /** Track ids switched off. */
  readonly disabled: readonly string[]
  /** Categories switched off, whole. */
  readonly mutedCategories: readonly SoundtrackCategory[]
  readonly shuffle: boolean
  readonly repeat: Repeat
}

export interface Queue {
  /** What has played, the current track last. Bounded at `HISTORY`. */
  readonly played: readonly string[]
  /** What is to come in this cycle, next first. */
  readonly upcoming: readonly string[]
}

export const EMPTY_QUEUE: Queue = { played: [], upcoming: [] }

/** How far back Previous can walk. */
export const HISTORY = 100

/** A uniform draw in [0, 1). */
export type Random = () => number

/**
 * Every track, in the listener's order.
 *
 * The arranged ids first, then whatever the arrangement does not mention in
 * the catalog's own order — so a track added by a later build lands at the
 * end of somebody's arrangement rather than nowhere, and an arrangement that
 * names a track a later build dropped simply skips it.
 */
export function arrange<T extends Pick<SoundtrackTrack, 'id'>>(
  tracks: readonly T[],
  order: readonly string[],
): readonly T[] {
  const byId = new Map(tracks.map((track) => [track.id, track]))
  const seen = new Set<string>()
  const arranged: T[] = []
  for (const id of order) {
    const track = byId.get(id)
    if (track === undefined || seen.has(id)) continue
    seen.add(id)
    arranged.push(track)
  }
  for (const track of tracks) if (!seen.has(track.id)) arranged.push(track)
  return arranged
}

/** The ids that may play: arranged, enabled, and in a category that is on. */
export function playable(
  tracks: readonly Pick<SoundtrackTrack, 'id' | 'category'>[],
  settings: Pick<PlaylistSettings, 'order' | 'disabled' | 'mutedCategories'>,
): readonly string[] {
  const disabled = new Set(settings.disabled)
  const muted = new Set(settings.mutedCategories)
  return arrange(tracks, settings.order)
    .filter((track) => !disabled.has(track.id) && !muted.has(track.category))
    .map((track) => track.id)
}

/**
 * `ids` in a uniformly random order (Fisher–Yates), never opening with
 * `avoid` while there is anything else to open with.
 */
export function shuffled(
  ids: readonly string[],
  random: Random,
  avoid: string | null = null,
): readonly string[] {
  const out = [...ids]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(random() * (i + 1)))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  if (out.length > 1 && out[0] === avoid) {
    // Swap with a uniformly chosen other position; the rest stays uniform.
    const j =
      1 + Math.min(out.length - 2, Math.floor(random() * (out.length - 1)))
    ;[out[0], out[j]] = [out[j]!, out[0]!]
  }
  return out
}

export const currentOf = (queue: Queue): string | null =>
  queue.played.at(-1) ?? null

/** The ids after `id` in the arrangement, to the end. */
function after(ids: readonly string[], id: string | null): readonly string[] {
  const at = id === null ? -1 : ids.indexOf(id)
  return ids.slice(at + 1)
}

/** One cycle's worth of upcoming tracks, following `current`. */
function cycle(
  ids: readonly string[],
  shuffle: boolean,
  random: Random,
  current: string | null,
): readonly string[] {
  return shuffle ? shuffled(ids, random, current) : ids
}

const remember = (played: readonly string[], id: string): readonly string[] =>
  [...played, id].slice(-HISTORY)

/**
 * A queue that starts on `first`, or on the first track of a fresh cycle.
 *
 * `first` is the track a reload resumes, or the one the listener picked. In a
 * shuffle the rest of the cycle is drawn around it; in order, the cycle runs
 * on from it to the end of the arrangement.
 */
export function startQueue(
  ids: readonly string[],
  shuffle: boolean,
  random: Random,
  first: string | null = null,
): Queue {
  if (ids.length === 0) return EMPTY_QUEUE
  const opening = first !== null && ids.includes(first) ? first : null
  if (opening !== null) {
    const rest = shuffle
      ? shuffled(
          ids.filter((id) => id !== opening),
          random,
        )
      : after(ids, opening)
    return { played: [opening], upcoming: rest }
  }
  const fresh = cycle(ids, shuffle, random, null)
  return { played: [fresh[0]!], upcoming: fresh.slice(1) }
}

/**
 * The queue after the current track, or null when the playlist has ended.
 *
 * `ended` is a track finishing; `skip` is the listener asking for the next
 * one. They differ in two places. Repeat-one replays a track that ended and
 * moves on from one that was skipped. Repeat-off stops at the end of the
 * cycle when the music ran out, and wraps when somebody asked for more.
 */
export function nextQueue(
  queue: Queue,
  ids: readonly string[],
  settings: Pick<PlaylistSettings, 'shuffle' | 'repeat'>,
  random: Random,
  reason: 'ended' | 'skip',
): Queue | null {
  if (ids.length === 0) return null
  const current = currentOf(queue)
  if (reason === 'ended' && settings.repeat === 'one' && current !== null) {
    return { played: remember(queue.played, current), upcoming: queue.upcoming }
  }
  const valid = new Set(ids)
  let upcoming: readonly string[] = queue.upcoming.filter((id) => valid.has(id))
  if (upcoming.length === 0) {
    if (reason === 'ended' && settings.repeat === 'off') return null
    // Ordered and wrapping: a single-track playlist repeats itself, and a
    // longer one starts again from the top.
    upcoming = cycle(ids, settings.shuffle, random, current)
  }
  const [next, ...rest] = upcoming
  return { played: remember(queue.played, next!), upcoming: rest }
}

/**
 * The queue with the previous track current again, or null when there is no
 * history to walk back down. The track it leaves goes back to the head of
 * the upcoming list, so Next undoes Previous.
 */
export function previousQueue(queue: Queue): Queue | null {
  if (queue.played.length < 2) return null
  const current = queue.played.at(-1)!
  return {
    played: queue.played.slice(0, -1),
    upcoming: [current, ...queue.upcoming],
  }
}

/**
 * The queue with `id` playing now.
 *
 * In order, the cycle continues from `id`'s place in the arrangement. In a
 * shuffle, `id` is taken out of what is still to come so it does not play
 * twice in one cycle; the rest of the draw is left as it was.
 */
export function jumpQueue(
  queue: Queue,
  ids: readonly string[],
  shuffle: boolean,
  id: string,
): Queue {
  const played = remember(queue.played, id)
  if (shuffle) {
    return { played, upcoming: queue.upcoming.filter((one) => one !== id) }
  }
  return { played, upcoming: after(ids, id) }
}

/**
 * The queue after the playlist itself changed: a track switched off, a
 * category muted, the order rearranged, shuffle turned on or off.
 *
 * The current track keeps playing — switching off the song you are listening
 * to stops it coming back, not mid-phrase — and everything still to come is
 * re-derived. Turning shuffle on draws a fresh cycle around the current
 * track. A shuffle that stays a shuffle keeps its draw, less what was
 * switched off, plus whatever was newly switched on — `before` is the
 * playable list the draw was made from, which is what tells a track switched
 * on apart from one that already played this cycle. In order, the cycle runs
 * on from the current track's place in the new arrangement, or, for a current
 * track just switched off, from its place in `before`.
 */
export function reconcileQueue(
  queue: Queue,
  ids: readonly string[],
  before: readonly string[],
  {
    shuffle,
    wasShuffled,
  }: { readonly shuffle: boolean; readonly wasShuffled: boolean },
  random: Random,
): Queue {
  const current = currentOf(queue)
  if (!shuffle) {
    return { played: queue.played, upcoming: runOn(ids, before, current) }
  }
  const others = ids.filter((id) => id !== current)
  if (!wasShuffled) {
    return { played: queue.played, upcoming: shuffled(others, random, current) }
  }
  const valid = new Set(others)
  const known = new Set(before)
  const kept = queue.upcoming.filter((id) => valid.has(id))
  const added = others.filter((id) => !known.has(id))
  return {
    played: queue.played,
    upcoming: [...kept, ...shuffled(added, random)],
  }
}

/**
 * The ordered cycle after `current` in `ids`.
 *
 * A current track that `ids` no longer holds — the one just switched off —
 * has no place in it to run on from, and `after` would start the cycle again
 * from the top. Its place is found in `before` instead: the cycle resumes at
 * the first track after it there that is still in `ids`, and ends where
 * nothing after it is.
 */
function runOn(
  ids: readonly string[],
  before: readonly string[],
  current: string | null,
): readonly string[] {
  if (current === null || ids.includes(current) || !before.includes(current))
    return after(ids, current)
  const valid = new Set(ids)
  const following = after(before, current).find((id) => valid.has(id))
  return following === undefined ? [] : ids.slice(ids.indexOf(following))
}

/* ------------------------------------------------------------------------- */
/* Editing the arrangement                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The arrangement with the track at `from` moved to `to`, as a whole id list.
 *
 * Whole, rather than a patch over what was stored: the editor draws
 * `arrange(tracks, order)`, so the positions it hands back are positions in
 * *that* list, and writing it back entire is what makes the stored order and
 * the drawn one the same thing. `to` is where the track ends up, clamped to
 * the list, so a drag past the last row is a move to the end and not an
 * error.
 */
export function moveTrack(
  ids: readonly string[],
  from: number,
  to: number,
): readonly string[] {
  if (from < 0 || from >= ids.length) return ids
  const target = Math.min(ids.length - 1, Math.max(0, to))
  if (target === from) return ids
  const moved = [...ids]
  const [id] = moved.splice(from, 1)
  moved.splice(target, 0, id!)
  return moved
}

/**
 * A set of ids with one switched in or out, as a stored list.
 *
 * The disabled tracks and the muted categories are both "the ones switched
 * off", stored as a list because a preference is JSON. A sorted list, so the
 * same set is the same stored value however it was arrived at, and the
 * settings page's changed-from-default count does not see a reordering of an
 * unchanged set as a change.
 */
export function withMember<T extends string>(
  list: readonly T[],
  member: T,
  included: boolean,
): readonly T[] {
  const set = new Set(list)
  if (included) set.add(member)
  else set.delete(member)
  return [...set].sort()
}
