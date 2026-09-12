import { mediaPath } from '@inertialref/protocol'

/*
 * Which file plays under a scene, and where it is served from.
 *
 * A script names its music by the track's name alone — `soundtrack:
 * 'tng-intro'` — and this turns the name into the files to ask for. Kept out
 * of `CutsceneOverlay.tsx` so the arithmetic is testable without a document
 * and so the overlay's rAF loop reads one answer rather than deriving it.
 */

/** A file the overlay may adopt, with the type `canPlayType` is asked about. */
export interface AudioCandidate {
  readonly src: string
  readonly type: string
}

/**
 * The encodings a track is served in, in the order they are preferred.
 *
 * `/media/` is the site's object storage, not the bundle: a track is
 * copyrighted music that never enters the repository, so the build pulls it
 * out of R2 and the Worker falls back to the same bucket when a build could
 * not. `apps/server/src/media.ts` is the arrangement — including why one track
 * has two encodings and why AAC comes first — and the paths are spelled by
 * `mediaPath` so this file, the router and `run_worker_first` cannot drift.
 *
 * The `codecs` parameter is not decoration. `canPlayType('audio/mp4')` alone
 * answers `maybe` on a browser that has the container and not the profile, and
 * `maybe` is indistinguishable from `probably` here — both are non-empty, and
 * both would have the overlay adopt a file it cannot decode and then play the
 * scene silent with no error to read. Naming `mp4a.40.2` asks the question
 * that has an answer.
 */
const ENCODINGS = [
  { extension: 'm4a', type: 'audio/mp4; codecs="mp4a.40.2"' },
  { extension: 'mp3', type: 'audio/mpeg' },
] as const

/** The files a named track may be served as, most preferred first. */
export const soundtrackCandidates = (
  soundtrack: string,
): readonly AudioCandidate[] =>
  ENCODINGS.map((encoding) => ({
    src: mediaPath(`${soundtrack}.${encoding.extension}`),
    type: encoding.type,
  }))

/**
 * The track a scene is cut to: null for a scene with no music, and for no
 * scene at all. The library's own listing is the source, so the overlay and
 * the director cannot disagree about which scene has a soundtrack.
 */
export function soundtrackFor(
  scenes: readonly {
    readonly id: string
    readonly soundtrack: string | null
  }[],
  id: string | null,
): string | null {
  if (id === null) return null
  return scenes.find((scene) => scene.id === id)?.soundtrack ?? null
}
