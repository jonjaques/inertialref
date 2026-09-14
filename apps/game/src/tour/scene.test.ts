import { describe, expect, it } from 'vitest'
import { describeView, openSession } from '@inertialref/devtools'
import { GUIDE_LIMITS } from '@inertialref/protocol'
import type { SceneFacts } from './executor.ts'
import {
  arrivalBlock,
  instantSeconds,
  openingLine,
  pictureInstant,
  quietBlock,
  sceneBlock,
  takeoverContext,
  uiContext,
} from './scene.ts'

const facts: SceneFacts = {
  framing: 'wide',
  system: 'Sol',
  planets: ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn'],
  moons: Array.from({ length: 40 }, (_, index) => `Moon ${index + 1}`),
  framings: Array.from({ length: 30 }, (_, index) => `framing-${index}`),
  sites: Array.from({ length: 20 }, (_, index) => ({
    id: `site-${index}`,
    name: `A rather long site name number ${index}`,
  })),
  provenance: 'observed',
}

describe('what the model sees', () => {
  it('writes the scene block inside its byte bound with the view first', () => {
    const session = openSession()
    session.harness.look('s:SOL/b:5', { ease: false })
    session.harness.observatory.compose('wide')
    for (let frame = 0; frame < 600; frame += 1)
      session.harness.observatory.sample(1 / 60)
    const view = describeView(session.harness)
    const block = sceneBlock(view, facts)
    expect(new TextEncoder().encode(block).byteLength).toBeLessThanOrEqual(
      GUIDE_LIMITS.sceneBytes,
    )
    expect(block).toMatch(
      /^Current view: Saturn \(gas-giant, observed\), framing "wide", orbit at/,
    )
    expect(block).toContain('On screen: Saturn (center')
    expect(block).toContain('Not traveling.')
    const arrival = arrivalBlock(
      { tool: 'go_to', subject: 'Saturn', framing: 'wide', viewRevision: 1 },
      view,
      facts,
    )
    expect(
      arrival.startsWith('Arrived: Saturn, framing wide, not traveling.'),
    ).toBe(true)
    expect(arrival.endsWith('Narrate this stop now.')).toBe(true)
    expect(uiContext(view)).toBe(
      `The visitor is now looking at Saturn from orbit at ${view.distanceRadii} radii.`,
    )
    expect(takeoverContext(view)).toMatch(
      /^The visitor has taken the camera; the view is now/,
    )
    expect(openingLine(view, facts, '21:04')).toContain('local time is 21:04')
    session.dispose()
  })
  it('keeps the clock honest in both directions', () => {
    expect(pictureInstant(0)).toBe('2000-01-01T12:00:00Z')
    expect(instantSeconds('2000-01-01T12:00:00Z')).toBe(0)
    expect(instantSeconds('not a date')).toBeNull()
    expect(quietBlock(10)).toBe(
      'The visitor has looked quietly for 10 seconds. Continue the tour with the next stop.',
    )
  })
})
