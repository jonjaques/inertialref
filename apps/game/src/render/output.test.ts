import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  describeOutput,
  EXTENDED_HEADROOM,
  headroomFor,
  type OutputCapability,
  type OutputPreference,
  resolveOutputMode,
} from './output.ts'

/*
 * The HDR decision, in Node.
 *
 * This is the half of the output path that can be tested without a GPU, and it
 * is deliberately the half that has the branches. What cannot be tested here is
 * named at the bottom of the file rather than left to be discovered.
 */

const capabilities = fc.record({
  webgpu: fc.boolean(),
  dynamicRangeHigh: fc.boolean(),
  extendedCanvas: fc.boolean(),
})

const preferences = fc.constantFrom<OutputPreference>(
  'auto',
  'extended',
  'standard',
)

const everything: OutputCapability = {
  webgpu: true,
  dynamicRangeHigh: true,
  extendedCanvas: true,
}

describe('resolveOutputMode', () => {
  it('never produces extended output without the canvas probe', () => {
    // The one hard fact among the three signals. Firefox 153 fails exactly this
    // and passes nothing else, so a preference that could override it would
    // hand Firefox a configuration that throws on the first frame.
    fc.assert(
      fc.property(preferences, capabilities, (preference, capability) => {
        const mode = resolveOutputMode(preference, {
          ...capability,
          extendedCanvas: false,
        })
        expect(mode).toBe('standard')
      }),
    )
  })

  it('honours "standard" whatever the browser reports', () => {
    fc.assert(
      fc.property(capabilities, (capability) => {
        expect(resolveOutputMode('standard', capability)).toBe('standard')
      }),
    )
  })

  it('lets "extended" overrule the media query but not the probe', () => {
    // Spike 1 measured `(dynamic-range: high)` returning true on a panel with
    // 2× headroom and false on the same panel in another browser. It is the
    // signal a player is entitled to disagree with; the probe is not.
    expect(
      resolveOutputMode('extended', { ...everything, dynamicRangeHigh: false }),
    ).toBe('extended')
    expect(
      resolveOutputMode('extended', { ...everything, extendedCanvas: false }),
    ).toBe('standard')
  })

  it('requires all three signals under "auto"', () => {
    expect(resolveOutputMode('auto', everything)).toBe('extended')
    expect(resolveOutputMode('auto', { ...everything, webgpu: false })).toBe(
      'standard',
    )
    expect(
      resolveOutputMode('auto', { ...everything, dynamicRangeHigh: false }),
    ).toBe('standard')
    expect(
      resolveOutputMode('auto', { ...everything, extendedCanvas: false }),
    ).toBe('standard')
  })

  it('is at most as permissive under "auto" as under "extended"', () => {
    // Auto may never light up a configuration the explicit opt-in would refuse.
    // Stated as an ordering rather than a truth table because the truth table is
    // what the implementation already is, and would pass by construction.
    fc.assert(
      fc.property(capabilities, (capability) => {
        if (resolveOutputMode('auto', capability) === 'extended') {
          expect(resolveOutputMode('extended', capability)).toBe('extended')
        }
      }),
    )
  })
})

describe('headroomFor', () => {
  it('collapses to 1 on the standard path, which is what makes the two agree', () => {
    // At headroom 1 the tone curve in `tonemap.ts` reduces to three's stock
    // ACES filmic exactly — same matrices, same fit, same clamp. That identity
    // is the mechanism behind `art.md`'s "the SDR render is a tonemapped version
    // of the same image, never a differently-authored one".
    expect(headroomFor('standard')).toBe(1)
    expect(headroomFor('extended')).toBe(EXTENDED_HEADROOM)
    expect(EXTENDED_HEADROOM).toBeGreaterThan(1)
  })

  it('stays inside the range the design says the curve must hold across', () => {
    // 2× is the EDR headroom of the laptop panel spike 1 measured; 16× is an
    // XDR display. There is no headroom API, so this number is authored, and
    // the bound names where it came from rather than being a round guess.
    expect(EXTENDED_HEADROOM).toBeGreaterThanOrEqual(2)
    expect(EXTENDED_HEADROOM).toBeLessThanOrEqual(16)
  })
})

describe('describeOutput', () => {
  it('says which backend and which range, because those are separable', () => {
    expect(
      describeOutput({
        backend: 'webgpu',
        mode: 'extended',
        preference: 'auto',
        headroom: 2,
        capability: everything,
      }),
    ).toBe('webgpu · extended 2× · auto')

    // WebGPU present and extended output off is a real, common state — Firefox
    // reaches it — so the line has to be able to say so.
    expect(
      describeOutput({
        backend: 'webgpu',
        mode: 'standard',
        preference: 'auto',
        headroom: 1,
        capability: {
          webgpu: true,
          dynamicRangeHigh: false,
          extendedCanvas: false,
        },
      }),
    ).toBe('webgpu · sRGB · auto')
  })
})

/*
 * Not covered here, and not coverable here.
 *
 * The tone curve itself is a TSL node graph. It cannot be evaluated in Node —
 * there is no CPU backend for the node system — and a scalar mirror of the same
 * arithmetic would pass while the graph it claims to describe drifted, which is
 * the failure mode `AGENTS.md` calls out about the terrain-normals test. So the
 * curve is verified on a GPU or not at all, and `docs/design/technical.md`
 * already names the benchmark harness that does it as a prerequisite for M2.
 */
