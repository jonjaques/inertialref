import type { Lens } from '@inertialref/rendering'
import { aaDprFactor } from '../render/output.ts'
import type { SurfaceQuality } from '../render/quality.ts'
import {
  CAMERA_LENS,
  type Preference,
  read,
  RENDER_AA,
  RENDER_LENS_FLARE,
  RENDER_SURFACE,
  subscribe,
  write,
} from './preferences.ts'

/*
 * The knobs the frame loop reads, bound to the preferences that own them.
 *
 * The engine holds each as a plain field — the frame loop reads it every frame
 * and must not touch React to do it — and the preference is the owner: a
 * reload restores it, an import replaces it, a panel's slider writes it. This
 * is the one table that says which field follows which key, so a knob the
 * engine reads is one definition in `preferences.ts` and one row here, and
 * nothing in the shell has to thread a value and a setter through the modes to
 * get it there.
 *
 * **One subscription per key, not one effect over all of them.** A single
 * effect keyed on every render preference re-asserts every field whenever any
 * of them moves, and a lens a verb fitted then holds its picture only until
 * the next unrelated toggle — press The Rings, change the anti-aliasing, and
 * Saturn goes from 0.660 of the frame height to 0.812 with the A ring's outer
 * edge off both sides. A binding per key cannot do that: the anti-aliasing's
 * listener writes the supersample factor and nothing else.
 *
 * The lens goes the other way as well. `ir.preset` and `ir.rise` solve a lens
 * as part of a picture and hand it to `engine.requestLens`; the sink installed
 * here writes it into the preference, and the binding above carries it back to
 * the field — so the panel's sliders agree with the picture on screen and the
 * picture survives a reload.
 */

/** What the bindings write, and all an engine has to be to take them. */
export interface EngineKnobs {
  flightLens: Lens
  lensFlare: boolean
  surfaceQuality: SurfaceQuality
  supersample: number
  onLensRequest: ((lens: Lens) => void) | null
}

/** One row: apply the stored value now, then follow the key. */
const knob =
  <T>(
    preference: Preference<T>,
    apply: (engine: EngineKnobs, value: T) => void,
  ) =>
  (engine: EngineKnobs): (() => void) => {
    apply(engine, read(preference))
    return subscribe(preference, (value) => apply(engine, value))
  }

const KNOBS: readonly ((engine: EngineKnobs) => () => void)[] = [
  knob(CAMERA_LENS, (engine, lens) => {
    engine.flightLens = lens
  }),
  knob(RENDER_LENS_FLARE, (engine, on) => {
    engine.lensFlare = on
  }),
  knob(RENDER_SURFACE, (engine, quality) => {
    engine.surfaceQuality = quality
  }),
  // What the drawing buffer is multiplied by, so the terrain predicate can
  // divide it back out: supersampling raises the sample count, not the detail
  // a viewer can resolve. See `GameEngine.supersample`.
  knob(RENDER_AA, (engine, level) => {
    engine.supersample = aaDprFactor(level)
  }),
]

/**
 * Bind an engine's knobs to the registry, and return the release.
 *
 * Applies every stored value on the way in, so an engine bound after boot
 * carries the preferences rather than its defaults.
 */
export function bindEngineKnobs(engine: EngineKnobs): () => void {
  const releases = KNOBS.map((bind) => bind(engine))
  engine.onLensRequest = (lens) => write(CAMERA_LENS, lens)
  return () => {
    for (const release of releases) release()
    engine.onLensRequest = null
  }
}
