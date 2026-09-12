import { describe, expect, it } from 'vitest'
import { americanize, rulesFiring } from './dictionary.mjs'

describe('American spelling', () => {
  it.each([
    ['alphabetising', 'alphabetizing'],
    ['amortises', 'amortizes'],
    ['capitalised', 'capitalized'],
    ['centralised', 'centralized'],
    ['Circularises', 'Circularizes'],
    ['customisation', 'customization'],
    ['generalisation', 'generalization'],
    ['hybridisation', 'hybridization'],
    ['internalising', 'internalizing'],
    ['localised', 'localized'],
    ['materialised', 'materialized'],
    ['memoised', 'memoized'],
    ['memorising', 'memorizing'],
    ['modernised', 'modernized'],
    ['Monetisation', 'Monetization'],
    ['personalisation', 'personalization'],
    ['photosynthesises', 'photosynthesizes'],
    ['physicalised', 'physicalized'],
    ['pressurised', 'pressurized'],
    ['rationalisation', 'rationalization'],
    ['analysing', 'analyzing'],
    ['catalogued', 'cataloged'],
    ['cataloguing', 'cataloging'],
    ['cataloguer', 'cataloger'],
    ['catalogue', 'catalog'],
    ['cancellable', 'cancelable'],
    ['levelling', 'leveling'],
    ['afterwards', 'afterward'],
    ['polarisation', 'polarization'],
    ['colourIndex', 'colorIndex'],
    ['COLOUR_LUT', 'COLOR_LUT'],
    ['Centred', 'Centered'],
    ['normalisation', 'normalization'],
    ['realised', 'realized'],
    ['emphasising', 'emphasizing'],
  ])('rewrites %s as %s', (source, expected) => {
    expect(americanize(source)).toBe(expected)
    expect(americanize(expected)).toBe(expected)
    expect(rulesFiring(source).length).toBeGreaterThan(0)
  })
  it.each([
    'analyses',
    'synthesis',
    'photosynthesis',
    'generalist',
    'rationalism',
    'realistic',
    'realism',
    'organism',
    'optimism',
    'emphasis',
    'promise',
    'CapabilityResult',
    'characteristic',
    'Polaris',
    'polaris',
    'DescentReport',
    'descentRegions',
  ])('preserves %s', (word) => {
    expect(americanize(word)).toBe(word)
    expect(rulesFiring(word)).toEqual([])
  })
  it('guards each occurrence even when the British verb shares a sentence with the noun', () => {
    expect(americanize('emphasis and emphasise')).toBe('emphasis and emphasize')
  })
})
