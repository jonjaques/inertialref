import { Route } from 'lucide-react'
import type { GuideSnapshot } from './runtime.ts'
import { GuidePlanStop } from './GuidePlanStop.tsx'
import { guideDuration, guidePlanPhase } from './planPresentation.ts'

export function GuidePlan({ state }: { state: GuideSnapshot }) {
  const plan = state.plan
  if (plan === null) {
    return (
      <section
        className="border-t border-slate-800 pt-3"
        aria-label="Tour plan"
      >
        <p className="type-ui flex items-center gap-1.5 text-slate-300">
          <Route aria-hidden className="size-3.5 shrink-0" />A route we can
          change together
        </p>
        <p className="type-ui mt-1 text-pretty text-slate-400">
          Ask for a five-minute Solar System tour or a quick demo. The stops and
          camera views will appear here, and adapt as we talk.
        </p>
      </section>
    )
  }
  const latest = state.planHistory.at(-1)
  const active = state.state !== 'ended'
  const complete = state.stopIndex >= plan.stops.length
  const phase = guidePlanPhase(state.state, state.narrationState)
  const currentName =
    state.subjectNames[plan.stops[state.stopIndex]?.subjectId ?? '']
  return (
    <section
      className="flex min-w-0 flex-col gap-3 border-t border-slate-800 pt-3"
      aria-label="Tour plan"
    >
      <div>
        <h3 className="type-ui text-pretty break-words text-slate-200">
          {plan.goal}
        </h3>
        <p className="type-ui mt-1 flex flex-wrap gap-x-2 text-slate-400">
          <span>{guideDuration(plan.durationSeconds)}</span>
          <span>{plan.stops.length} stops</span>
          <span>
            {complete
              ? 'Complete'
              : !active
                ? 'Ended'
                : `Stop ${state.stopIndex + 1}`}
          </span>
        </p>
        <p
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {complete
            ? 'Tour complete.'
            : !active
              ? 'Tour ended.'
              : `Stop ${state.stopIndex + 1} of ${plan.stops.length}${currentName ? `, ${currentName}` : ''}. ${phase.label}.`}
        </p>
      </div>
      <ol className="flex min-w-0 flex-col" aria-label="Planned stops">
        {plan.stops.map((stop, index) => (
          <GuidePlanStop
            key={stop.id}
            stop={stop}
            name={state.subjectNames[stop.subjectId] ?? 'Selected object'}
            index={index}
            current={active && index === state.stopIndex}
            passed={index < state.stopIndex}
            phase={phase}
            elapsedSeconds={state.stopElapsedSeconds}
            last={index === plan.stops.length - 1}
          />
        ))}
      </ol>
      {latest && (
        <div className="border-t border-slate-800 pt-2">
          <p
            className="type-ui text-slate-300"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {state.planRevision > 1
              ? `Plan updated · revision ${state.planRevision}`
              : 'The plan'}
            {latest.reason && `: ${latest.reason}`}
          </p>
          {latest.changes.length > 0 && (
            <ul
              className="type-ui mt-1 list-disc space-y-1 pl-4 text-slate-400"
              aria-label="Latest plan changes"
            >
              {latest.changes.map((change, index) => (
                <li
                  key={`${index}:${change}`}
                  className="text-pretty break-words"
                >
                  {change}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
