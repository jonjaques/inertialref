import { describe, expect, it } from 'vitest'
import { CUTSCENES } from '@inertialref/devtools'
import { soundtrackCandidates, soundtrackFor } from './cutsceneAudio.ts'

/*
 * Sound is staging, so a script declares it. An overlay that owns one track
 * and starts it for whatever is open plays the title sequence's music over
 * every scene, from the first frame of the Mars landing's entry burn.
 */

const scenes = CUTSCENES.map((script) => ({
  id: script.id,
  soundtrack: script.soundtrack ?? null,
}))

describe('a scene’s soundtrack', () => {
  it('belongs to the title sequence and to nothing else in the library', () => {
    expect(soundtrackFor(scenes, 'tng-intro')).toBe('tng-intro')
    expect(soundtrackFor(scenes, 'mars-landing')).toBeNull()
    expect(soundtrackFor(scenes, 'nothing')).toBeNull()
    expect(soundtrackFor(scenes, null)).toBeNull()
  })

  it('is asked for as AAC first and MPEG second, under /media/', () => {
    // The order is Safari's: it chases a clock by seeking, and only the AAC
    // carries a sample table a seek can land on exactly.
    expect(soundtrackCandidates('tng-intro').map((c) => c.src)).toEqual([
      '/media/tng-intro.m4a',
      '/media/tng-intro.mp3',
    ])
    expect(soundtrackCandidates('tng-intro')[0]?.type).toContain('mp4a.40.2')
  })
})
