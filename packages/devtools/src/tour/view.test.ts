import { describe, expect, it } from 'vitest'
import { openSession } from '../session.ts'
import { describeView, placeWord } from './view.ts'

describe('the guide sees the scene without a renderer', () => {
  it('puts a composed subject at the center, lit, and leaves the world untouched', () => {
    const session = openSession()
    const ir = session.harness
    ir.look('s:SOL/b:5', { ease: false })
    ir.observatory.compose('portrait')
    for (let frame = 0; frame < 600; frame += 1) ir.observatory.sample(1 / 60)
    const hash = session.world.stateHash()
    const revision = ir.observatory.mutationRevision
    const view = describeView(ir)
    expect(session.world.stateHash()).toBe(hash)
    expect(ir.observatory.mutationRevision).toBe(revision)
    expect(view.subject?.name).toBe('Saturn')
    expect(view.system?.id).toBe('SOL')
    const saturn = view.onScreen.find((item) => item.name === 'Saturn')!
    expect(saturn.place).toBe('center')
    expect(Math.abs(saturn.x)).toBeLessThan(0.2)
    expect(Math.abs(saturn.y)).toBeLessThan(0.2)
    expect(saturn.extent).toBe('large')
    expect(saturn.lit).toBeGreaterThan(0.5)
    expect(saturn.lit).toBeLessThanOrEqual(1)
    for (const item of view.onScreen) {
      expect(Math.abs(item.x)).toBeLessThanOrEqual(1 + item.size)
      expect(Math.abs(item.y)).toBeLessThanOrEqual(1 + item.size)
      expect(item.lit).toBeGreaterThanOrEqual(0)
    }
    expect(view.onScreen[0]).toBe(saturn)
    expect(view.distanceRadii).toBeGreaterThan(1)
    expect(view.timeMode).toBe('live')
    session.dispose()
  })
  it('reports a crescent as mostly dark and a standing eye with its horizon', () => {
    const session = openSession()
    const ir = session.harness
    ir.look('s:SOL/b:5', { ease: false })
    ir.observatory.compose('crescent')
    for (let frame = 0; frame < 600; frame += 1) ir.observatory.sample(1 / 60)
    const crescent = describeView(ir).onScreen.find(
      (item) => item.name === 'Saturn',
    )!
    expect(crescent.lit).toBeLessThan(0.5)
    ir.look('s:SOL/b:3', { ease: false })
    const site = ir.sites()[0]!
    ir.visit(undefined, { site: site.id })
    const standing = describeView(ir).standing!
    expect(standing.site).toBe(site.id)
    expect(['day', 'twilight', 'night']).toContain(standing.daylight)
    expect(standing.heightMeters).toBeGreaterThan(0)
    session.dispose()
  })
  it('describes nothing before a subject is chosen', () => {
    const session = openSession()
    session.harness.observatory.clear()
    const view = describeView(session.harness)
    expect(view.subject).toBeNull()
    expect(view.onScreen).toEqual([])
    session.dispose()
  })
  it('names places the way a guide would', () => {
    expect(placeWord(0, 0)).toBe('center')
    expect(placeWord(-0.5, 0.5)).toBe('upper left')
    expect(placeWord(0.95, 0)).toBe('right edge')
    expect(placeWord(0, -0.6)).toBe('bottom')
  })
})
