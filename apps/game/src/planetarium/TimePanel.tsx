'use no memo'
import { Gauge, Pause, Play } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Action } from '../hud/Action.tsx'
import { TransportButton } from '../hud/TransportButton.tsx'
import { usePolled } from '../hud/usePolled.ts'
import { nextWarp } from '../hud/warp.ts'
import type { PlanetariumContext } from './context.ts'

/** Pause, warp, and what the clock is actually delivering. */
export function TimePanel({ engine }: PlanetariumContext) {
  const world = usePolled(() => engine.harness.status().world)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <TransportButton
        label={world.paused ? 'Run (Space)' : 'Pause (Space)'}
        icon={world.paused ? Play : Pause}
        primary
        onClick={() => engine.world.clock.setPaused(!world.paused)}
      />

      <div className="flex items-center gap-1">
        <Action
          label="−"
          title="Slower ( [ )"
          onClick={() => warp(engine, -1)}
        />
        <span className="w-16 text-center text-slate-300 tabular-nums">
          {world.timeScale}×
        </span>
        <Action
          label="+"
          title="Faster ( ] )"
          onClick={() => warp(engine, 1)}
        />
      </div>

      <Separator orientation="vertical" className="mx-1 !h-4 bg-slate-800" />

      <Gauge aria-hidden className="size-3.5 shrink-0 text-slate-400" />
      <span className="text-slate-400 tabular-nums">{world.timeText}</span>
      {/* What the clock is actually delivering. Below the requested warp when
          the simulation cannot keep up, and saying so is the whole point —
          `hud/PerfPanel.tsx` found that warp above 5× had never worked. */}
      {world.achievedTimeScale < world.timeScale * 0.95 && (
        <span
          className="text-amber-300/80"
          title="The simulation is not keeping up with the requested warp"
        >
          {world.achievedTimeScale.toFixed(1)}× actual
        </span>
      )}
    </div>
  )
}

const warp = (engine: GameEngine, direction: number): void => {
  engine.world.clock.setTimeScale(
    nextWarp(engine.world.clock.timeScale, direction),
  )
}
