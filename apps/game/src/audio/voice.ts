/*
 * Whether a voice the visitor is listening to is live — the Planetarium's
 * guide, today.
 *
 * Its own module, and a small one, so that each side can reach it without
 * reaching the other: the guide loads lazily, in a chunk of its own, and an
 * import of the player from there would pull the soundtrack into it, while an
 * import of the guide from the player would pull the guide into every page.
 * The guide says when its session is live; the player ducks under it rather
 * than playing a melody across a conversation.
 *
 * By source, so two voices that overlap do not end the duck when the first
 * one stops.
 */

type Listener = (live: boolean) => void

const sources = new Set<string>()
const listeners = new Set<Listener>()

/** Whether any voice is live now. */
export const voiceLive = (): boolean => sources.size > 0

/** Say whether `source` is speaking to the visitor, or about to. */
export function setVoice(source: string, live: boolean): void {
  const before = voiceLive()
  if (live) sources.add(source)
  else sources.delete(source)
  const after = voiceLive()
  if (before !== after) for (const listener of listeners) listener(after)
}

/** Hear every change in whether a voice is live. */
export function onVoice(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
