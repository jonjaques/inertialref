import { Link } from 'react-router'
import { Clapperboard, Play } from 'lucide-react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { FOCUS_RING } from '../hud/focus.ts'
import { cinemaScene } from '../pages/paths.ts'
import { secondsText } from './timecode.ts'

/** Every scene this build ships, as a list you can open one of. */
export function CinemaLibrary({ engine }: { engine: GameEngine }) {
  const scenes = engine.harness.cutscenes()
  return (
    // A scrim, because the library sits over whatever the world is showing and
    // that is very often a sunlit planet. `docs/design/ux.md` measured 70% in
    // front of Earth as the point where a page reads without obliterating what
    // it is over; the same number, for the same reason.
    <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-slate-950/70 p-6">
      <div className="w-full max-w-2xl">
        <header className="mb-6 flex items-center gap-3">
          <Clapperboard className="size-6 text-sky-400" />
          <div>
            <h1 className="text-lg tracking-[0.2em] text-slate-100 uppercase">
              Cinema
            </h1>
            <p className="font-mono text-[11px] text-slate-400">
              scripted scenes, played over the live world — nothing here is a
              video file
            </p>
          </div>
        </header>

        <ul className="flex flex-col gap-2">
          {scenes.map((entry) => (
            <li key={entry.id}>
              <Link
                to={cinemaScene(entry.id)}
                className={`flex items-center gap-3 rounded-lg border border-slate-700/60 bg-slate-950/80 px-4 py-3 backdrop-blur transition-colors hover:border-sky-500/60 hover:bg-slate-900/80 ${FOCUS_RING}`}
              >
                <Play className="size-4 shrink-0 text-sky-400" />
                <span className="min-w-0 flex-1">
                  <span className="block text-slate-100">{entry.id}</span>
                  <span className="block truncate font-mono text-[11px] text-slate-400">
                    {entry.description}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-slate-400 tabular-nums">
                  {/* `secondsText`, not the same arithmetic inlined: rounding
                      the seconds *within* the minute rendered a 119.6 s scene
                      as `1:60`. */}
                  {secondsText(entry.seconds)}
                </span>
              </Link>
            </li>
          ))}
          {scenes.length === 0 && (
            <li className="rounded-lg border border-dashed border-slate-700/60 px-4 py-6 text-center font-mono text-[11px] text-slate-400">
              no scenes in this build
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}
