import { formatReading } from '@inertialref/shared'
import { compassDegrees } from '@inertialref/rendering'
import { Slider } from '@/components/ui/slider'
import { Action } from '../hud/Action.tsx'
import { Row } from '../hud/Row.tsx'
import { releaseFocus } from '../hud/focus.ts'
import { COMPASS, DESCENT_RUNGS, elevationText } from './surface.ts'
import type { SurveySiteRow } from './useSurveySites.ts'

/**
 * The arm below half a radius: where to stand, how high, and which way.
 *
 * A component rather than four branches inline, because the section is one
 * thing in two states and the states share nothing but the site grid — in
 * orbit it is a list of places to go, and standing it is a list of places to
 * move to, with the descent and the heading filled in under it.
 */
export function GroundSection({
  eye,
  sites,
  standing,
  onVisit,
  onScrub,
  onHeight,
  onHeading,
  onPitch,
  onLevel,
  onLeave,
}: {
  readonly eye: {
    readonly kind: string | null
    readonly site: string | null
    readonly scrub: number
    readonly height: number
    readonly ground: number
    readonly heading: number
    readonly pitch: number
  }
  readonly sites: readonly SurveySiteRow[] | null
  readonly standing: boolean
  readonly onVisit: (site: string) => void
  readonly onScrub: (scrub: number) => void
  readonly onHeight: (height: number) => void
  readonly onHeading: (radians: number) => void
  readonly onPitch: (radians: number) => void
  readonly onLevel: () => void
  readonly onLeave: () => void
}) {
  if (eye.kind === 'star')
    return (
      <p className="type-ui text-pretty text-slate-400">
        A star has no surface to stand on.
      </p>
    )
  // `null` is "the survey has not run yet", which is one frame after every
  // target change; `[]` is "this body has no sites". Drawing the empty state
  // for the first put "nowhere to stand" on screen for a body with six.
  if (sites === null) return null
  if (sites.length === 0)
    return (
      <p className="type-ui text-pretty text-slate-400">
        Nothing to stand on here. Pick a solid body.
      </p>
    )

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-1.5">
        {sites.map((site) => (
          <button
            key={site.id}
            type="button"
            title={site.detail}
            onClick={(event) => {
              releaseFocus(event)
              onVisit(site.id)
            }}
            // The same card geometry the shot grid uses, and the same reason for
            // the property list on the transition: `cn` is `twMerge`, so a bare
            // `transition-transform` would win the merge and take the hover
            // colors with it.
            className={`group flex flex-col items-start gap-0.5 rounded border px-1.5 py-1 text-left transition-[color,border-color,background-color,scale] active:scale-[0.96] ${
              standing && eye.site === site.id
                ? 'border-sky-500/50 bg-sky-500/15'
                : 'border-slate-700/70 bg-slate-900/50 hover:border-sky-500/60 hover:bg-slate-800/60'
            }`}
          >
            <span
              className={`type-label leading-tight ${
                standing && eye.site === site.id
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

      {!standing ? (
        // The one line the grid needs, and only while the press has not been
        // made: it says what a card does and that the camera is not down there
        // yet. Standing, the same space is the height readout.
        <p className="type-ui text-pretty text-slate-400">
          Pick a site to stand on it. Heights are against this world’s datum.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="type-ui flex items-baseline gap-1.5 text-slate-400">
              Height
              <span className="ml-auto text-slate-300 tabular-nums">
                {formatReading(eye.height)}
              </span>
            </span>
            <Slider
              min={0}
              max={1000}
              step={1}
              value={[Math.round(eye.scrub * 1000)]}
              aria-label="Height above the ground"
              onValueChange={([next]) => {
                // Logarithmic, in the arm rather than here: `heightForScrub`
                // owns the mapping so the slider, the console and the descent
                // probe cannot disagree about what half-way down means.
                if (next !== undefined) onScrub(next / 1000)
              }}
              onClick={releaseFocus}
              className="min-w-0 flex-1 py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
            />
            <div className="flex flex-wrap gap-1">
              {DESCENT_RUNGS.map((rung, index) => (
                <Action
                  key={rung.label}
                  label={rung.label}
                  title={rung.why}
                  tone={index === 0 ? 'primary' : 'normal'}
                  onClick={() => {
                    // `null` is the top of the band, which depends on the body:
                    // the ceiling is the orbit arm's floor, so it is 3,186 km
                    // at Earth and 118 km at Miranda.
                    if (rung.height === null) onScrub(1)
                    else onHeight(rung.height)
                  }}
                />
              ))}
            </div>
          </div>

          <Row label="Ground here" value={elevationText(eye.ground)} />

          <div className="flex flex-col gap-1">
            <span className="type-ui flex items-baseline gap-1.5 text-slate-400">
              Facing
              <span className="ml-auto text-slate-300 tabular-nums">
                {compassDegrees(eye.heading)}°
              </span>
            </span>
            <div className="flex flex-wrap gap-1">
              {COMPASS.map((point) => (
                <Action
                  key={point.label}
                  label={point.label}
                  title={`Face ${point.deg}°`}
                  onClick={() => onHeading((point.deg * Math.PI) / 180)}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="type-ui flex items-baseline gap-1.5 text-slate-400">
              Tilt
              <span className="ml-auto text-slate-300 tabular-nums">
                {degrees(eye.pitch)}°
              </span>
            </span>
            <Slider
              min={-88}
              max={88}
              step={1}
              value={[degrees(eye.pitch)]}
              aria-label="Tilt above the horizontal"
              onValueChange={([next]) => {
                if (next !== undefined) onPitch((next * Math.PI) / 180)
              }}
              onClick={releaseFocus}
              className="min-w-0 flex-1 py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
            />
            <div className="flex flex-wrap gap-1">
              <Action
                label="Level"
                // Below the horizontal, and by more than anyone expects: the
                // dip is `acos(r / (r + h))`, which is 0.045° from 2 m on an
                // Earth-sized body and 19.79° from 400 km. A control that
                // leveled to zero would aim at empty sky from the top of the
                // descent.
                //
                // Solved in the arm rather than here, from the height the
                // stance actually holds: the height this panel can see is up to
                // 125 ms old, and `setStanceHeight` decides whether to keep
                // tracking the horizon by comparing against the dip the
                // *current* height implies — so a pitch solved from a stale
                // height stops the tracking for the rest of the descent.
                title="Put the horizon across the middle of the frame"
                onClick={onLevel}
              />
              <Action
                label="Back to orbit"
                title="Leave the ground, at the framing you left"
                onClick={onLeave}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** Radians as whole degrees, which is every angle this section prints. */
const degrees = (radians: number): number =>
  Math.round((radians * 180) / Math.PI)
