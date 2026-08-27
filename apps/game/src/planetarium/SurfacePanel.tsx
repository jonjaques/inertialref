import { formatDistance } from '@inertialref/shared'
import { compassDegrees, MIN_STANCE_HEIGHT } from '@inertialref/rendering'
import { Slider } from '@/components/ui/slider'
import { Action } from '../hud/Action.tsx'
import { Section } from '../hud/Section.tsx'
import { releaseFocus } from '../hud/focus.ts'
import { useEngine, useShallow } from '../state/engineStore.ts'
import type { PlanetariumContext } from './context.ts'
import { COMPASS, DESCENT_RUNGS, elevationText } from './surface.ts'
import { useSurveySites } from './useSurveySites.ts'

/**
 * Stand on it.
 *
 * The observatory's second arm, given a control surface. The orbit arm stops at
 * 1.5 radii and is right to — half a radius up is where a planetarium stops
 * showing you a world and starts showing you ground with no horizon in it — and
 * the cost of that clamp was that terrain, which only exists below it, could
 * never be *inspected*. The only way to look at a mountain was to fly a ship at
 * it, which is a canonical change, a physics problem and several minutes.
 *
 * **Not on the Object panel.** That panel is the record — mass, orbit, air,
 * light — and `.claude/rules/record.md` is explicit that nothing about the
 * camera belongs on it; range, fill and the orbit angles live in the Camera
 * instrument for the same reason. Descending is a camera act, so it is a camera
 * panel.
 *
 * Three controls and they are three different questions. *Where* on the body,
 * which is a list because a seeded world has no place names and typing
 * coordinates into a sphere lands you on the same undifferentiated mid-slope
 * every time. *How high*, on a logarithmic slider because the band is six
 * decades and a linear one spends 99.9% of its travel above the altitude
 * terrain is drawn at. And *which way you are facing*, which is a compass and a
 * tilt.
 */
export function SurfacePanel({ engine, target }: PlanetariumContext) {
  const observatory = engine.harness.observatory
  const sites = useSurveySites(engine, target)
  /*
   * Primitives and a small stable slice, never the whole status object.
   *
   * `observer` is a fresh object graph on every one of the eight samples a
   * second, so a selector over it re-renders this panel — six site buttons,
   * five rungs, eight compass points — eight times a second on a camera that
   * has not moved. `useShallow` over the five numbers this actually draws bails
   * out instead.
   */
  const stance = useEngine(
    useShallow((snapshot) => ({
      kind: snapshot.observer?.target?.kind ?? null,
      standing: snapshot.observer?.surface != null,
      site: snapshot.observer?.surface?.site ?? null,
      scrub: snapshot.observer?.surface?.scrub ?? 1,
      height: snapshot.observer?.surface?.stance.height ?? 0,
      ground: snapshot.observer?.surface?.groundElevation ?? 0,
      heading: snapshot.observer?.surface?.stance.heading ?? 0,
      pitch: snapshot.observer?.surface?.stance.pitch ?? 0,
    })),
  )

  if (stance.kind === 'star') {
    return (
      <p className="type-ui text-pretty text-slate-400">
        a star has no surface — pick a body and this panel fills in
      </p>
    )
  }
  // `null` is "the survey has not run yet", which is one frame after every
  // target change; `[]` is "this body has no sites". Drawing the empty state
  // for the first put "no ground here yet" on screen for a body with six.
  if (sites === null) return null
  if (sites.length === 0) {
    return (
      <p className="type-ui text-pretty text-slate-400">
        no ground here yet — pick a solid body
      </p>
    )
  }

  /*
   * `observatory.standing`, never the sampled `stance.standing`.
   *
   * The snapshot is republished at `PANEL_HZ`, so for up to 125 ms after a
   * press it still says "in orbit". A second press inside that window took the
   * arrival branch again and re-stood on `sites[0]`, which is always the
   * summit — and this phase's own tests pin that a summit above the fade line
   * draws nothing. The observatory answers the same question synchronously.
   */
  const visit = (site: string): void => {
    if (observatory.standing) {
      // Already down here: move the stance and keep the height, the heading and
      // the tilt. `stand` reads an absent heading as north and an absent pitch
      // as the horizon, so routing every site press through it would reset both
      // controls beside it on every press.
      observatory.moveTo(site)
      return
    }
    // Through the harness rather than the observatory, so the console verb and
    // this button are the same call and cannot drift on the degrees/radians
    // boundary. `ir.visit` takes degrees; the arm below it takes radians.
    engine.harness.visit(undefined, { site, height: MIN_STANCE_HEIGHT })
  }

  return (
    <div className="flex flex-col gap-1">
      <Section id="planetarium.surface.sites" title="Sites">
        <div className="grid grid-cols-2 gap-1.5">
          {sites.map((site) => (
            <button
              key={site.id}
              type="button"
              title={site.detail}
              onClick={(event) => {
                releaseFocus(event)
                visit(site.id)
              }}
              // The same card geometry `PresetsPanel`'s shot grid uses, and the
              // same reason for the property list on the transition: `cn` is
              // `twMerge`, so a bare `transition-transform` would win the merge
              // and take the hover colours with it.
              className={`group flex flex-col items-start gap-0.5 rounded border px-1.5 py-1 text-left transition-[color,border-color,background-color,scale] active:scale-[0.96] ${
                stance.standing && stance.site === site.id
                  ? 'border-sky-500/50 bg-sky-500/15'
                  : 'border-slate-700/70 bg-slate-900/50 hover:border-sky-500/60 hover:bg-slate-800/60'
              }`}
            >
              <span
                className={`type-label leading-tight ${
                  stance.standing && stance.site === site.id
                    ? 'text-sky-200'
                    : 'text-slate-300 group-hover:text-sky-200'
                }`}
              >
                {site.name}
              </span>
              <span className="type-ui tabular-nums text-slate-400">
                {elevationText(site.elevation)}
              </span>
            </button>
          ))}
        </div>
        {/* Derived, not authored, and saying so is the difference between a
            list of coordinates somebody typed and a claim about the place. The
            last two are for the renderer rather than the geology: three faces
            of the addressing cube meet at one, and the east/north basis is
            undefined at the other. */}
        <p className="type-ui mt-1.5 text-pretty text-slate-400">
          found by searching this world’s own terrain — the last two are where
          the addressing is hardest, not where the geology is
        </p>
      </Section>

      <Section
        id="planetarium.surface.descent"
        title="Descent"
        trailing={stance.standing ? formatDistance(stance.height) : 'in orbit'}
      >
        <div className="flex flex-col gap-1">
          <span className="type-ui flex items-center gap-1.5 text-slate-400">
            Height above ground
            <span className="ml-auto text-slate-300 tabular-nums">
              {stance.standing ? formatDistance(stance.height) : '—'}
            </span>
          </span>
          <Slider
            min={0}
            max={1000}
            step={1}
            disabled={!stance.standing}
            value={[Math.round(stance.scrub * 1000)]}
            aria-label="Height above the ground"
            onValueChange={([next]) => {
              // Logarithmic, in the arm rather than here: `heightForScrub` owns
              // the mapping so the slider, the console and the descent probe
              // cannot disagree about what half-way down means.
              if (next !== undefined) observatory.setStanceScrub(next / 1000)
            }}
            onClick={releaseFocus}
            className="min-w-0 flex-1 py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
          />
          <div className="flex flex-wrap gap-1">
            {DESCENT_RUNGS.map((rung) => (
              <Action
                key={rung.label}
                label={rung.label}
                title={rung.why}
                tone={rung.label === 'Ground' ? 'primary' : 'normal'}
                onClick={() => {
                  if (!observatory.standing) visit(sites[0]?.id ?? 'summit')
                  // `null` is the top of the band, which depends on the body:
                  // the ceiling is the orbit arm's floor, so it is 3,186 km at
                  // Earth and 118 km at Miranda.
                  if (rung.height === null) observatory.setStanceScrub(1)
                  else observatory.setStanceHeight(rung.height)
                }}
              />
            ))}
          </div>
          <p className="type-ui mt-1 text-pretty text-slate-400">
            {stance.standing
              ? `the ground here is ${elevationText(stance.ground)} against the datum`
              : 'below half a radius the orbit camera stops — this is the arm underneath it'}
          </p>
        </div>
      </Section>

      <Section
        id="planetarium.surface.look"
        title="Heading"
        trailing={`${compassDegrees(stance.heading)}°`}
      >
        <div className="flex flex-wrap gap-1">
          {COMPASS.map((point) => (
            <Action
              key={point.label}
              label={point.label}
              disabled={!stance.standing}
              title={`Face ${point.deg}°`}
              onClick={() =>
                observatory.setHeading((point.deg * Math.PI) / 180)
              }
            />
          ))}
        </div>

        <div className="mt-2 flex flex-col gap-1">
          <span className="type-ui flex items-center gap-1.5 text-slate-400">
            Tilt
            <span className="ml-auto text-slate-300 tabular-nums">
              {Math.round((stance.pitch * 180) / Math.PI)}°
            </span>
          </span>
          <Slider
            min={-88}
            max={88}
            step={1}
            disabled={!stance.standing}
            value={[Math.round((stance.pitch * 180) / Math.PI)]}
            aria-label="Tilt above the horizontal"
            onValueChange={([next]) => {
              if (next !== undefined) {
                observatory.setPitch((next * Math.PI) / 180)
              }
            }}
            onClick={releaseFocus}
            className="min-w-0 flex-1 py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
          />
          <div className="flex flex-wrap gap-1">
            <Action
              label="Horizon"
              disabled={!stance.standing}
              // Below the horizontal, and by more than anyone expects: the dip
              // is `acos(r / (r + h))`, which is 0.045° from 2 m on an
              // Earth-sized body and 19.79° from 400 km. A control that levelled
              // to zero would aim at empty sky from the top of the descent.
              //
              // Solved in the arm rather than here, from the height the stance
              // actually holds: the height this panel can see is up to 125 ms
              // old, and `setStanceHeight` decides whether to keep tracking the
              // horizon by comparing against the dip the *current* height
              // implies — so a pitch solved from a stale height stops the
              // tracking for the rest of the descent.
              title="Put the horizon across the middle of the frame"
              onClick={() => observatory.levelToHorizon()}
            />
            <Action
              label="Leave"
              disabled={!stance.standing}
              title="Back to orbit, at the framing you left"
              onClick={() => engine.harness.ascend()}
            />
          </div>
        </div>
      </Section>
    </div>
  )
}
