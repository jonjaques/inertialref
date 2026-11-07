import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { creditWithChange, readSoundtrackCatalog } from './audio.ts'
import { AUDIO_SOURCES } from './audioSources.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const NOTICE = new URL('../../../data/audio/LICENSE.md', import.meta.url)

describe('creditWithChange', () => {
  it('stops a credit that ends on a bare domain before the notice', () => {
    expect(
      creditWithChange(
        '"Cylinders" by Chris Zabriskie. chriszabriskie.com',
        'level lowered 1.0 dB, re-encoded as AAC and Opus',
      ),
    ).toBe(
      '"Cylinders" by Chris Zabriskie. chriszabriskie.com. Modified: level lowered 1.0 dB, re-encoded as AAC and Opus.',
    )
  })

  it('adds no second stop to a credit that has one', () => {
    expect(
      creditWithChange('Ascent by HoliznaCC0. CC0.', 'level unchanged'),
    ).toBe('Ascent by HoliznaCC0. CC0. Modified: level unchanged.')
    expect(creditWithChange('A (CC BY 4.0)', 'x')).toBe(
      'A (CC BY 4.0) Modified: x.',
    )
  })

  it('always opens the notice as a sentence of its own', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((text) => text.trim() !== ''),
        fc.string({ minLength: 1 }),
        (credit, modified) => {
          const joined = creditWithChange(credit, modified)
          expect(joined).toMatch(/[.!?)] Modified: /)
          expect(joined.endsWith('.')).toBe(true)
        },
      ),
    )
  })
})

describe('the committed soundtrack', () => {
  const catalog = readSoundtrackCatalog(ROOT)

  it('carries every source that is not held, and nothing else', () => {
    const shipped = AUDIO_SOURCES.filter((source) => source.held === undefined)
    expect(catalog.tracks.map((track) => track.id).sort()).toEqual(
      shipped.map((source) => source.id).sort(),
    )
  })

  it('credits every track in sentences, with what was changed', () => {
    for (const track of catalog.tracks) {
      expect(track.credit, track.id).toMatch(/[.!?)] Modified: .+\.$/)
      expect(track.credit, track.id).toContain(track.modified)
    }
  })

  /*
   * A loudness target in prose is a negative number, and a hyphen in front of
   * one is a hyphen: a screen reader says "eighteen", not "minus eighteen".
   */
  it('prints the loudness target with a minus sign', () => {
    const notice = readFileSync(NOTICE, 'utf8')
    expect(notice).toContain('−18 LUFS integrated')
    expect(notice).toContain('−1 dBTP ceiling')
    expect(notice).not.toMatch(/-\d+ (LUFS|dBTP)/)
  })
})
