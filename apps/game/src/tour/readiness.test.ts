import { describe, expect, it } from 'vitest'
import { subjectView, ViewReadiness } from './readiness.ts'

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

describe('what a tour waits for at its subject', () => {
  const scene = {
    bodies: [{ address: 'earth' }],
    stars: [{ system: 'SOL' }],
    stations: [{ address: 'iss' }],
  }
  const textures = () => true
  const NONE: ReadonlySet<string> = new Set()

  it('finds a station among the stations, and waits for its model', () => {
    // Looked for among the bodies alone, the ISS was never present and a
    // `go_to` it never arrived.
    const iss = { address: 'iss', system: 'SOL', kind: 'station' }
    expect(subjectView(scene, iss, textures, NONE)).toEqual({
      present: true,
      assets: false,
    })
    expect(subjectView(scene, iss, textures, new Set(['iss']))).toEqual({
      present: true,
      assets: true,
    })
  })

  it('keeps a body to its textures and a star to its system', () => {
    const earth = { address: 'earth', system: 'SOL', kind: 'planet' }
    expect(subjectView(scene, earth, () => false, NONE)).toEqual({
      present: true,
      assets: false,
    })
    const sol = { address: 's:SOL', system: 'SOL', kind: 'star' }
    expect(subjectView(scene, sol, textures, NONE)).toEqual({
      present: true,
      assets: true,
    })
    const gone = { address: 'gone', system: 'X', kind: 'planet' }
    expect(subjectView(scene, gone, textures, NONE).present).toBe(false)
  })
})
