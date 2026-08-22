/*
 * Frames, and how to write them down.
 *
 * The cinema player speaks *frames* everywhere — in the URL, in the readout, in
 * the step buttons — and not seconds, because the scenes it plays are timed
 * against a reference edit measured frame by frame (ADR-0010, and CONTEXT.md's
 * "the title sequence, re-cut against its own frames"). A link that carried
 * `t=48.2s` would round to a different still on a 24 fps scene than on a 30 fps
 * one, and the whole point of a shareable frame is that two people see the same
 * picture.
 */

/**
 * A frame count as SMPTE-style `m:ss:ff` — minutes, seconds, frames.
 *
 * **Both fields come from one rate.** The frames field used to wrap on
 * `Math.round(fps)` while the seconds field ticked on the true rate, and at
 * 24000/1001 those two disagree once a second: frames 1006→1007→1008 read
 * `0:41:22` → `0:42:23` → `0:42:00`, so the frame counter ran *backwards*
 * inside a second — 21 times over the title sequence. A still identified by a
 * timecode that occurs twice cannot be found again, which is the one thing this
 * module exists to make possible. Deriving the remainder from the same `fps`
 * the seconds came from makes the pair monotonic by construction; it also
 * disposes of `Math.round(fps)`, which is 0 for any rate under 0.5 and turned
 * the readout into `0:00:NaN`.
 */
export function timecode(frame: number, fps: number): string {
  if (!Number.isFinite(frame) || !Number.isFinite(fps) || fps <= 0) return '—'
  const whole = Math.max(0, Math.floor(frame))
  const seconds = Math.floor(whole / fps)
  const frames = Math.floor(whole - seconds * fps)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${pad(seconds % 60)}:${pad(frames)}`
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** A duration in whole seconds, for a scene listing. */
export function durationText(frames: number, fps: number): string {
  if (!Number.isFinite(frames) || !Number.isFinite(fps) || fps <= 0) return '—'
  return secondsText(frames / fps)
}

/**
 * A duration in seconds as `m:ss`.
 *
 * Rounded once, before the split — which is the whole content of this
 * function, and why it is one rather than two lines at each call site. The
 * library listing did the arithmetic inline as
 * `Math.floor(s / 60)`:`Math.round(s % 60)`, so a 119.6 s scene took the floor
 * of the minutes and rounded the remainder up past its own modulus and
 * rendered `1:60`.
 */
export function secondsText(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${pad(whole % 60)}`
}

/**
 * The frame a URL asked for, clamped to a scene that exists.
 *
 * Everything that is not a frame number resolves to 0 rather than throwing: the
 * parameter is typed by hand and pasted from chat clients that helpfully append
 * punctuation, and a player that refuses to open is a worse answer to `t=1150.`
 * than one that opens at the start.
 */
export function parseFrame(
  value: string | null,
  durationFrames: number,
): number {
  if (value === null) return 0
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  // `durationFrames - 1`, because the director stops *on* the last frame and a
  // seek to it would end the scene rather than show it.
  return Math.min(parsed, Math.max(0, Math.floor(durationFrames) - 1))
}

/** Whether a URL asked for playback rather than a still. */
export const parseAutoplay = (value: string | null): boolean =>
  value === '1' || value === 'true'

/**
 * How far a transport button moves the playhead.
 *
 * A frame and a second, in both directions — the two step sizes an edit is
 * actually reviewed at. `secondStep` rounds, because a 23.976 fps scene has no
 * whole number of frames in a second and a fractional seek would land the
 * playhead between two stills.
 */
export const secondStep = (fps: number): number => Math.max(1, Math.round(fps))
