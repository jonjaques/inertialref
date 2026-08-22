'use no memo'
import { AU, LIGHT_YEAR } from '@inertialref/shared'
import { Button } from '@/components/ui/button'
import { Action } from '../hud/Action.tsx'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { Section } from '../hud/Section.tsx'
import { usePolled } from '../hud/usePolled.ts'
import type { PlanetariumContext } from './context.ts'
import { PHASES, RANGES, TOUR } from './presets.ts'

/**
 * Compositions and distances, one press each.
 *
 * The mobile answer, and the reason the directive asks for it: a phone has one
 * finger and no keyboard, so a preset is the only way to reach a framing that
 * would otherwise take a drag, a pinch and a phase solve. It is also the
 * fastest path on a desktop, which is why it is not a mobile-only panel.
 */
export function PresetsPanel({ engine, focus }: PlanetariumContext) {
  const observatory = engine.harness.observatory
  const status = usePolled(() => engine.harness.observerStatus(), 3)
  const disabled = status?.target == null
  const isStar = status?.target?.kind === 'star'

  return (
    <div className="flex flex-col gap-2">
      <Section id="planetarium.presets.phase" title="lighting">
        <div className="flex flex-wrap gap-1">
          {PHASES.map((phase) => (
            <Button
              key={phase.label}
              variant="outline"
              disabled={disabled || isStar}
              title={`${phase.label} — ${phase.deg}° from the sun line`}
              onClick={(event) => {
                releaseFocus(event)
                observatory.setPhase(phase.deg)
              }}
              className={`h-auto min-h-9 flex-1 gap-1.5 rounded border-slate-700 bg-slate-800/60 px-2 text-[10px] font-normal tracking-widest text-slate-300 uppercase shadow-none hover:border-sky-500/60 hover:bg-slate-800/60 hover:text-sky-200 disabled:opacity-35 ${FOCUS_RING}`}
            >
              <phase.icon aria-hidden className="size-4" />
              {phase.label}
            </Button>
          ))}
        </div>
        {isStar && (
          // A star has no phase: it is the light source. Saying so beats four
          // buttons that appear to do nothing.
          <p className="mt-1 text-[10px] text-slate-400">
            a star is the light — phase needs something it shines on
          </p>
        )}
      </Section>

      <Section id="planetarium.presets.range" title="framing">
        <div className="flex flex-wrap gap-1">
          {RANGES.map((range) => (
            <Action
              key={range.label}
              label={range.label}
              disabled={disabled}
              title={`Fill ${Math.round(range.fill * 100)}% of the frame`}
              onClick={() => observatory.frameTarget(range.fill)}
            />
          ))}
          <Action
            label="1 AU"
            disabled={disabled}
            title="Back off to one astronomical unit"
            onClick={() => observatory.setDistance(AU)}
          />
          <Action
            label="1 ly"
            disabled={disabled}
            title="Back off to one light year — the system as a point"
            onClick={() => observatory.setDistance(LIGHT_YEAR)}
          />
        </div>
      </Section>

      <Section id="planetarium.presets.tour" title="the tour">
        <div className="flex flex-wrap gap-1">
          {TOUR.map((stop) => (
            <Action
              key={stop.address}
              label={stop.label}
              title={stop.why}
              onClick={() => focus(stop.address)}
            />
          ))}
        </div>
      </Section>
    </div>
  )
}
