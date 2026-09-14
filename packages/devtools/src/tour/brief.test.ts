import { describe, expect, it } from 'vitest'
import type { SubjectBrief } from '@inertialref/protocol'
import { openSession } from '../session.ts'
import { subjectBrief } from './brief.ts'

const fact = (brief: SubjectBrief, key: string) =>
  brief.facts.find((item) => item.id.endsWith(`.${key}`))!

describe('spoken measurements retain the application record', () => {
  it('reads Saturn at a useful scale while retaining its original quantities and units', () => {
    const session = openSession()
    try {
      const brief = subjectBrief(session.harness, 's:SOL/b:5')!
      const radius = fact(brief, 'radius')
      expect(radius.speech).toContain('60,270 kilometers')
      expect(radius.quantity).toBe(60_268_000)
      expect(radius.unit).toBe('m')
      expect(radius.display).toBe('60268000 m')

      const density = fact(brief, 'density')
      expect(density.speech).toContain('0.6871 grams per cubic centimeter')
      expect(density.quantity).toBeGreaterThan(687)
      expect(density.quantity).toBeLessThan(688)
      expect(density.unit).toBe('kg/m³')
      expect(density.display).toMatch(/^687\..* kg\/m³$/)

      const mass = fact(brief, 'mass')
      expect(mass.speech).toContain(
        '5.683 times ten to the power of twenty-six kilograms',
      )
      expect(mass.quantity).toBe(5.6834e26)
      expect(mass.unit).toBe('kg')
      expect(mass.display).toBe('5.6834e+26 kg')
      expect(fact(brief, 'period').speech).toContain('29.45 years')
      expect(fact(brief, 'axis').speech).toContain('9.537 astronomical units')
    } finally {
      session.dispose()
    }
  })

  it('reads short orbits in hours and long rotations in days without changing their stored units', () => {
    const session = openSession()
    try {
      const phobos = subjectBrief(session.harness, 's:SOL/b:3.0')!
      expect(fact(phobos, 'period').speech).toContain('7.66 hours')
      expect(fact(phobos, 'period').quantity).toBeCloseTo(0.31902172, 8)
      expect(fact(phobos, 'period').unit).toBe('day')
      expect(fact(phobos, 'mass').speech).toContain(
        '1.066 times ten to the power of sixteen kilograms',
      )
      expect(fact(phobos, 'axis').speech).toContain('9,376 kilometers')

      const venus = subjectBrief(session.harness, 's:SOL/b:1')!
      expect(fact(venus, 'rotation').speech).toContain('243.02 days')
      expect(fact(venus, 'rotation').quantity).toBeGreaterThan(5800)
      expect(fact(venus, 'rotation').unit).toBe('h')
    } finally {
      session.dispose()
    }
  })
})
