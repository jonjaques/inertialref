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
      // The session's play is a held one; see `CutsceneHost.play`.
      play: (id) => director.play(id, true),
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
  hold = false
  readonly calls: string[]

  constructor(calls: string[]) {
    this.calls = calls
  }

  play(id: string, hold = false): CutsceneStatus {
    this.calls.push(`play:${id}`)
    if (id === 'nothing') throw new Error(`Unknown cutscene "${id}"`)
    this.status = { id, frame: 0, durationFrames: DURATION, fps: FPS }
    this.outcome = null
    this.paused = false
    this.hold = hold
    return this.status
  }

  seek(frame: number): void {
    this.calls.push(`seek:${frame}`)
    if (this.status !== null) this.status = { ...this.status, frame }
    // A seek away from a held end is the scene playing again.
    if (this.outcome?.ending === 'ended') this.outcome = null
  }

  /** The playhead runs off the end: held, it parks; otherwise it leaves. */
  end(): void {
    const open = this.status
    if (open === null) return
    if (!this.hold) {
      this.finish('ended')
      return
    }
    this.calls.push('hold')
    this.status = { ...open, frame: DURATION - 1 }
    this.paused = true
    this.outcome = {
      id: open.id,
      ending: 'ended',
      durationFrames: DURATION,
      fps: FPS,
    }
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
  it('reports a scene that ran out as ended, on its last frame', () => {
    const { host, director, calls } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    expect(session.sample()?.ended).toBe(false)

    director.end()
    const playhead = session.sample()

    expect(playhead?.ended).toBe(true)
    expect(playhead?.frame).toBe(DURATION - 1)
    expect(playhead?.paused).toBe(true)
    /*
     * THE REGRESSION. The director used to restore the player on the final
     * frame and the session reopened the scene two frames short a sample
     * later — up to 125 ms of the chase camera on whatever body the ship was
     * left at, and a terrain streamer that had dropped every patch of the
     * one the scene was on. The last frame is held on stage now; nothing
     * here plays or seeks to put it back.
     */
    expect(calls.filter((one) => one.startsWith('play:'))).toHaveLength(1)
    expect(calls.filter((one) => one.startsWith('seek:'))).toHaveLength(0)
  })

  it('reports a scene stopped by hand as no scene at all', () => {
    /*
     * `stopCutscene` — the console, the Navigate panel's Stop, the player
     * unmounting — produced exactly the evidence the old heuristic read as an
     * ending, so a stop near the end of a scene reopened it within 100 ms and
     * undid itself.
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

  it('keeps the card up, however many times the held end is sampled', () => {
    const { host, director } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    director.end()
    expect(session.sample()?.ended).toBe(true)
    expect(session.sample()?.ended).toBe(true)
    expect(session.sample()?.ended).toBe(true)
  })

  it('dismisses the end card on a seek, and keeps the scene', () => {
    // Using the transport is how somebody stops reading the card. Without this
    // it sat over a scene that was visibly somewhere else.
    const { host, director } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    director.end()
    expect(session.sample()?.ended).toBe(true)

    session.seek(100)
    const after = session.sample()
    expect(after?.ended).toBe(false)
    expect(after).not.toBeNull()
  })

  it('shows the end card after a scene that was paused and resumed on the way', () => {
    /*
     * `dismissed` used to conflate two things: "hide the card that is up" and
     * "suppress any future card". Pausing mid-scene is an ordinary act — the
     * transport exists for it — and it silently cost the ending its card, and
     * with it the Replay button that lives there.
     */
    const { host, director } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    session.toggle() // pause, part way through
    session.toggle() // and carry on

    director.end()
    expect(session.sample()?.ended).toBe(true)
  })

  it('shows the card again when a dismissed scene is played to its end once more', () => {
    // The other half of the same conflation: a second genuine ending of the
    // same scene has to raise a second card.
    const { host, director } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    director.end()
    expect(session.sample()?.ended).toBe(true)

    session.seek(100) // dismiss the card and go back into the scene
    expect(session.sample()?.ended).toBe(false)

    director.end()
    expect(session.sample()?.ended).toBe(true)
  })

  it('plays an ended scene again from the top', () => {
    /*
     * The director holds the last frame, so a plain resume there walks off
     * the end on the next sample and parks again — a Play button that does
     * nothing anybody can see. Play at the end is watching it again.
     */
    const { host, director, calls } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    director.end()
    session.sample()

    calls.length = 0
    session.toggle()
    expect(calls).toEqual(['seek:0', 'resume'])
    expect(session.sample()?.ended).toBe(false)
    expect(session.sample()?.frame).toBe(0)
  })

  it('plays from the top after the card was dismissed on the last frame', () => {
    // "Stay on the last frame", then Play: the playhead is still on the last
    // frame, so the same rule applies whether or not the card is up.
    const { host, director, calls } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    director.end()
    session.sample()
    session.seek(DURATION - 1)

    calls.length = 0
    session.toggle()
    expect(calls).toEqual(['seek:0', 'resume'])
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
    director.end()
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

  it('leaves a scene it did not open alone when it ends', () => {
    /*
     * THE FROZEN WORLD. `sample()` runs on the engine store's sampler, which
     * is session-wide and keeps running with no cinema mounted — so a scene
     * started from the console (`ir.play('tng-intro')`, which every driven
     * measurement does) ends by restoring the player and the clock, and a
     * session that claimed it would have paused the clock to hold a picture
     * nobody had asked for. Every flight and warp figure taken after that
     * described a world that was not advancing, with nothing on screen to
     * say so.
     */
    const { host, director, calls } = fake()
    const session = createCutsceneSession(host)

    // Not through `session.open`: the console, the harness, a driver script.
    director.play('tng-intro')
    expect(session.sample()?.id).toBe('tng-intro')

    director.end()
    expect(session.sample()).toBeNull()
    expect(calls).not.toContain('pause')
    expect(director.paused).toBe(false)
  })

  it('raises no card for a held scene somebody else opened', () => {
    // `ir.play(id, { hold: true })` from the console: the director parks the
    // last frame, and that is all anybody asked for.
    const { host, director } = fake()
    const session = createCutsceneSession(host)
    director.play('tng-intro', true)
    director.end()
    const playhead = session.sample()
    expect(playhead?.frame).toBe(DURATION - 1)
    expect(playhead?.ended).toBe(false)
  })

  it('stops reacting to an ending the moment the player leaves', () => {
    // The window is one sample wide and the sampler is 8 Hz. `stop()` drops the
    // claim *before* it stops the director, so an ending that arrives in the
    // same beat the player navigates away has nothing left to react to it.
    const { host, director, calls } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)

    director.end()
    session.stop()
    expect(session.sample()).toBeNull()
    expect(session.sample()).toBeNull()
    expect(calls).toContain('finish:stopped')
  })

  it('drops its claim when an open fails, rather than keeping the last one', () => {
    /*
     * The claim is the *id*, and it is cleared before `host.play` rather than
     * after. A session that opened A and then fails to open B has no scene of
     * its own — but a flag set by the last successful open still reads as one,
     * so whatever ends next gets a card for a reader who is looking at an
     * error message.
     */
    const { host, director } = fake()
    const session = createCutsceneSession(host)
    session.open('tng-intro', 0, true)
    expect(session.open('nothing', 0, true)).toContain('Unknown cutscene')

    // Something else entirely, from the console, held.
    director.play('tng-intro', true)
    director.end()

    expect(session.sample()?.ended).toBe(false)
  })

  it('says nothing at all before a scene has ever been opened', () => {
    const { host } = fake()
    expect(createCutsceneSession(host).sample()).toBeNull()
  })
})
