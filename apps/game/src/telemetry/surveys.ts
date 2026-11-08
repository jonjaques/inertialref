import { loadSurveys, recordEvent } from './client.ts'

/*
 * PostHog surveys in API mode: PostHog holds the questions and the answers,
 * and this interface draws them in its own controls (`hud/SurveyPrompt.tsx`).
 *
 * The SDK's own popover is off (`disable_surveys_automatic_display`): it is a
 * Preact widget with its own type and colors, positioned over a canvas that
 * owns every pixel, and it decides when to appear from display conditions
 * that read person properties — which a personless visitor never has. So
 * every display condition in PostHog stays empty, and this code decides when:
 * the tour survey when a tour ends, the docs one at the end of an article.
 *
 * The three events are PostHog's own names and properties, which is what its
 * survey results read. A rating is sent as a string: the results view reads
 * responses as strings whatever the question type.
 */

/** The surveys this interface draws, by their name in PostHog. */
export const SURVEYS = {
  tour: 'After a tour',
  docs: 'Was this page useful?',
} as const

export type SurveyQuestion =
  | {
      readonly type: 'rating'
      readonly id: string
      readonly question: string
      readonly scale: number
      readonly lowerBoundLabel: string
      readonly upperBoundLabel: string
      readonly optional: boolean
    }
  | {
      readonly type: 'single_choice'
      readonly id: string
      readonly question: string
      readonly choices: readonly string[]
      readonly optional: boolean
    }
  | {
      readonly type: 'open'
      readonly id: string
      readonly question: string
      readonly optional: boolean
    }

export interface Survey {
  readonly id: string
  readonly name: string
  readonly iteration: number | null
  readonly questions: readonly SurveyQuestion[]
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : ''

/** One question as this interface can draw it, or null for a kind it cannot. */
function parseQuestion(raw: unknown): SurveyQuestion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const q = raw as Record<string, unknown>
  const id = text(q['id'])
  const question = text(q['question'])
  if (id === '' || question === '') return null
  const optional = q['optional'] === true
  switch (q['type']) {
    case 'rating': {
      const scale = typeof q['scale'] === 'number' ? q['scale'] : 5
      if (!Number.isInteger(scale) || scale < 2 || scale > 10) return null
      return {
        type: 'rating',
        id,
        question,
        scale,
        lowerBoundLabel: text(q['lowerBoundLabel']),
        upperBoundLabel: text(q['upperBoundLabel']),
        optional,
      }
    }
    case 'single_choice': {
      const choices = Array.isArray(q['choices'])
        ? q['choices'].filter((c): c is string => typeof c === 'string')
        : []
      if (choices.length === 0) return null
      return { type: 'single_choice', id, question, choices, optional }
    }
    case 'open':
      return { type: 'open', id, question, optional }
    default:
      return null
  }
}

/**
 * A launched survey as PostHog's surveys API returns it, or null for one this
 * interface cannot draw in full. A survey with one undrawable question is
 * refused whole: half a survey is answers to questions nobody was asked.
 */
export function parseSurvey(raw: unknown): Survey | null {
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Record<string, unknown>
  const id = text(s['id'])
  const name = text(s['name'])
  if (id === '' || name === '' || s['type'] !== 'api') return null
  if (s['end_date'] !== null && s['end_date'] !== undefined) return null
  const rawQuestions = Array.isArray(s['questions']) ? s['questions'] : []
  const questions = rawQuestions.map(parseQuestion)
  if (questions.length === 0 || questions.includes(null)) return null
  const iteration = s['current_iteration']
  return {
    id,
    name,
    iteration: typeof iteration === 'number' ? iteration : null,
    questions: questions as SurveyQuestion[],
  }
}

/** The launched survey with this name, once PostHog says; never on a page that reports nothing. */
export function findSurvey(
  name: string,
  found: (survey: Survey) => void,
): void {
  loadSurveys((surveys) => {
    for (const raw of surveys) {
      const survey = parseSurvey(raw)
      if (survey?.name === name) {
        found(survey)
        return
      }
    }
  })
}

const base = (survey: Survey): Record<string, unknown> => ({
  $survey_id: survey.id,
  $survey_name: survey.name,
  ...(survey.iteration === null ? {} : { $survey_iteration: survey.iteration }),
})

export function surveyShown(
  survey: Survey,
  context: Readonly<Record<string, unknown>>,
): void {
  recordEvent('survey shown', { ...base(survey), ...context })
}

export function surveyDismissed(
  survey: Survey,
  context: Readonly<Record<string, unknown>>,
): void {
  recordEvent('survey dismissed', {
    ...base(survey),
    ...context,
    $set: { [`$survey_dismissed/${survey.id}`]: true },
  })
}

/** The answers, by question id, as strings. Unanswered optional questions are absent. */
export type SurveyAnswers = Readonly<Record<string, string>>

/** The `survey sent` properties for a set of answers. Exported for its test. */
export function sentProperties(
  survey: Survey,
  answers: SurveyAnswers,
  submissionId: string,
): Record<string, unknown> {
  const responses: Record<string, string> = {}
  for (const question of survey.questions) {
    const answer = answers[question.id]
    if (answer !== undefined && answer !== '')
      responses[`$survey_response_${question.id}`] = answer
  }
  return {
    ...base(survey),
    $survey_submission_id: submissionId,
    $survey_completed: true,
    $survey_questions: survey.questions.map((question) => ({
      id: question.id,
      question: question.question,
      response: answers[question.id] ?? null,
    })),
    ...responses,
    $set: { [`$survey_responded/${survey.id}`]: true },
  }
}

export function surveySent(
  survey: Survey,
  answers: SurveyAnswers,
  context: Readonly<Record<string, unknown>>,
): void {
  recordEvent('survey sent', {
    ...sentProperties(survey, answers, crypto.randomUUID()),
    ...context,
  })
}
