import { expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { Quaternion as Q, UV, Vec } from '@inertialref/spatial'
import {
  GALAXY_VIEWS,
  isUsableLens,
  type Lens,
  LENS_PRESETS,
} from '@inertialref/rendering'
import { openSession } from './session.ts'
import {
  DEFAULT_PICTURE_PROCESSING,
  type PictureProcessing,
} from './pictures.ts'

it('takes fixed galactic views through the observatory without changing the world', () => {
  const selectedLens = {
    ...LENS_PRESETS.flight,
    shutter: 1 / 250,
    fStop: 8,
    iso: 400,
  }
  const selectedProcessing = {
    ...DEFAULT_PICTURE_PROCESSING,
    mode: 'manual' as const,
  }
  let lens: Lens = selectedLens
  let processing: PictureProcessing = selectedProcessing
  let lensWrites = 0
  let processingWrites = 0
  const session = openSession({
    workers: null,
    render: {
      framingLens: () => lens,
      setFlightLens: (next) => {
        lens = next
        lensWrites++
      },
      cameraProcessing: () => processing,
      setCameraProcessing: (next) => {
        processing = next
        processingWrites++
      },
    },
  })
  try {
    const ir = session.harness
    const before = session.world.stateHash()
    for (const view of ['face-on', 'edge-on'] as const) {
      ir.galaxyView(view)
      const pose = ir.observerSample(0)!
      expect(pose).toEqual(GALAXY_VIEWS[view].pose)
      expect(ir.observatory.eye).toEqual(pose.position)
      expect(ir.observerStatus()?.galaxyView).toBe(view)
      expect(isUsableLens(GALAXY_VIEWS[view].lens)).toBe(true)
      expect(lens).toEqual(selectedLens)
      expect(processing).toEqual(selectedProcessing)
      const direction = Q.basis(pose.orientation).forward
      const center = UV.difference(UV.fromMeters(0, 0, 0), pose.position)
      expect(Vec.dot(direction, Vec.normalize(center))).toBeCloseTo(1, 12)
      expect(Vec.length(center) / PARSEC).toBe(
        view === 'face-on' ? 30000 : 40000,
      )
      ir.observatory.drag(100, 80)
      ir.observatory.zoomNotches(2)
      expect(ir.observerSample(10)).toEqual(pose)
      expect(session.world.stateHash()).toBe(before)
    }
    ir.look('s:SOL/b:2', { ease: false })
    expect(ir.observerStatus()?.galaxyView).toBeNull()
    expect(ir.observerStatus()?.target?.name).toBe('Earth')
    ir.galaxyView('face-on')
    ir.observatory.clear()
    expect(ir.observerSample(0)).toBeNull()
    expect(ir.observerStatus()).toBeNull()
    expect(lensWrites).toBe(0)
    expect(processingWrites).toBe(0)
    expect(session.world.stateHash()).toBe(before)
  } finally {
    session.dispose()
  }
})

it('rejects an unknown fixed view before changing the observatory', () => {
  const session = openSession({ workers: null })
  try {
    const ir = session.harness
    ir.look('s:SOL/b:2', { ease: false })
    const pose = ir.observerSample(0)
    expect(() => ir.galaxyView('constructor' as 'face-on')).toThrow(
      'Unknown galaxy view',
    )
    expect(ir.observerSample(0)).toEqual(pose)
  } finally {
    session.dispose()
  }
})
