import { describe, expect, it } from 'vitest'
import { LENS_PRESETS } from '@inertialref/rendering'
import { TEST_CATALOG } from '@inertialref/universe'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { openSession } from './session.ts'
import {
  decodePictures,
  encodePictures,
  mergePictures,
} from './pictureFormat.ts'
import { PICTURES } from './pictures.ts'
import { snapshot } from '@inertialref/simulation'
import { UV } from '@inertialref/spatial'

function rig() {
  let lens = LENS_PRESETS.flight
  const session = openSession({
    seed: 'inertialref',
    catalog: TEST_CATALOG,
    workers: () => createInlineWorker(createTaskRegistry()),
    render: {
      framingLens: () => lens,
      setFlightLens: (next) => {
        lens = next
      },
    },
  })
  return session
}

describe('portable pictures', () => {
  it('keeps an orbit camera beside the drawn body across date changes and navigation', () => {
    const session = rig()
    try {
      const observer = session.harness.observatory
      const hash = session.world.stateHash()
      for (const time of [842011200, -86400, 123456, null]) {
        observer.setTime(time)
        for (const address of ['s:SOL/b:2', 's:SOL/b:2.0', 's:SOL/b:2']) {
          observer.focus(address, { ease: false })
          const pose = observer.sample(0)!
          const shot = snapshot(session.world, undefined, observer.time)
          const body = shot.bodies.find(
            (one) => one.address === observer.target!.address,
          )!
          const distance = UV.distance(pose.position, body.position)
          expect(distance).toBeCloseTo(observer.state.distance, 2)
          expect(observer.eye).toEqual(pose.position)
        }
      }
      expect(session.world.stateHash()).toBe(hash)
    } finally {
      session.dispose()
    }
  })
  it('round trips every bundled picture through the public format', () => {
    expect(decodePictures(JSON.parse(encodePictures(PICTURES)))).toEqual(
      PICTURES,
    )
  })
  it('captures and restores a hand-composed surface shot, time and infinite focus without touching the simulation', () => {
    const session = rig()
    try {
      const ir = session.harness
      ir.look('s:SOL/b:2.0', { ease: false })
      ir.observatory.setTime(123456)
      ir.visit('s:SOL/b:2.0', { latitude: 0.2, longitude: -0.5, height: 2000 })
      ir.aim(24, -8)
      const pose = ir.observatory.sample(0)
      const hash = session.world.stateHash()
      const saved = ir.capturePicture('my-shot', 'My Shot')
      const restored = decodePictures(JSON.parse(encodePictures([saved])))[0]!
      ir.look('s:SOL/b:3', { ease: false })
      ir.observatory.setTime(987654)
      ir.takePicture(restored)
      expect(ir.observatory.sample(0)).toEqual(pose)
      expect(ir.observatory.time).toBe(123456)
      expect(ir.capturePicture('my-shot', 'My Shot')).toEqual(saved)
      expect(session.world.stateHash()).toBe(hash)
      const shot = snapshot(session.world, undefined, ir.observatory.time)
      expect(shot.renderTime).toBe(123456)
      const moon = shot.bodies.find((body) => body.address.endsWith('/b:2.0'))!
      expect(moon.position).toEqual(
        session.world.frames.pose(moon.frame, 123456).position,
      )
    } finally {
      session.dispose()
    }
  })
  it('rejects bad versions, duplicate IDs and nonfinite camera numbers', () => {
    expect(() => decodePictures({ version: 99, pictures: [] })).toThrow()
    expect(() =>
      decodePictures(JSON.parse(encodePictures([PICTURES[0]!, PICTURES[0]!]))),
    ).toThrow()
    const session = rig()
    try {
      session.harness.look('s:SOL/b:2')
      const shot = session.harness.capturePicture('test', 'Test')
      const data = JSON.parse(encodePictures([shot]))
      data.pictures[0].framing.state.distance = null
      expect(() => decodePictures(data)).toThrow()
    } finally {
      session.dispose()
    }
  })
  it('keeps cinematic recipes out of planetarium imports', () => {
    const picture = {
      ...PICTURES[0]!,
      framing: { kind: 'cinematic', script: 'enterprise-portraits', frame: 0 },
    }
    expect(() =>
      decodePictures({
        format: 'inertialref/presets',
        version: 1,
        pictures: [picture],
      }),
    ).toThrow()
  })
  it('imports collisions without replacing shots and is idempotent', () => {
    const first = PICTURES[0]!
    const second = { ...first, label: 'Another Shot' }
    const merged = mergePictures([first], [second])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual(first)
    expect(merged[1]!.id).not.toBe(first.id)
    expect(mergePictures(merged, [second])).toEqual(merged)
    const reordered = Object.fromEntries(
      Object.entries(second).reverse(),
    ) as typeof second
    expect(mergePictures(merged, [reordered])).toEqual(merged)
  })
  it('plays photographic time without advancing canonical state and releases it on clear', () => {
    const session = rig()
    try {
      const observer = session.harness.observatory
      const hash = session.world.stateHash()
      observer.setTime(100)
      observer.advanceTime(2)
      expect(observer.time).toBe(100)
      observer.setTimeScale(10)
      observer.setTimePaused(false)
      observer.advanceTime(2)
      expect(observer.time).toBe(120)
      expect(session.world.stateHash()).toBe(hash)
      observer.clear()
      expect(observer.heldTime).toBeNull()
      expect(observer.time).toBe(session.world.clock.renderTime)
    } finally {
      session.dispose()
    }
  })
  it('refuses a surface shot on a gas giant before changing the view', () => {
    const session = rig()
    try {
      const ir = session.harness
      ir.visit('s:SOL/b:2.0', { height: 200 })
      ir.observatory.setTime(123)
      const saved = ir.capturePicture('test', 'Test')
      const before = ir.observatory.status()
      expect(() =>
        ir.takePicture({ ...saved, address: 's:SOL/b:4', time: 456 }),
      ).toThrow(/surface/)
      expect(ir.observatory.status()).toEqual(before)
      expect(() =>
        ir.takePicture({ ...saved, generation: { galaxy: 999 } }),
      ).toThrow(/generation/)
      expect(ir.observatory.status()).toEqual(before)
    } finally {
      session.dispose()
    }
  })
  it('refuses a different universe seed before moving the camera', () => {
    const session = rig()
    try {
      const ir = session.harness
      ir.look('s:SOL/b:2')
      const saved = ir.capturePicture('test', 'Test')
      const before = ir.observatory.status()
      expect(() =>
        ir.takePicture({ ...saved, seed: 'another universe' }),
      ).toThrow(/seed/i)
      expect(ir.observatory.status()).toEqual(before)
    } finally {
      session.dispose()
    }
  })
})
