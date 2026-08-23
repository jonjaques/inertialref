import { AU, LIGHT_YEAR } from '@inertialref/shared'
import { Button } from '@/components/ui/button'
import { Action } from '../hud/Action.tsx'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { Section } from '../hud/Section.tsx'
import { useEngine } from '../state/engineStore.ts'
import type { PlanetariumContext } from './context.ts'
import { COMPOSITIONS, PHASES, RANGES } from './presets.ts'

/**
 * Light, distance, and whole compositions — one press each.
 *
 * The mobile answer, and the reason the directive asks for it: a phone has one
 * finger and no keyboard, so a preset is the only way to reach a framing that
 * would otherwise take a drag, a pinch and a phase solve. It is also the
 * fastest path on a desktop, which is why it is not a mobile-only panel.
 *
 * Three sections, in the order a shot is actually decided: where the light is,
 * how big the subject is, and — for the times you would rather not decide —
 * six pictures somebody already composed.
 */
export function PresetsPanel({ engine }: PlanetariumContext) {
  const observatory = engine.harness.observatory
  const status = useEngine((snapshot) => snapshot.observer)
  const disabled = status?.target == null
  const isStar = status?.target?.kind === 'star'

  return (
    <div className="flex flex-col gap-2">
      <Section id="planetarium.presets.phase" title="Light">
        <div className="flex flex-wrap gap-1">
          {PHASES.map((phase) => (
            <Button
              key={phase.label}
              variant="outline"
              disabled={disabled || isStar}
              title={`${phase.why} — ${phase.deg}° from the sun line`}
              onClick={(event) => {
                releaseFocus(event)
                observatory.setPhase(phase.deg, phase.tilt)
              }}
              className={`type-label h-auto min-h-9 flex-1 gap-1.5 rounded border-slate-700 bg-slate-800/60 px-2 font-normal text-slate-300 shadow-none hover:border-sky-500/60 hover:bg-slate-800/60 hover:text-sky-200 disabled:opacity-35 ${FOCUS_RING}`}
            >
              <phase.icon aria-hidden className="size-4" />
              {phase.label}
            </Button>
          ))}
        </div>
        {isStar && (
          // A star has no phase: it is the light source. Saying so beats five
          // buttons that appear to do nothing.
          <p className="type-ui mt-1.5 text-slate-400">
            a star is the light — phase needs something it shines on
          </p>
        )}
      </Section>

      <Section id="planetarium.presets.range" title="Framing">
        <div className="flex flex-wrap gap-1">
          {RANGES.map((range) => (
            <Action
              key={range.label}
              label={range.label}
              disabled={disabled}
              title={`${range.why} — ${Math.round(range.fill * 100)}% of the frame`}
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

      {/*
       * Compositions, where the two lists above are axes.
       *
       * Words rather than glyphs, because this is a panel body: "earthrise" is
       * a picture everybody has seen and no 16 px drawing of it would be. The
       * phase ladder above keeps its icons for the opposite reason — four words
       * for four terminator positions are four buttons that look identical, and
       * there the glyph *is* the specification.
       */}
      <Section id="planetarium.presets.compositions" title="Compositions">
        <div className="flex flex-wrap gap-1">
          {COMPOSITIONS.map((shot) => (
            <Action
              key={shot.label}
              label={shot.label}
              disabled={disabled || isStar}
              title={shot.why}
              onClick={() => {
                observatory.setPhase(shot.phase, shot.tilt)
                observatory.frameTarget(shot.fill)
              }}
            />
          ))}
        </div>
      </Section>
    </div>
  )
}
