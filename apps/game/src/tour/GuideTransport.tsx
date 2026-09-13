import { ArrowLeft, ArrowRight, Pause, Play, Square } from 'lucide-react'
import { Action } from '../hud/Action.tsx'
import { useActionTitle } from '../input/useKeymap.ts'
import type { GuideRuntime, GuideSnapshot } from './runtime.ts'

export function GuideTransport({
  runtime,
  state,
}: {
  runtime: GuideRuntime
  state: GuideSnapshot
}) {
  const next = useActionTitle('guide.next', 'Next stop')
  const back = useActionTitle('guide.back', 'Previous stop')
  const pause = useActionTitle(
    'guide.pause',
    state.state === 'paused' ? 'Resume tour' : 'Pause tour',
  )
  const end = useActionTitle('guide.end', 'End guide')
  const active = state.plan !== null && state.state !== 'ended'
  return (
    <div className="flex flex-col gap-2">
      <p className="type-readout text-slate-400" role="status">
        {state.connection === 'connecting'
          ? 'Connecting…'
          : state.state.replaceAll('-', ' ')}
        {active && ` · ${state.stopIndex + 1} of ${state.plan!.stops.length}`}
      </p>
      {state.plan && (
        <p className="type-ui text-slate-300">{state.plan.goal}</p>
      )}
      {(active || state.connection !== 'offline' || state.message !== null) && (
        <div className="flex flex-wrap gap-1.5">
          <Action
            label="Back"
            icon={ArrowLeft}
            title={back}
            disabled={!active || state.stopIndex === 0}
            onClick={() => runtime.command('back')}
          />
          <Action
            label={state.state === 'paused' ? 'Resume' : 'Pause tour'}
            icon={state.state === 'paused' ? Play : Pause}
            title={pause}
            onClick={() =>
              runtime.command(state.state === 'paused' ? 'resume' : 'pause')
            }
          />
          <Action
            label="Next"
            icon={ArrowRight}
            title={next}
            disabled={!active}
            onClick={() => runtime.command('next')}
          />
          <Action
            label="End"
            icon={Square}
            title={end}
            onClick={() => runtime.end()}
          />
        </div>
      )}
    </div>
  )
}
