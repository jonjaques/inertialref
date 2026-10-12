import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Scene } from 'three/webgpu'
import { pass } from 'three/tsl'
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
  pictureUpscales,
  renderSize,
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

describe('the render grid', () => {
  /*
   * The scene pass sizes its own target, by three's arithmetic, and the
   * upscaler sizes its input by `renderSize`. They are one grid only if the
   * two are one expression, so this asks a real pass — three's `PassNode`,
   * which sizes a target in Node without a device — rather than a copy of its
   * formula.
   */
  const scenePass = pass(new Scene(), new PerspectiveCamera())

  it("is the pass's own extent at every ratio", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7680 }),
        fc.integer({ min: 1, max: 4320 }),
        fc.constantFrom(...PICTURE_SCALES),
        (width, height, scale) => {
          const ratio = pictureRatio({ ...DEFAULT_PICTURE, scale })
          scenePass.setResolutionScale(1 / ratio)
          scenePass.setSize(width, height)
          // Equal wherever the pass has an extent. A buffer narrower than the
          // ratio gives the pass a target 0 across, which no texture can be,
          // and the upscaler's input is held at one.
          expect(renderSize(width, ratio)).toBe(
            Math.max(1, scenePass.renderTarget.width),
          )
          expect(renderSize(height, ratio)).toBe(
            Math.max(1, scenePass.renderTarget.height),
          )
        },
      ),
      { numRuns: 400 },
    )
  })

  it('is what the panel reports as the render size', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7680 }),
        fc.integer({ min: 1, max: 4320 }),
        fc.constantFrom(...PICTURE_SCALES),
        fc.constantFrom(...PICTURE_AA),
        (width, height, scale, aa) => {
          const picture = { ...DEFAULT_PICTURE, scale, aa }
          const buffer = pictureDprFactor(picture)
          expect(pictureDimensions(picture, width, height).render).toEqual({
            width: renderSize(width * buffer, pictureRatio(picture)),
            height: renderSize(height * buffer, pictureRatio(picture)),
          })
        },
      ),
    )
  })

  it('upscales exactly the resolved pictures that draw below the display', () => {
    for (const aa of PICTURE_AA) {
      for (const scale of PICTURE_SCALES) {
        const picture = { aa, scale, sharpness: 'standard' } as const
        expect(pictureUpscales(resolvePicture(picture, 'webgpu'))).toBe(
          aa === 'temporal' || scale !== 'native',
        )
        // A WebGL renderer has no upscaler, and resolution says so.
        expect(pictureUpscales(resolvePicture(picture, 'webgl'))).toBe(false)
      }
    }
  })
})
