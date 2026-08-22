import { describe, expect, it } from 'vitest'
import { UV } from '@inertialref/spatial'
import { openSession } from './session.ts'
import { sampleIsFinite } from './cutscene.ts'
import { TNG_INTRO } from './cutscenes/tngIntro.ts'

/*
 * The cutscene director, held to the reference edit's measured numbers.
 *
 * The script exists to be diffable against a frame-analysed reference, so
 * these tests assert the measurements themselves: title fade windows, the
 * credit grid, the warp-flash shape, the locked camera, and the hard cut.
 * A change that shifts any of these is a change to the recreation's fidelity
 * and should have to say so.
 */

const FPS = TNG_INTRO.fps

function playing() {
  const session = openSession()
  const harness = session.harness
  harness.play('tng-intro')
  // Any epoch works — the first sample anchors frame 0 to it.
  const at = (frame: number) => harness.cutsceneSample(100 + frame / FPS)
  expect(at(0)).not.toBeNull()
  return { session, harness, at }
}

function opacity(
  sample: NonNullable<ReturnType<ReturnType<typeof playing>['at']>>,
  id: string,
): number {
  const text = sample.texts.find((candidate) => candidate.id === id)
  if (text === undefined) throw new Error(`no text ${id}`)
  return text.opacity
}

describe('tng-intro timing', () => {
  it('is the reference edit’s length on the reference timebase', () => {
    expect(TNG_INTRO.durationFrames).toBe(2742)
    expect(TNG_INTRO.fps).toBeCloseTo(24000 / 1001, 9)
  })

  it('fires credits 4-9 on the measured 65/67 grid', () => {
    const { at } = playing()
    const grid = [1654, 1719, 1786, 1851, 1918, 1983]
    const ids = ['c4', 'c5', 'c6', 'c7', 'c8', 'c9']
    grid.forEach((start, i) => {
      const id = ids[i] as string
      // Dark just before the threshold crossing, full once the fade lands.
      expect(opacity(at(start - 1)!, id)).toBe(0)
      expect(opacity(at(start + 5)!, id)).toBeCloseTo(1, 6)
    })
  })

  it('shows the logo at f1150 and the subtitle 32 frames later', () => {
    const { at } = playing()
    expect(opacity(at(1149)!, 'logo')).toBe(0)
    expect(opacity(at(1155)!, 'logo')).toBeCloseTo(1, 6)
    expect(opacity(at(1181)!, 'subtitle')).toBe(0)
    expect(opacity(at(1203)!, 'subtitle')).toBeCloseTo(1, 6)
    // Both are gone before the fly-through wipe arrives.
    expect(opacity(at(1264)!, 'logo')).toBe(0)
  })

  it('runs both warp flashes on the measured 4/7/4 envelope', () => {
    const { at } = playing()
    for (const start of [1085, 2382]) {
      expect(at(start - 1)!.effects.flash).toBe(0)
      for (let f = start + 4; f <= start + 11; f += 1)
        expect(at(f)!.effects.flash).toBe(1)
      expect(at(start + 16)!.effects.flash).toBe(0)
    }
  })
})

describe('tng-intro camera discipline', () => {
  it('never moves the camera while a title is on screen', () => {
    const { at } = playing()
    const lock = at(1120)!.camera
    // Every frame with visible text in scenes B and C: the measured
    // constraint is that all dynamism is the ship's.
    for (let f = 1100; f <= 2613; f += 7) {
      const sample = at(f)!
      const anyText = sample.texts.some((text) => text.opacity > 1e-3)
      if (!anyText) continue
      expect(UV.distance(sample.camera.position, lock.position)).toBeLessThan(
        1e-6,
      )
      const q = sample.camera.orientation
      const dot = Math.abs(
        q.x * lock.orientation.x +
          q.y * lock.orientation.y +
          q.z * lock.orientation.z +
          q.w * lock.orientation.w,
      )
      expect(dot).toBeGreaterThan(1 - 1e-9)
    }
  })

  it('keeps the f240 join a hard cut and the journey continuous', () => {
    const { at } = playing()
    // The match cut: a real discontinuity between the Earth stage and the
    // journey stage.
    const before = at(239)!.camera.position
    const after = at(240)!.camera.position
    expect(UV.distance(before, after)).toBeGreaterThan(1e9)
    // But inside the journey the route is continuous. The bound is the
    // route's own local speed rather than a constant — the fast legs cover
    // AU-scale distances per frame legitimately. A smooth curve's half-frame
    // step is ~1/6 of the surrounding three-frame span; a splice-bug jump
    // makes the two nearly equal, so half the span cleanly separates them.
    for (let f = 245; f < 1083; f += 3) {
      const halfStep = UV.distance(
        at(f)!.camera.position,
        at(f + 0.5)!.camera.position,
      )
      const span = UV.distance(
        at(f - 1)!.camera.position,
        at(f + 2)!.camera.position,
      )
      expect(halfStep).toBeLessThan(span * 0.5 + 10)
    }
  })

  it('emits finite poses across the whole piece', () => {
    const { at } = playing()
    for (let f = 0; f < 2742; f += 25) {
      const sample = at(f)!
      expect(sampleIsFinite(sample), `frame ${f}`).toBe(true)
      expect(sample.effects.blackout).toBeGreaterThanOrEqual(0)
      expect(sample.effects.blackout).toBeLessThanOrEqual(1)
    }
  })
})

describe('cutscene director lifecycle', () => {
  it('restores the player exactly on stop, clock settings included', () => {
    const session = openSession()
    const harness = session.harness
    const player = session.player()!
    session.world.clock.setTimeScale(25)
    // A field-by-field copy: the packages tsconfig has no DOM or Node lib, so
    // `structuredClone` does not exist here, and the state is flat anyway.
    const live = session.world.entities.require(player).state
    const before = {
      frame: live.frame,
      position: { ...live.position },
      velocity: { ...live.velocity },
      orientation: { ...live.orientation },
      angularVelocity: { ...live.angularVelocity },
    }

    harness.play('tng-intro')
    expect(session.world.clock.timeScale).toBe(1)
    // The world keeps ticking underneath the cutscene.
    session.world.runTicks(128)
    harness.cutsceneSample(session.world.clock.time)
    harness.stopCutscene()

    const after = session.world.entities.require(player).state
    expect(after.frame).toBe(before.frame)
    expect(after.position).toEqual(before.position)
    expect(after.velocity).toEqual(before.velocity)
    expect(after.orientation).toEqual(before.orientation)
    expect(session.world.clock.timeScale).toBe(25)
  })

  it('stops itself and restores after the final frame', () => {
    const session = openSession()
    const harness = session.harness
    harness.play('tng-intro')
    expect(harness.cutsceneSample(100)).not.toBeNull()
    expect(
      harness.cutsceneSample(100 + (TNG_INTRO.durationFrames + 5) / FPS),
    ).toBeNull()
    expect(harness.cutsceneStatus()).toBeNull()
  })

  it('seeks to an exact reference frame', () => {
    const { harness, at } = playing()
    at(500)
    harness.seekCutscene(1150)
    const sample = harness.cutsceneSample(100 + 500 / FPS)
    expect(sample!.frame).toBeCloseTo(1150, 6)
  })

  it('abandons cleanly when the world is replaced underneath it', () => {
    const session = openSession()
    const harness = session.harness
    harness.play('tng-intro')
    const save = harness.save()
    const result = harness.load(save)
    expect(result.ok).toBe(true)
    // The captured state belongs to the discarded world; the next sample must
    // not restore it into the new one — it abandons and goes quiet.
    expect(harness.cutsceneSample(100)).toBeNull()
    expect(harness.cutsceneStatus()).toBeNull()
    // And a stop after the abandonment is a harmless no-op.
    harness.stopCutscene()
  })
})
