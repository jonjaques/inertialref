import { describe, expect, it } from 'vitest'
import { calloutLabels, PAD_VIEWS, stickSummary } from './controllerLabels.ts'
import { resolvePadBindings } from './keymap.ts'

/*
 * The picture says what a press would do, which is the dispatcher's answer —
 * shadows included — and not a second reading of the table.
 */

const live = (id: string) =>
  PAD_VIEWS.find((view) => view.id === id)?.live ?? []

describe('calloutLabels', () => {
  it('names a stick by the verbs of its four directions', () => {
    const flight = calloutLabels(resolvePadBindings(), live('flight'))
    expect(flight.get('ls')).toBe('Thrust · Translate')
    expect(flight.get('rs')).toBe('Pitch · Yaw')
    expect(flight.get('south')).toBe('Kill Rotation')
    expect(flight.get('west')).toBe('Pause')
  })

  it('shows the standing stance taking the stick the planetarium looks with', () => {
    const orbit = calloutLabels(resolvePadBindings(), live('planetarium'))
    const ground = calloutLabels(resolvePadBindings(), live('standing'))
    expect(orbit.get('ls')).toBe('Look')
    expect(ground.get('ls')).toBe('Fly')
    expect(ground.get('east')).toBe('Back to Orbit')
  })

  it('follows a rebind, and says nothing for a control that means nothing', () => {
    const moved = calloutLabels(
      resolvePadBindings({ 'flight.kill': 'touchpad' }),
      live('flight'),
    )
    expect(moved.get('touchpad')).toBe('Kill Rotation')
    expect(moved.get('south')).toBeNull()
  })
})

describe('stickSummary', () => {
  it('keeps each verb once, in order, and nothing for an unbound stick', () => {
    expect(
      stickSummary(['Walk forward', 'Walk backward', 'Strafe left', null]),
    ).toBe('Walk · Strafe')
    expect(stickSummary([null, null, null, null])).toBeNull()
  })
})
