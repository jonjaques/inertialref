import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  Quaternion as Q,
  UV,
  Vec,
  vec3,
  type UniverseVector,
} from '@inertialref/spatial'
import {
  bodyFixedDirection,
  bodyFixedFrameId,
  drawnSurfaceRadius,
  systemId,
} from '@inertialref/universe'
import { verticalFovDegrees } from '@inertialref/rendering'
import { sampleIsFinite } from './cutscene.ts'
import { MARS_LANDING, MARS_PAD_SITE } from './cutscenes/marsLanding.ts'
import { openSession } from './session.ts'

describe('Mars landing', () => {
  it('is available through the Cinema director', () => {
    const { harness } = openSession()
    expect(harness.cutscenes().map((scene) => scene.id)).toContain(
      'mars-landing',
    )
    harness.play('mars-landing')
    expect(harness.cutsceneSample(0)?.ship.visible).toBe(true)
  })

  it('keeps the whole descent and its held ephemeris independent of seek order', () => {
    const { world } = openSession()
    const script = MARS_LANDING.prepare(world)
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1103, noNaN: true }), (frame) => {
        const before = world.stateHash()
        const sample = script.sample(frame)
        script.sample(17)
        expect(script.sample(frame)).toEqual(sample)
        expect(world.stateHash()).toEqual(before)
        expect(sampleIsFinite(sample)).toBe(true)
        expect(sample.presentationTime).toBe(MARS_PAD_SITE.presentationTime)
        expect(sample.ship.model).toBe('rocinante')
        expect(
          Math.hypot(...Object.values(sample.ship.orientation)),
        ).toBeCloseTo(1, 9)
      }),
      { numRuns: 60 },
    )
  })

  it('keeps the camera above the drawn ground and outside the hull for every frame', () => {
    const { world } = openSession()
    const mars = world.loadSystem(systemId('SOL')).planets[3]!
    const spin = world.frames.pose(
      bodyFixedFrameId(mars.address),
      MARS_PAD_SITE.presentationTime,
    )
    const script = MARS_LANDING.prepare(world)
    for (let frame = 0; frame < MARS_LANDING.durationFrames; frame += 1) {
      const sample = script.sample(frame)
      const local = Q.rotateInverse(
        spin.orientation,
        UV.difference(sample.camera.position, spin.position),
      )
      const ground = drawnSurfaceRadius(
        mars,
        bodyFixedDirection(spin, sample.camera.position),
      )
      expect(
        Vec.length(local) - ground,
        `ground clearance at ${frame}`,
      ).toBeGreaterThan(3)
      expect(
        UV.distance(sample.camera.position, sample.ship.position),
        `hull clearance at ${frame}`,
      ).toBeGreaterThan(100)
    }
  })

  it('meets the pad upright, extinguishes the burn, and holds the landed photograph', () => {
    const { world } = openSession()
    const script = MARS_LANDING.prepare(world)
    const end = script.sample(41 * 24)
    const stage = end.stage!
    const offset = Q.rotateInverse(
      stage.orientation,
      UV.difference(end.ship.position, stage.position),
    )
    expect(offset.x).toBeCloseTo(0, 4)
    expect(offset.y).toBeCloseTo(23, 4)
    expect(offset.z).toBeCloseTo(0, 4)
    const nose = Q.rotateInverse(
      stage.orientation,
      Q.rotate(end.ship.orientation, vec3(0, 0, -1)),
    )
    expect(nose.y).toBeCloseTo(1, 9)
    expect(end.ship.throttle).toBe(0)
    expect(script.sample(45 * 24).effects.landingDust).toBe(0)
    expect(script.sample(45 * 24).ship).toEqual(end.ship)
    expect(script.sample(45 * 24).camera).toEqual(end.camera)
    expect(verticalFovDegrees(script.sample(3 * 24).lens)).toBeLessThan(3)
    expect(verticalFovDegrees(script.sample(26 * 24).lens)).toBeGreaterThan(30)
  })

  it('returns the player and clock controls after the scene', () => {
    const { world, harness, player } = openSession()
    const id = player()!
    world.clock.setTimeScale(4)
    world.clock.setPaused(true)
    const before = world.entities.require(id).state
    harness.play('mars-landing')
    harness.cutsceneSample(0)
    harness.stopCutscene()
    expect(world.entities.require(id).state).toEqual(before)
    expect(world.clock.timeScale).toBe(4)
    expect(world.clock.paused).toBe(true)
  })

  it('opens on a readable hull profile and reveals the low Sun beside the pad', () => {
    const { world } = openSession()
    const system = world.loadSystem(systemId('SOL'))
    const script = MARS_LANDING.prepare(world)
    const project = (
      sample: ReturnType<typeof script.sample>,
      at: UniverseVector,
    ) => {
      const local = Q.rotateInverse(
        sample.camera.orientation,
        UV.difference(at, sample.camera.position),
      )
      const half = Math.tan((verticalFovDegrees(sample.lens) * Math.PI) / 360)
      expect(local.z).toBeLessThan(0)
      return {
        x: 0.5 + local.x / (-local.z * half * (16 / 9) * 2),
        y: 0.5 - local.y / (-local.z * half * 2),
      }
    }
    for (const seconds of [0, 4, 8]) {
      const sample = script.sample(seconds * 24)
      const end = (z: number) =>
        project(
          sample,
          UV.translate(
            sample.ship.position,
            Q.rotate(sample.ship.orientation, vec3(0, 0, z)),
          ),
        )
      const nose = end(-23)
      const tail = end(23)
      expect(Math.hypot(nose.x - tail.x, nose.y - tail.y)).toBeGreaterThan(0.27)
      for (const point of [nose, tail]) {
        expect(point.x).toBeGreaterThan(0.1)
        expect(point.x).toBeLessThan(0.9)
        expect(point.y).toBeGreaterThan(0.1)
        expect(point.y).toBeLessThan(0.9)
      }
    }
    for (const seconds of [21, 30, 42]) {
      const sample = script.sample(seconds * 24)
      const sun = project(sample, system.position)
      const pad = project(sample, sample.stage!.position)
      expect(sun.x).toBeGreaterThan(0.15)
      expect(sun.x).toBeLessThan(pad.x - 0.08)
      expect(sun.y).toBeGreaterThan(0.3)
      expect(sun.y).toBeLessThan(0.6)
      expect(pad.y).toBeGreaterThan(0.6)
      expect(pad.y).toBeLessThan(0.85)
    }
  })
})
