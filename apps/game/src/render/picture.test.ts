import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PICTURE,
  PICTURE_AA,
  PICTURE_SCALES,
  PICTURE_SHARPNESS,
  isPicture,
  parsePictureQuery,
  pictureDimensions,
  pictureDprFactor,
  pictureRatio,
  pictureSamples,
  pictureSharpness,
  resolvePicture,
} from './picture.ts'

describe('the picture record', () => {
  it('keeps native MSAA as the default', () => {
    expect(DEFAULT_PICTURE).toEqual({
      aa: 'msaa',
      scale: 'native',
      sharpness: 'standard',
    })
    expect(pictureSamples(DEFAULT_PICTURE)).toBe(4)
    expect(pictureDprFactor(DEFAULT_PICTURE)).toBe(1)
  })

  it('accepts exactly the complete legal combinations', () => {
    for (const aa of PICTURE_AA)
      for (const scale of PICTURE_SCALES)
        for (const sharpness of PICTURE_SHARPNESS) {
          expect(isPicture({ aa, scale, sharpness })).toBe(
            aa !== 'supersample' || scale === 'native',
          )
        }
    for (const invalid of [
      null,
      [],
      'native',
      {},
      { aa: 'msaa' },
      { ...DEFAULT_PICTURE, aa: '2x' },
      { ...DEFAULT_PICTURE, scale: 'half' },
      { ...DEFAULT_PICTURE, sharpness: 0.8 },
    ]) {
      expect(isPicture(invalid)).toBe(false)
    }
  })

  it('keeps the preference intact while WebGL resolves to native edges', () => {
    const wanted = {
      aa: 'temporal',
      scale: 'quality',
      sharpness: 'crisp',
    } as const
    expect(resolvePicture(wanted, 'webgpu')).toBe(wanted)
    expect(resolvePicture(wanted, 'webgl')).toEqual({
      aa: 'msaa',
      scale: 'native',
      sharpness: 'crisp',
    })
    expect(wanted.scale).toBe('quality')
  })

  it('uses AMD ratios, single-sampled temporal input and explicit sharpening', () => {
    expect(
      PICTURE_SCALES.map((scale) =>
        pictureRatio({ ...DEFAULT_PICTURE, scale }),
      ),
    ).toEqual([1, 1.5, 1.7, 2, 3])
    expect(pictureSamples({ ...DEFAULT_PICTURE, aa: 'temporal' })).toBe(0)
    expect(pictureSamples({ ...DEFAULT_PICTURE, aa: 'off' })).toBe(0)
    expect(
      PICTURE_SHARPNESS.map((sharpness) =>
        pictureSharpness({ ...DEFAULT_PICTURE, sharpness }),
      ),
    ).toEqual([0, 0.8, 1])
  })

  it('changes render pixels without changing display pixels', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7680 }),
        fc.integer({ min: 1, max: 4320 }),
        fc.constantFrom(...PICTURE_SCALES),
        (width, height, scale) => {
          const picture = { ...DEFAULT_PICTURE, scale }
          const dimensions = pictureDimensions(picture, width, height)
          expect(dimensions.display).toEqual({ width, height })
          expect(dimensions.render.width).toBeGreaterThanOrEqual(1)
          expect(dimensions.render.width).toBeLessThanOrEqual(width)
          expect(dimensions.render.height).toBeLessThanOrEqual(height)
          expect(pictureDprFactor(picture)).toBe(1)
        },
      ),
    )
    expect(
      pictureDimensions({ ...DEFAULT_PICTURE, scale: 'quality' }, 1600, 900),
    ).toEqual({
      display: { width: 1600, height: 900 },
      render: { width: 1066, height: 600 },
    })
    expect(
      pictureDimensions({ ...DEFAULT_PICTURE, aa: 'supersample' }, 1600, 900)
        .render,
    ).toEqual({ width: 3200, height: 1800 })
  })

  it('parses a complete page override and refuses malformed combinations', () => {
    expect(parsePictureQuery('native')).toEqual(DEFAULT_PICTURE)
    expect(parsePictureQuery('temporal:quality')).toEqual({
      aa: 'temporal',
      scale: 'quality',
      sharpness: 'standard',
    })
    expect(parsePictureQuery('off:performance:crisp')).toEqual({
      aa: 'off',
      scale: 'performance',
      sharpness: 'crisp',
    })
    expect(parsePictureQuery('bilinear:quality')).toEqual({
      aa: 'off',
      scale: 'quality',
      sharpness: 'off',
    })
    for (const invalid of [
      null,
      '',
      'quality',
      'temporal',
      'supersample:quality',
      'msaa:native:crisp:extra',
      'bilinear:unknown',
      'bilinear:quality:unknown',
    ])
      expect(parsePictureQuery(invalid)).toBeNull()
  })
})
