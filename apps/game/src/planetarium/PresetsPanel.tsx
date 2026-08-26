import { AU, LIGHT_YEAR } from '@inertialref/shared'
import { Button } from '@/components/ui/button'
import { Action } from '../hud/Action.tsx'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { Section } from '../hud/Section.tsx'
import { useEngine, useShallow } from '../state/engineStore.ts'
import type { PlanetariumContext } from './context.ts'
import { PHASES, SHOTS } from './presets.ts'
import { ShotThumb } from './ShotThumb.tsx'

/**
 * Compose the picture: one press each.
 *
 * The mobile answer, and the reason the directive asks for it: a phone has one
 * finger and no keyboard, so a preset is the only way to reach a framing that
 * would otherwise take a drag, a pinch and a phase solve. It is also the
 * fastest path on a desktop, which is why it is not a mobile-only panel.
 *
 * **Shots are drawn, not named, and there is one list of them.** This panel had
 * two — `Framing` with three word-buttons and `Compositions` with six — and
 * they were never two kinds of thing: a framing is a composition that happens
 * not to move the light. Nine identical rectangles of type, and the two things
 * that separate any two shots are how much of the frame the body fills and
 * where the terminator falls, both of which are pictures. `ShotThumb.tsx` draws
 * them to the same geometry the solver uses, so the thumbnail is a prediction
 * rather than an illustration.
 *
 * What stays as an axis is the light, because changing it *without* losing your
 * framing is the commonest thing anyone does here and a whole shot cannot
 * express it. The two scale jumps are not framings at all — they are absolute
 * distances, and they are the only way out to where a system is a point.
 */
export function PresetsPanel({ engine }: PlanetariumContext) {
  const observatory = engine.harness.observatory
  /*
   * Two facts, not the status object.
   *
   * `observer` is a fresh object graph on every one of the eight samples a
   * second, so a selector over the whole thing re-renders a grid of nine SVGs
   * eight times a second on a camera that has not moved.
   */
  const subject = useEngine(
    useShallow((snapshot) => ({
      has: snapshot.observer?.target != null,
      isStar: snapshot.observer?.target?.kind === 'star',
    })),
  )
  const disabled = !subject.has

  return (
    <div className="flex flex-col gap-1">
      {/*
       * The grid is the panel's subject, so it carries no heading of its own.
       * A `Section` titled "Shots" inside a panel titled "Shots" is the word
       * twice in forty pixels, and the disclosure it would buy is the panel's
       * own collapse doing the same job one row up.
       */}
      <div className="mb-2">
        <div className="grid grid-cols-3 gap-1.5">
          {SHOTS.map((shot) => (
            <button
              key={shot.label}
              type="button"
              disabled={disabled}
              title={shot.why}
              onClick={(event) => {
                releaseFocus(event)
                // Light first, then distance. `frameTarget` solves against the
                // lens and the subject's radius and does not care where the
                // camera is standing, so the order is free — but it is written
                // this way round because a reader stepping through it in the
                // console sees the picture assembled the way it is described.
                observatory.setPhase(shot.phase, shot.tilt)
                observatory.frameTarget(shot.fill)
              }}
              /*
               * `rounded` outside, `rounded-sm` on the thumbnail inside, with
               * 2px of padding between them — outer radius is inner radius plus
               * padding, which is what keeps a nested corner from looking
               * pinched. The two radii this system has are 0.375rem and
               * 0.25rem; the picture takes the smaller one.
               */
              className={`group flex flex-col gap-1 rounded border border-slate-700/70 bg-slate-900/50 p-0.5 transition-[border-color,background-color,scale] hover:border-sky-500/60 hover:bg-slate-800/60 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35 ${FOCUS_RING}`}
            >
              {/*
               * A star is always full, so its thumbnail is drawn full.
               *
               * `setPhase` returns immediately on a star — it *is* the light,
               * there is no terminator to swing round — so on one of these only
               * the `frameTarget` half runs. Drawing the authored phase there
               * would leave nine thumbnails promising crescents and rim-lit
               * disks that the press cannot produce, which is the one thing a
               * thumbnail may not do. At phase 0 they collapse to what a star
               * actually offers, which is five distinct framings, and the line
               * under the grid says so.
               */}
              <ShotThumb
                phase={subject.isStar ? 0 : shot.phase}
                tilt={subject.isStar ? 0 : shot.tilt}
                fill={shot.fill}
              />
              {/* Wrapping rather than truncating. Three columns in a 19 rem
                  panel is about seven characters a line, and `truncate` turned
                  "Blue Marble" into "BLUE MARB…" — a caption for a picture,
                  cut off. The grid row grows to the tallest card, so two lines
                  cost nothing that a shorter, worse name would have saved. */}
              <span className="type-label px-0.5 pb-0.5 text-center leading-tight text-balance text-slate-300 transition-colors group-hover:text-sky-200">
                {shot.label}
              </span>
            </button>
          ))}
        </div>
        {subject.isStar && (
          // Enabled rather than disabled, unlike the Light row below: the
          // framing half of a shot works on anything, and `Close` on a star is
          // exactly what somebody wants from it. What does not work is said
          // once, here, rather than left for the reader to infer from nine
          // presses that all do the same thing.
          <p className="type-ui mt-1.5 text-pretty text-slate-400">
            a star is always full — on one, a shot sets the framing and nothing
            else
          </p>
        )}
      </div>

      <Section id="planetarium.presets.phase" title="Light">
        <div className="flex flex-wrap gap-1">
          {PHASES.map((phase) => (
            <Button
              key={phase.label}
              variant="outline"
              disabled={disabled || subject.isStar}
              title={`${phase.why} — ${phase.deg}° from the sun line`}
              onClick={(event) => {
                releaseFocus(event)
                observatory.setPhase(phase.deg, phase.tilt)
              }}
              className={`type-label h-auto min-h-9 flex-1 gap-1.5 rounded border-slate-700 bg-slate-800/60 px-2 font-normal text-slate-300 shadow-none transition-[border-color,color,scale] hover:border-sky-500/60 hover:bg-slate-800/60 hover:text-sky-200 active:scale-[0.96] disabled:opacity-35 ${FOCUS_RING}`}
            >
              <phase.icon aria-hidden className="size-4" />
              {phase.label}
            </Button>
          ))}
        </div>
        <p className="type-ui mt-1.5 text-pretty text-slate-400">
          {subject.isStar
            ? // A star has no phase: it is the light source. Saying so beats
              // five buttons that appear to do nothing.
              'a star is the light — phase needs something it shines on'
            : 'moves the camera round the terminator and leaves the framing alone'}
        </p>
      </Section>

      <Section id="planetarium.presets.scale" title="Step Back">
        <div className="flex flex-wrap gap-1">
          <Action
            label="1 AU"
            disabled={disabled}
            title="Back off to one astronomical unit — the subject among its neighbours"
            onClick={() => observatory.setDistance(AU)}
          />
          <Action
            label="1 ly"
            disabled={disabled}
            title="Back off to one light year — the whole system as a point"
            onClick={() => observatory.setDistance(LIGHT_YEAR)}
          />
        </div>
        {/* Not framings, which is why they are not shots: a framing is solved
            against the subject's radius and means the same thing at a moon and
            at a star, and these are absolute. One AU from Jupiter is a planet
            in a frame; one AU from Sol is most of the inner system. */}
        <p className="type-ui mt-1.5 text-pretty text-slate-400">
          absolute distances, not framings — the way out to where a system is a
          point
        </p>
      </Section>
    </div>
  )
}
