import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { wrap } from '../driveScript.mjs'
import { batchRuns } from './measure.mjs'
import {
  BANDS,
  CLIPS,
  EIGHTH,
  NOISE_FRAMES,
  UNCLIPPED,
  noiseTable,
} from './noise.mjs'
import { figures, plan, unfit } from './page.mjs'

/*
 * The `noise` step without a browser: its source run as the text drive.mjs
 * sends, in a context holding nothing but fakes of the page's globals, and
 * the batches it serves.
 */

const SIZES = ['1080p', 'retina']

/**
 * A page whose two texels hold cloud and draw a level set by the levers,
 * plus a noise that alternates by frame: the temporal RMS is the noise over
 * the level. A frame after a reset carries an error that halves each frame.
 */
function fakePage() {
  let drawn = 0
  let sinceReset = 0
  let levers = { clip: 1.25 }
  const level = () => 10 * levers.clip
  const engine = {
    set clouds(next) {
      if (next.force === 'reset') sinceReset = -1
      levers = next
    },
  }
  const ir = {
    clouds: () => ({ settle: { pending: false }, frames: drawn, sinceReset }),
    cloudRadiance: async () => {
      const frame = drawn + 1
      const settling = sinceReset < 64 ? 2 ** -(sinceReset + 1) : 0
      const value = level() * (1 + (frame % 2 ? 0.05 : -0.05) + settling)
      return {
        width: 2,
        height: 1,
        luminance: Float32Array.from([value, value]),
        cloud: Uint8Array.from([1, 1]),
      }
    },
  }
  const context = vm.createContext({
    engine,
    ir,
    requestAnimationFrame: (callback) =>
      setImmediate(() => {
        drawn += 1
        sinceReset += 1
        callback()
      }),
  })
  return { context }
}

async function send(page, run, tag) {
  const planned = plan(run, {})
  const install = planned.find((s) => s.tag === 'install:kind')
  vm.runInContext(wrap(install.args[1]), page.context)
  const step = planned.find((s) => s.tag === tag)
  return await vm.runInContext(wrap(step.args[1]), page.context)
}

describe('the noise batches', () => {
  it('cost and measure the jitter’s two arms on horizon and inside', () => {
    const runs = batchRuns('jitter', SIZES)
    expect(runs).toHaveLength(8)
    const noise = runs.filter((r) => r.type === 'noise')
    for (const r of noise) {
      expect(r.arms.map((a) => [a.name, a.levers.jitter])).toEqual([
        ['ign', 'ign'],
        ['stbn', 'stbn'],
      ])
      // The jitter moves: nothing here is held.
      for (const a of r.arms) expect(a.levers.jitterFrame).toBeNull()
    }
    const cost = runs.filter((r) => r.type === 'ab')
    for (const r of cost)
      expect([r.base.jitter, r.candidate.jitter, r.pairs]).toEqual([
        'ign',
        'stbn',
        5,
      ])
  })

  it('compare each band with the widest where the band is in frame', () => {
    const runs = batchRuns('handover', SIZES)
    expect(new Set(runs.map((r) => r.scenario))).toEqual(
      new Set(['earth-limb', 'descent-150']),
    )
    for (const r of runs) {
      expect(r.arms.map((a) => a.levers.handoverBand)).toEqual([...BANDS])
      expect(r.compares).toEqual([
        ['band 1', 'band 3'],
        ['band 1.5', 'band 3'],
        ['band 2', 'band 3'],
      ])
    }
  })

  it('read each clip’s bias against a clip that holds nothing', () => {
    for (const r of batchRuns('clip', SIZES)) {
      expect(r.arms.map((a) => a.levers.clip)).toEqual([...CLIPS, UNCLIPPED])
      expect(r.compares.map(([, b]) => b)).toEqual([
        'unclipped',
        'unclipped',
        'unclipped',
      ])
    }
  })
})

describe('the noise step', () => {
  const clip = batchRuns('clip', ['1080p'])[0]

  it('reads an arm’s temporal RMS over its cloud texels, and its eighth frame after the reset', async () => {
    const page = fakePage()
    const arm = await send(page, clip, 'arm:clip 1.25')
    // ±5% about the level, alternating frame by frame.
    expect(arm.temporalRms).toBeCloseTo(
      0.05 * Math.sqrt(NOISE_FRAMES / (NOISE_FRAMES - 1)),
      6,
    )
    // The eighth frame carries 2^-8 of its level past the mean, and its own
    // ±5%: what is left of the reset is what the rule compares.
    expect(arm.eighthError).toBeGreaterThan(0.05)
    expect(arm.eighthError).toBeLessThan(0.05 + 2 ** -(EIGHTH - 1))
    expect(arm.texels).toBe(2)
  })

  it('compares two arms’ means: the RMS and the worst texel', async () => {
    const page = fakePage()
    await send(page, clip, 'arm:clip 1.5')
    await send(page, clip, 'arm:unclipped')
    const compared = await send(page, clip, 'compare:clip 1.5:unclipped')
    // The fake's level is the clip's: 15 against 160.
    expect(compared.worst).toBeCloseTo(Math.abs(15 - 160) / 160, 6)
    expect(compared.relative).toBeCloseTo(compared.worst, 6)
    await expect(send(page, clip, 'compare:clip 2:unclipped')).rejects.toThrow(
      /no arm clip 2/,
    )
  })

  it('stands a row only with every arm and comparison read, and prints one line each', () => {
    const steps = plan(clip, {})
    const out = {
      results: steps.map((s) =>
        s.tag === 'settle'
          ? { settled: true }
          : s.tag === 'stance'
            ? { value: { lens: { focalLength: clip.lens } } }
            : s.tag.startsWith('arm:')
              ? { value: { temporalRms: 0.05, eighthError: 0.06, texels: 9 } }
              : s.tag.startsWith('compare:')
                ? { value: { relative: 0.004, worst: 0.009, texels: 9 } }
                : { value: null },
      ),
    }
    const row = { ...figures(clip, steps, out), quiet: { ok: true } }
    expect(unfit(row)).toBeNull()
    const lines = noiseTable([row]).split('\n')
    expect(lines).toHaveLength(2 + clip.arms.length + clip.compares.length)
    expect(lines.at(-1)).toMatch(
      /\| clip 2 \| — \| — \| unclipped \| 0\.40% \| 0\.90% \| 9 \|/,
    )
    const blind = {
      ...row,
      arms: row.arms.map((a, i) => (i === 0 ? { ...a, temporalRms: null } : a)),
    }
    expect(unfit(blind)).toBe('no noise capture for clip 1.25')
  })
})
