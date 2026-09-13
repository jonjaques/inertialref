import { Check } from 'lucide-react'
import type { TourStop } from '@inertialref/protocol'
import {
  GUIDE_CAMERA_MOTION,
  guideElapsed,
  type GuidePlanPhase,
} from './planPresentation.ts'

export function GuidePlanStop({
  stop,
  name,
  index,
  current,
  passed,
  phase,
  elapsedSeconds,
  last,
}: {
  stop: TourStop
  name: string
  index: number
  current: boolean
  passed: boolean
  phase: GuidePlanPhase
  elapsedSeconds: number
  last: boolean
}) {
  const motion = GUIDE_CAMERA_MOTION[stop.motion ?? 'hold']
  const MotionIcon = motion.icon
  const PhaseIcon = phase.icon
  return (
    <li
      className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2"
      aria-current={current ? 'step' : undefined}
    >
      <div className="relative flex flex-col items-center" aria-hidden>
        <span
          className={`type-readout z-1 flex size-6 shrink-0 items-center justify-center rounded-full border ${
            current
              ? 'border-sky-400 bg-slate-950 text-sky-200'
              : passed
                ? 'border-slate-700 bg-slate-950 text-slate-400'
                : 'border-slate-700 bg-slate-950 text-slate-300'
          }`}
        >
          {passed ? <Check className="size-3.5" /> : index + 1}
        </span>
        {!last && <span className="min-h-3 w-px grow bg-slate-700" />}
      </div>
      <div className={`min-w-0 pb-3 ${current ? 'pt-0.5' : 'pt-1'}`}>
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          <p
            className={`type-ui break-words ${current ? 'text-sky-200' : 'text-slate-300'}`}
          >
            <span className="sr-only">Stop {index + 1}: </span>
            {name}
          </p>
          <span className="type-ui text-slate-400">
            {current ? 'Now' : passed ? 'Visited' : 'Coming up'}
          </span>
        </div>
        <p
          className={`type-ui mt-0.5 text-pretty break-words ${
            current ? 'text-slate-200' : 'line-clamp-2 text-slate-400'
          }`}
          title={current ? undefined : stop.objective}
        >
          {stop.objective}
        </p>
        <p className="type-ui mt-1 flex items-center gap-1.5 text-slate-400">
          <MotionIcon aria-hidden className="size-3.5 shrink-0" />
          {motion.label}
        </p>
        {current && (
          <div className="mt-2 flex flex-col gap-1 border-t border-slate-800 pt-2">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <p className="type-ui flex items-center gap-1.5 text-sky-300">
                <PhaseIcon aria-hidden className="size-3.5 shrink-0" />
                {phase.label}
              </p>
              {elapsedSeconds > 0 && (
                <span className="type-readout text-slate-400">
                  {guideElapsed(elapsedSeconds)} at this stop
                </span>
              )}
            </div>
            {(stop.lookSeconds ?? 0) > 0 && (
              <p className="type-ui text-slate-400">
                {stop.lookSeconds} seconds to look around after the story.
              </p>
            )}
          </div>
        )}
      </div>
    </li>
  )
}
