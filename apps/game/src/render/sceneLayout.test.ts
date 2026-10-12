import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  PICTURE_AA,
  PICTURE_SCALES,
  PICTURE_SHARPNESS,
  pictureSamples,
  resolvePicture,
  type Picture,
} from './picture.ts'
import {
  attachment,
  attachmentBytes,
  blendReadsAlpha,
  sceneLayout,
  type SceneBackend,
} from './sceneLayout.ts'

/*
 * The scene target's rows, over every picture and both backends.
 *
 * The constraint the first property holds is Dawn's: a blend whose factors
 * read the source's alpha needs the fragment output to carry one, and three
 * emits as many components as the attachment's format has. Mirroring
 * `motion`'s blend onto the two-channel `velocity` row is the fix the upscaler
 * plan names and the one Dawn refuses — "reading alpha but it is missing from
 * fragment output" — so the table refuses it here, in Node, first.
 */

const picture = fc.record({
  aa: fc.constantFrom(...PICTURE_AA),
  scale: fc.constantFrom(...PICTURE_SCALES),
  sharpness: fc.constantFrom(...PICTURE_SHARPNESS),
}) as fc.Arbitrary<Picture>
const backend = fc.record({
  kind: fc.constantFrom('webgpu' as const, 'webgl' as const),
  reversedDepth: fc.boolean(),
}) as fc.Arbitrary<SceneBackend>

describe('the scene layout', () => {
  it('gives four channels to every attachment whose blend reads alpha', () => {
    fc.assert(
      fc.property(picture, backend, (p, b) => {
        for (const row of sceneLayout(p, b).attachments) {
          if (blendReadsAlpha(row.blend)) expect(row.channels).toBe(4)
        }
      }),
    )
  })

  it('takes the material’s blend on output alone', () => {
    // Three applies a material's blend to the attachment named `output` and
    // none to any other, so `material` on another row is a blend nobody draws.
    fc.assert(
      fc.property(picture, backend, (p, b) => {
        for (const row of sceneLayout(p, b).attachments)
          expect(row.blend === 'material').toBe(row.name === 'output')
      }),
    )
  })

  it('is the resolved picture’s: its samples, and temporal rows only for temporal', () => {
    fc.assert(
      fc.property(picture, backend, (p, b) => {
        const layout = sceneLayout(p, b)
        const resolved = resolvePicture(p, b.kind)
        expect(layout.samples).toBe(pictureSamples(resolved))
        const temporal = resolved.aa === 'temporal'
        expect(attachment(layout, 'velocity') !== null).toBe(temporal)
        expect(attachment(layout, 'reactive') !== null).toBe(temporal)
        // The optics' rows are in every layout production builds.
        expect(attachment(layout, 'motion')).not.toBeNull()
        expect(attachment(layout, 'meterMask')).not.toBeNull()
        // Output is the pass's own texture, index zero, and a name is a key.
        expect(layout.attachments[0]?.name).toBe('output')
        const names = layout.attachments.map((row) => row.name)
        expect(new Set(names).size).toBe(names.length)
        expect(layout.depthType !== undefined).toBe(b.reversedDepth)
      }),
    )
  })

  it('is one object for one picture, so it can key a cache', () => {
    fc.assert(
      fc.property(picture, backend, (p, b) => {
        expect(sceneLayout({ ...p }, { ...b })).toBe(sceneLayout(p, b))
      }),
    )
    // A WebGL renderer has no temporal path, so its temporal picture is MSAA's.
    const temporal: Picture = {
      aa: 'temporal',
      scale: 'quality',
      sharpness: 'standard',
    }
    const webgl = { kind: 'webgl', reversedDepth: false } as const
    expect(sceneLayout(temporal, webgl)).toBe(
      sceneLayout({ ...temporal, aa: 'msaa', scale: 'native' }, webgl),
    )
  })

  it('counts the meter mask a byte a sample', () => {
    const mask = attachment(
      sceneLayout(
        { aa: 'msaa', scale: 'native', sharpness: 'standard' },
        {
          kind: 'webgpu',
          reversedDepth: true,
        },
      ),
      'meterMask',
    )
    expect(mask === null ? null : attachmentBytes(mask)).toBe(1)
  })
})
