import { describe, expect, it, vi } from 'vitest'
import { loadCatalog, TEST_VOLUME, TEST_CATALOG } from '@inertialref/universe'
import { openSession } from './session.ts'
import { findPicture } from './pictures.ts'

const PORTRAIT_CATALOG = loadCatalog({
  ...TEST_VOLUME,
  stars: [
    ...TEST_VOLUME.stars,
    { ...TEST_VOLUME.stars[1]!, id: 'HIP8102', commonName: 'Portrait fixture' },
  ],
})

const PROXIMA = 'g:milky-way/s:HIP70890/b:0'

describe('declared camera cuts', () => {
  it('releases the Far Shore preset camera once, without cuts while idle', () => {
    const declareCut = vi.fn()
    const session = openSession({ render: { declareCut } })
    const ir = session.harness
    try {
      ir.preset('far-shore')
      expect(ir.observatory.sample(0)).not.toBeNull()
      declareCut.mockClear()
      ir.observatory.clear()
      expect(ir.observatory.sample(0)).toBeNull()
      expect(declareCut).toHaveBeenCalledTimes(1)
      declareCut.mockClear()
      ir.observatory.clear()
      expect(declareCut).not.toHaveBeenCalled()
    } finally {
      session.dispose()
    }
  })

  it('restores a changed pose at the same preset body and time', () => {
    const declareCut = vi.fn()
    const session = openSession({ render: { declareCut } })
    const ir = session.harness
    const preset = findPicture('far-shore')
    try {
      ir.preset(preset.id)
      ir.ascend()
      const saved = ir.capturePicture('shore-orbit', 'Above the Far Shore')
      const pose = ir.observatory.sample(0)
      ir.observatory.setAngles(1.2, -0.2, false)
      expect(ir.observatory.sample(0)).not.toEqual(pose)
      const changed = ir.capturePicture('changed', 'Changed')
      expect(changed.address).toBe(saved.address)
      expect(changed.time).toBe(saved.time)
      const hash = session.world.stateHash()
      declareCut.mockClear()
      ir.takePicture(saved)
      expect(ir.observatory.sample(0)).toEqual(pose)
      expect(session.world.stateHash()).toBe(hash)
      expect(declareCut).toHaveBeenCalledTimes(1)
      declareCut.mockClear()
      expect(() =>
        ir.takePicture({ ...saved, seed: 'another universe' }),
      ).toThrow()
      expect(declareCut).not.toHaveBeenCalled()
    } finally {
      session.dispose()
    }
  })

  it('declares a galaxy camera handoff and its release', () => {
    const declareCut = vi.fn()
    const session = openSession({ render: { declareCut } })
    const ir = session.harness
    try {
      ir.observatory.viewGalaxy('face-on')
      expect(ir.observatory.sample(0)).not.toBeNull()
      expect(declareCut).toHaveBeenCalled()
      declareCut.mockClear()
      ir.observatory.clear()
      expect(ir.observatory.sample(0)).toBeNull()
      expect(declareCut).toHaveBeenCalledTimes(1)
    } finally {
      session.dispose()
    }
  })

  it('declares a successful external-system load, leaving failed loads quiet', () => {
    const declareCut = vi.fn()
    const session = openSession({
      catalog: TEST_CATALOG,
      render: { declareCut },
    })
    const ir = session.harness
    try {
      ir.orbit(PROXIMA, 400)
      const save = ir.save()
      declareCut.mockClear()
      expect(ir.load('not a save').ok).toBe(false)
      expect(declareCut).not.toHaveBeenCalled()
      expect(ir.load(save).ok).toBe(true)
      expect(declareCut).toHaveBeenCalledTimes(1)
    } finally {
      session.dispose()
    }
  })

  it('declares discontinuities outside Sol and preserves continuous framing', () => {
    const declareCut = vi.fn()
    const session = openSession({
      catalog: TEST_CATALOG,
      render: { declareCut },
    })
    const ir = session.harness
    try {
      ir.orbit(PROXIMA, 400)
      expect(declareCut).toHaveBeenCalled()
      declareCut.mockClear()
      ir.look(PROXIMA, { ease: false })
      expect(declareCut).toHaveBeenCalled()
      declareCut.mockClear()
      ir.look(PROXIMA, { ease: true, fill: 0.5 })
      ir.observatory.sample(1 / 60)
      expect(declareCut).not.toHaveBeenCalled()
      ir.look('g:milky-way/s:HIP70890/b:1', { ease: true })
      expect(declareCut).toHaveBeenCalled()
      declareCut.mockClear()
      ir.visit(PROXIMA, { latitude: 10, longitude: 20, height: 50 })
      expect(declareCut).toHaveBeenCalled()
      declareCut.mockClear()
      ir.ascend()
      expect(declareCut).toHaveBeenCalled()
      declareCut.mockClear()
      expect(ir.load(ir.save()).ok).toBe(true)
      expect(declareCut).toHaveBeenCalled()
    } finally {
      session.dispose()
    }
  })

  it('declares authored shot boundaries, but sampling a held Tau Ceti shot is quiet', () => {
    const declareCut = vi.fn()
    const session = openSession({
      catalog: PORTRAIT_CATALOG,
      render: { declareCut },
    })
    const ir = session.harness
    try {
      ir.play('enterprise-portraits')
      expect(declareCut).toHaveBeenCalled()
      ir.cutsceneSample(100)
      declareCut.mockClear()
      ir.cutsceneSample(105)
      ir.cutsceneSample(105)
      expect(declareCut).not.toHaveBeenCalled()
      ir.cutsceneSample(110)
      expect(declareCut).toHaveBeenCalledTimes(1)
      declareCut.mockClear()
      ir.cutscenePeek(500)
      expect(declareCut).not.toHaveBeenCalled()
      ir.seekCutscene(20)
      expect(declareCut).toHaveBeenCalledTimes(1)
      declareCut.mockClear()
      ir.seekCutscene(Number.NaN)
      expect(declareCut).not.toHaveBeenCalled()
      ir.stopCutscene()
      expect(declareCut).toHaveBeenCalledTimes(1)
    } finally {
      session.dispose()
    }
  })
})
