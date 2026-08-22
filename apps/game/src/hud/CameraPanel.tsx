import { DEFAULT_FOV } from '../engine/GameEngine.ts'
import { FOCUS_RING } from './focus.ts'
import { Action, Section } from './widgets.tsx'

/*
 * The camera, as an adjustable instrument.
 *
 * The field of view is the one lens decision in every screenshot: 65° is the
 * flying default, and it is also why a planet filling the frame from close up
 * wears a magnified cap of itself. A photographic comparison sometimes wants
 * the longer lens, and reloading to test one is how nobody ever tests one.
 * The slider writes `engine.fov`; `CameraRig` applies it, so the value
 * survives the canvas remounting under an HDR change.
 */

export interface CameraState {
  readonly fov: number
  readonly onFov: (fov: number) => void
}

/** The slider's range. 20° is a telephoto; past 110° everything fisheyes. */
const FOV_MIN = 20
const FOV_MAX = 110

export function CameraPanel({ camera }: { camera: CameraState }) {
  return (
    <div>
      <Section
        id="camera.lens"
        title="field of view"
        trailing={`${camera.fov}°`}
      >
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={FOV_MIN}
            max={FOV_MAX}
            step={1}
            value={camera.fov}
            onChange={(event) => camera.onFov(Number(event.target.value))}
            className={`min-w-0 flex-1 accent-sky-500 ${FOCUS_RING}`}
            aria-label="Field of view, degrees"
          />
          <span className="w-9 shrink-0 text-right tabular-nums text-slate-300">
            {camera.fov}°
          </span>
          <Action
            label="reset"
            title={`Back to the ${DEFAULT_FOV}° flying default`}
            disabled={camera.fov === DEFAULT_FOV}
            onClick={() => camera.onFov(DEFAULT_FOV)}
          />
        </div>
        <div className="mt-1 text-slate-600">
          Narrow reads like a telephoto photograph; wide is for flying. The
          bookmarks in navigate → shots were composed at {DEFAULT_FOV}°.
        </div>
      </Section>
    </div>
  )
}
