import { describe, expect, it } from 'vitest'
import { CUTSCENES } from '@inertialref/devtools'
import { soundtrackCandidates, soundtrackFor } from './cutsceneAudio.ts'

/*
 * Sound is staging, so a script declares it. The title sequence's music used
 * to play over every scene, from the first frame of the Mars landing's entry
 * burn, because the overlay owned one track and started it for whatever was
 * open.
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
