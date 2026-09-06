import { describe, expect, it } from 'vitest'
import { LENS_PRESETS } from '@inertialref/rendering'
import { TEST_CATALOG } from '@inertialref/universe'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { openSession } from './session.ts'
import { decodePictures, encodePictures } from './pictureFormat.ts'
import { PICTURES } from './pictures.ts'
import { snapshot } from '@inertialref/simulation'

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
