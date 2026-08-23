import { DEFAULT_FOV } from '../engine/GameEngine.ts'
import { Action } from './Action.tsx'
import type { CameraState } from './controls.ts'
import { FovSlider } from './FovSlider.tsx'
import { Section } from './Section.tsx'

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

export function CameraPanel({ camera }: { camera: CameraState }) {
  return (
    <div>
      <Section
        id="camera.lens"
        title="Field of View"
        trailing={`${camera.fov}°`}
      >
        <div className="flex items-center gap-2">
          <FovSlider fov={camera.fov} onFov={camera.onFov} />
          <span className="w-9 shrink-0 text-right text-slate-300 tabular-nums">
            {camera.fov}°
          </span>
          <Action
            label="Reset"
            title={`Back to the ${DEFAULT_FOV}° flying default`}
            disabled={camera.fov === DEFAULT_FOV}
            onClick={() => camera.onFov(DEFAULT_FOV)}
          />
        </div>
        <div className="mt-1 text-slate-400">
          Narrow reads like a telephoto photograph; wide is for flying. The
          bookmarks in navigate → shots were composed at {DEFAULT_FOV}°.
        </div>
      </Section>
    </div>
  )
}
