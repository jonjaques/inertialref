import { describe, expect, it } from 'vitest'
import {
  boundaryOf,
  CLASSIFY,
  classifyStep,
  dropFindings,
  dropsOf,
  markCloudsOnly,
  rangeCheck,
  verdictOf,
} from './classify.mjs'
import { provenance, role } from './sheet.mjs'

/*
 * One fixture of each kind, as the evidence `classify.mjs` gathers from a
 * cast: the flagged step (its residual past the motion, and that motion),
 * the series at the cast's two frames and at the settled stills of the same
 * path frames, and the log between them. Luminance in 8-bit levels, the
 * motion 1 level a frame, the step 6 levels darker, as a deck's edge is.
 */

const step = (over = {}) => ({
  series: 'cell 1,2',
  from: 40,
  to: 41,
  span: 1,
  expected: -1,
  residual: -6,
  threshold: 1.02,
  ...over,
})

/** Log entries from path frame 40 to 41: opacity live, the range given. */
const entries = (ranges, { resets = [1, 1], opacity = 0.2 } = {}) =>
  ranges.map((range, i) => ({ k: 40 + i, range, opacity, resets: resets[i] }))

describe('a flagged step, classified', () => {
  it('calls a real entry what the stills hold with the range falling through 2 km', () => {
    const finding = classifyStep({
      step: step(),
      cast: { a: 180, b: 173 },
      settled: { a: 181, b: 174 },
      entries: entries([2600, 1400]),
    })
    expect(finding).toMatchObject({ kind: 'entry', fails: false })
  })

  it('calls an exit what the stills hold with the range leaving, a null range being clear', () => {
    const finding = classifyStep({
      step: step({ residual: 6, expected: 1 }),
      cast: { a: 173, b: 180 },
      settled: { a: 174, b: 181 },
      entries: entries([900, null]),
    })
    expect(finding).toMatchObject({ kind: 'exit', fails: false })
  })

  it('calls a handover error what the stills hold with the eye at no boundary', () => {
    // A switch that depends on pose sits in the stills too: agreement alone
    // would have passed it.
    const finding = classifyStep({
      step: step(),
      cast: { a: 180, b: 173 },
      settled: { a: 181, b: 174 },
      entries: entries([8000, 7900]),
    })
    expect(finding).toMatchObject({
      kind: 'error',
      cause: 'handover',
      fails: true,
    })
  })

  it('calls a reconstruction error a step the stills lack, where the history reset', () => {
    const finding = classifyStep({
      step: step(),
      cast: { a: 180, b: 173 },
      settled: { a: 180, b: 179 },
      entries: entries([8000, 7900], { resets: [3, 4] }),
    })
    expect(finding).toMatchObject({
      kind: 'error',
      cause: 'reconstruction',
      fails: true,
    })
  })

  it('calls a reconstruction error a step that leaves its still with no reset', () => {
    const finding = classifyStep({
      step: step(),
      cast: { a: 180, b: 173 },
      settled: { a: 180, b: 179 },
      entries: entries([8000, 7900]),
    })
    expect(finding).toMatchObject({ kind: 'error', cause: 'reconstruction' })
  })

  it('calls a cache error a step that lands on its still from off it', () => {
    // The cast sat 7 levels off its still, stale, and the refresh put it back.
    const finding = classifyStep({
      step: step(),
      cast: { a: 187, b: 179 },
      settled: { a: 180, b: 179 },
      entries: entries([8000, 7900]),
    })
    expect(finding).toMatchObject({
      kind: 'error',
      cause: 'cache',
      fails: true,
    })
  })

  it('leaves unresolved a step with no settled sample, and it cannot pass', () => {
    const finding = classifyStep({
      step: step(),
      cast: null,
      settled: { a: 0, b: null },
      entries: entries([2600, 1400]),
    })
    expect(finding).toMatchObject({ kind: 'unresolved', fails: true })
    expect(finding.reason).toContain('path frame 41')
  })

  it('leaves unresolved a held change where neither the readout nor the field can place the eye', () => {
    const finding = classifyStep({
      step: step(),
      cast: { a: 180, b: 173 },
      settled: { a: 181, b: 174 },
      entries: entries([null, null], { opacity: null }),
    })
    expect(finding).toMatchObject({ kind: 'unresolved', fails: true })
  })

  it('reads the boundary from the CPU field where the log carries no readout', () => {
    const density = new Map([
      [40, 0],
      [41, 0.3],
    ])
    const finding = classifyStep({
      step: step(),
      cast: { a: 180, b: 173 },
      settled: { a: 181, b: 174 },
      entries: entries([null, null], { opacity: null }),
      fieldAt: (entry) => density.get(entry.k),
    })
    expect(finding).toMatchObject({ kind: 'entry', fails: false })
  })

  it('reads a changed-pixel step by the stills’ own count against the same motion', () => {
    const changed = step({ series: 'changed', expected: 1000, residual: 9000 })
    expect(
      classifyStep({
        step: changed,
        cast: { a: 300, b: 300 },
        settled: { a: 0, b: 0, d: 9500 },
        entries: entries([2600, 1400]),
      }).kind,
    ).toBe('entry')
    expect(
      classifyStep({
        step: changed,
        cast: { a: 300, b: 9000 },
        settled: { a: 0, b: 0, d: 1100 },
        entries: entries([2600, 1400]),
      }),
    ).toMatchObject({ kind: 'error', cause: 'reconstruction' })
  })

  it('holds a change carried at half the cast’s step, and not under it', () => {
    const at = (carried) =>
      classifyStep({
        step: step(),
        cast: { a: 180, b: 173 },
        settled: { a: 180, b: 180 - 1 + carried },
        entries: entries([2600, 1400]),
      }).kind
    expect(at(-6 * CLASSIFY.holds)).toBe('entry')
    expect(at(-6 * CLASSIFY.holds + 0.1)).toBe('error')
  })
})

describe('the boundary', () => {
  it('crosses at 2 km, by the range where the readout is live', () => {
    expect(boundaryOf(entries([2001, 1999]))).toEqual({
      crossed: true,
      kind: 'entry',
      by: 'range',
    })
    expect(boundaryOf(entries([2500, 2100]))).toEqual({
      crossed: false,
      kind: null,
      by: 'range',
    })
  })

  it('cannot answer with no readout and no field', () => {
    expect(boundaryOf(entries([null, null], { opacity: null }))).toBe(null)
  })
})

describe('a drop the clouds alone make', () => {
  // The ruling's third fixture: G6 drops at the same heights with the clouds
  // on and off, so the descent drops them; a drop the clouds-on arm makes
  // where the clouds-off arm does not, within ten path frames, is the clouds'.
  const on = [{ frame: 189 }, { frame: 200 }, { frame: 582 }, { frame: 430 }]
  const off = [{ frame: 183 }, { frame: 196 }, { frame: 582 }]

  it('is marked where the control dropped nothing within ten path frames', () => {
    expect(markCloudsOnly(on, off).map((one) => one.cloudsOnly)).toEqual([
      false,
      false,
      false,
      true,
    ])
  })

  it('keeps a mark the record already carries', () => {
    expect(
      markCloudsOnly([{ frame: 189, cloudsOnly: true }], off)[0].cloudsOnly,
    ).toBe(true)
  })

  it('is a finding of its own kind, listed and never masked', () => {
    const findings = dropFindings(markCloudsOnly(on, off))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'clouds-only-drop', from: 430 })
    expect(verdictOf(findings)).toMatchObject({ drops: 1, errors: 0 })
  })
})

describe('the record a classification is written into', () => {
  // A record as the capture writes it: each cast with its provenance, its
  // role and its rate from `sheet.mjs`'s own builders.
  const run = {
    commit: 'c1',
    clean: true,
    fixtures: { references: 'r', cornerstones: 'c' },
  }
  const page = { stance: { address: 'g:x' }, processing: 'enhanced' }
  const rate = { hz: 60, held: true, atSixty: true }
  const cast = (name, clouds, dropped) => ({
    name,
    id: 'weather-g6-descent',
    speed: 'slow',
    clouds,
    control: clouds ? 'weather-g6-descent-slow-off' : null,
    dropped,
    ...provenance(run, 'weather-g6-descent', page, role('candidate'), rate),
  })
  const record = {
    casts: [
      cast('weather-g6-descent-slow-on', true, [{ frame: 430 }]),
      cast('weather-g6-descent-slow-off', false, [{ frame: 182 }]),
    ],
  }

  it('reads the drops of a cast the capture kept', () => {
    const { drops } = dropsOf(record, 'weather-g6-descent-slow-on')
    expect(drops).toEqual([{ frame: 430, cloudsOnly: true }])
  })

  it('refuses a cast the record itself would refuse', () => {
    const { rate: _, ...rateless } = record.casts[0]
    expect(() =>
      dropsOf({ casts: [rateless] }, 'weather-g6-descent-slow-on'),
    ).toThrow(/carries no rate; the record is refused/)
    const { levers: __, ...leverless } = record.casts[0]
    expect(() =>
      dropsOf({ casts: [leverless] }, 'weather-g6-descent-slow-on'),
    ).toThrow(/carries no levers/)
  })
})

describe('a cast’s verdict', () => {
  it('fails on an error or an unresolved finding, and passes on entries alone', () => {
    const kinds = (list) =>
      verdictOf(
        list.map((kind) => ({
          kind,
          fails: kind === 'error' || kind === 'unresolved',
        })),
      )
    expect(kinds(['entry', 'exit']).passes).toBe(true)
    expect(kinds(['entry', 'error']).passes).toBe(false)
    expect(kinds(['unresolved']).passes).toBe(false)
  })
})

describe('C6’s range', () => {
  const log = (ranges) => ranges.map((range, k) => ({ k, range, opacity: 0.1 }))

  it('passes a path clear at both ends with a cloud between', () => {
    expect(rangeCheck(log([null, 2400, 600, 150, 900, 2600]), 6)).toEqual({
      first: null,
      last: 2600,
      least: 150,
      passes: true,
    })
  })

  it('fails a path that starts inside 2 km, or never falls under it', () => {
    expect(rangeCheck(log([1500, 600, 2600]), 3).passes).toBe(false)
    expect(rangeCheck(log([3000, 2500, 2600]), 3).passes).toBe(false)
  })

  it('reads only the path, not the tail recorded past it', () => {
    expect(rangeCheck(log([2400, 600, 2600, 900]), 3).passes).toBe(true)
  })

  it('says nothing without a live readout', () => {
    expect(
      rangeCheck(
        [
          { k: 0, range: null, opacity: null },
          { k: 1, range: null, opacity: null },
        ],
        2,
      ),
    ).toBe(null)
  })
})
