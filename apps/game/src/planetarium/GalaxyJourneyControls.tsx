import { GALAXY_JOURNEY_SECONDS } from '@inertialref/rendering'
import { Slider } from '@/components/ui/slider'
import { Action } from '../hud/Action.tsx'
import { formatShutter } from '../hud/controls.ts'
import { releaseFocus } from '../hud/focus.ts'
import { attempt } from '../hud/notice.ts'
import { useEngine, useShallow } from '../state/engineStore.ts'
import { CAMERA_LENS, usePersistentState } from '../state/preferences.ts'
import type { PlanetariumContext } from './context.ts'

export function GalaxyJourneyControls({
  engine,
  onNotice,
}: Pick<PlanetariumContext, 'engine' | 'onNotice'>) {
  const [lens] = usePersistentState(CAMERA_LENS)
  const { progress, remaining, distance } = useEngine(
    useShallow((s) => ({
      progress: s.observer?.journey?.progress ?? null,
      remaining: s.observer?.journey?.remainingSeconds ?? 0,
      distance: s.observer?.altitudeText ?? '',
    })),
  )
  const travel = (to: number, seconds = 0) =>
    attempt(onNotice, 'Earth To The Galaxy', () =>
      engine.harness.galaxyJourney(to, seconds),
    )
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <Action label="Earth Orbit" onClick={() => travel(0)} />
        <Action
          label="Travel Out"
          tone="primary"
          disabled={progress === 1 && remaining === 0}
          onClick={() => travel(1, GALAXY_JOURNEY_SECONDS)}
        />
        <Action
          label="Return"
          disabled={progress === null || (progress === 0 && remaining === 0)}
          onClick={() => travel(0, GALAXY_JOURNEY_SECONDS)}
        />
        <Action
          label="Hold"
          disabled={remaining === 0}
          onClick={() => {
            const current = engine.harness.observatory.journey
            if (current !== null) travel(current.progress)
          }}
        />
      </div>
      {progress !== null && (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="type-label text-slate-400">Earth To The Disk</span>
            <span className="type-readout text-slate-300">{distance}</span>
          </div>
          <Slider
            min={0}
            max={1}
            step={0.001}
            value={[progress]}
            aria-label="Earth to the galactic disk journey progress"
            onValueChange={([next]) => {
              if (next !== undefined) travel(next)
            }}
            onClick={releaseFocus}
            className="py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
          />
          <p className="type-ui text-pretty text-slate-400">
            {formatShutter(lens.shutter)} · f/{lens.fStop} · ISO {lens.iso}.{' '}
            Exposure follows the lens. Bright bodies can clip while the faint
            disk is visible.
          </p>
        </>
      )}
    </div>
  )
}
