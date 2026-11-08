import { Input } from '@/components/ui/input'
import type { SurveyQuestion } from '../telemetry/surveys.ts'
import { Action } from './Action.tsx'

/** One survey question in the interface's own controls (`SurveyPrompt`). */
export function SurveyQuestionRow({
  question,
  value,
  onAnswer,
}: {
  question: SurveyQuestion
  value: string
  onAnswer: (text: string) => void
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="type-ui mb-1 text-pretty text-slate-300">
        {question.question}
      </legend>
      {question.type === 'rating' && (
        <>
          <div className="flex flex-wrap gap-1">
            {Array.from({ length: question.scale }, (_, i) =>
              String(i + 1),
            ).map((score) => (
              <Action
                key={score}
                label={score}
                tone={value === score ? 'primary' : 'normal'}
                title={`${score} of ${question.scale}`}
                onClick={() => onAnswer(score)}
              />
            ))}
          </div>
          {(question.lowerBoundLabel || question.upperBoundLabel) && (
            <div className="type-micro flex justify-between text-slate-400">
              <span>{question.lowerBoundLabel}</span>
              <span>{question.upperBoundLabel}</span>
            </div>
          )}
        </>
      )}
      {question.type === 'single_choice' && (
        <div className="flex flex-wrap gap-1">
          {question.choices.map((choice) => (
            <Action
              key={choice}
              label={choice}
              tone={value === choice ? 'primary' : 'normal'}
              onClick={() => onAnswer(choice)}
            />
          ))}
        </div>
      )}
      {question.type === 'open' && (
        <Input
          value={value}
          maxLength={1000}
          placeholder={question.optional ? 'Optional' : ''}
          aria-label={question.question}
          onChange={(event) => onAnswer(event.target.value)}
        />
      )}
    </fieldset>
  )
}
