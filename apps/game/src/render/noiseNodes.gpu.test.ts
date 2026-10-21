import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Object3D, Vector3 } from 'three/webgpu'
import { int, uint, uniformArray, uv, vec4 } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import {
  asField,
  asVector,
  latticeNoise,
  STRIPES_PER_CELL,
  stripes,
} from './noiseNodes.ts'
import {
  gradientNoise,
  latticeHash,
  NOISE_CELLS,
  type NoiseSample,
} from './noiseTexture.ts'
import { MACRO_METERS, macroOctave } from './terrain.ts'
import { wearGround } from './groundWear.ts'

/*
 * The two bands that may not repeat, on the GPU, against the CPU.
 *
 * `latticeNoise` is the texture's own construction on a lattice with no
 * period, and `gradientNoise` in `noiseTexture.ts` is the function the
 * texture is baked from — so the graph is held to the code that already
 * draws every other octave, bit for bit in the hash and to float32 in the
 * arithmetic. `macroOctave` is the macro band as the ground reads it, from
 * the anchor split the dresser makes; `stripes` is the gullies' phasor field.
 */

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(64, 1)
})
afterAll(() => gpu.dispose())

/** A seeded stream, so a failure names the same points twice. */
function stream(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** One value per pixel of a `count`×1 draw, from a list. */
const perPixel = (points: readonly Vector3[]) =>
  uniformArray<'vec3'>(points.slice(), 'vec3').element(
    int(uv().x.mul(points.length)),
  )

/*
 * float32 against float64 on a quintic of a unit fraction: the value and
 * the gradient are sums of eight products under three, and a few float32
 * ulps of each is the honest floor.
 */
const ARITHMETIC = 2e-5

describe('latticeNoise', () => {
  it('is gradientNoise without a period, value and gradient', async () => {
    const next = stream(7)
    const cells: Vector3[] = []
    const fractions: Vector3[] = []
    for (let i = 0; i < 64; i += 1) {
      // Cells out to Earth's radius in macro cells and beyond, negative
      // included: the hash's two's complement is the claim.
      const cell = () => Math.floor((next() - 0.5) * 2 * 5000)
      cells.push(new Vector3(cell(), cell(), cell()))
      fractions.push(
        new Vector3(
          Math.fround(next()),
          Math.fround(next()),
          Math.fround(next()),
        ),
      )
    }
    const pixels = await gpu.drawGraph(
      latticeNoise(asVector(perPixel(cells)), asVector(perPixel(fractions))),
      { float: true, width: 64, height: 1 },
    )
    const sample: NoiseSample = { value: 0, dx: 0, dy: 0, dz: 0 }
    for (let i = 0; i < 64; i += 1) {
      const c = cells[i]!
      const f = fractions[i]!
      gradientNoise(c.x + f.x, c.y + f.y, c.z + f.z, sample)
      const [value, dx, dy, dz] = pixels.at(i, 0)
      expect(Math.abs(value - sample.value)).toBeLessThan(ARITHMETIC)
      expect(Math.abs(dx - sample.dx)).toBeLessThan(ARITHMETIC * 4)
      expect(Math.abs(dy - sample.dy)).toBeLessThan(ARITHMETIC * 4)
      expect(Math.abs(dz - sample.dz)).toBeLessThan(ARITHMETIC * 4)
    }
  })

  it('does not close on the texture period', () => {
    const next = stream(11)
    const sample: NoiseSample = { value: 0, dx: 0, dy: 0, dz: 0 }
    let apart = 0
    for (let i = 0; i < 64; i += 1) {
      const x = next() * 1000
      const y = next() * 1000
      const z = next() * 1000
      gradientNoise(x, y, z, sample)
      const here = sample.value
      gradientNoise(x + NOISE_CELLS, y, z, sample)
      apart += Math.abs(sample.value - here)
    }
    // Two independent draws of a field whose RMS is about a quarter.
    expect(apart / 64).toBeGreaterThan(0.1)
  })
})

/** A wearer's macro split, from the production dresser. */
function splitOf(anchor: Vector3): { cell: Vector3; offset: Vector3 } {
  const wear = wearGround(new Object3D(), anchor, 6_371_000)
  return { cell: wear.macroCell.clone(), offset: wear.macroOffset.clone() }
}

describe('the macro band', () => {
  /*
   * Points on Earth's radius, each written as an anchor a patch might hold
   * plus a patch-local offset, and evaluated through `macroOctave` exactly as
   * the ground does: the uniforms are float32, the anchor's split is float64.
   */
  async function macroAt(
    anchors: readonly Vector3[],
    locals: readonly Vector3[],
    octave: number,
  ): Promise<[number, number, number, number][]> {
    const cells: Vector3[] = []
    const offsets: Vector3[] = []
    for (const anchor of anchors) {
      const { cell, offset } = splitOf(anchor)
      cells.push(cell)
      offsets.push(offset)
    }
    const field = asField(
      macroOctave(
        asVector(perPixel(cells)),
        asVector(perPixel(offsets)),
        asVector(perPixel(locals)),
        octave,
      ),
    )
    const pixels = await gpu.drawGraph(vec4(field), {
      float: true,
      width: anchors.length,
      height: 1,
    })
    return anchors.map((_, i) => pixels.at(i, 0))
  }

  /** A point on Earth's surface along `direction`, and an anchor near it. */
  function points(seed: number, count: number) {
    const next = stream(seed)
    const anchors: Vector3[] = []
    const locals: Vector3[] = []
    for (let i = 0; i < count; i += 1) {
      const direction = new Vector3(
        next() - 0.5,
        next() - 0.5,
        next() - 0.5,
      ).normalize()
      anchors.push(direction.multiplyScalar(6_371_000))
      locals.push(
        new Vector3(
          Math.fround((next() - 0.5) * 3000),
          Math.fround((next() - 0.5) * 3000),
          Math.fround((next() - 0.5) * 3000),
        ),
      )
    }
    return { anchors, locals }
  }

  it('has the wavelength it names: zero on every lattice point', async () => {
    // A lattice point of both octaves, reached from an anchor a patch-sized
    // offset away. The texture's band, at 637 m a cell, read 0.3 here.
    const next = stream(3)
    const anchors: Vector3[] = []
    const locals: Vector3[] = []
    for (let i = 0; i < 32; i += 1) {
      const lattice = new Vector3(
        1592 - Math.floor(next() * 3184),
        1592 - Math.floor(next() * 3184),
        1592 - Math.floor(next() * 3184),
      ).multiplyScalar(MACRO_METERS)
      const local = new Vector3(
        Math.fround((next() - 0.5) * 2000),
        Math.fround((next() - 0.5) * 2000),
        Math.fround((next() - 0.5) * 2000),
      )
      locals.push(local)
      anchors.push(lattice.clone().sub(local))
    }
    for (const octave of [0, 1]) {
      for (const [value] of await macroAt(anchors, locals, octave)) {
        // The offset and the local are float32 near 4 km: a quarter of a
        // millimeter each, a ten-thousandth of a cell's slope.
        expect(Math.abs(value)).toBeLessThan(1e-4)
      }
    }
  })

  it('is the aperiodic noise at the body-fixed point, whatever anchor reaches it', async () => {
    const { anchors, locals } = points(5, 48)
    // The same points reached from anchors 2.5 km away: another patch.
    const shift = new Vector3(1250.5, -2000.25, 875.75)
    const others = anchors.map((a) => a.clone().add(shift))
    const otherLocals = locals.map((l) => l.clone().sub(shift))
    const here = await macroAt(anchors, locals, 0)
    const there = await macroAt(others, otherLocals, 0)
    const sample: NoiseSample = { value: 0, dx: 0, dy: 0, dz: 0 }
    anchors.forEach((anchor, i) => {
      const p = anchor.clone().add(locals[i]!).divideScalar(MACRO_METERS)
      gradientNoise(p.x, p.y, p.z, sample)
      const [value, dx] = here[i]!
      expect(Math.abs(value - sample.value)).toBeLessThan(1e-4)
      expect(Math.abs(dx - sample.dx / MACRO_METERS)).toBeLessThan(
        1e-4 / MACRO_METERS,
      )
      // Two patches meeting at this point draw one value: the seam the
      // split exists to close.
      expect(Math.abs(value - there[i]![0])).toBeLessThan(1e-4)
    })
  })

  /*
   * The texture's period at the band's named cell, and at the 637 m cell a
   * `2π` left in the frequency made of it: the band fetched from the texture
   * repeated at the second and would at the first.
   */
  it.each([
    ['the named cell', NOISE_CELLS * MACRO_METERS],
    ['the cell the texture drew', (NOISE_CELLS * MACRO_METERS) / (2 * Math.PI)],
  ])('does not repeat at the texture period on %s', async (_, period) => {
    const { anchors, locals } = points(9, 48)
    const along = new Vector3(period, 0, 0)
    const away = anchors.map((a) => a.clone().add(along))
    const here = await macroAt(anchors, locals, 0)
    const there = await macroAt(away, locals, 0)
    const apart =
      here.reduce(
        (sum, [value], i) => sum + Math.abs(value - there[i]![0]),
        0,
      ) / here.length
    expect(apart).toBeGreaterThan(0.1)
  })
})

/**
 * The gullies' phasor, written out from its construction: eight corner
 * waves along `across`, each with its hash's phase, blended by the quintic
 * weights as phasors and renormalized by `2L` clamped at one.
 */
function stripesReference(
  cell: Vector3,
  fraction: Vector3,
  across: Vector3,
  seed: number,
): [number, number] {
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  const u = [fade(fraction.x), fade(fraction.y), fade(fraction.z)]
  let x = 0
  let y = 0
  for (let corner = 0; corner < 8; corner += 1) {
    const o = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1]
    const weight =
      (o[0] ? u[0]! : 1 - u[0]!) *
      (o[1] ? u[1]! : 1 - u[1]!) *
      (o[2] ? u[2]! : 1 - u[2]!)
    const h = latticeHash(cell.x + o[0]!, cell.y + o[1]!, cell.z + o[2]!, seed)
    const turns =
      STRIPES_PER_CELL *
        ((fraction.x - o[0]!) * across.x +
          (fraction.y - o[1]!) * across.y +
          (fraction.z - o[2]!) * across.z) +
      h / 4294967296
    x += weight * Math.cos(2 * Math.PI * turns)
    y += weight * Math.sin(2 * Math.PI * turns)
  }
  const reach = Math.hypot(x, y)
  const scale = Math.min(2 * reach, 1) / Math.max(reach, 1e-4)
  return [x * scale, y * scale]
}

describe('the gully stripes', () => {
  const SEED = 0x6a09e667

  function field(seed: number, count: number) {
    const next = stream(seed)
    const cells: Vector3[] = []
    const fractions: Vector3[] = []
    const acrosses: Vector3[] = []
    for (let i = 0; i < count; i += 1) {
      const cell = () => Math.floor((next() - 0.5) * 400_000)
      cells.push(new Vector3(cell(), cell(), cell()))
      fractions.push(
        new Vector3(
          Math.fround(next()),
          Math.fround(next()),
          Math.fround(next()),
        ),
      )
      acrosses.push(
        new Vector3(next() - 0.5, next() - 0.5, next() - 0.5).normalize(),
      )
    }
    return { cells, fractions, acrosses }
  }

  async function draw(
    cells: readonly Vector3[],
    fractions: readonly Vector3[],
    acrosses: readonly Vector3[],
  ) {
    const phasor = stripes(
      asVector(perPixel(cells)),
      asVector(perPixel(fractions)),
      asVector(perPixel(acrosses)),
      uint(SEED),
    )
    const pixels = await gpu.drawGraph(vec4(phasor, 0, 1), {
      float: true,
      width: cells.length,
      height: 1,
    })
    return cells.map((_, i) => pixels.at(i, 0))
  }

  it('is the construction it names, and never longer than one', async () => {
    const { cells, fractions, acrosses } = field(13, 64)
    const drawn = await draw(cells, fractions, acrosses)
    drawn.forEach(([x, y], i) => {
      const [rx, ry] = stripesReference(
        cells[i]!,
        fractions[i]!,
        acrosses[i]!,
        SEED,
      )
      // Angles of up to forty radians in float32, and the hash's low bits.
      expect(Math.abs(x - rx)).toBeLessThan(1e-4)
      expect(Math.abs(y - ry)).toBeLessThan(1e-4)
      expect(Math.hypot(x, y)).toBeLessThan(1 + 1e-5)
    })
  })

  it('advances across the slope and holds still down it', async () => {
    // A twentieth of a cell either way: a tenth of a stripe across the
    // slope, which turns the phase by 0.63 rad where the corners agree.
    const { cells, fractions, acrosses } = field(17, 64)
    const step = 0.05
    const down = acrosses.map((a) =>
      new Vector3(-a.y, a.x, 0).normalize().multiplyScalar(step),
    )
    const nudge = (offsets: readonly Vector3[]) =>
      fractions.map(
        (f, i) =>
          new Vector3(
            Math.fround(Math.min(Math.max(f.x + offsets[i]!.x, 0), 0.999)),
            Math.fround(Math.min(Math.max(f.y + offsets[i]!.y, 0), 0.999)),
            Math.fround(Math.min(Math.max(f.z + offsets[i]!.z, 0), 0.999)),
          ),
      )
    const base = await draw(cells, fractions, acrosses)
    const sideways = await draw(
      cells,
      nudge(acrosses.map((a) => a.clone().multiplyScalar(step))),
      acrosses,
    )
    const downhill = await draw(cells, nudge(down), acrosses)
    const turn = (a: number[], b: number[]) =>
      Math.abs(
        Math.atan2(
          a[0]! * b[1]! - a[1]! * b[0]!,
          a[0]! * b[0]! + a[1]! * b[1]!,
        ),
      )
    const mean = (other: number[][]) =>
      base.reduce((sum, b, i) => sum + turn(b, other[i]!), 0) / base.length
    const acrossTurn = mean(sideways)
    const downTurn = mean(downhill)
    expect(acrossTurn).toBeGreaterThan(0.4)
    expect(downTurn).toBeLessThan(acrossTurn * 0.5)
  })
})
