import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  lensForFov,
  type RenderBody,
  type RenderScene,
  type RenderStar,
  shellBoundaries,
  WEATHER_SCENARIOS,
} from '@inertialref/rendering'
import {
  type Quat,
  Quaternion as Q,
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
  servedBody,
} from './cloudFrame.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { CLOUD_BASE_CELLS } from './cloudNoise.ts'
import { CLOUD_CLIPMAP_LEVELS, createCloudUniforms } from './cloudUniforms.ts'
import { CLOUD_VOLUME_SIZE, CLOUD_VOLUME_TEXELS } from './cloudVolume.ts'

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

function scene(bodies: readonly RenderBody[]): RenderScene {
  return {
    camera: { position: Vec.ZERO, orientation: Q.IDENTITY, up: UP_RENDER },
    horizon: null,
    bodies,
    stars: [star(Vec.scale(STAR_DIRECTION, 1.5e9))],
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

const LEVEL = lookingAlong(
  Vec.normalize(Vec.cross(UP_RENDER, { x: 0, y: 0, z: 1 })),
)

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
    record: (address) => SOL.get(address) ?? null,
    scattering: () => null,
    renderTime: 50_000,
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

describe('a body’s frame', () => {
  it('forms the eye’s heights in float64, with no radius taken from another', () => {
    const [frame] = run([inputs({ bodies: [earthAt(1250.5)] })])
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

  it('takes the sun as TerrainPatches does: the key star from the body’s center, turned into its axes', () => {
    const body = earthAt(1500)
    const [frame] = run([inputs({ bodies: [body] })])
    const key = scene([body]).stars[0]!
    expect(frame!.served.sun).toEqual(
      Q.rotate(
        Q.conjugate(body.orientation),
        Vec.normalize(Vec.sub(key.placement.position, body.placement.position)),
      ),
    )
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
    const [frame] = run([inputs({}, { scenario: 'two-decks' })])
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
    const [frame] = run([inputs({}, { scenario: 'cirrus-over-cumulus' })])
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

  it('steps by delta × warp under warp, which is no jump while it stays inside the hour', () => {
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

  it('jumps when the drift’s hour wraps, where the field starts over', () => {
    const frames = run([
      inputs({ renderTime: 3600 * 7 - 0.01 }),
      inputs({ renderTime: 3600 * 7 + 0.005 }),
    ])
    expect(frames[1]!.jump).toBe(true)
    expect(frames[1]!.reset).toBe('jump')
  })

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

  it('resets on the history’s key: a lever, the picture epoch, the sensor’s key or the bodies', () => {
    const changes: readonly [
      Parameters<typeof inputs>[0],
      Partial<CloudLevers>,
    ][] = [
      [{}, { scenario: 'overcast' }],
      [{}, { traceScale: 2 }],
      [{ pictureEpoch: 1 }, {}],
      [{ historyKey: 'seed:b:4' }, {}],
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
      expect(frames[1]!.reset).toBe('key')
    }
    // The stats counter changes how a frame is drawn, not what it means.
    const drawn = run([inputs(), inputs({}, { stats: true })])
    expect(drawn[1]!.reset).toBe('none')
  })

  it('resets on a resize', () => {
    const frames = run([
      inputs(),
      inputs({ css: { width: 1440, height: 900 } }),
    ])
    expect(frames[1]!.reset).toBe('resize')
  })

  it('resets on motion: a turn past 20°, or travel past a tenth of the eye’s clearance', () => {
    const turned = lookingAlong(
      Q.rotate(
        Q.fromAxisAngle(UP_RENDER, (25 * Math.PI) / 180),
        Q.rotate(LEVEL, { x: 0, y: 0, z: -1 }),
      ),
    )
    const turn = run([
      inputs(),
      inputs({ camera: { position: Vec.ZERO, quaternion: turned } }),
    ])
    expect(turn[1]!.reset).toBe('motion')
    const small = lookingAlong(
      Q.rotate(
        Q.fromAxisAngle(UP_RENDER, (15 * Math.PI) / 180),
        Q.rotate(LEVEL, { x: 0, y: 0, z: -1 }),
      ),
    )
    const slight = run([
      inputs(),
      inputs({ camera: { position: Vec.ZERO, quaternion: small } }),
    ])
    expect(slight[1]!.reset).toBe('none')
    // At 1,500 m the nearest boundary is fair-cumulus's base 500 m below: 50 m.
    const step = (meters: number) =>
      inputs({
        camera: {
          position: Vec.scale(
            Vec.normalize(Vec.cross(UP_RENDER, { x: 0, y: 0, z: 1 })),
            meters,
          ),
          quaternion: LEVEL,
        },
      })
    expect(run([inputs(), step(49)])[1]!.reset).toBe('none')
    expect(run([inputs(), step(51)])[1]!.reset).toBe('motion')
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
  it('rebuilds every cache under cut, every call, and holds the regime immediate', () => {
    const cut = { force: 'cut' as const }
    const frames = run([inputs(), inputs({}, cut), inputs({}, cut)])
    for (const frame of frames.slice(1)) {
      expect(frame.reset).toBe('cut')
      expect(frame.regime).toBe('immediate')
      expect(frame.served.clipmap.rebuilt.every(Boolean)).toBe(true)
      expect(frame.served.volume.rebuilt.every(Boolean)).toBe(true)
    }
    // Without the force the same still eye scrolls nothing and rebuilds nothing.
    const still = run([inputs(), inputs()])
    expect(still[1]!.served.clipmap.rebuilt.some(Boolean)).toBe(false)
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
    // Cleared, the eye is the camera's again, and the jump back is motion.
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
