import type { AaLevel, OutputPreference } from '../render/output.ts'
import type { RendererDescription } from '../render/output.ts'

/*
 * The knobs the shell owns, as types.
 *
 * Its own module for the reason `planetarium/context.ts` gives: a `.tsx` file
 * that exports anything besides components is a file Vite's Fast Refresh gives
 * up on, and in this app a full reload means rebuilding the renderer and losing
 * the camera. These four shapes were declared in the four component files that
 * happen to draw them, and every one of those files is edited while iterating
 * on a panel.
 *
 * They are also read in two places each — the dev dock and the `/settings`
 * page — which is the other half of why they are here: two inline object
 * literals for "the graphics knobs" is how a build ends up with two
 * anti-aliasing switches that disagree.
 */

/**
 * The field-of-view range, once.
 *
 * 20° is a telephoto; past 110° everything fisheyes. Stated here because three
 * places need it and they must agree: the camera panel's slider, the
 * planetarium's own lens control, and the guard on the persisted value in
 * `App`. A stored 5000° is not a field of view somebody nearly asked for — it
 * reaches `engine.fov` and the projection matrix behind it.
 */
export const FOV_MIN = 20
export const FOV_MAX = 110

export interface CameraState {
  readonly fov: number
  readonly onFov: (fov: number) => void
}

export interface GraphicsState {
  readonly lensFlare: boolean
  readonly onLensFlare: (on: boolean) => void
  readonly aa: AaLevel
  readonly onAa: (level: AaLevel) => void
}

/**
 * The renderer, as far as the dock is concerned: what was asked for, what came
 * back, and how to ask for something else.
 *
 * One shape rather than three because they are read together — the whole point
 * of showing the resolved mode next to the preference is that they routinely
 * disagree, and a browser that cannot produce extended range is supposed to say
 * so rather than silently ignore the setting.
 */
export interface HudRenderState {
  readonly preference: OutputPreference
  readonly output: RendererDescription | null
  /**
   * Ask for a specific state, not the next one.
   *
   * This was `onCyclePreference`, and cycling is what a three-state setting
   * does when it is drawn as one button: reaching `standard` from `standard`
   * cost three presses and three renderer rebuilds, each of which is a visible
   * stall. The control is a radio group now, so the verb is the one a radio
   * group has.
   */
  readonly onPreference: (preference: OutputPreference) => void
}

/** Every verb that is bound to both a key and a button. See `App`. */
export interface HudCommands {
  readonly togglePause: () => void
  readonly warp: (direction: number) => void
  readonly toggleAssist: () => void
  readonly killRotation: () => void
  readonly save: () => void
  readonly load: () => void
}
