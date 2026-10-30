import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
} from 'three/webgpu'
import { Fn, uniform, uv, vec4 } from 'three/tsl'
import {
  DEPOSIT_SLOPE_KNOTS,
  type DepositSlopeTable,
  depositSlopeAt,
  depositSlopeKnot,
} from '@inertialref/universe'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { createSlopeTable, type SlopeTable } from './slopeTable.ts'

/*
 * The slope a deposit reads, drawn on the GPU and held to `depositSlopeAt`.
 *
 * The table is a synthetic one with a different shape in every row, so a row
 * read as its neighbor, a knot read one off, or a morph mixed the wrong way
 * round all move the answer. The graph writes the slope it was handed beside
 * what it read, so the CPU is asked about the float32 the GPU actually used
 * rather than about a pixel center it rounded on its own.
 */

const WIDTH = 256
let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu(WIDTH, 1)
})
afterAll(() => gpu.dispose())

/** Rows 0..levels−1, each a monotone curve of its own; the last the identity. */
function synthetic(levels: number, lift: number): DepositSlopeTable {
  const table = new Float32Array(levels * DEPOSIT_SLOPE_KNOTS)
  for (let row = 0; row < levels; row += 1) {
    const coarse = (levels - 1 - row) / Math.max(levels - 1, 1)
    for (let k = 0; k < DEPOSIT_SLOPE_KNOTS; k += 1) {
      const knot = Math.log10(depositSlopeKnot(k))
      table[row * DEPOSIT_SLOPE_KNOTS + k] =
        knot + coarse * (lift + 0.15 * Math.sin(k * 0.7 + row))
    }
  }
  return { levels, table }
}

/**
 * One quad, one material, one program for the life of the rig: the level and
 * the morph are uniforms, so a draw at another of either rebuilds nothing,
 * and neither does a table written in place.
 */
function rig(slopes: SlopeTable) {
  const level = uniform(0)
  const morph = uniform(0)
  const material = new MeshBasicNodeMaterial()
  // `uv().x²` across 0 → 0.6: flat to 66°, and most of the samples near flat,
  // where every threshold the material draws against sits.
  material.fragmentNode = Fn(() => {
    const slope = uv().x.mul(uv().x).mul(0.6)
    return vec4(slopes.read(slope, level, morph), slope, 0, 1)
  })()
  const quad = new Mesh(new PlaneGeometry(2, 2), material)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  camera.position.z = 0.5
  camera.updateMatrixWorld()
  const scene = new Scene()
  scene.add(quad)
  return {
    async draw(
      at: number,
      k: number,
    ): Promise<{ given: number; read: number }[]> {
      level.value = at
      morph.value = k
      const pixels = await gpu.draw(scene, camera, {
        width: WIDTH,
        height: 1,
        float: true,
      })
      return Array.from({ length: WIDTH }, (_, x) => {
        const [read, given] = pixels.at(x, 0)
        return { given, read }
      })
    },
    dispose(): void {
      quad.geometry.dispose()
      material.dispose()
    },
  }
}

/** The worst error against the CPU, relative to the answer. */
function worst(
  table: DepositSlopeTable | null,
  level: number,
  morph: number,
  samples: readonly { given: number; read: number }[],
): number {
  let error = 0
  for (const { given, read } of samples) {
    const expected = depositSlopeAt(table, level, morph, given)
    error = Math.max(
      error,
      Math.abs(read - expected) / Math.max(expected, 1e-6),
    )
  }
  return error
}

/*
 * The bound is float32's through a log, a knot lookup and an exp, relative
 * to the answer. Measured worst on an Apple M5, Metal 3, over every case
 * below: 1.6e-6. The bound is four times that; a row read as its neighbor or
 * a morph mixed the wrong way round is off by a tenth or more.
 */
const BOUND = 6.5e-6

it('reads its own row, its parent’s by the morph, and the identity past the table', async () => {
  const slopes = createSlopeTable()
  const table = synthetic(6, 0.6)
  slopes.set(table)
  const drawn = rig(slopes)
  try {
    for (const [level, morph] of [
      [5, 0],
      [3, 0],
      [3, 0.4],
      [3, 1],
      [1, 0.75],
      [0, 0.5],
      [9, 0],
    ] as const) {
      const samples = await drawn.draw(level, morph)
      expect(
        worst(table, level, morph, samples),
        `${level} ${morph}`,
      ).toBeLessThan(BOUND)
    }
  } finally {
    drawn.dispose()
  }
})

it('reads a negative level as drawn', async () => {
  const slopes = createSlopeTable()
  slopes.set(synthetic(6, 0.6))
  const drawn = rig(slopes)
  try {
    for (const { given, read } of await drawn.draw(-1, 0.5)) {
      expect(read).toBe(given)
    }
  } finally {
    drawn.dispose()
  }
})

it('reads a table written in place, with no program rebuilt', async () => {
  /*
   * The texture is one object written in place, because a texture node's
   * binding is frozen at compile: the program built against the first table
   * reads the second, and with none written every row is the identity.
   */
  const slopes = createSlopeTable()
  const first = synthetic(6, 0.6)
  const second = synthetic(4, -0.8)
  slopes.set(first)
  const drawn = rig(slopes)
  try {
    expect(worst(first, 2, 0.3, await drawn.draw(2, 0.3))).toBeLessThan(BOUND)
    const built = gpu.pipelinesBuilt()
    slopes.set(second)
    expect(worst(second, 2, 0.3, await drawn.draw(2, 0.3))).toBeLessThan(BOUND)
    slopes.set(null)
    expect(worst(null, 2, 0.3, await drawn.draw(2, 0.3))).toBeLessThan(BOUND)
    expect(gpu.pipelinesBuilt()).toBe(built)
  } finally {
    drawn.dispose()
  }
})
