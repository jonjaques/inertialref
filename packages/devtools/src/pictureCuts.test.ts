import { describe, expect, it, vi } from 'vitest'
import { loadCatalog, TEST_VOLUME, TEST_CATALOG } from '@inertialref/universe'
import { openSession } from './session.ts'

const PORTRAIT_CATALOG = loadCatalog({
  ...TEST_VOLUME,
  stars: [
    ...TEST_VOLUME.stars,
    { ...TEST_VOLUME.stars[1]!, id: 'HIP8102', commonName: 'Portrait fixture' },
  ],
})

const PROXIMA = 'g:milky-way/s:HIP70890/b:0'

describe('declared camera cuts', () => {
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
