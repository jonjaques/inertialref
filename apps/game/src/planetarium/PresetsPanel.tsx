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
import { attempt, describeCause } from '../hud/notice.ts'
import { Section } from '../hud/Section.tsx'
import { useEngine, useShallow } from '../state/engineStore.ts'
import type { PlanetariumContext } from './context.ts'
import { PHASES } from './presets.ts'
import { PictureCard } from './PictureCard.tsx'
import { ShotThumb } from './ShotThumb.tsx'

/**
 * Compose the picture: one press each, in two tiers.
 *
 * **Pictures** are absolute — an address, a framing and a lens — so they
 * produce the same frame every time they are pressed, and their thumbnails are
 * *plates*: captured through the renderer and vendored, because a drawn diagram
 * of a picture that exists is a worse thumbnail than the picture. That is what
 * makes them fixtures rather than framings, and a fixture is what a
 * before/after plate is: the geology phase is judged from these, which is why
 * they exist before the geology does.
 *
 * **Compositions** are the tier under them: relative to whatever is under the
 * camera, sixteen of them, with the light row and the step-backs beneath. There
 * were two lists of these and now there is one — `gibbous` here and
 * `ir.shot('gibbous')` come out of one solver and mean one picture, and three
 * of the sixteen were reachable only by teleporting a hull until the aim became
 * an offset.
 *
 * A preset sets the camera and nothing about the layers. Names and traces are
 * the viewer's, and a button that turned them off would be the interface
 * reasserting itself.
 *
 * The mobile answer is the other half of why this panel exists: a phone has one
 * finger and no keyboard, so a preset is the only way to reach a framing that
 * would otherwise take a drag, a pinch and a phase solve.
 */
export function PresetsPanel({ engine, camera, onNotice }: PlanetariumContext) {
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
      <Section id="planetarium.presets.pictures" title="Pictures">
        <div className="grid grid-cols-2 gap-1.5">
          {engine.harness.presets().map((picture) => (
            <PictureCard
              key={picture.id}
              picture={picture}
              onTake={() => {
                /*
                 * Caught, because a picture can refuse: an address a build no
                 * longer ships, or a rise from a moon that is not turning. A
                 * throw out of an `onClick` reaches `window.onerror`, so the
                 * press does nothing and says nothing.
                 */
                try {
                  const taken = engine.harness.preset(picture.id)
                  // The notice the shell already flashes, saying what the press
                  // did — a preset that moved the camera and the lens with no
                  // word for it is two changes a viewer has to infer.
                  onNotice(
                    `${taken.picture.label} — ${taken.status.target?.name ?? 'nowhere'}, ${Math.round(taken.fovDeg)}°`,
                  )
                } catch (cause) {
                  onNotice(describeCause(cause))
                }
              }}
            />
          ))}
        </div>
        {/* The lens moves with a picture, which is the thing about them a
            viewer has to be told once: a composition holds the lens and a
            picture names one. */}
        <p className="type-ui mt-1.5 text-pretty text-slate-400">
          the same frame every time — an address, a framing and a lens. The
          thumbnails are captures, not drawings.
        </p>
      </Section>

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
                fill={fillOf(composition, camera.lens)}
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
            a star is always full — on one, a composition sets the framing and
            nothing else
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
        {/* Not framings, which is why they are not compositions: a framing is
            solved against the subject's radius and means the same thing at a
            moon and at a star, and these are absolute. One AU from Jupiter is a
            planet in a frame; one AU from Sol is most of the inner system. */}
        <p className="type-ui mt-1.5 text-pretty text-slate-400">
          absolute distances, not framings — the way out to where a system is a
          point
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
