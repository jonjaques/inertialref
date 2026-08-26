import type { Neighbour } from './catalogue.ts'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { starColour } from './kinds.ts'

/**
 * Where you are, and what is around you — one rail, a few light years wide.
 *
 * The catalog is a list and a list answers "what is there". It cannot answer
 * "how far apart is any of it", which in a planetarium is the question: Proxima
 * at 4.24 ly and Sirius at 8.6 ly are two rows differing by a numeral, and the
 * fact that one is twice as far as the other never lands. Drawn on a scale, it
 * lands immediately and costs 28 px.
 *
 * The dots are real stars at their real distances in their real colours —
 * `docs/design/art.md` puts a star's colour on the list of things this game may
 * not invent, so an M dwarf is the dim red one and looks it. Clicking a dot
 * flies the camera there, which makes this the fastest control in the mode for
 * the one gesture it is worth being fast at.
 *
 * The scale is `√r`, argued in `catalogue.ts` § `neighbours`. The short version
 * is that a survey's volume grows as r³, so linearly the whole neighborhood
 * piles into the left tenth of the rail.
 */
export function NeighbourhoodRail({
  stars,
  radiusLightYears,
  target,
  onFocus,
}: {
  stars: readonly Neighbour[]
  radiusLightYears: number
  /** The system the camera is in, so its dot can be marked. */
  target: string | null
  onFocus: (address: string) => void
}) {
  if (stars.length === 0) return null

  return (
    <div className="flex flex-col gap-1 rounded border border-slate-800/80 bg-slate-900/40 px-2 pt-1.5 pb-1">
      <div className="type-label flex items-baseline justify-between text-sky-400/80">
        Neighborhood
        <span className="type-micro text-slate-400 normal-case tabular-nums">
          {stars.length} within {radiusLightYears} ly
        </span>
      </div>

      {/*
       * `relative` over a 20 px band, with each star absolutely placed.
       *
       * A flex row would space them evenly, which is the one thing this must
       * not do — the whole content of the picture is that they are *not* evenly
       * spaced. `left` as a percentage keeps it correct at every panel width,
       * including the 19 rem column and the bottom sheet on a phone.
       */}
      <div className="relative h-5">
        {/* The axis, and the eye sitting on its left end. */}
        <span
          aria-hidden
          className="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 bg-gradient-to-r from-sky-400/40 to-slate-700/60"
        />
        {stars.map((star) => {
          const here = star.address === target
          const tint = starColour(star.colour)
          return (
            <button
              key={star.address}
              type="button"
              aria-current={here}
              title={`${star.name} — ${star.lightYears.toFixed(2)} ly`}
              onClick={(event) => {
                releaseFocus(event)
                onFocus(star.address)
              }}
              /*
               * 20 px of hit area around a 6 px dot, and the two are different
               * boxes on purpose — the same split `FovSlider` makes for the
               * thumb and its track. Dots overlap where two stars are at
               * similar distances, so the *drawn* mark has to stay small while
               * the target stays reachable; the last one painted wins the
               * click, which is the near one, which is the one a pointer aimed
               * between two of them most likely meant.
               */
              className={`absolute top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition-transform hover:scale-125 active:scale-[0.96] ${FOCUS_RING}`}
              style={{ left: `${star.at * 100}%` }}
            >
              <span
                aria-hidden
                className={`block rounded-full ${here ? 'size-2.5 ring-2 ring-sky-300/70' : 'size-1.5'}`}
                style={{
                  backgroundColor: tint ?? 'rgb(148 163 184)',
                  // Unloaded is dimmer, which is the same claim the catalog
                  // row's glyph makes: charted, not yet resolved into a system.
                  opacity: star.loaded ? 1 : 0.5,
                }}
              />
            </button>
          )
        })}
      </div>

      {/* Two ticks, not a ruler. The rail is a sense of scale rather than an
          instrument, and a labeled axis under a 28 px band is more chrome than
          picture. Both are placed by the same √ scale the dots are, so the
          midpoint label sits where a quarter of the radius actually falls. */}
      <div className="type-micro relative h-3 text-slate-500 tabular-nums">
        <span className="absolute left-0">here</span>
        {/* A quarter of the radius, because the scale is √r and this is the
            halfway mark on it. One decimal: at a 10 ly sweep the midpoint is
            2.5 ly, and rounding it to "3" puts a wrong number under a tick
            that is drawn in exactly the right place. */}
        <span className="absolute left-1/2 -translate-x-1/2">
          {(radiusLightYears / 4).toFixed(1)}
        </span>
        <span className="absolute right-0">{radiusLightYears} ly</span>
      </div>
    </div>
  )
}
