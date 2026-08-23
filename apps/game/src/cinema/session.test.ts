import { describe, expect, it } from 'vitest'
import type { CutsceneOutcome, CutsceneStatus } from '@inertialref/devtools'
import { type CutsceneHost, createCutsceneSession } from './session.ts'

/*
 * Ended, stopped, or never open — as a fact rather than a guess.
 *
 * The behavior these cover was previously fifty lines inside `CinemaPlayer`,
 * driven by a 100 ms poll, and reachable only by rendering the player against a
 * live engine. It reconstructed "did it end or was it stopped?" from a `null`
 * and a half-second window around the final frame — which read `stopCutscene`
 * from the console as an ending, because that produces identical evidence.
 */

const DURATION = 2742
const FPS = 24

/** A director, as much of one as a session can see. */
function fake(): { host: CutsceneHost; calls: string[]; director: Director } {
  const calls: string[] = []
  const director = new Director(calls)
  return {
    calls,
    director,
    host: {
      status: () => director.status,
      outcome: () => director.outcome,
      paused: () => director.paused,
      play: (id) => director.play(id),
      seek: (frame) => director.seek(frame),
      pause: () => {
        calls.push('pause')
        director.paused = true
      },
      resume: () => {
        calls.push('resume')
        director.paused = false
      },
      stop: () => director.finish('stopped'),
    },
  }
}

class Director {
  status: CutsceneStatus | null = null
  outcome: CutsceneOutcome | null = null
  paused = false
  readonly calls: string[]

  constructor(calls: string[]) {
    this.calls = calls
  }

  play(id: string): CutsceneStatus {
    this.calls.push(`play:${id}`)
    if (id === 'nothing') throw new Error(`Unknown cutscene "${id}"`)
    this.status = { id, frame: 0, durationFrames: DURATION, fps: FPS }
    this.outcome = null
    this.paused = false
    return this.status
  }

  seek(frame: number): void {
    this.calls.push(`seek:${frame}`)
    if (this.status !== null) this.status = { ...this.status, frame }
  }

  /** What the director does when a scene leaves, whichever way it left. */
  finish(ending: CutsceneOutcome['ending']): void {
    const open = this.status
    if (open === null) return
    this.calls.push(`finish:${ending}`)
    this.status = null
    this.outcome = { id: open.id, ending, durationFrames: DURATION, fps: FPS }
  }
}

describe('a cutscene session', () => {
  it('reports a scene that ran out as ended, and puts its last frame back', () => {
    const { host, director, calls } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    expect(session.sample()?.ended).toBe(false)

    director.finish('ended')
    const playhead = session.sample()

    expect(playhead?.ended).toBe(true)
    expect(playhead?.durationFrames).toBe(DURATION)
    // The director stops on the final frame and hands the camera back, which
    // leaves whatever the chase camera sees on screen — a composition nobody
    // wrote, as a hard cut on the last beat. Two frames short, not one: the
    // director reports done *on* the final frame, so a re-open at the end
    // would end again on the next sample and loop.
    expect(calls).toContain(`seek:${DURATION - 2}`)
  })

  it('reports a scene stopped by hand as no scene at all', () => {
    /*
     * THE REGRESSION. `stopCutscene` — the console, the Navigate panel's Stop,
     * the player unmounting — produced exactly the evidence the old heuristic
     * read as an ending, so a stop near the end of a scene reopened it within
     * 100 ms and undid itself.
     */
    const { host, director } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', DURATION - 5, false)
    expect(session.sample()).not.toBeNull()

    director.finish('stopped')
    expect(session.sample()).toBeNull()
  })

  it('reports a scene whose world was replaced as no scene at all', () => {
    // A save loaded from the console. Not an ending either.
    const { host, director } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    director.finish('abandoned')
    expect(session.sample()).toBeNull()
  })

  it('handles an ending once, however many times it is sampled', () => {
    const { host, director, calls } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    director.finish('ended')
    session.sample()
    session.sample()
    session.sample()
    expect(calls.filter((one) => one === 'play:tng-intro')).toHaveLength(2)
  })

  it('dismisses the end card on a seek, and keeps the scene', () => {
    // Using the transport is how somebody stops reading the card. Without this
    // it sat over a scene that was visibly somewhere else.
    const { host, director } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    director.finish('ended')
    expect(session.sample()?.ended).toBe(true)

    session.seek(100)
    const after = session.sample()
    expect(after?.ended).toBe(false)
    expect(after).not.toBeNull()
  })

  it('dismisses the end card on play, because that is watching it again', () => {
    const { host, director } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    director.finish('ended')
    session.sample()

    session.toggle()
    expect(session.sample()?.ended).toBe(false)
  })

  it('toggles against the clock, from one place', () => {
    // `toggle` used to be implemented twice, identically, in the player and in
    // the debug transport, each reading `world.clock.paused` for itself.
    const { host, director, calls } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    expect(director.paused).toBe(false)

    session.toggle()
    expect(director.paused).toBe(true)
    session.toggle()
    expect(director.paused).toBe(false)
    expect(calls.filter((one) => one === 'pause' || one === 'resume')).toEqual([
      'pause',
      'resume',
    ])
  })

  it('replays from the top, whether the scene ended or is still open', () => {
    const { host, director, calls } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 1150, false)
    director.finish('ended')
    session.sample()

    calls.length = 0
    session.replay()
    expect(calls).toEqual(['play:tng-intro'])
    // From the top, not from the frame the ending left behind — a replay that
    // opened on the last frame would end immediately.
    expect(session.sample()?.frame).toBe(0)
    expect(session.sample()?.paused).toBe(false)
  })

  it('opens paused at a frame, seeking before pausing', () => {
    /*
     * The order is the rule: `play` un-pauses the clock as part of anchoring
     * the reference timing, so pausing first would be undone. This is the
     * verification pipeline's capture loop — pause, seek, screenshot.
     */
    const { host, calls } = fake()
    const session = createCutsceneSession(host)
    expect(session.open('tng-intro', 1150, false)).toBeNull()
    expect(calls).toEqual(['play:tng-intro', 'seek:1150', 'pause'])
    expect(session.sample()?.paused).toBe(true)
  })

  it('clamps an open past the end rather than opening on nothing', () => {
    const { host, calls } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 99_999, false)
    expect(calls).toContain(`seek:${DURATION - 1}`)
  })

  it('reports why it could not open, by return value', () => {
    // A return value rather than a field to read back, so a component holds it
    // in state instead of reading mutable session state during a render.
    const { host } = fake()
    const session = createCutsceneSession(host)
    expect(session.open('nothing', 0, true)).toContain('Unknown cutscene')
    expect(session.sample()).toBeNull()
  })

  it('freezes the published frame while a pointer owns the scrubber', () => {
    /*
     * The rule every transport needs and none of them owned. A readout that
     * keeps republishing while a hand drags the input fights the hand; both
     * transports used to implement it, one of them by checking a ref inside its
     * own poll.
     */
    const { host, director } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    expect(session.sample()?.frame).toBe(0)

    session.hold(true)
    director.seek(900)
    expect(session.sample()?.frame).toBe(0)

    session.hold(false)
    expect(session.sample()?.frame).toBe(900)
  })

  it('says nothing at all before a scene has ever been opened', () => {
    const { host } = fake()
    expect(createCutsceneSession(host).sample()).toBeNull()
  })
})
