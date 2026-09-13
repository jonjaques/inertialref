import { describe, expect, it } from 'vitest'
import { decodeTourContext } from '../../packages/protocol/src/tour.ts'
import {
  TOUR_EVAL_REQUESTS,
  evaluationContext,
  gradeDecision,
} from './fixtures.mjs'

describe('explicit tour evaluation fixtures', () => {
  it('accepts honest projected provenance and bounded discovery without accepting invented movement', () => {
    const projected = TOUR_EVAL_REQUESTS.find((row) => row.id === 'unknown-07')
    expect(
      gradeDecision(
        projected,
        {
          kind: 'explanation',
          actions: [],
          plan: null,
          factIds: ['projection:record'],
        },
        evaluationContext(),
      ).intendedTask,
    ).toBe(true)
    const absent = TOUR_EVAL_REQUESTS.find((row) => row.id === 'unknown-09')
    expect(
      gradeDecision(
        absent,
        {
          kind: 'actions',
          actions: [{ tool: 'resolve_subject', query: 'Completely Invented' }],
          plan: null,
          factIds: [],
        },
        evaluationContext(),
      ).intendedTask,
    ).toBe(true)
    expect(
      gradeDecision(
        absent,
        {
          kind: 'actions',
          actions: [{ tool: 'show_subject', subjectId: 'saturn' }],
          plan: null,
          factIds: [],
        },
        evaluationContext(),
      ).intendedTask,
    ).toBe(false)
    expect(
      gradeDecision(
        absent,
        {
          kind: 'actions',
          actions: [{ tool: 'resolve_subject', query: 'Other object' }],
          plan: null,
          factIds: [],
        },
        evaluationContext(),
      ).intendedTask,
    ).toBe(false)
  })

  it('includes sixty unique requests, ten in each required category', () => {
    expect(TOUR_EVAL_REQUESTS).toHaveLength(60)
    expect(new Set(TOUR_EVAL_REQUESTS.map((row) => row.id)).size).toBe(60)
    const categories = Object.groupBy(TOUR_EVAL_REQUESTS, (row) => row.category)
    expect(Object.keys(categories)).toHaveLength(6)
    expect(Object.values(categories).every((rows) => rows.length === 10)).toBe(
      true,
    )
    expect(decodeTourContext(evaluationContext(), '').ok).toBe(true)
  })
  it('does not score a safe but wrong-subject response as task success', () => {
    const fixture = TOUR_EVAL_REQUESTS.find(
      (row) => row.id === 'corrections-01',
    )
    expect(
      gradeDecision(
        fixture,
        {
          kind: 'actions',
          actions: [{ tool: 'show_subject', subjectId: 'titan' }],
          plan: null,
          factIds: [],
        },
        evaluationContext(),
      ),
    ).toMatchObject({
      intendedTask: false,
      failures: ['requested-subject-missing', 'superseded-subject-selected'],
    })
  })
})
