import { describe, expect, it } from 'vitest'
import { americanize, rulesFiring } from './dictionary.mjs'

describe('American spelling', () => {
  it.each([
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
