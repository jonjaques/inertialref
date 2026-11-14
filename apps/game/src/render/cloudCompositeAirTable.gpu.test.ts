import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  type Scene,
  SphereGeometry,
} from 'three/webgpu'
import { ivec2, screenCoordinate, texture, vec3 } from 'three/tsl'
import { Quaternion as Q, type Vec3 } from '@inertialref/spatial'
import type { CloudLevers } from './cloudLevers.ts'
import { cloudRig, RIG_EARTH_RADIUS } from './cloudSystemRig.ts'
import { openGpu } from './gpuHarness.ts'
import { sensorRadiance } from './radiance.ts'

/*
 * The composite's air from its table of directions against the march a
 * pixel, a frame of each on one settled history (rubric row 20): the
 * relative difference of the scene target's luminance over every pixel the
 * composite drew to, as a histogram, its 95th percentile and its worst.
 *
 * **One history, two programs.** The `air` lever is a program of the
 * composite and resets nothing, and with the jitter held a held still
 * repeats every four frames. So a frame of the march, a frame of the table
 * and a second frame of the march are drawn four frames apart on a chain
 * that has settled. Where the history is still, the two frames of the march
 * are equal to the bit, as from orbit. Where it is not (a paced bake, a
 * field that drifts), they say which pixels it moved, `floor`, and the
 * table is read over the pixels it did not: `table`.
 *
 * **The rig draws no scene** but what a stance adds, so the scene target
 * holds the composite's source alone over black, or over a ground of 0.02:
 * a real frame's difference is this one diluted by the scene the cloud
 * passes. With nothing drawn every pixel is the sky's class. A stance's
 * ground makes a surface's: the datum's sphere under the orbit stance, a
 * plane under the fog. A shelf inside the deck cuts every span short, which
 * is the march a pixel in both programs, and a wall 3 km off is the ridge
 * in front of distant cloud.
 *
 * The tuning stances are the ones the form was chosen on: the cost
 * instrument's four stand-ins, and three that put a surface behind them.
 * The held-out stances were drawn once, after the form was frozen. One
 * stance runs small in every suite; all of them at both sizes under
 * IR_CLOUD_MEASURE, which writes `.data/clouds/compositeAirTable.json`.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const OUT =
  process.env.IR_CLOUD_AIR_OUT ?? '.data/clouds/compositeAirTable.json'
const ONLY = (process.env.IR_CLOUD_AIR_ONLY ?? '')
  .split(';')
  .map((word) => word.trim())
  .filter((word) => word.length > 0)

/** Frames of settling, the most more while work is owed, and the frames between two compared. */
const SETTLE = 140
const SETTLE_MORE = 400
const CYCLE = 4
/** A pixel under this share of the frame's brightest is black to any judge: it is not a pixel of the measure. */
const BLACK = 1e-4
/** A pixel is steady where the march's two frames agree to this share of it. */
const STEADY = 1e-4
const BINS = [1e-4, 3e-4, 1e-3, 3e-3, 1e-2, 2e-2, 5e-2, 1e-1] as const

const radians = (degrees: number): number => (degrees * Math.PI) / 180
/** A sun `elevation` degrees up, `azimuth` degrees off the view's heading, render axes at the eye's place. */
const sunAt = (elevation: number, azimuth: number): Vec3 => ({
  x: -Math.sin(radians(azimuth)) * Math.cos(radians(elevation)),
  y: Math.sin(radians(elevation)),
  z: -Math.cos(radians(azimuth)) * Math.cos(radians(elevation)),
})
const SUN = sunAt(37.5, 60)

/** What a stance draws behind its cloud: nothing, or one of these, at a radiance of 0.02. */
type Ground =
  /** The datum's sphere, faceted as the planet's is: a surface under every ray that meets it. */
  | 'sphere'
  /** A plane `altitude` meters over the datum: the ground under a low eye, or a shelf inside a deck. */
  | { readonly altitude: number }
  /** A wall across the view 3 km ahead, its top 1.5° over the horizon. */
  | 'ridge'

interface Stance {
  readonly key: string
  readonly weather: CloudLevers['weather']
  /** Meters over the datum. */
  readonly eye: number
  /** Degrees over the horizon. */
  readonly pitch: number
  readonly sun?: Vec3
  readonly ground?: Ground
}

const ORBIT: Stance = {
  key: 'orbit',
  weather: 'broken-horizon',
  eye: 400_000,
  pitch: -40,
  sun: SUN,
}
const OVERCAST: Stance = {
  key: 'overcast, 12 km down',
  weather: 'overcast',
  eye: 12_000,
  pitch: -90,
}

/**
 * The stances the form was chosen on: the cost instrument's stand-ins, one
 * sun each, and three with a surface, which the stand-ins never draw.
 */
const TUNING: readonly Stance[] = [
  ORBIT,
  { key: 'ground', weather: 'fair-cumulus', eye: 2, pitch: 10, sun: SUN },
  { key: 'horizon', weather: 'broken-horizon', eye: 2, pitch: 2, sun: SUN },
  OVERCAST,
  { ...ORBIT, key: 'orbit over the datum', ground: 'sphere' },
  { ...OVERCAST, key: 'overcast on the datum', ground: { altitude: 0 } },
  {
    ...OVERCAST,
    key: 'overcast on a shelf in the deck',
    ground: { altitude: 600 },
  },
]

/** The datum's limb from 400 km, degrees under the horizontal. */
const LIMB_DIP =
  (Math.acos(RIG_EARTH_RADIUS / (RIG_EARTH_RADIUS + 400_000)) * 180) / Math.PI
const LIMB: Stance = {
  key: 'limb, 45° sun',
  weather: 'broken-horizon',
  eye: 400_000,
  pitch: -20,
  sun: sunAt(45, 0),
}

/**
 * The stances the form was not chosen on, drawn once after it was frozen:
 * the limb at dusk (the sun 1.2° under it, ahead, so the frame crosses the
 * terminator), the same limb under a 45° sun, inside a deck, fog on a
 * ground, and a ridge 3 km off in front of cloud past 40 km.
 */
const HELD_OUT: readonly Stance[] = [
  { ...LIMB, key: 'limb at dusk', sun: sunAt(-(LIMB_DIP + 1.2), 0) },
  LIMB,
  { key: 'inside a deck', weather: 'inside', eye: 1200, pitch: 0, sun: SUN },
  {
    key: 'fog',
    weather: 'fog',
    eye: 2,
    pitch: 0,
    sun: SUN,
    ground: { altitude: 0 },
  },
  {
    key: 'ridge',
    weather: 'broken-horizon',
    eye: 2,
    pitch: 2,
    sun: SUN,
    ground: 'ridge',
  },
]

/** Adds a stance's ground to the rig's scene; what it made, to dispose. */
function lay(scene: Scene, stance: Stance): readonly { dispose(): void }[] {
  const ground = stance.ground
  if (ground === undefined) return []
  const material = sensorRadiance(new MeshBasicNodeMaterial())
  material.colorNode = vec3(0.02)
  material.side = DoubleSide
  let geometry: PlaneGeometry | SphereGeometry
  const mesh = new Mesh(undefined, material)
  if (ground === 'sphere') {
    geometry = new SphereGeometry(RIG_EARTH_RADIUS, 512, 256)
    mesh.position.set(0, -(RIG_EARTH_RADIUS + stance.eye), 0)
  } else if (ground === 'ridge') {
    // From 100 m under the eye to 78 m over it, 3 km ahead: 1.5° up.
    geometry = new PlaneGeometry(40_000, 178)
    mesh.position.set(0, -11, -3000)
  } else {
    const reach = 40 * Math.max(stance.eye - ground.altitude, 50)
    geometry = new PlaneGeometry(2 * reach, 2 * reach)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(0, ground.altitude - stance.eye, 0)
  }
  mesh.geometry = geometry
  mesh.frustumCulled = false
  scene.add(mesh)
  scene.updateMatrixWorld(true)
  return [geometry, material]
}

interface Size {
  readonly key: string
  readonly css: readonly [number, number]
  readonly dpr: number
}

const SIZES: readonly Size[] = [
  { key: '1080p', css: [1920, 1080], dpr: 1 },
  { key: 'retina', css: [1440, 900], dpr: 2 },
]
/** What every run of the suite draws: the orbit stance, where the limb crosses the frame, at a sixth of 1080p. */
const SMALL: Size = { key: 'small', css: [320, 180], dpr: 1 }

interface Difference {
  readonly pixels: number
  readonly p95: number
  readonly worst: number
  /** The worst pixel: its place from the top left, and each frame's luminance there. */
  readonly worstAt: readonly [number, number]
  readonly worstPixel: number
  readonly worstOther: number
  /** Pixels by relative difference: under each of `BINS`, then over the last. */
  readonly histogram: readonly number[]
}

const luma = (data: Float32Array, k: number): number =>
  0.2126 * data[k]! + 0.7152 * data[k + 1]! + 0.0722 * data[k + 2]!

/**
 * `other` against `reference` over the pixels `reference` lit, relative to
 * `reference`; over those of them `again` agrees with, where it is given.
 */
function difference(
  reference: Float32Array,
  other: Float32Array,
  width: number,
  again?: Float32Array,
): Difference {
  let peak = 0
  for (let k = 0; k < reference.length; k += 4)
    peak = Math.max(peak, luma(reference, k))
  const floor = peak * BLACK
  const found: number[] = []
  const histogram = new Array<number>(BINS.length + 1).fill(0)
  let worst = 0
  let worstAt = 0
  for (let k = 0; k < reference.length; k += 4) {
    const base = luma(reference, k)
    if (!(base > floor)) continue
    if (again !== undefined && Math.abs(luma(again, k) - base) > STEADY * base)
      continue
    const off = Math.abs(luma(other, k) - base) / base
    found.push(off)
    const bin = BINS.findIndex((edge) => off < edge)
    histogram[bin === -1 ? BINS.length : bin]! += 1
    if (off > worst) {
      worst = off
      worstAt = k
    }
  }
  found.sort((a, b) => a - b)
  const pixel = worstAt / 4
  return {
    pixels: found.length,
    p95: found[Math.ceil(0.95 * found.length) - 1] ?? 0,
    worst,
    worstAt: [pixel % width, Math.floor(pixel / width)],
    worstPixel: luma(reference, worstAt),
    worstOther: luma(other, worstAt),
    histogram,
  }
}

interface Row {
  readonly key: string
  readonly size: string
  readonly stance: string
  readonly over: CloudLevers['over']
  readonly render: readonly [number, number]
  readonly settledAfter: number
  /** The march a pixel against itself eight frames on: what the history alone moves. */
  readonly floor: Difference
  /** The table against the march a pixel, over the pixels the history held steady. */
  readonly table: Difference
  /** The same over every pixel the composite lit, the history's own movement in it. */
  readonly tableEvery: Difference
}

async function measure(
  stance: Stance,
  size: Size,
  over: CloudLevers['over'],
): Promise<Row> {
  const [cssWidth, cssHeight] = size.css
  const width = cssWidth * size.dpr
  const height = cssHeight * size.dpr
  const own = await openGpu(cssWidth, cssHeight)
  if (size.dpr !== 1) own.renderer.setPixelRatio(size.dpr)
  const chain = cloudRig(own, width, height, {
    eye: stance.eye,
    looking: Q.fromAxisAngle({ x: 1, y: 0, z: 0 }, radians(stance.pitch)),
    air: true,
    ...(stance.sun === undefined ? {} : { sun: stance.sun }),
    levers: {
      weather: stance.weather,
      on: true,
      jitterFrame: 0,
      over,
      air: 'pixel',
    },
  })
  const laid = lay(chain.scene, stance)
  try {
    await chain.system!.warm()
    for (let k = 0; k < SETTLE; k += 1) chain.frame()
    await own.read(chain.target)
    let more = 0
    while (
      chain.system!.report.settle?.pending === true &&
      more < SETTLE_MORE
    ) {
      for (let k = 0; k < 20; k += 1) chain.frame()
      await own.read(chain.target)
      more += 20
    }
    const scene = chain.sensor.sceneTarget
    const drawn = async (air: CloudLevers['air']): Promise<Float32Array> => {
      chain.levers = { ...chain.levers, air }
      for (let k = 0; k < CYCLE; k += 1) chain.frame()
      const pixels = await own.drawGraph(
        texture(scene.texture).load(ivec2(screenCoordinate.xy)),
        { float: true, width: scene.width, height: scene.height },
      )
      return pixels.data as Float32Array
    }
    const pixel = await drawn('pixel')
    const table = await drawn('table')
    const again = await drawn('pixel')
    return {
      key: `${size.key} ${stance.key}`,
      size: size.key,
      stance: stance.key,
      over,
      render: [scene.width, scene.height],
      settledAfter: SETTLE + more,
      floor: difference(pixel, again, scene.width),
      table: difference(pixel, table, scene.width, again),
      tableEvery: difference(pixel, table, scene.width),
    }
  } finally {
    chain.dispose()
    for (const held of laid) held.dispose()
    own.dispose()
  }
}

describe('the composite’s air from its table of directions', () => {
  it('draws the orbit stance within row 20’s bounds of the march a pixel, in every run of the suite', async () => {
    const row = await measure(ORBIT, SMALL, 'chain')
    expect(row.table.pixels).toBeGreaterThan(1000)
    expect(row.table.p95).toBeLessThan(0.01)
  }, 300_000)

  it.skipIf(!MEASURE)(
    'is read against the march a pixel at the tuning and the held-out stances and both sizes, and written',
    async () => {
      const rows: Row[] = []
      for (const size of SIZES)
        for (const stance of [...TUNING, ...HELD_OUT]) {
          const key = `${size.key} ${stance.key}`
          if (ONLY.length > 0 && !ONLY.some((word) => key.includes(word)))
            continue
          rows.push(await measure(stance, size, 'chain'))
        }
      mkdirSync('.data/clouds', { recursive: true })
      writeFileSync(
        OUT,
        `${JSON.stringify(
          {
            note: 'cloudCompositeAirTable.gpu.test.ts: the scene target’s luminance with the composite’s air from its table of directions against the march a pixel, relative, over the pixels the composite lit and the history held steady; `floor` is the march against itself eight frames on, `tableEvery` the table over every lit pixel',
            bins: BINS,
            at: new Date().toISOString(),
            rows,
          },
          null,
          2,
        )}\n`,
      )
      for (const row of rows) {
        expect(Number.isFinite(row.table.p95), row.key).toBe(true)
        expect(row.table.pixels, row.key).toBeGreaterThan(0)
      }
    },
    1_800_000,
  )
})
