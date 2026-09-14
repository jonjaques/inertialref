import type { ViewDescription } from '@inertialref/devtools'
import { GUIDE_LIMITS } from '@inertialref/protocol'
import type { GuideArrival, SceneFacts } from './executor.ts'

/*
 * What the model sees, as text.
 *
 * Three channels, each sized to its rate of change. The scene block is a
 * developer message queued on a view change; it sits in the backend
 * conversation so the next delegated response reads it as its most recent
 * state. The one-line UI context goes to the voice through a thinking
 * append, so "what am I looking at?" needs no delegation. The arrival and
 * the quiet-time messages are the beat's metronome. Every one of them is
 * browser-authored prose about application state; tool output and
 * transcripts never become an instruction.
 *
 * A queued `user` item made the voice reply as if the visitor had spoken.
 * Every message here is a developer message.
 */

/** Seconds from the Unix epoch to J2000, the observatory's zero. */
const J2000_UNIX_SECONDS = 946_728_000

/** An ISO 8601 instant for a picture time in seconds from J2000. */
export function pictureInstant(seconds: number): string {
  const date = new Date((seconds + J2000_UNIX_SECONDS) * 1000)
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace(/\.\d{3}Z$/, 'Z')
    : 'unknown'
}

/** Seconds from J2000 for an ISO 8601 instant, or null when it is not one. */
export function instantSeconds(iso: string): number | null {
  const millis = Date.parse(iso)
  return Number.isFinite(millis) ? millis / 1000 - J2000_UNIX_SECONDS : null
}

function join(names: readonly string[], limit: number): string {
  if (names.length === 0) return 'none'
  const shown = names.slice(0, limit)
  return names.length > limit
    ? `${shown.join(', ')} and ${names.length - limit} more`
    : shown.join(', ')
}

function onScreen(view: ViewDescription): string {
  if (view.onScreen.length === 0) return 'nothing named'
  return view.onScreen
    .map((item) => {
      const detail = [item.place, item.extent]
      if (item.kind !== 'star' && item.extent !== 'point')
        detail.push(`lit ${Math.round(item.lit * 100)}%`)
      return `${item.name} (${detail.join(', ')})`
    })
    .join(', ')
}

function timeWords(view: ViewDescription): string {
  const instant = pictureInstant(view.pictureTime)
  switch (view.timeMode) {
    case 'live':
      return `${instant} live`
    case 'paused':
      return `${instant} held`
    case 'rate':
      return `${instant} running at ${view.timeScale}x`
    case 'held':
      return `${instant} held, running`
  }
}

function subjectLine(view: ViewDescription, facts: SceneFacts): string {
  const subject = view.subject
  if (subject === null) return 'Current view: nothing chosen.'
  const kind = `${subject.kind}${facts.provenance === null ? '' : `, ${facts.provenance}`}`
  const where = view.standing
    ? `standing at ${view.standing.site ?? 'a site'}`
    : `orbit at ${view.distanceRadii ?? '?'} radii`
  const framing = facts.framing === null ? '' : `, framing "${facts.framing}"`
  return `Current view: ${subject.name} (${kind})${framing}, ${where}, fill ${Math.round(view.fill * 100) / 100}, picture time ${timeWords(view)}. ${view.traveling ? 'Traveling.' : 'Not traveling.'}`
}

function standingLine(view: ViewDescription): string {
  const standing = view.standing
  if (standing === null)
    return `Standing: no. Guide motion: ${view.motion ? 'running' : 'none'}.`
  return `Standing: yes, heading ${standing.headingDeg}°, pitch ${standing.pitchDeg}°, ${standing.daylight}${standing.sunAltitudeDeg === null ? '' : ` (sun ${standing.sunAltitudeDeg}° above the horizon)`}.`
}

function fit(lines: readonly string[], bytes: number): string {
  let text = lines.join('\n')
  // The lists are last and longest; a block over the bound loses them from
  // the end before it loses anything the model needs to move the camera.
  let kept = lines.length
  while (new TextEncoder().encode(text).byteLength > bytes && kept > 2) {
    kept -= 1
    text = lines.slice(0, kept).join('\n')
  }
  return text
}

/** The scene block: what is on screen and what can be named next. */
export function sceneBlock(view: ViewDescription, facts: SceneFacts): string {
  const subject = view.subject?.name ?? 'the subject'
  return fit(
    [
      subjectLine(view, facts),
      standingLine(view),
      `On screen: ${onScreen(view)}.`,
      `This system: ${facts.system ?? 'unknown'}; planets ${join(facts.planets, 12)}${facts.moons.length === 0 ? '' : `; ${subject}'s moons ${join(facts.moons, 10)}`}.`,
      `Framings for ${subject}: ${join(facts.framings, 12)}.`,
      `Sites: ${
        facts.sites.length === 0
          ? 'none (no solid surface)'
          : join(
              facts.sites.map((site) => `${site.name} (${site.id})`),
              8,
            )
      }.`,
    ],
    GUIDE_LIMITS.sceneBytes,
  )
}

/** The arrival message: the receipt the model was told to wait for. */
export function arrivalBlock(
  arrival: GuideArrival,
  view: ViewDescription,
  facts: SceneFacts,
): string {
  const where =
    arrival.tool === 'stand_at'
      ? `standing on ${arrival.subject}`
      : arrival.tool === 'leave_surface'
        ? `back in orbit around ${arrival.subject}`
        : `${arrival.subject}${arrival.framing === null ? '' : `, framing ${arrival.framing}`}`
  return fit(
    [
      `Arrived: ${where}, not traveling.`,
      standingLine(view),
      `On screen: ${onScreen(view)}.`,
      `Framings for ${arrival.subject}: ${join(facts.framings, 12)}. Sites: ${
        facts.sites.length === 0
          ? 'none'
          : join(
              facts.sites.map((site) => site.name),
              6,
            )
      }.`,
      'Narrate this stop now.',
    ],
    GUIDE_LIMITS.sceneBytes,
  )
}

/** The metronome's other tick. */
export function quietBlock(seconds: number): string {
  return `The visitor has looked quietly for ${Math.round(seconds)} seconds. Continue the tour with the next stop.`
}

/** What the visitor did, for the backend. */
export function takeoverBlock(
  view: ViewDescription,
  facts: SceneFacts,
): string {
  return `The visitor has taken the camera. Any move you had pending is canceled; the tour continues from this view if it continues at all.\n${sceneBlock(view, facts)}`
}

/** One sentence for the voice, so it can answer without delegating. */
export function uiContext(view: ViewDescription): string {
  const subject = view.subject
  if (subject === null) return 'The visitor is looking at an empty sky.'
  if (view.standing !== null)
    return `The visitor is now standing on ${subject.name}${view.standing.site === null ? '' : ` at ${view.standing.site}`}, in ${view.standing.daylight}.`
  const largest = view.onScreen[0]
  const lit =
    largest !== undefined &&
    largest.name === subject.name &&
    largest.kind !== 'star'
      ? largest.lit < 0.25
        ? ' as a thin crescent'
        : largest.lit < 0.6
          ? ' half lit'
          : ''
      : ''
  return `The visitor is now looking at ${subject.name}${lit} from orbit${view.distanceRadii === null ? '' : ` at ${view.distanceRadii} radii`}${view.traveling ? ', still traveling' : ''}.`
}

export function takeoverContext(view: ViewDescription): string {
  return `The visitor has taken the camera; ${uiContext(view).replace(/^The visitor is now /, 'the view is now ')}`
}

/** The developer message the session is created with. */
export function openingLine(
  view: ViewDescription,
  facts: SceneFacts,
  localTime: string,
): string {
  const subject = view.subject
  const what =
    subject === null
      ? 'The visitor has not chosen anything to look at yet.'
      : `On screen: ${onScreen(view)}. The subject is ${subject.name} (${subject.kind}${facts.provenance === null ? '' : `, ${facts.provenance}`}), ${view.standing === null ? `seen from orbit at ${view.distanceRadii ?? '?'} radii` : `from its surface`}.`
  return `${what} The visitor's local time is ${localTime}.`
}

/**
 * The opening: who is speaking, what they can do, what is on screen. The
 * voice knows its own name only because the browser tells it; the provider's
 * voice id is not in the session's instructions.
 */
export function greetingInstruction(voice: string): string {
  const name = voice.charAt(0).toUpperCase() + voice.slice(1)
  return `Introduce yourself as ${name}, the guide here, in one sentence. In one more, say that the visitor can ask to go anywhere, land on a world, take a tour, or ask what they are looking at. Then one short, specific sentence about what is on screen, and listen. Speak first.`
}
export const BEGIN_CONVERSATION =
  'Begin the conversation now, following the instructions provided.'
export const PAUSE_INSTRUCTION =
  'The visitor paused. Stay silent until the developer says they resumed.'
export const RESUME_INSTRUCTION =
  'The visitor resumed. Listen, and continue from where things were.'
