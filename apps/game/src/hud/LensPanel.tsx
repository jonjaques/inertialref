import { useId } from 'react'
import { Link, useLocation } from 'react-router'
import { GALAXY_VIEWS } from '@inertialref/rendering'
import { Slider } from '@/components/ui/slider'
import { overlayState, settingsSection } from '../pages/paths.ts'
import { useEngine } from '../state/engineStore.ts'
import { RENDER_LENS_FLARE, usePersistentState } from '../state/preferences.ts'
import { formatShutter } from './controls.ts'
import { FOCUS_RING, releaseFocus } from './focus.ts'
import { LensSection } from './LensSection.tsx'
import { OpticsSection } from './OpticsSection.tsx'

/**
 * The instrument the picture is taken through: the camera's processing, the
 * glass, and what the two of them resolve to.
 *
 * A panel of its own, in every mode with a viewport — the planetarium and the
 * flight modes register the same component, as they do the Navigator. The
 * lens is set beside the picture it shapes: a settings page opens over the
 * menu as readily as over a mode and cannot show the picture, a section under
 * the Camera panel's pose is a scroll past the verbs that panel is opened
 * for, and a panel nobody opens until they want it costs a glyph in the menu
 * and nothing else. ADR-0058 has the alternatives.
 *
 * `glare` is the planetarium's, and only it passes one: it is how much of the
 * flare's ghost-and-streak stack a photograph shows, which is a choice about
 * one picture. Whether there is a flare at all is the display's, in Settings,
 * and while that is off the glare row says so and where, rather than being a
 * slider that moves nothing.
 */
export function LensPanel({
  glare,
}: {
  glare?: {
    readonly amount: number
    readonly onAmount: (amount: number) => void
  }
}) {
  const location = useLocation()
  const id = useId()
  /*
   * A fixed Milky Way view owns the lens on screen while it is held
   * (`engine.lens`, rule 32), and keeps this one aside. One string out of the
   * snapshot, so the panel re-renders when the instrument changes and not at
   * the sample rate.
   */
  const galaxy = useEngine((snapshot) => snapshot.observer?.galaxyView ?? null)
  const [flare] = usePersistentState(RENDER_LENS_FLARE)
  const instrument = galaxy === null ? null : GALAXY_VIEWS[galaxy]
  const percent = Math.round((glare?.amount ?? 0) * 100)

  return (
    <div className="flex flex-col gap-1">
      {instrument !== null && (
        <p
          role="status"
          className="type-ui mb-1 rounded border border-slate-800/80 bg-slate-900/40 px-2 py-1.5 text-pretty text-sky-200"
        >
          The Milky Way view exposes through its own lens —{' '}
          {formatShutter(instrument.lens.shutter)} at f/
          {instrument.lens.fStop}, ISO {instrument.lens.iso}. Your lens and
          camera mode are kept, and come back when you look at something else.
        </p>
      )}
      <LensSection held={instrument !== null}>
        {glare !== undefined && (
          /*
           * Glare is the fifth channel, in the same two lines as the four
           * above it.
           *
           * An aperture is a designed object, so what it does to a bright
           * source is a property of the instrument rather than of the star —
           * `docs/design/art.md` licenses glare, bloom and diffraction spikes
           * on exactly that basis. Which makes it a lens control and not a
           * lie: at zero this is the sky with no optics in front of it.
           */
          <div className="flex flex-col">
            <div className="flex items-baseline justify-between gap-3">
              <span id={id} className="type-ui shrink-0 text-slate-400">
                Glare
              </span>
              <span className="type-readout truncate text-right text-slate-300">
                {flare ? `${percent}%` : 'off'}
              </span>
              <span id={`${id}-about`} hidden>
                Lens glare — ghosts, streaks and bloom
              </span>
            </div>
            <Slider
              min={0}
              max={100}
              step={5}
              value={[percent]}
              // Off with the flare in Settings, and while a Milky Way view
              // holds the optics: its instrument draws no flare at all, so the
              // slider would move nothing either way.
              disabled={!flare || instrument !== null}
              // Named by the word above it, as the lens channels are; the
              // sentence that says what glare is goes in the description.
              aria-labelledby={id}
              aria-describedby={`${id}-about`}
              aria-valuetext={`${percent}%`}
              onValueChange={([next]) => {
                if (next !== undefined) glare.onAmount(next / 100)
              }}
              onClick={releaseFocus}
              // The same 24px-of-hit-area-around-a-6px-track geometry
              // `LensSlider` documents.
              className="min-w-0 flex-1 py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
            />
            {!flare && (
              <p className="type-ui text-pretty text-slate-400">
                Lens flare is off for every mode in{' '}
                <Link
                  to={settingsSection('display')}
                  state={overlayState(location)}
                  className={`rounded text-sky-300 underline-offset-2 hover:text-sky-200 hover:underline ${FOCUS_RING}`}
                >
                  Settings · Display
                </Link>
                .
              </p>
            )}
          </div>
        )}
      </LensSection>
      <OpticsSection />
    </div>
  )
}
