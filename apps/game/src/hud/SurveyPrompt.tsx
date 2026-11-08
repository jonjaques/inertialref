import { useEffect, useState } from 'react'
import {
  findSurvey,
  type Survey,
  surveyDismissed,
  surveySent,
  surveyShown,
} from '../telemetry/surveys.ts'
import { Action } from './Action.tsx'
import { SurveyQuestionRow } from './SurveyQuestionRow.tsx'

/*
 * A PostHog survey, drawn in the interface's own controls.
 *
 * It draws nothing until PostHog has answered with a launched survey of this
 * name, which on a page that reports nothing is never: no request is made,
 * no empty frame is held open, and a survey stopped in PostHog disappears on
 * the next load without a deploy. `telemetry/surveys.ts` says why the SDK's
 * own popover is not used.
 *
 * `subject` names what the answer is about — a tour's session, a docs page —
 * and rides on every event, so a rating can be read beside the trace or the
 * page it rates.
 */
export function SurveyPrompt({
  name,
  subject,
}: {
  /** The survey's name in PostHog (`SURVEYS`). */
  name: string
  /** One property naming what is being rated, e.g. `{ doc_route: '/docs/…' }`. */
  subject: readonly [key: string, value: string]
}) {
  const [survey, setSurvey] = useState<Survey | null>(null)
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({})
  const [done, setDone] = useState<'sent' | 'dismissed' | null>(null)
  const [key, value] = subject

  useEffect(() => {
    let live = true
    setSurvey(null)
    setAnswers({})
    setDone(null)
    findSurvey(name, (found) => {
      if (live) setSurvey(found)
    })
    return () => {
      live = false
    }
  }, [name, value])

  useEffect(() => {
    if (survey !== null) surveyShown(survey, { [key]: value })
  }, [survey, key, value])

  if (survey === null || done === 'dismissed') return null
  if (done === 'sent')
    return (
      <p className="type-micro text-slate-400" role="status">
        Thanks — that helps.
      </p>
    )

  const answer = (id: string, text: string): void =>
    setAnswers((held) => ({ ...held, [id]: text }))
  const complete = survey.questions.every(
    (question) => question.optional || (answers[question.id] ?? '') !== '',
  )

  return (
    <form
      className="flex flex-col gap-2 rounded border border-slate-800 bg-slate-950/60 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!complete) return
        surveySent(survey, answers, { [key]: value })
        setDone('sent')
      }}
    >
      {survey.questions.map((question) => (
        <SurveyQuestionRow
          key={question.id}
          question={question}
          value={answers[question.id] ?? ''}
          onAnswer={(text) => answer(question.id, text)}
        />
      ))}
      <div className="flex justify-end gap-1">
        <Action
          label="Not now"
          title="Close this question"
          onClick={() => {
            surveyDismissed(survey, { [key]: value })
            setDone('dismissed')
          }}
        />
        <Action
          label="Send"
          tone="primary"
          type="submit"
          disabled={!complete}
          title="Send your answer"
        />
      </div>
    </form>
  )
}
