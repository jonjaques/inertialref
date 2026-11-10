import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CLOUD_TRACE_DIVISOR,
  CLOUD_TRACE_LONG_EDGE,
  cloudExtents,
  type Extent,
  textureBytes,
} from './cloudBudget.ts'

/*
 * The trace's extent is the ray budget, and the declared bytes are the
 * "in memory" column the measurement reports, so both are held to the
 * design's own figures (§3.2, §3.19). The bytes are counted by hand here
 * from each resource's format and size, a megabyte being 10⁶ bytes as the
 * table writes it, and every texture has one level.
 */

const extent = (width: number, height: number): Extent => ({ width, height })

describe('the cloud passes’ extents', () => {
  it('trace a quarter of a 1080p frame and keep twice that in history', () => {
    const at = cloudExtents(extent(1920, 1080), extent(1920, 1080))
    expect(at.trace).toEqual(extent(480, 270))
    expect(at.history).toEqual(extent(960, 540))
  })

  it('follow the display, not the drawing buffer, at Retina', () => {
    // 2880 × 1800 drawn, 1440 × 900 shown: the ray budget is the display's.
    const at = cloudExtents(extent(2880, 1800), extent(1440, 900))
    expect(at.trace).toEqual(extent(360, 225))
    expect(at.history).toEqual(extent(720, 450))
  })

  it('follow the scene target under temporal upscaling, which renders under the display', () => {
    // 1080p at FSR's Quality is a 1280 × 720 scene target.
    const at = cloudExtents(extent(1280, 720), extent(1920, 1080))
    expect(at.trace).toEqual(extent(320, 180))
  })

  it('hold to the display under supersampling, which renders twice it', () => {
    const at = cloudExtents(extent(3840, 2160), extent(1920, 1080))
    expect(at.trace).toEqual(extent(480, 270))
  })

  it('turn with a portrait display', () => {
    const at = cloudExtents(extent(1080, 1920), extent(1080, 1920))
    expect(at.trace).toEqual(extent(270, 480))
  })

  it('cap the long edge at 480 × the trace scale, keeping the aspect', () => {
    const wide = cloudExtents(extent(2560, 1440), extent(2560, 1440))
    expect(wide.trace).toEqual(extent(480, 270))
    expect(
      cloudExtents(extent(2560, 1440), extent(2560, 1440), 2).trace,
    ).toEqual(extent(960, 540))
    expect(
      cloudExtents(extent(2560, 1440), extent(2560, 1440), 0.5).trace,
    ).toEqual(extent(240, 135))
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8192 }),
        fc.integer({ min: 1, max: 8192 }),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom(0.5, 1, 2),
        (width, height, density, traceScale) => {
          const css = extent(width, height)
          const render = extent(width * density, height * density)
          const { trace, history } = cloudExtents(render, css, traceScale)
          expect(Math.max(trace.width, trace.height)).toBeLessThanOrEqual(
            CLOUD_TRACE_LONG_EDGE * traceScale,
          )
          expect(trace.width).toBeGreaterThanOrEqual(1)
          expect(trace.height).toBeGreaterThanOrEqual(1)
          // Never finer than a quarter of the display, then scaled.
          expect(trace.width).toBeLessThanOrEqual(
            Math.max(
              1,
              Math.round(Math.ceil(width / CLOUD_TRACE_DIVISOR) * traceScale),
            ),
          )
          expect(history).toEqual(extent(2 * trace.width, 2 * trace.height))
        },
      ),
    )
  })
})

/** §3.19, a row at a time: formats are bytes a texel, sizes as allocated. */
const MB = 1e6

describe('the declared bytes', () => {
  it('count each resource as §3.19 does, at one level', () => {
    const rows: readonly [string, number, number][] = [
      ['base noise, R8 128³', textureBytes(128, 128, 128, 1), 2.1],
      ['detail R8 32³', textureBytes(32, 32, 32, 1), 0.03],
      [
        'profile RGBA8 64 × 8 and phase RGBA16F 1024 × 32',
        textureBytes(64, 8, 1, 4) + textureBytes(1024, 32, 1, 8),
        0.26,
      ],
      [
        'weather cube, 4 × RGBA8 1542 × 1028',
        4 * textureBytes(1542, 1028, 1, 4),
        25.36,
      ],
      ['clipmap, 4 × RGBA8 256² × 6', 4 * textureBytes(256, 256, 6, 4), 6.29],
      ['volume, RG8 256² × 102', textureBytes(256, 256, 102, 2), 13.37],
      ['sun grid, R16F 128² × 32', textureBytes(128, 128, 32, 2), 1.05],
      ['far atlas, RGBA8 1548 × 774', textureBytes(1548, 774, 1, 4), 4.79],
      ['depth copy at 1080p, R16F', textureBytes(1920, 1080, 1, 2), 4.15],
      ['depth copy at Retina, R16F', textureBytes(2880, 1800, 1, 2), 10.37],
    ]
    for (const [name, bytes, megabytes] of rows)
      expect([name, Math.round(bytes / 1e4) / 100]).toEqual([name, megabytes])
    // The byte counts themselves, for the rows a megabyte rounds.
    expect(textureBytes(128, 128, 128, 1)).toBe(2_097_152)
    expect(4 * textureBytes(1542, 1028, 1, 4)).toBe(25_362_816)
    expect(textureBytes(256, 256, 102, 2)).toBe(13_369_344)
  })

  it('size the trace at 72 bytes a texel and the history at 48, from the extents', () => {
    /*
     * The trace writes light (w × h), aux and knot depths (2w × h each) and
     * knot light (2w × 2h), all RGBA16F; the history holds three RGBA16F
     * textures at each of two parities.
     */
    const trace = (size: Extent): number =>
      textureBytes(size.width, size.height, 1, 8) +
      2 * textureBytes(2 * size.width, size.height, 1, 8) +
      textureBytes(2 * size.width, 2 * size.height, 1, 8)
    const history = (size: Extent): number =>
      2 * 3 * textureBytes(size.width, size.height, 1, 8)
    const hd = cloudExtents(extent(1920, 1080), extent(1920, 1080))
    const retina = cloudExtents(extent(2880, 1800), extent(1440, 900))
    expect(trace(hd.trace)).toBe(480 * 270 * 72)
    expect(trace(hd.trace) / MB).toBeCloseTo(9.33, 2)
    expect(trace(retina.trace) / MB).toBeCloseTo(5.83, 2)
    expect(history(hd.history)).toBe(960 * 540 * 48)
    expect(history(hd.history) / MB).toBeCloseTo(24.88, 2)
    expect(history(retina.history) / MB).toBeCloseTo(15.55, 2)
  })

  it('add up to the landed set: 91.6 MB at 1080p and 85.0 MB at Retina', () => {
    // The field, the volume and the sun grid summed through it, and the
    // atlas, with everything every frame holds.
    const fixed =
      textureBytes(128, 128, 128, 1) +
      textureBytes(32, 32, 32, 1) +
      textureBytes(64, 8, 1, 4) +
      textureBytes(1024, 32, 1, 8) +
      4 * textureBytes(1542, 1028, 1, 4) +
      4 * textureBytes(256, 256, 6, 4) +
      textureBytes(256, 256, 102, 2) +
      textureBytes(128, 128, 32, 2) +
      textureBytes(1548, 774, 1, 4)
    const atSize = (render: Extent, css: Extent): number => {
      const { trace, history } = cloudExtents(render, css)
      return (
        fixed +
        textureBytes(render.width, render.height, 1, 2) +
        trace.width * trace.height * 72 +
        history.width * history.height * 48
      )
    }
    expect(atSize(extent(1920, 1080), extent(1920, 1080)) / MB).toBeCloseTo(
      91.6,
      1,
    )
    expect(atSize(extent(2880, 1800), extent(1440, 900)) / MB).toBeCloseTo(
      85.0,
      1,
    )
  })

  it('halve each further level’s width and height, and count a depth of layers or slices alike', () => {
    expect(textureBytes(256, 256, 1, 4, 3)).toBe(
      4 * (256 * 256 + 128 * 128 + 64 * 64),
    )
    expect(textureBytes(1, 1, 1, 8, 4)).toBe(32)
    expect(textureBytes(256, 256, 6, 4)).toBe(6 * textureBytes(256, 256, 1, 4))
  })
})
