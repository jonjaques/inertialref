import {
  mediaPath,
  type SoundtrackFile,
  type SoundtrackTrack,
} from '@inertialref/protocol'

/*
 * Which of a track's encodings this browser plays, and where it is served.
 *
 * The catalog lists AAC first and Opus second (`apps/ingest/src/audio.ts`
 * says why), and every browser this game supports decodes at least one of
 * them. The question is asked once per session, of an element that is never
 * attached to anything: codec support does not change while a page is open.
 *
 * **The codecs parameter is the question.** `canPlayType('audio/mp4')` answers
 * `maybe` on a browser with the container and not the profile, and a `maybe`
 * file that cannot be decoded is a track that plays as silence with no error
 * to read. The catalog's types name the codec, so the answers are `probably`
 * or empty, and `probably` is preferred over a `maybe` wherever both occur.
 */

/** `HTMLMediaElement.canPlayType`, as a function a test can supply. */
export type CanPlay = (type: string) => string

/** The encoding to play, or null when this browser decodes none of them. */
export function playableFile(
  track: Pick<SoundtrackTrack, 'files'>,
  canPlay: CanPlay,
): SoundtrackFile | null {
  let fallback: SoundtrackFile | null = null
  for (const file of track.files) {
    const answer = canPlay(file.type)
    if (answer === 'probably') return file
    if (answer !== '' && fallback === null) fallback = file
  }
  return fallback
}

/** The URL a file is fetched from. */
export const fileUrl = (file: Pick<SoundtrackFile, 'name'>): string =>
  mediaPath(file.name)

/**
 * The browser's answer, asked of a detached element.
 *
 * Returns a function that says no to everything where there is no document —
 * the prerender and the Node suite — so a module that imports this can be
 * loaded there without a guard at every call site.
 */
export function browserCanPlay(): CanPlay {
  if (typeof document === 'undefined') return () => ''
  const probe = document.createElement('audio')
  const answers = new Map<string, string>()
  return (type) => {
    let answer = answers.get(type)
    if (answer === undefined) {
      answer = probe.canPlayType(type)
      answers.set(type, answer)
    }
    return answer
  }
}
