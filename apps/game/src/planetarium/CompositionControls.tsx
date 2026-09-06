import { AU, LIGHT_YEAR } from '@inertialref/shared'
import {
  angularRadius,
  type Composition,
  COMPOSITIONS,
  type Lens,
  verticalFov,
} from '@inertialref/rendering'
import { Button } from '@/components/ui/button'
import { Action } from '../hud/Action.tsx'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { attempt } from '../hud/notice.ts'
import { Section } from '../hud/Section.tsx'
import { useEngine, useShallow } from '../state/engineStore.ts'
import { CAMERA_LENS, usePersistentState } from '../state/preferences.ts'
import type { PlanetariumContext } from './context.ts'
import { PHASES } from './presets.ts'
import { ShotThumb } from './ShotThumb.tsx'

export function CompositionControls(context: PlanetariumContext) {
  const { engine, onNotice } = context
  // The lens each card's fill is converted through: the one on screen, which
  // is the preference — a preset's fitted lens lands there too.
  const [lens] = usePersistentState(CAMERA_LENS)
  const observatory = engine.harness.observatory
  /*
   * Two facts, not the status object.
   *
   * `observer` is a fresh object graph on every one of the eight samples a
   * second, so a selector over the whole thing re-renders a grid of sixteen
   * SVGs eight times a second on a camera that has not moved.
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
      <Section
        id="planetarium.presets.compositions"
        title="Compositions"
        trailing={`${COMPOSITIONS.length}`}
      >
        <div className="grid grid-cols-3 gap-1.5">
          {COMPOSITIONS.map((composition) => (
            <button
              key={composition.id}
              type="button"
              disabled={disabled}
              title={composition.why}
              onClick={(event) => {
                releaseFocus(event)
                /*
                 * A composition refuses more often than the enabled state can
                 * say. A star has no terminator to swing round, and the two
                 * standoffs below the orbit floor land on the surface arm,
                 * which needs ground — so `sunset` on Jupiter is a real "no"
                 * with a reason, and an uncaught throw out of an `onClick` is
                 * that reason going to `window.onerror` instead of to the
                 * person who pressed the button.
                 */
                attempt(onNotice, composition.label, () =>
                  observatory.compose(composition.id),
                )
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
               * A star *is* the light — there is no terminator to swing round —
               * so on one of these only the standoff half of a composition
               * means anything. Drawing the authored phase there would leave
               * sixteen thumbnails promising crescents and rim-lit disks that
               * the press cannot produce, which is the one thing a thumbnail
               * may not do.
               */}
              <ShotThumb
                phase={subject.isStar ? 0 : composition.phaseDeg}
                tilt={subject.isStar ? 0 : composition.tiltDeg}
                // The thumbnail draws a *fill*, and half the list names radii
                // instead — so the standoff is converted through the lens the
                // press will actually be solved against, rather than through a
                // nominal one. A card that promised a framing the button does
                // not take is the same defect as the phase above.
                fill={fillOf(composition, lens)}
              />
              {/* Wrapping rather than truncating. Three columns in a 19 rem
                  panel is about seven characters a line, and `truncate` turned
                  "Blue Marble" into "BLUE MARB…" — a caption for a picture,
                  cut off. The grid row grows to the tallest card, so two lines
                  cost nothing that a shorter, worse name would have saved. */}
              <span className="type-label px-0.5 pb-0.5 text-center leading-tight text-balance text-slate-300 transition-colors group-hover:text-sky-200">
                {composition.label}
              </span>
            </button>
          ))}
        </div>
        {subject.isStar && (
          // Enabled rather than disabled, unlike the Light row below: the
          // framing half of a composition works on anything, and `Close` on a
          // star is exactly what somebody wants from it. What does not work is
          // said once, here, rather than left for the reader to infer from
          // sixteen presses that all do the same thing.
          <p className="type-ui mt-1.5 text-pretty text-slate-400">
            A star is always full, so on one of these only the distance changes.
          </p>
        )}
      </Section>

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
              'A star is the light. Phase needs something it shines on.'
            : 'Swings the camera around the terminator. The framing does not change.'}
        </p>
      </Section>

      <Section id="planetarium.presets.scale" title="Step Back">
        <div className="flex flex-wrap gap-1">
          <Action
            label="1 AU"
            disabled={disabled}
            title="Back off to one astronomical unit — the subject among its neighbors"
            onClick={() => observatory.setDistance(AU)}
          />
          <Action
            label="1 ly"
            disabled={disabled}
            title="Back off to one light year — the whole system as a point"
            onClick={() => observatory.setDistance(LIGHT_YEAR)}
          />
        </div>
        {/* Not framings, which is why they are not compositions: a framing is
            solved against the subject's radius and means the same thing at a
            moon and at a star, and these are absolute. One AU from Jupiter is a
            planet in a frame; one AU from Sol is most of the inner system. */}
        <p className="type-ui mt-1.5 text-pretty text-slate-400">
          Fixed distances, not framings. One AU from Jupiter is a planet in the
          frame; one AU from Sol is most of the inner system.
        </p>
      </Section>
    </div>
  )
}

/**
 * A composition's standoff as a fraction of the frame height.
 *
 * Half the list names a `fill` outright and half names body radii, and the
 * thumbnail draws one thing. Converting through the lens the press will
 * actually be solved against — rather than through a nominal 65° — is what
 * keeps the card a prediction: at 8× zoom a 5.2-radii bookmark fills the frame,
 * and a thumbnail drawn at the flight angle would show a disk a fifth the size.
 *
 * A unit sphere, because a fill is a ratio and the body's own radius cancels
 * out of it — which is the same reason `standoffRadii` solves on one.
 */
function fillOf(composition: Composition, lens: Lens): number {
  if (composition.standoff.kind === 'fill') return composition.standoff.fill
  const angle = 2 * angularRadius(1, composition.standoff.radii)
  return Math.min(1, angle / verticalFov(lens))
}
