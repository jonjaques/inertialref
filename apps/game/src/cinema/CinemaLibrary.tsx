import { Play } from 'lucide-react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { FOCUS_RING } from '../hud/focus.ts'
import { cinemaScene } from '../pages/paths.ts'
import { secondsText } from './timecode.ts'

/**
 * Every scene this build ships, as a list you can open one of.
 *
 * A running order, not a grid of thumbnails — there are no thumbnails, because
 * there is no video: each of these is a script the director plays against the
 * live world, which is the one thing about this screen worth saying out loud.
 * So the page says it, once, under the title, and then gets out of the way.
 */
export function CinemaLibrary({ engine }: { engine: GameEngine }) {
  const scenes = engine.harness.cutscenes()
  return (
    // A scrim, because the library sits over whatever the world is showing and
    // that is very often a sunlit planet. `docs/design/ux.md` measured 70% in
    // front of Earth as the point where a page reads without obliterating what
    // it is over; the same number, for the same reason.
    // Centered by the child's `m-auto`, not by `items-center`/`justify-center`
    // on the scroller: auto margins collapse when the column outgrows the
    // frame, where flex centering overflows it symmetrically — and the half
    // above the scroll origin, the heading first, is unreachable by any
    // scroll.
    // `hud-bleed`, for the same reason the settings scrim carries it: a dimmed
    // screen with an undimmed band along an edge reads as a rendering fault.
    // The padding is spelled out rather than left to `p-6` because the class
    // and the utility would both be setting `padding` in the same cascade
    // layer; `max` keeps the design's 1.5 rem wherever the OS has spent less.
    <div
      className="hud-bleed pointer-events-auto absolute flex overflow-y-auto bg-slate-950/70"
      style={{
        paddingTop: 'max(1.5rem, var(--safe-top))',
        paddingRight: 'max(1.5rem, var(--safe-right))',
        paddingBottom: 'max(1.5rem, var(--safe-bottom))',
        paddingLeft: 'max(1.5rem, var(--safe-left))',
      }}
    >
      <div className="m-auto w-full max-w-2xl">
        <header className="mb-7 border-b border-slate-800 pb-4">
          {/* The display face, at the size a place gets. `Cinema` is a mode —
              the same kind of noun the front door sets in it, and the same one
              the IR menu prints beside the mark. */}
          <h1 className="type-display text-[2.75rem] text-slate-50">Cinema</h1>
          <p className="type-body mt-2 max-w-[52ch] text-slate-400">
            Scripted scenes, played over the live world. Nothing here is a video
            file — the director drives the same camera the planetarium does, one
            frame at a time, and every frame is addressable.
          </p>
        </header>

        <ul className="flex flex-col gap-2">
          {scenes.map((entry) => (
            <li key={entry.id}>
              <a
                href={cinemaScene(entry.id)}
                className={`group flex items-center gap-4 rounded-lg border border-slate-700/60 bg-slate-950/80 px-4 py-3.5 backdrop-blur transition-colors hover:border-sky-500/60 hover:bg-slate-900/80 ${FOCUS_RING}`}
              >
                <Play className="size-4 shrink-0 text-sky-400 transition-colors group-hover:text-sky-300" />
                <span className="min-w-0 flex-1">
                  {/* The scene id, in the Instrument register: it is an
                      identifier — the thing that goes in the URL and into
                      `ir.play()` — rather than a title somebody wrote. */}
                  <span className="type-readout block truncate text-slate-100">
                    {entry.id}
                  </span>
                  <span className="type-ui mt-0.5 block truncate text-slate-400">
                    {entry.description}
                  </span>
                </span>
                <span className="type-figure shrink-0 text-slate-300">
                  {/* `secondsText`, not the same arithmetic inlined: rounding
                      the seconds *within* the minute rendered a 119.6 s scene
                      as `1:60`. */}
                  {secondsText(entry.seconds)}
                </span>
              </a>
            </li>
          ))}
          {scenes.length === 0 && (
            <li className="type-ui rounded-lg border border-dashed border-slate-700/60 px-4 py-8 text-center text-slate-400">
              no scenes in this build
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}
