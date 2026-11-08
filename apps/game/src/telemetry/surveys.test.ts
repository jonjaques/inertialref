import { describe, expect, it } from 'vitest'
import { parseSurvey, sentProperties } from './surveys.ts'

/** A launched API survey as PostHog's surveys endpoint returns one. */
const raw = {
  id: '0190-tour',
  name: 'After a tour',
  type: 'api',
  end_date: null,
  current_iteration: null,
  questions: [
    {
      id: 'q-rating',
      type: 'rating',
      question: 'How was the tour?',
      scale: 5,
      lowerBoundLabel: 'Lost',
      upperBoundLabel: 'Wonderful',
    },
    {
      id: 'q-why',
      type: 'open',
      question: 'Anything the guide should have done?',
      optional: true,
    },
  ],
}

describe('PostHog surveys in this interface', () => {
  it('draws a launched API survey whose every question it can draw', () => {
    const survey = parseSurvey(raw)
    expect(survey?.questions.map((q) => q.type)).toEqual(['rating', 'open'])
    expect(survey?.iteration).toBeNull()
  })

  it('refuses a popover survey, a stopped one, and one it can only half draw', () => {
    expect(parseSurvey({ ...raw, type: 'popover' })).toBeNull()
    expect(parseSurvey({ ...raw, end_date: '2026-11-01T00:00:00Z' })).toBeNull()
    expect(
      parseSurvey({
        ...raw,
        questions: [
          ...raw.questions,
          { id: 'q3', type: 'link', question: 'Go' },
        ],
      }),
    ).toBeNull()
  })

  it('sends answers as PostHog’s results read them: strings, by question id', () => {
    const survey = parseSurvey(raw)!
    expect(sentProperties(survey, { 'q-rating': '4' }, 'sub-1')).toEqual({
      $survey_id: '0190-tour',
      $survey_name: 'After a tour',
      $survey_submission_id: 'sub-1',
      $survey_completed: true,
      $survey_questions: [
        { id: 'q-rating', question: 'How was the tour?', response: '4' },
        {
          id: 'q-why',
          question: 'Anything the guide should have done?',
          response: null,
        },
      ],
      '$survey_response_q-rating': '4',
      $set: { '$survey_responded/0190-tour': true },
    })
  })
})
