import { describe, expect, it } from 'vitest'
import { ViewReadiness } from './readiness.ts'

describe('a tour arrival belongs to a drawn view', () => {
  it('waits for assets and two presented frames after a mutation', () => {
    const readiness = new ViewReadiness()
    const renderer = {}
    expect(
      readiness.ready({
        renderer,
        revision: 1,
        frame: 10,
        present: true,
        assets: false,
      }),
    ).toBe(false)
    expect(
      readiness.ready({
        renderer,
        revision: 1,
        frame: 20,
        present: true,
        assets: false,
      }),
    ).toBe(false)
    expect(
      readiness.ready({
        renderer,
        revision: 1,
        frame: 20,
        present: true,
        assets: true,
      }),
    ).toBe(false)
    expect(
      readiness.ready({
        renderer,
        revision: 1,
        frame: 22,
        present: true,
        assets: true,
      }),
    ).toBe(true)
    expect(
      readiness.ready({
        renderer,
        revision: 2,
        frame: 23,
        present: true,
        assets: true,
      }),
    ).toBe(false)
    expect(
      readiness.ready({
        renderer: {},
        revision: 2,
        frame: 100,
        present: true,
        assets: true,
      }),
    ).toBe(false)
  })
})
