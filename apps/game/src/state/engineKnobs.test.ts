import { afterEach, describe, expect, it } from 'vitest'
import { LENS_PRESETS, lensForFov } from '@inertialref/rendering'
import { aaDprFactor } from '../render/output.ts'
import { DEFAULT_SURFACE_QUALITY } from '../render/quality.ts'
import { bindEngineKnobs, type EngineKnobs } from './engineKnobs.ts'
import {
  CAMERA_LENS,
  read,
  RENDER_AA,
  RENDER_LENS_FLARE,
  RENDER_SURFACE,
  write,
} from './preferences.ts'

/*
 * The round trip between a preference and the field the frame loop reads,
 * in Node, with the registry's in-memory storage.
 *
 * This is the test the shell's mirror effect could not have: the defect it
 * guards — an unrelated toggle re-asserting the lens — lived in an effect's
 * dependency list, which only a browser could exercise.
 */

const KNOBS = [CAMERA_LENS, RENDER_LENS_FLARE, RENDER_SURFACE, RENDER_AA]

function engine(): EngineKnobs {
  return {
    flightLens: LENS_PRESETS.flight,
    lensFlare: true,
    surfaceQuality: DEFAULT_SURFACE_QUALITY,
    supersample: 1,
    onLensRequest: null,
  }
}

describe('the engine knobs', () => {
  afterEach(() => {
    for (const knob of KNOBS) write(knob, knob.initial)
  })

  it('applies what is stored on the way in', () => {
    write(RENDER_LENS_FLARE, false)
    write(RENDER_AA, '4x')
    const bound = engine()
    const release = bindEngineKnobs(bound)
    expect(bound.lensFlare).toBe(false)
    expect(bound.supersample).toBe(aaDprFactor('4x'))
    expect(bound.flightLens).toEqual(read(CAMERA_LENS))
    release()
  })

  it('follows a write to its own key, and no other', () => {
    const bound = engine()
    const release = bindEngineKnobs(bound)
    const wide = lensForFov(80)
    write(CAMERA_LENS, wide)
    expect(bound.flightLens).toEqual(wide)
    // The Saturn case: an unrelated toggle must leave the lens where a verb
    // put it. The anti-aliasing listener writes the supersample factor alone.
    write(RENDER_AA, '4x')
    expect(bound.supersample).toBe(aaDprFactor('4x'))
    expect(bound.flightLens).toEqual(wide)
    release()
  })

  it('routes a lens the engine did not choose into the preference, and back', () => {
    const bound = engine()
    const release = bindEngineKnobs(bound)
    const fitted = lensForFov(42)
    expect(bound.onLensRequest).not.toBeNull()
    bound.onLensRequest?.(fitted)
    // The owner has it, so a reload and the panel's sliders agree with the
    // picture — and the field follows through the same binding.
    expect(read(CAMERA_LENS)).toEqual(fitted)
    expect(bound.flightLens).toEqual(fitted)
    release()
  })

  it('keeps a lens the sliders cannot reach on the field, and off the owner', () => {
    // The field's guard admits a 5° lens; the preference's does not. Asking the
    // owner anyway would announce the default back onto the field — a script's
    // picture reverted for wanting an angle the panel does not offer.
    const bound = engine()
    const release = bindEngineKnobs(bound)
    const before = read(CAMERA_LENS)
    const narrow = lensForFov(5)
    expect(CAMERA_LENS.accept(narrow)).toBe(false)
    bound.flightLens = narrow
    bound.onLensRequest?.(narrow)
    expect(read(CAMERA_LENS)).toEqual(before)
    expect(bound.flightLens).toBe(narrow)
    release()
  })

  it('stops following once released', () => {
    const bound = engine()
    const release = bindEngineKnobs(bound)
    release()
    write(RENDER_LENS_FLARE, false)
    expect(bound.lensFlare).toBe(true)
    expect(bound.onLensRequest).toBeNull()
  })
})
