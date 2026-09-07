import { expect, it } from 'vitest'
import { openSession } from '@inertialref/devtools'
import { presentationClock } from './time.ts'

it('routes shared transport controls to photographic time while a preset holds it', () => {
  const session = openSession({ workers: null })
  try {
    const observer = session.harness.observatory
    const paused = session.world.clock.paused
    const scale = session.world.clock.timeScale
    observer.setTime(120)
    const controls = presentationClock(session)
    controls.setPaused(false)
    controls.setTimeScale(100)
    expect(observer.timePaused).toBe(false)
    expect(observer.timeScale).toBe(100)
    expect(session.world.clock.paused).toBe(paused)
    expect(session.world.clock.timeScale).toBe(scale)
    observer.clear()
    expect(presentationClock(session)).toBe(session.world.clock)
  } finally {
    session.dispose()
  }
})
