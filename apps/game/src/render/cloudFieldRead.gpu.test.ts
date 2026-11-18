import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { StorageBufferAttribute, Vector3 } from 'three/webgpu'
import {
  float,
  Fn,
  globalId,
  If,
  int,
  length,
  Loop,
  mod,
  storage,
  uint,
  uniform,
  vec2,
} from 'three/tsl'
import { Quaternion as Q } from '@inertialref/spatial'
import { fieldMedium } from './cloudDensity.ts'
import { altitudeAt, sunMuAt } from './cloudGeometry.ts'
import type { CloudSample } from './cloudNodes.ts'
import { cloudRig } from './cloudSystemRig.ts'
import { adapterOffers, openGpu } from './gpuHarness.ts'
import { installPassTimeline, passTimelineOf } from './passTimeline.ts'

/*
 * What one read of the fine medium costs, apart from the march around it:
 * a kernel makes N reads a pixel on 480 × 270 pixels in the trace's 8 × 8
 * workgroups, and a read's cost is the slope between 8 and 40. Each read is
 * the product's `fieldMedium`, through the system's own baked clipmap,
 * noise and profile, under the overcast (a 3,000 m cell) with the eye 100 m
 * up.
 *
 * Two things set a read's cost that a frame cannot separate. The spacing
 * between neighboring pixels' reads sets whether a batch's noise fetches
 * share texels: a sixty-fourth of a cell shares them, a quarter does not.
 * And the clipmap level the read lands in sets how far its level pick runs.
 * So the kernel is timed at both spacings in levels 0 and 3. A pixel's
 * place repeats every 32 pixels on each axis, so even at a quarter cell the
 * reads stay inside the one level: 24 km a side, centered on the eye's
 * foot for level 0 and 180 km out for level 3. Along a pixel the reads are
 * 100 m apart, the footprint is a twentieth of a cell, and the dither is
 * 0.5.
 *
 * A test's figure, of this stance on this adapter, in GPU microseconds for
 * one read on each of the 129,600 pixels. Written to
 * `.data/clouds/fieldRead.json` and held to nothing but being a number.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const TIMESTAMPS = await adapterOffers('timestamp-query')
const OUT = '.data/clouds/fieldRead.json'

const W = 480
const H = 270
const GROUP = 8
/** Pixels a place repeats over, on each axis. */
const TILE = 32
const FEW = 8
const MANY = 40

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

describe.skipIf(!MEASURE || !TIMESTAMPS)('one read of the field’s cost', () => {
  it('is timed at a sixty-fourth and a quarter of a cell between pixels, in clipmap levels 0 and 3, and written', async () => {
    const own = await openGpu(W, H)
    const chain = cloudRig(own, W, H, {
      eye: 100,
      looking: Q.fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2),
      air: true,
      levers: { weather: 'overcast', on: true },
    })
    await chain.system!.warm()
    const stop = installPassTimeline(own.renderer)
    try {
      for (let k = 0; k < 140; k += 1) chain.frame()
      await own.read(chain.target)
      const timeline = passTimelineOf(own.renderer)!
      const field = chain.system!.field
      const { uniforms } = field
      const body = uniforms.served
      const up = body.up.value.clone().normalize()
      const seed =
        Math.abs(up.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0)
      const east = new Vector3().crossVectors(up, seed).normalize()
      const north = new Vector3().crossVectors(east, up).normalize()
      const { base, top, cell: cells } = body.layers
      const cell = cells.value.x
      const knobs = {
        reads: uniform(FEW),
        out: uniform(0),
        spacing: uniform(0),
        lift: uniform((base.value.x + top.value.x) / 2 - body.eye.value),
        east: uniform(east),
        north: uniform(north),
      }
      const count = W * H
      const output = new StorageBufferAttribute(new Float32Array(count), 1)
      const into = storage(output, 'float', count)
      const medium = fieldMedium({
        uniforms,
        clipmap: field.clipmap.nodes,
        noise: field.noise.nodes,
        profile: field.profile,
      })
      const kernel = Fn(() => {
        const texel = globalId.xy
        If(texel.x.lessThan(uint(W)).and(texel.y.lessThan(uint(H))), () => {
          const place = mod(vec2(texel), TILE).sub(TILE / 2)
          const sum = float(0).toVar()
          Loop(
            {
              start: int(0),
              end: int(knobs.reads),
              type: 'int',
              condition: '<',
            },
            ({ i }) => {
              const x = knobs.out
                .add(place.x.mul(knobs.spacing))
                .add(float(i).mul(100))
              const y = place.y.mul(knobs.spacing)
              // The datum's fall at that distance, so the reads stay at mid-level.
              const fall = x.mul(x).add(y.mul(y)).div(body.datumRadius.mul(2))
              const offset = knobs.east
                .mul(x)
                .add(knobs.north.mul(y))
                .add(body.up.mul(knobs.lift.sub(fall)))
                .toVar()
              const sample: CloudSample = {
                offset,
                distance: length(offset),
                altitude: altitudeAt(body, offset),
                sunMu: sunMuAt(body, offset),
                footprint: float(cell / 20),
                dither: float(0.5),
              }
              const read = medium(sample, body)
              // Every member the march reads, so none is compiled away.
              sum.addAssign(
                read.sigma
                  .add(read.fraction)
                  .add(read.radius.mul(1e-3))
                  .add(read.depth.x.mul(1e-3))
                  .add(read.column.mul(1e-9)),
              )
            },
          )
          into.element(texel.y.mul(uint(W)).add(texel.x)).assign(sum)
        })
      })()
        .computeKernel([GROUP, GROUP, 1])
        .setName('cloud field read')
      const dispatch = (): void => {
        own.renderer.compute(kernel, [
          Math.ceil(W / GROUP),
          Math.ceil(H / GROUP),
          1,
        ])
      }
      const time = async (reads: number): Promise<number> => {
        knobs.reads.value = reads
        for (let k = 0; k < 4; k += 1) dispatch()
        const runs: number[] = []
        for (let run = 0; run < 5; run += 1) {
          const read = await timeline.measure(dispatch, 8)
          runs.push(
            read.passes
              .filter((pass) => pass.label.includes('cloud field read'))
              .reduce((sum, pass) => sum + pass.ms, 0),
          )
        }
        return median(runs)
      }
      // The first figure a process times reads low: a warm-up, not a read.
      dispatch()
      await time(MANY)
      const rows: unknown[] = []
      for (const [level, out] of [
        [0, 0],
        [3, 180e3],
      ] as const)
        for (const share of [1 / 64, 1 / 4]) {
          knobs.out.value = out
          knobs.spacing.value = share * cell
          const takes: number[] = []
          for (let take = 0; take < 3; take += 1) {
            const few = await time(FEW)
            const many = await time(MANY)
            takes.push(((many - few) / (MANY - FEW)) * 1000)
          }
          expect(takes.every(Number.isFinite)).toBe(true)
          rows.push({
            level,
            out,
            spacingCells: share,
            spacingMeters: share * cell,
            usPerRead: median(takes),
            takes,
          })
        }
      mkdirSync('.data/clouds', { recursive: true })
      writeFileSync(
        OUT,
        `${JSON.stringify(
          {
            note: 'cloudFieldRead.gpu.test.ts: GPU µs for one read of fieldMedium on each of 480 × 270 pixels, the slope between 8 and 40 reads a pixel; a test’s figure at one stance, not a campaign’s',
            stance: `overcast, cell ${cell} m, eye 100 m; reads at mid-level, 100 m apart along a pixel, a footprint of cell/20, dither 0.5; places repeat every ${TILE} pixels; 8 × 8 workgroups; each take the median of 5 runs of 8 dispatches`,
            rows,
          },
          null,
          2,
        )}\n`,
      )
    } finally {
      stop()
      chain.dispose()
      own.dispose()
    }
  }, 300_000)
})
