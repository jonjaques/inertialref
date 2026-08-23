'use no memo'
import { useParams } from 'react-router'
import { Workspace } from '../dock/Workspace.tsx'
import type { DevWorkspace } from '../dock/workspace.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import { usePolled } from '../hud/usePolled.ts'
import { CinemaLibrary } from './CinemaLibrary.tsx'
import { CinemaPlayer } from './CinemaPlayer.tsx'
import { useTransportIdle } from './useTransportIdle.ts'

/**
 * `/cinema` is a library and `/cinema/:scene` is a player.
 *
 * One route entry with a branch rather than two components wired separately,
 * because the two share nothing but the path prefix — and the branch is the
 * cheapest place to say which of them a URL means.
 *
 * `'use no memo'`: the running check below reads `engine.harness`, a stable
 * reference whose contents change every frame. The compiler would render the
 * poll once and show that forever.
 */
export function CinemaMode({
  engine,
  dev,
}: {
  engine: GameEngine
  dev: DevWorkspace
}) {
  const { scene } = useParams<{ scene?: string }>()
  /*
   * Is a scene actually playing — running, not merely open?
   *
   * Off the harness rather than out of the player's state, because both bars
   * that fade have to agree and only one of them is the player. A paused or
   * ended scene is one somebody is working with, and its controls stay put.
   */
  const running = usePolled(
    () =>
      engine.harness.cutsceneStatus() !== null && !engine.world.clock.paused,
    4,
  )
  const idle = useTransportIdle(running)

  return (
    <>
      {scene === undefined ? (
        <CinemaLibrary engine={engine} />
      ) : (
        <CinemaPlayer engine={engine} id={scene} idle={idle} />
      )}
      {/*
       * The workspace over both, and over the library too — which it was not,
       * for one revision, with the argument that a library is a page and a page
       * does not want panels over it.
       *
       * That argument was about the panes and it left the *menu* out with them.
       * The IR menu is not panel chrome: it is where you are, the way back to
       * the front door, and the settings, and `/cinema` was the one screen in
       * the build with no way off it that was not the browser's back button.
       *
       * It costs nothing to render here. Cinema contributes no panels of its
       * own and the instruments start closed, so with nothing open a pane draws
       * nothing at all — `DockPane` returns null on an empty zone with no drag
       * in flight. What is left is the bar.
       *
       * And the bar fades with the transport. `pointer-events-none` while it is
       * out, so a click aimed at the frame does not land on a menu nobody can
       * see; the same pointer move that brings the transport back brings this.
       */}
      {/*
       * `visibility` alongside the opacity, and the wrapper stays
       * `pointer-events-none` throughout — the menu inside turns events back on
       * for itself, exactly as it does under `.hud-layer`. Opacity alone would
       * leave a fully invisible bar taking clicks across the bottom of a
       * playing scene. `visibility` transitions as a discrete step that holds
       * `visible` until the end, so the fade still plays on the way out.
       */}
      <div
        className={`pointer-events-none absolute inset-0 transition-[opacity,visibility] duration-300 ${
          idle ? 'invisible opacity-0' : 'visible opacity-100'
        }`}
      >
        <Workspace id="cinema" title="Cinema" panels={NO_PANELS} dev={dev} />
      </div>
    </>
  )
}

/** Cinema contributes no panels of its own. Named, so the array is stable. */
const NO_PANELS = [] as const
