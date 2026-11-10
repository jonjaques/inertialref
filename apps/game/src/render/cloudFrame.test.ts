import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  CLIMATE_REGIME,
  cloudsServed,
  fieldClock,
  lensForFov,
  MAX_CLOUD_LAYERS,
  placeAt,
  regimeWeather,
  type RenderBody,
  type RenderPlacement,
  type RenderScene,
  type RenderStar,
  SCENARIO_IDS,
  shellBoundaries,
  shellUnion,
  turnBack,
  WEATHER_SCENARIOS,
  wetWorld,
} from '@inertialref/rendering'
import {
  createRenderOrigin,
  type Quat,
  Quaternion as Q,
  UV,
  type Vec3,
  Vec,
} from '@inertialref/spatial'
import {
  type Body,
  formatAddress,
  galaxySeedOf,
  generateSystem,
  MILKY_WAY,
  resolveSystem,
  SOL_ONLY_CATALOG,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import {
  CLOUD_CLIPMAP_SIZE,
  CLOUD_CLIPMAP_TEXELS,
  type CloudFrame,
  type CloudFrameInputs,
  cloudFrame,
  cloudNoisePeriods,
  type CloudResetReason,
  drawnWeather,
  scenarioClimate,
  servedBody,
  weatherScenario,
} from './cloudFrame.ts'
import {
  type CloudLevers,
  deckYields,
  DEFAULT_CLOUD_LEVERS,
} from './cloudLevers.ts'
import { CLOUD_BASE_CELLS } from './cloudNoise.ts'
import { CLOUD_CLIPMAP_LEVELS, createCloudUniforms } from './cloudUniforms.ts'
import { CLOUD_VOLUME_SIZE, CLOUD_VOLUME_TEXELS } from './cloudVolume.ts'
import { WARP_STEPS } from '../hud/warp.ts'

/*
 * The frame's rules, §3.3, each on a scene built here: a body placed about a
 * render-space eye with a turned orientation, a key star far off, and the
 * records the wet predicate reads taken from the universe as
 * `World.loadSystem` makes them. Everything a GPU module reads of a frame
 * comes through these rules, so they are held one at a time.
 */

const ROOT = rootSeed('inertialref')
const GALAXY = galaxySeedOf(ROOT, MILKY_WAY)

function records(id: string): Map<string, Body> {
  const stub = resolveSystem(GALAXY, SOL_ONLY_CATALOG, systemId(id))!
  const system = generateSystem(ROOT, MILKY_WAY, stub)
  return new Map(
    [...walkBodies(system)].map((body) => [formatAddress(body.address), body]),
  )
}

const SOL = records('SOL')
const EARTH = 'g:milky-way/s:SOL/b:2'
const MARS = 'g:milky-way/s:SOL/b:3'
const earth = SOL.get(EARTH)!
const mars = SOL.get(MARS)!
/**
 * Earth as it stands once its deck's record goes: wet, with no authored
 * deck, which is a body the volume serves unasked. The frame's rules are
 * held on this record; the served set is held on the records as they are.
 */
const deckless: Body = {
  ...earth,
  appearance: { ...earth.appearance, clouds: null },
}
const SERVED = new Map(SOL).set(EARTH, deckless)

/** A turned body, so body-fixed and render axes differ in every component. */
const TURNED: Quat = Q.fromAxisAngle({ x: 0.3, y: -0.5, z: 0.8 }, 0.7)
/** The eye's direction from the body's center, in render axes. */
const UP_RENDER = Vec.normalize({ x: 0.3, y: 0.8, z: -0.52 })

function place(
  record: Body,
  options: {
    readonly center: Vec3
    readonly orientation?: Quat
    readonly angularRadius?: number
    readonly compression?: number
    readonly airTop?: number
  },
): RenderBody {
  const compression = options.compression ?? 1
  return {
    sunlight: 0.85,
    address: formatAddress(record.address),
    name: record.name,
    kind: record.kind,
    placement: {
      position: options.center,
      scale: record.radius * compression,
      compression,
      distance: Vec.length(options.center) / compression,
      tier: 'surface',
      compressed: compression !== 1,
      angularRadius: options.angularRadius ?? 1.2,
    },
    orientation: options.orientation ?? TURNED,
    hasAtmosphere: record.appearance.haze !== null,
    terminator: 0.1,
    atmosphereScale: 1.02,
    airTop: options.airTop ?? 1.015,
    airHeights: { rayleigh: 0.0013, aerosol: 0.0002 },
    limb: 0.25,
    limbFalloff: 0.004,
    trueRadius: record.radius,
    rotationPeriod: record.rotationPeriod,
    flattening: 1,
    figure: null,
    rings: null,
    appearance: record.appearance,
  }
}

const STAR_DIRECTION = Vec.normalize({ x: -0.6, y: 0.75, z: 0.28 })

const star = (position: Vec3): RenderStar => ({
  luminance: 1.6e9,
  sunlight: 1,
  system: 'SOL',
  name: 'Sun',
  placement: {
    position,
    scale: 1e6,
    compression: 1e-3,
    distance: 1.5e11,
    tier: 'billboard',
    compressed: true,
    angularRadius: 0.0047,
  },
  color: { r: 1, g: 0.96, b: 0.9 },
  brightness: 1,
})

function scene(
  bodies: readonly RenderBody[],
  stars: readonly RenderStar[] = [star(Vec.scale(STAR_DIRECTION, 1.5e9))],
): RenderScene {
  return {
    camera: { position: Vec.ZERO, orientation: Q.IDENTITY, up: UP_RENDER },
    horizon: null,
    bodies,
    stars,
    entities: [],
    structures: [],
    stations: [],
    terrainCandidates: [],
  } as unknown as RenderScene
}

/** Earth with the eye `height` meters over its datum, at the render origin. */
const earthAt = (height: number, orientation: Quat = TURNED): RenderBody =>
  place(earth, {
    center: Vec.scale(UP_RENDER, -(earth.radius + height)),
    orientation,
  })

/** A camera looking along `forward` in render axes, its up near `UP_RENDER`. */
function lookingAlong(forward: Vec3): Quat {
  const back = Vec.normalize(Vec.negate(forward))
  const right = Vec.normalize(Vec.cross(UP_RENDER, back))
  const up = Vec.cross(back, right)
  return Q.fromBasis(right, up, back)
}

/** A horizontal heading in render axes, and a camera looking along it. */
const HEADING = Vec.normalize(Vec.cross(UP_RENDER, { x: 0, y: 0, z: 1 }))
const LEVEL = lookingAlong(HEADING)

function inputs(
  overrides: Partial<CloudFrameInputs> & {
    readonly bodies?: readonly RenderBody[]
  } = {},
  levers: Partial<CloudLevers> = {},
): CloudFrameInputs {
  const { bodies, ...rest } = overrides
  return {
    levers: { ...DEFAULT_CLOUD_LEVERS, on: true, ...levers },
    scene: scene(bodies ?? [earthAt(1500)]),
    record: (address) => SERVED.get(address) ?? null,
    scattering: () => null,
    renderTime: 50_000,
    rate: 1,
    visibility: false,
    enhanced: false,
    pictureEpoch: 0,
    historyKey: 'seed:flight',
    camera: { position: Vec.ZERO, quaternion: LEVEL },
    lens: lensForFov(65),
    css: { width: 1920, height: 1080 },
    render: { width: 1920, height: 1080 },
    delta: 1 / 60,
    ...rest,
  }
}

/** A run of frames, each built on the last. */
function run(steps: readonly CloudFrameInputs[]): CloudFrame[] {
  const frames: CloudFrame[] = []
  let previous: CloudFrame | null = null
  for (const step of steps) {
    const frame = cloudFrame(step, previous)
    if (frame === null) throw new Error('no frame')
    frames.push(frame)
    previous = frame
  }
  return frames
}

const angle = (a: Vec3, b: Vec3): number =>
  Math.acos(
    Math.min(1, Math.max(-1, Vec.dot(Vec.normalize(a), Vec.normalize(b)))),
  )

describe('the body a frame serves', () => {
  const wet = (body: RenderBody) =>
    body.address === EARTH || body.address === 'b:wet-moon'
  const moon = { ...earthAt(1500), address: 'b:wet-moon' }

  it('is the wet body whose air the eye is inside', () => {
    const inside = earthAt(1500)
    const bigger = {
      ...place(earth, { center: { x: 4e8, y: 0, z: 0 }, angularRadius: 2 }),
      address: 'b:wet-moon',
    }
    expect(servedBody([bigger, inside], Vec.ZERO, wet, null)?.address).toBe(
      EARTH,
    )
  })

  it('is otherwise the wet body largest in the sky, and never a dry one', () => {
    const far = place(earth, {
      center: { x: 4e8, y: 0, z: 0 },
      angularRadius: 0.01,
    })
    const near = {
      ...place(earth, { center: { x: 0, y: 3e8, z: 0 }, angularRadius: 0.2 }),
      address: 'b:wet-moon',
    }
    const dry = place(mars, {
      center: { x: 0, y: 0, z: 9e7 },
      angularRadius: 0.9,
    })
    expect(servedBody([far, dry, near], Vec.ZERO, wet, null)?.address).toBe(
      'b:wet-moon',
    )
    expect(servedBody([dry], Vec.ZERO, wet, null)).toBeNull()
  })

  it('is the forced one, wet or not, and none when the forced one is not in the scene', () => {
    const dry = place(mars, { center: { x: 0, y: 0, z: 9e7 } })
    expect(servedBody([moon, dry], Vec.ZERO, wet, MARS)?.address).toBe(MARS)
    expect(servedBody([moon], Vec.ZERO, wet, MARS)).toBeNull()
  })

  it('gives no frame with the levers off, or with nothing to serve', () => {
    expect(cloudFrame(inputs({}, { on: false }), null)).toBeNull()
    expect(
      cloudFrame(
        inputs({ bodies: [place(mars, { center: { x: 0, y: -4e6, z: 0 } })] }),
        null,
      ),
    ).toBeNull()
  })
})

describe('the served set', () => {
  /** Earth alone in the sky, the eye in its air, under the records as they are. */
  const overEarth = (levers: Partial<CloudLevers> = {}, record = SOL) =>
    cloudFrame(
      inputs({ record: (address) => record.get(address) ?? null }, levers),
      null,
    )

  it('leaves Earth, whose deck is authored, out: no frame over it unasked', () => {
    expect(wetWorld(earth)).toBe(true)
    expect(earth.appearance.clouds).not.toBeNull()
    expect(cloudsServed(earth)).toBe(false)
    expect(overEarth()).toBeNull()
  })

  it('serves Earth where a lever forces it by address', () => {
    const frame = overEarth({ served: EARTH })
    expect(frame?.served.address).toBe(EARTH)
  })

  it('serves Earth unasked once its deck’s record goes, with no change to the rule', () => {
    expect(cloudsServed(deckless)).toBe(true)
    expect(overEarth({}, SERVED)?.served.address).toBe(EARTH)
  })

  it('takes a second body from the set, and never a decked one unasked', () => {
    const twin = { ...earthAt(1500), address: 'b:twin' }
    const far = {
      ...place(earth, { center: { x: 4e8, y: 0, z: 0 }, angularRadius: 0.2 }),
      address: 'b:far',
    }
    const second = (record: Body, levers: Partial<CloudLevers> = {}) =>
      cloudFrame(
        inputs(
          {
            bodies: [twin, far],
            record: (address) =>
              address === 'b:twin'
                ? deckless
                : address === 'b:far'
                  ? record
                  : null,
          },
          levers,
        ),
        null,
      )?.second?.address ?? null
    expect(second(deckless)).toBe('b:far')
    expect(second(earth)).toBeNull()
    expect(second(earth, { second: 'b:far' })).toBe('b:far')
  })

  /*
   * C11: on a frame Earth is drawn, its deck is hidden exactly when the
   * volume serves it. A frame of Earth with neither is a bare planet, and
   * one with both draws two cloud decks.
   */
  it('hides Earth’s deck on exactly the frames the volume serves Earth', () => {
    const cases: readonly [Partial<CloudLevers>, Map<string, Body>][] = [
      [{}, SOL],
      [{ served: EARTH }, SOL],
      [{ on: false }, SOL],
      [{ on: false, served: EARTH }, SOL],
      [{ served: MARS }, SOL],
      [{}, SERVED],
    ]
    for (const [set, record] of cases) {
      const levers = { ...DEFAULT_CLOUD_LEVERS, on: true, ...set }
      const frame = overEarth(set, record)
      const volume = frame?.served.address === EARTH
      // `Bodies` reads the served address off the last frame's report.
      const hidden = deckYields(levers, frame?.served.address ?? null, EARTH)
      expect(hidden, JSON.stringify(set)).toBe(volume)
    }
    // The measurement that prices the deck hides it with no volume: the one
    // frame of Earth with neither, and it is asked for by name.
    expect(
      deckYields({ ...DEFAULT_CLOUD_LEVERS, deck: 'hidden' }, null, EARTH),
    ).toBe(true)
  })
})

describe('a body’s weather in its frame', () => {
  it('draws the climate as the body’s own weather, and a named regime as that regime', () => {
    expect(DEFAULT_CLOUD_LEVERS.weather).toBe('climate')
    expect(weatherScenario('climate')).toBe(WEATHER_SCENARIOS[CLIMATE_REGIME])
    for (const id of SCENARIO_IDS)
      expect(weatherScenario(id)).toBe(WEATHER_SCENARIOS[id])
    // A wet world's own weather is its fitted climate, not a regime, and the
    // frame lays out that climate's levels.
    const own = drawnWeather('climate', deckless)
    expect(own.regime).toBeNull()
    const [frame] = run([inputs()])
    const [held] = run([inputs({}, { weather: CLIMATE_REGIME })])
    expect(frame!.served.levels.map(({ base, top }) => [base, top])).toEqual(
      own.weather!.levels.map(({ base, top }) => [base, top]),
    )
    // The key is the lever's, so a change of weather starts the bakes over.
    expect(frame!.served.weatherKey).toBe('climate')
    expect(held!.served.weatherKey).toBe(CLIMATE_REGIME)
  })

  it.each(SCENARIO_IDS)(
    '%s: lays the scenario’s layers out as three levels, the absent ones at the union’s top with nothing in them',
    (id) => {
      const scenario = WEATHER_SCENARIOS[id]
      const [frame] = run([inputs({}, { weather: id })])
      const { levels } = frame!.served
      const { top } = shellUnion(scenario)
      const clock = fieldClock(regimeWeather(deckless, id), 50_000)
      expect(levels).toHaveLength(MAX_CLOUD_LAYERS)
      levels.forEach((level, k) => {
        const layer = scenario.layers[k]
        expect([level.base, level.top]).toEqual(
          layer === undefined ? [top, top] : [layer.base, layer.top],
        )
        expect(level.sigma).toBe(layer?.sigma ?? 0)
        expect(level.radius).toBe(layer?.radius ?? 10)
        expect(level.radiusRange).toEqual([level.radius, level.radius])
        expect(level.cell).toBe(layer?.cellMeters ?? 1)
        expect(level.erosion).toBe(layer?.erosion ?? 0)
        // The medium is the unscaled one. Every level turns at the regime's
        // eastward wind over the body's radius, by its clock's reduced angle.
        expect([level.gain, level.transport]).toEqual([1, 1])
        expect(level.turnRate).toBe(scenario.wind.east / earth.radius)
        expect(level.turn).toEqual(turnBack(clock.turn[k]!))
        // Its origins, reduced by its own periods: eight cells and one.
        for (const axis of ['x', 'y', 'z'] as const) {
          expect(level.noiseOrigin[axis]).toBeGreaterThanOrEqual(0)
          expect(level.noiseOrigin[axis]).toBeLessThan(
            level.cell * CLOUD_BASE_CELLS,
          )
          expect(level.detailOrigin[axis]).toBeLessThan(level.cell)
        }
        expect(level.phaseRows).toBeGreaterThan(0)
        expect(level.meanDepth[0]).toBe(level.meanDepth[1])
        expect(level.meanDepth[0] > 0).toBe(layer !== undefined)
      })
      // The boundaries a march crosses are the levels' own, in order.
      expect(shellBoundaries(scenario)).toEqual(
        levels.flatMap((level) => [level.base, level.top]),
      )
      expect(frame!.served.climate).toEqual(scenarioClimate(scenario, 50_000))
    },
  )

  it('gives a second body the frame’s weather too, under the same key', () => {
    const far = {
      ...place(earth, { center: { x: 4e8, y: 0, z: 0 }, angularRadius: 0.2 }),
      address: 'b:far',
    }
    const [frame] = run([
      inputs(
        {
          bodies: [earthAt(1500), far],
          record: (address) =>
            address === 'b:far' ? deckless : (SERVED.get(address) ?? null),
        },
        { weather: 'two-decks' },
      ),
    ])
    expect(frame!.second?.address).toBe('b:far')
    expect(frame!.second!.weatherKey).toBe('two-decks')
    expect(frame!.second!.levels.map(({ base, top }) => [base, top])).toEqual(
      frame!.served.levels.map(({ base, top }) => [base, top]),
    )
  })

  it('turns each body’s levels at its own weather’s rate: the wind over its own radius', () => {
    const small: Body = { ...deckless, radius: earth.radius / 4 }
    const far = {
      ...place(earth, { center: { x: 4e8, y: 0, z: 0 }, angularRadius: 0.2 }),
      address: 'b:far',
    }
    const [frame] = run([
      inputs({
        bodies: [earthAt(1500), far],
        record: (address) =>
          address === 'b:far' ? small : (SERVED.get(address) ?? null),
      }),
    ])
    const near = drawnWeather('climate', deckless).weather!
    const quarter = drawnWeather('climate', small).weather!
    frame!.served.levels.forEach((level, k) =>
      expect(level.turnRate).toBe(near.turn[k]),
    )
    // The same winds over a quarter of the radius turn four times as fast.
    frame!.second!.levels.forEach((level, k) => {
      expect(level.turnRate).toBe(quarter.turn[k])
      expect(level.turnRate / near.turn[k]!).toBeCloseTo(4, 12)
    })
  })
})

/*
 * The field is a function of body, place and time (phase 1 design §5.3):
 * one body point at one instant reads one lattice coordinate whatever eye
 * the frame was built from. Each level's coordinate is its reduced origin
 * plus its turn applied to the offset from the eye, as the march forms it.
 */
describe('the field’s derivation', () => {
  /** A frame of Earth with the eye `height` over the body-fixed direction `up`. */
  function frameOver(up: Vec3, height: number, time: number): CloudFrame {
    const render = Q.rotate(TURNED, Vec.normalize(up))
    const body = place(earth, {
      center: Vec.scale(render, -(earth.radius + height)),
    })
    return run([
      inputs(
        {
          bodies: [body],
          renderTime: time,
          camera: { position: Vec.ZERO, quaternion: LEVEL },
        },
        { weather: 'two-decks' },
      ),
    ])[0]!
  }

  const turned = (m: readonly number[], v: Vec3): Vec3 => ({
    x: m[0]! * v.x + m[1]! * v.y + m[2]! * v.z,
    y: m[3]! * v.x + m[4]! * v.y + m[5]! * v.z,
    z: m[6]! * v.x + m[7]! * v.y + m[8]! * v.z,
  })

  /** A body point's coordinate in level `k`'s base noise, as `origin + M·(p − eye)`. */
  function latticeAt(frame: CloudFrame, k: number, point: Vec3): Vec3 {
    const level = frame.served.levels[k]!
    return Vec.add(
      level.noiseOrigin,
      turned(level.turn, Vec.sub(point, frame.served.eye)),
    )
  }

  const offPeriod = (a: number, b: number, period: number): number => {
    const turns = (a - b) / period
    return Math.abs(turns - Math.round(turns)) * period
  }

  it('maps one body point to one lattice coordinate from two eyes, one at a pole', () => {
    const unit = fc.double({ min: -1, max: 1, noNaN: true })
    fc.assert(
      fc.property(
        unit,
        unit,
        unit,
        fc.double({ min: 0, max: 3e9, noNaN: true }),
        (x, y, z, time) => {
          const toward =
            Vec.length({ x, y, z }) < 1e-3 ? { x: 1, y: 0, z: 0 } : { x, y, z }
          const near = frameOver(toward, 1500, time)
          const pole = frameOver({ x: 0, y: 1, z: 0 }, 1500, time)
          // A point 2.5 km up, within 300 km of the first eye.
          const at = Vec.add(
            Vec.scale(Vec.normalize(near.served.eye), earth.radius + 2500),
            Vec.scale(near.camera.forward, 3e5 * Math.abs(x)),
          )
          for (let k = 0; k < 3; k += 1) {
            const period = near.served.levels[k]!.cell * CLOUD_BASE_CELLS
            const a = latticeAt(near, k, at)
            const b = latticeAt(pole, k, at)
            // Float64 throughout, the offset 6,400 km long from the pole:
            // a nanometer's rounding a coordinate, a micrometer of bound.
            for (const axis of ['x', 'y', 'z'] as const)
              expect(offPeriod(a[axis], b[axis], period)).toBeLessThan(1e-6)
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('holds the turn to its float64 reduction at 3.2 × 10¹² s, a centimeter at the radius', () => {
    const t = 3.2e12
    const frame = frameOver({ x: 0.3, y: 0.4, z: 0.5 }, 1500, t)
    const rate = frame.served.levels[0]!.turnRate
    // The reference: frac(t·rate/2π) in BigInt, from t's and the period's
    // own binary forms, so no rounding but the period's enters it.
    const period = (2 * Math.PI) / rate
    const scale = 2n ** 80n
    const tb = BigInt(t) * scale
    const pb = BigInt(Math.round(period * 2 ** 40)) * 2n ** 40n
    const turns = Number(tb % pb) / Number(pb)
    const m = frame.served.levels[0]!.turn
    const angle = Math.atan2(m[6]!, m[0]!)
    const reference = 2 * Math.PI * turns
    const miss = Math.abs(
      Math.atan2(Math.sin(angle - reference), Math.cos(angle - reference)),
    )
    expect(miss * earth.radius).toBeLessThan(0.01)
  })
})

describe('a body’s frame', () => {
  it('forms the eye’s heights in float64, with no radius taken from another', () => {
    const [frame] = run([
      inputs({ bodies: [earthAt(1250.5)] }, { weather: 'fair-cumulus' }),
    ])
    const { shells, eye } = frame!.served
    expect(Math.abs(shells.eye - 1250.5)).toBeLessThan(1e-6)
    expect(Vec.length(eye) - earth.radius).toBeCloseTo(1250.5, 6)
    const boundaries = shellBoundaries(WEATHER_SCENARIOS['fair-cumulus'])
    expect(shells.boundaries).toEqual(boundaries)
    expect(shells.eyeOver).toEqual(boundaries.map((b) => shells.eye - b))
    // The eye is in the body's own axes: the turn undone, the render axes not.
    expect(
      Vec.dot(Vec.normalize(eye), Q.rotateInverse(TURNED, UP_RENDER)),
    ).toBeCloseTo(1, 12)
  })

  it('takes the sun as the key star’s true direction from the body’s center, turned into its axes', () => {
    const body = earthAt(1500)
    const [frame] = run([inputs({ bodies: [body] })])
    const key = scene([body]).stars[0]!
    // True offsets from the eye at the render origin: each placement's
    // direction at its true distance.
    const trueOf = (placement: RenderPlacement): Vec3 =>
      Vec.scale(Vec.normalize(placement.position), placement.distance)
    const sun = Vec.normalize(
      Vec.sub(trueOf(key.placement), trueOf(body.placement)),
    )
    expect(
      Vec.distance(frame!.served.sun, Q.rotate(Q.conjugate(TURNED), sun)),
    ).toBeLessThan(1e-15)
  })

  it('lights by the key star’s color, at its sunlight unless visibility stages it to one', () => {
    const [shaded] = run([inputs()])
    expect(shaded!.served.dayColor).toEqual({
      r: 0.85,
      g: 0.96 * 0.85,
      b: 0.9 * 0.85,
    })
    const [staged] = run([inputs({ visibility: true })])
    expect(staged!.served.dayColor).toEqual({ r: 1, g: 0.96, b: 0.9 })
  })

  it('blows the scenario’s wind east and north at the eye, in the body’s axes', () => {
    const [frame] = run([inputs({}, { weather: 'two-decks' })])
    const { wind, eye } = frame!.served
    expect(Vec.dot(wind, Vec.normalize(eye))).toBeCloseTo(0, 12)
    expect(Vec.length(wind)).toBeCloseTo(Math.hypot(8, 4), 12)
    // North is the pole laid on the horizon: its share of the wind is 4 m/s.
    const pole = { x: 0, y: 1, z: 0 }
    const up = Vec.normalize(eye)
    const north = Vec.normalize(Vec.sub(pole, Vec.scale(up, Vec.dot(pole, up))))
    expect(Vec.dot(wind, north)).toBeCloseTo(4, 12)
  })

  it('reduces the noise origins by a period every layer’s noise tiles in', () => {
    const scenario = WEATHER_SCENARIOS['cirrus-over-cumulus']
    const periods = cloudNoisePeriods(scenario)
    expect(periods.base).toBe(240_000)
    expect(periods.detail).toBe(30_000)
    for (const layer of scenario.layers) {
      expect(periods.base % (layer.cellMeters * CLOUD_BASE_CELLS)).toBe(0)
      expect(periods.detail % layer.cellMeters).toBe(0)
    }
    const [frame] = run([inputs({}, { weather: 'cirrus-over-cumulus' })])
    const { noiseOrigin, eye } = frame!.served
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(noiseOrigin[axis]).toBeGreaterThanOrEqual(0)
      expect(noiseOrigin[axis]).toBeLessThan(periods.base)
      const wraps = (eye[axis] - noiseOrigin[axis]) / periods.base
      expect(Math.abs(wraps - Math.round(wraps))).toBeLessThan(1e-9)
    }
  })

  it('lays out its caches as their modules do', () => {
    const [frame] = run([inputs()])
    const { clipmap, volume } = frame!.served
    expect(clipmap.frames.length).toBe(CLOUD_CLIPMAP_LEVELS)
    expect(clipmap.frames.map((level) => level.texelMeters)).toEqual([
      ...CLOUD_CLIPMAP_TEXELS,
    ])
    expect(
      clipmap.frames.every((level) => level.size === CLOUD_CLIPMAP_SIZE),
    ).toBe(true)
    expect(volume.frames.map((level) => level.texelMeters)).toEqual([
      ...CLOUD_VOLUME_TEXELS,
    ])
    expect(
      volume.frames.every((level) => level.size === CLOUD_VOLUME_SIZE),
    ).toBe(true)
    expect(cloudNoisePeriods(WEATHER_SCENARIOS['fair-cumulus']).base).toBe(
      1200 * CLOUD_BASE_CELLS,
    )
  })

  it('copies into the uniform bundle', () => {
    const [frame] = run([inputs()])
    const uniforms = createCloudUniforms()
    uniforms.write(frame!)
    expect(uniforms.served.datumRadius.value).toBe(earth.radius)
    expect(uniforms.served.active.value).toBe(1)
    expect(uniforms.trace.size.value.x).toBe(480)
    expect(uniforms.camera.pixelAngle.value).toBe(frame!.camera.pixelAngle)
  })
})

describe('the frame’s camera', () => {
  it('turns the camera’s basis into the served body’s axes and spends the ray budget by the trace’s rows', () => {
    const [frame] = run([inputs()])
    const { camera } = frame!
    const toBodyFixed = Q.conjugate(TURNED)
    const forward = Q.rotate(
      toBodyFixed,
      Q.rotate(LEVEL, { x: 0, y: 0, z: -1 }),
    )
    expect(Vec.distance(camera.forward, forward)).toBeLessThan(1e-12)
    expect(Vec.dot(camera.right, camera.up)).toBeCloseTo(0, 12)
    const halfTan = Math.tan((65 * Math.PI) / 360)
    expect(camera.halfTan).toBeCloseTo(halfTan, 12)
    expect(camera.aspect).toBe(1920 / 1080)
    expect(camera.pixelAngle).toBeCloseTo((2 * Math.atan(halfTan)) / 270, 15)
  })
})

/*
 * The sun the clouds are lit by is the star's true direction from the body's
 * center. Placed as `buildScene` places them, from true positions about the
 * eye, the star stands at a compressed render distance, and the difference
 * of two render positions carries the parallax of the eye's offset from the
 * center over that distance.
 */
describe('the frame’s sun, placed as the scene places it', () => {
  const AU = 1.495978707e11
  const SUN_RADIUS = 6.957e8
  const HORIZON = Vec.normalize(Vec.cross(UP_RENDER, { x: 0, y: 0, z: 1 }))

  /**
   * The eye `height` over Earth at the render origin, and the sun
   * `elevation` degrees over the eye's horizon from Earth's center, 1 AU off.
   */
  function stance(height: number, elevation: number) {
    const origin = createRenderOrigin(UV.fromMeters(0, 0, 0))
    const center = Vec.scale(UP_RENDER, -(earth.radius + height))
    const rad = (elevation * Math.PI) / 180
    const truth = Vec.add(
      Vec.scale(HORIZON, Math.cos(rad)),
      Vec.scale(UP_RENDER, Math.sin(rad)),
    )
    const toStar = Vec.add(center, Vec.scale(truth, AU))
    const at = (v: Vec3) => UV.fromMeters(v.x, v.y, v.z)
    const bodyPlaced = placeAt(origin, at(center), earth.radius, Vec.ZERO)
    const starPlaced = placeAt(origin, at(toStar), SUN_RADIUS, Vec.ZERO)
    const body: RenderBody = {
      ...place(earth, {
        center: bodyPlaced.position,
        compression: bodyPlaced.compression,
      }),
      placement: bodyPlaced,
    }
    const key: RenderStar = {
      ...star(starPlaced.position),
      placement: starPlaced,
    }
    const [frame] = run([
      inputs({ bodies: [body], scene: scene([body], [key]) }),
    ])
    const fixed = (v: Vec3) => Q.rotate(Q.conjugate(TURNED), v)
    // atan2 of the cross and the dot: an arccosine resolves nothing under
    // 1.5 × 10⁻⁸ rad, where its argument is one float64 step from 1.
    const degrees = (a: Vec3, b: Vec3) =>
      (Math.atan2(Vec.length(Vec.cross(a, b)), Vec.dot(a, b)) * 180) / Math.PI
    const rendered = Vec.sub(starPlaced.position, bodyPlaced.position)
    return {
      compression: bodyPlaced.compression,
      starRadii: Vec.length(rendered) / bodyPlaced.scale,
      before: degrees(fixed(rendered), fixed(truth)),
      after: degrees(frame!.served.sun, fixed(truth)),
    }
  }

  it.each([
    ['in the near field', 1500, 1],
    ['from 36,000 km, compressed', 3.6e7, 0.33],
  ])(
    'is the true sun %s, where the render positions’ difference is half a degree off',
    (_where, height, compression) => {
      const dusk = stance(height, -1.5)
      expect(dusk.compression).toBeCloseTo(compression, 2)
      // The parallax the render difference carries, at a star 114 radii out
      // from the near eye: 0.51°, E2's figure.
      expect(dusk.before).toBeGreaterThan(0.4)
      // Float64's rounding of two offsets 1 AU long: 10⁻¹⁴ of a degree.
      expect(dusk.after).toBeLessThan(1e-9)
    },
  )
})

describe('the field’s clock', () => {
  it('is the world’s presentation instant, and its own Δt between frames', () => {
    const frames = run([inputs(), inputs({ renderTime: 50_000 + 1 / 60 })])
    expect(frames[0]!.time).toBe(50_000)
    expect(frames[0]!.frameSeconds).toBe(0)
    expect(frames[1]!.time).toBe(50_000 + 1 / 60)
    expect(frames[1]!.frameSeconds).toBe(50_000 + 1 / 60 - 50_000)
    expect(frames[1]!.reset).toBe('none')
    expect(frames[1]!.regime).toBe('converging')
  })

  it('steps by scrubSeconds a call under scrub, always a jump, the world’s clock untouched', () => {
    const scrub = { force: 'scrub' as const }
    const frames = run([
      inputs({}, scrub),
      inputs({}, scrub),
      inputs({}, scrub),
    ])
    expect(frames.map((frame) => frame.time)).toEqual([50_000, 60_800, 71_600])
    expect(frames[1]!.frameSeconds).toBe(10_800)
    expect(frames.slice(1).every((frame) => frame.jump)).toBe(true)
    expect(frames.slice(1).every((frame) => frame.regime === 'immediate')).toBe(
      true,
    )
  })

  it('turns the sun 45° about the pole for 3 h of scrub on Earth', () => {
    const scrub = { force: 'scrub' as const }
    const frames = run([inputs({}, scrub), inputs({}, scrub)])
    const before = frames[0]!.served.sun
    const after = frames[1]!.served.sun
    const turn = (2 * Math.PI * 10_800) / earth.rotationPeriod
    // The sidereal day, 86,164 s: 45.12°.
    expect((turn * 180) / Math.PI).toBeCloseTo(45.12, 2)
    // About +Y, the body's pole: the height of the sun over the equator holds.
    expect(after.y).toBeCloseTo(before.y, 12)
    const flat = (v: Vec3) => ({ x: v.x, y: 0, z: v.z })
    expect(angle(flat(before), flat(after))).toBeCloseTo(turn, 9)
    // The ground turns toward −2π/period about +Y; the sun runs the other way.
    const spin = Q.fromAxisAngle({ x: 0, y: 1, z: 0 }, -turn)
    expect(Vec.distance(Q.rotate(spin, before), after)).toBeLessThan(1e-9)
  })

  it('steps by delta × warp under warp, which is no jump', () => {
    const warp = { force: 'warp' as const, warp: 1000 }
    const frames = run([
      inputs({ renderTime: 3600 * 20 + 10 }, warp),
      inputs({ renderTime: 3600 * 20 + 10 }, warp),
    ])
    expect(frames[1]!.time).toBeCloseTo(3600 * 20 + 10 + 1000 / 60, 9)
    expect(frames[1]!.frameSeconds).toBeCloseTo(1000 / 60, 9)
    expect(frames[1]!.jump).toBe(false)
    expect(frames[1]!.reset).toBe('none')
  })

  it('raises no jump where an hour turns over: the levels turn, and nothing starts over', () => {
    const frames = run([
      inputs({ renderTime: 3600 * 7 - 0.01 }),
      inputs({ renderTime: 3600 * 7 + 0.005 }),
    ])
    expect(frames[1]!.jump).toBe(false)
    expect(frames[1]!.reset).toBe('none')
  })

  /*
   * A jump is a step the clock's rate does not explain (phase 1 design §4.7).
   * The world's step is `rate·delta` on a steady clock; the sensor's frames
   * jitter, so each call's delta and the world's step are drawn ±25% of a
   * frame apart, more than a display's own.
   */
  it.each([60, 120])(
    'raises no jump and no reset at any rate of the dock’s ladder at %i Hz, and one for a step of three hours',
    (hertz) => {
      for (const rate of WARP_STEPS) {
        const steps: CloudFrameInputs[] = []
        let time = 50_000
        for (let k = 0; k < 120; k += 1) {
          const delta = (1 + 0.25 * Math.sin(k * 1.7)) / hertz
          const world = (1 + 0.25 * Math.cos(k * 2.3)) / hertz
          time += rate * world
          steps.push(inputs({ rate, delta, renderTime: time }))
        }
        const frames = run(steps)
        const later = frames.slice(1)
        expect(
          later.every((frame) => !frame.jump && frame.reset === 'none'),
          `${rate}× at ${hertz} Hz`,
        ).toBe(true)
        const scrubbed = cloudFrame(
          inputs({
            rate,
            delta: 1 / hertz,
            renderTime: time + rate / hertz + 3 * 3600,
          }),
          frames.at(-1)!,
        )!
        // At 10⁵× a frame's own step is 28 minutes at 60 Hz: three hours
        // is inside four of them, and the clock explains it.
        const explained = 3 * 3600 <= 4 * (rate / hertz)
        expect(scrubbed.jump, `${rate}× at ${hertz} Hz`).toBe(!explained)
        if (!explained) expect(scrubbed.reset).toBe('jump')
      }
    },
  )

  it('jumps when the world’s instant moves farther than the call could have taken it', () => {
    const frames = run([inputs(), inputs({ renderTime: 50_000 + 5 })])
    expect(frames[1]!.jump).toBe(true)
    expect(frames[1]!.reset).toBe('jump')
    const held = run([inputs(), inputs()])
    expect(held[1]!.jump).toBe(false)
  })
})

describe('the regime', () => {
  it('is immediate on a first frame', () => {
    const [frame] = run([inputs()])
    expect(frame!.reset).toBe('first')
    expect(frame!.regime).toBe('immediate')
    expect(frame!.frameIndex).toBe(0)
  })

  it('resets on a change of field: the weather, a size the caches are laid out by, or a body, and rebuilds every cache', () => {
    const changes: readonly [
      Parameters<typeof inputs>[0],
      Partial<CloudLevers>,
    ][] = [
      [{}, { weather: 'overcast' }],
      [{}, { traceScale: 2 }],
      [{}, { farFootprint: DEFAULT_CLOUD_LEVERS.farFootprint * 2 }],
      [
        {
          bodies: [
            earthAt(1500),
            place(mars, { center: { x: 0, y: 0, z: 9e7 }, angularRadius: 0.1 }),
          ],
        },
        { second: MARS },
      ],
    ]
    for (const [change, levers] of changes) {
      const frames = run([inputs(), inputs(change, levers)])
      expect(frames[1]!.reset, JSON.stringify(levers)).toBe('field')
      expect(frames[1]!.regime).toBe('immediate')
      expect(frames[1]!.served.clipmap.rebuilt.every(Boolean)).toBe(true)
      expect(frames[1]!.served.volume.rebuilt.every(Boolean)).toBe(true)
    }
  })

  it('resets on a cut that keeps the field: the picture epoch, the sensor’s key or the composite, and keeps every cache', () => {
    const cuts: readonly [
      Parameters<typeof inputs>[0],
      Partial<CloudLevers>,
    ][] = [
      [{ pictureEpoch: 1 }, {}],
      [{ historyKey: 'seed:b:4' }, {}],
      [{}, { composite: 'thin' }],
    ]
    for (const [change, levers] of cuts) {
      const frames = run([inputs(), inputs(change, levers)])
      expect(frames[1]!.reset, JSON.stringify(change)).toBe('picture')
      expect(frames[1]!.regime).toBe('immediate')
      expect(frames[1]!.served.clipmap.rebuilt.some(Boolean)).toBe(false)
      expect(frames[1]!.served.volume.rebuilt.some(Boolean)).toBe(false)
    }
    // A cut that also moves the eye scrolls the levels as any frame does,
    // and rebuilds only a level whose anchor moved: 600 m along the ground
    // scrolls the finest volume level by twelve of its 50 m texels and moves
    // no anchor.
    const away = Vec.scale(HEADING, 600)
    const moved = run([
      inputs(),
      inputs({
        pictureEpoch: 1,
        camera: { position: away, quaternion: LEVEL },
      }),
    ])[1]!
    expect(moved.reset).toBe('picture')
    expect(moved.served.volume.dirty[0]!.length).toBeGreaterThan(0)
    expect(moved.served.volume.rebuilt.some(Boolean)).toBe(false)
    expect(moved.served.clipmap.rebuilt.some(Boolean)).toBe(false)
    // The stats counter changes how a frame is drawn, not what it means.
    const drawn = run([inputs(), inputs({}, { stats: true })])
    expect(drawn[1]!.reset).toBe('none')
  })

  it('names a reason from one list', () => {
    // The union is what a report's reader switches on.
    const reasons: Record<CloudResetReason, true> = {
      none: true,
      first: true,
      field: true,
      picture: true,
      jump: true,
      resize: true,
      cut: true,
      force: true,
    }
    const drawn = new Set(
      run([
        inputs(),
        inputs({}, { weather: 'overcast' }),
        inputs({}, { weather: 'overcast' }),
        inputs({ pictureEpoch: 1 }, { weather: 'overcast' }),
      ]).map((frame) => frame.reset),
    )
    for (const reason of drawn) expect(reasons[reason]).toBe(true)
    expect([...drawn]).toEqual(['first', 'field', 'none', 'picture'])
  })

  it('reads the clock’s rate and leaves the jump to the step it took: a steady 1× raises none', () => {
    const frames = run([
      inputs({ rate: 1 }),
      inputs({ rate: 1, renderTime: 50_000 + 1 / 60 }),
      inputs({ rate: 100, renderTime: 50_000 + 2 / 60 }),
    ])
    expect(frames.map((frame) => frame.jump)).toEqual([false, false, false])
  })

  it('resets on a resize', () => {
    const frames = run([
      inputs(),
      inputs({ css: { width: 1440, height: 900 } }),
    ])
    expect(frames[1]!.reset).toBe('resize')
  })

  /*
   * The history rejects per pixel what it cannot reproject, so motion is no
   * reset (phase 1 design §5.10): a turn of any size, and travel past a
   * layer's boundary, where the eye's clearance is nothing.
   */
  it('never resets on the camera’s motion: a turn past 20°, or travel past a tenth of the eye’s clearance', () => {
    const turned = lookingAlong(
      Q.rotate(
        Q.fromAxisAngle(UP_RENDER, (25 * Math.PI) / 180),
        Q.rotate(LEVEL, { x: 0, y: 0, z: -1 }),
      ),
    )
    const deck = { weather: 'fair-cumulus' } as const
    const turn = run([
      inputs({}, deck),
      inputs({ camera: { position: Vec.ZERO, quaternion: turned } }, deck),
    ])
    expect(turn[1]!.reset).toBe('none')
    // At 1,500 m the nearest boundary is fair-cumulus's base 500 m below.
    const step = (meters: number) =>
      inputs(
        {
          camera: { position: Vec.scale(HEADING, meters), quaternion: LEVEL },
        },
        deck,
      )
    expect(run([inputs({}, deck), step(51)])[1]!.reset).toBe('none')
    expect(run([inputs({}, deck), step(400)])[1]!.reset).toBe('none')
  })

  it('stays converging in level flight 20 m under a base at 250 m/s for 120 frames', () => {
    // fair-cumulus's base is 1,000 m; the eye flies at 980 m, 4.2 m a frame.
    const steps = Array.from({ length: 121 }, (_, k) =>
      inputs(
        {
          bodies: [earthAt(980)],
          renderTime: 50_000 + k / 60,
          camera: {
            position: Vec.scale(HEADING, (250 * k) / 60),
            quaternion: LEVEL,
          },
        },
        { weather: 'fair-cumulus' },
      ),
    )
    const frames = run(steps)
    expect(frames[0]!.served.shells.eyeOver[0]).toBeCloseTo(-20, 6)
    expect(frames.slice(1).map((frame) => frame.reset)).toEqual(
      new Array(120).fill('none'),
    )
  })

  it('counts every call, and turns over the regime once nothing resets', () => {
    const frames = run([inputs(), inputs(), inputs()])
    expect(frames.map((frame) => frame.frameIndex)).toEqual([0, 1, 2])
    expect(frames.map((frame) => frame.regime)).toEqual([
      'immediate',
      'converging',
      'converging',
    ])
  })
})

describe('the forced paths', () => {
  it('restarts the history under cut, every call, and keeps every cache', () => {
    const cut = { force: 'cut' as const }
    const frames = run([inputs(), inputs({}, cut), inputs({}, cut)])
    for (const frame of frames.slice(1)) {
      expect(frame.reset).toBe('cut')
      expect(frame.regime).toBe('immediate')
      expect(frame.served.clipmap.rebuilt.some(Boolean)).toBe(false)
      expect(frame.served.volume.rebuilt.some(Boolean)).toBe(false)
    }
  })

  it('immediates under reset, and nothing else', () => {
    const frames = run([inputs(), inputs({}, { force: 'reset' })])
    expect(frames[1]!.reset).toBe('force')
    expect(frames[1]!.served.clipmap.rebuilt.some(Boolean)).toBe(false)
  })

  it('flies the eye flySpeed/60 a call along the level forward, carried from the call it was set and dropped after', () => {
    const fly = { force: 'fly' as const, flySpeed: 250 }
    const frames = run([
      inputs(),
      inputs({}, fly),
      inputs({}, fly),
      inputs({}, fly),
      inputs(),
    ])
    const start = frames[0]!.served.eye
    const step = 250 / 60
    for (const k of [1, 2, 3]) {
      const flown = Vec.sub(frames[k]!.served.eye, start)
      expect(Vec.length(flown)).toBeCloseTo(k * step, 6)
      // Along the horizontal: the height barely moves, by the curvature alone.
      expect(Vec.dot(flown, Vec.normalize(start))).toBeLessThan(1e-3)
      expect(
        Vec.dot(Vec.normalize(flown), frames[k]!.camera.forward),
      ).toBeCloseTo(1, 6)
      expect(frames[k]!.translation).toEqual(
        Vec.sub(frames[k]!.served.eye, frames[k - 1]!.served.eye),
      )
    }
    // 4.2 m a call stays under both motion bounds, so fly prices the converging path.
    expect(frames.slice(2, 4).every((frame) => frame.reset === 'none')).toBe(
      true,
    )
    // Cleared, the eye is the camera's again.
    expect(Vec.distance(frames[4]!.served.eye, start)).toBeLessThan(1e-6)
    expect(frames[4]!.flown).toEqual(Vec.ZERO)
  })

  it('moves the rays and the caches with the flown eye, and not the scene’s camera', () => {
    const fly = { force: 'fly' as const, flySpeed: 7700 }
    let frames = run([inputs(), inputs({}, fly)])
    for (let k = 0; k < 30; k += 1)
      frames = [...frames, cloudFrame(inputs({}, fly), frames.at(-1)!)!]
    const last = frames.at(-1)!
    const travel = Vec.distance(last.served.eye, frames[0]!.served.eye)
    expect(travel).toBeCloseTo((31 * 7700) / 60, 3)
    // The finest volume level's 50 m texels have scrolled under the eye.
    expect(last.served.volume.frames[0]!.origin).not.toEqual(
      frames[0]!.served.volume.frames[0]!.origin,
    )
    expect(last.camera.forward).toEqual(frames[0]!.camera.forward)
  })
})
