import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CORNERSTONES,
  openSession,
  type Picture,
  sunAt,
  sunDirection,
} from '@inertialref/devtools'
import { formatSeed } from '@inertialref/procedural'
import {
  type Lens,
  LENS_PRESETS,
  scenarioCoverage,
  WEATHER_SCENARIOS,
} from '@inertialref/rendering'
import { type Vec3, vec3 } from '@inertialref/spatial'
import {
  type Body,
  bodyFixedFrameId,
  findBody,
  geodeticDirection,
  groundElevation,
  parseAddress,
  seaDatumElevation,
} from '@inertialref/universe'
import { loadStarCatalog } from './catalog.ts'

/*
 * The cornerstones' ledger: what each of the nine pictures the weather is
 * judged on asks of the world, held in Node, without a GPU.
 *
 * A cornerstone is a preset taken before the work it judges, so its instant
 * has to stay the instant it was solved for. Each was solved for a sun —
 * E1's 50° and falling, G3's 1.5° under the horizon — and written into
 * `cornerstones.json` as a time. A change to a body's frames, its spin or
 * its orbit moves that sun without moving the time, and the picture then
 * shows another hour. So beside the snapshot, which names what moved, this
 * holds each cornerstone's sun to its target within half a degree, its
 * trend, and a heading toward the sun to the azimuth it was solved at.
 *
 * It also holds what the generated world's pictures need of the ground: G1,
 * G3, G5 and G6's last frame stand on land, not open water, and G1's rise is
 * the land stance's 20 m over the sea; and G3's deck can be lit from below
 * at all: the layer's base is lit by at least half a degree, and every base
 * under the full deck sunward of the stance has a clear sky where its ray
 * to the sun climbs back into the layer.
 *
 * The snapshot is `cornerstoneLedger.json`; `pnpm cornerstones:ledger`
 * rewrites it, as `presets:ledger` rewrites the pictures'.
 */

const DEG = Math.PI / 180
const figure = (value: number): number => Number(value.toPrecision(10))
const degrees = (value: number): number => Math.round(value * 1e3) / 1e3
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

/** What each picture's sun was solved for (phase 1 design §3.3). */
interface SunRule {
  /** Degrees, or the day's highest sun. */
  readonly elevation: number | 'noon'
  readonly trend: 'rising' | 'falling' | null
  /** The heading is the sun's azimuth plus this, degrees; null when it is not. */
  readonly heading: number | null
  /** The pitch is the sun's elevation negated: G4 looks at the antisolar point. */
  readonly antisolar?: true
}

const RULES: Readonly<Record<string, SunRule | null>> = {
  'weather-e1-cumulus-orbit': {
    elevation: 50,
    trend: 'falling',
    heading: null,
  },
  'weather-e2-limb-dusk': { elevation: -21, trend: 'falling', heading: 0 },
  // The whole face is `blue-marble`'s held instant, and composes no stance.
  'weather-e3-whole-face': null,
  'weather-g1-fair': { elevation: 'noon', trend: null, heading: 120 },
  'weather-g2-overcast-shore': {
    elevation: 35,
    trend: 'rising',
    heading: null,
  },
  'weather-g3-underlit-dusk': {
    elevation: -1.5,
    trend: 'falling',
    heading: 0,
  },
  'weather-g4-over-deck': {
    elevation: 35,
    trend: 'falling',
    heading: 180,
    antisolar: true,
  },
  'weather-g5-inside': { elevation: 45, trend: 'rising', heading: null },
  'weather-g6-descent': { elevation: 45, trend: 'rising', heading: null },
}

/** The pictures that stand on the land stance, L, and so on dry ground. */
const ON_LAND = [
  'weather-g1-fair',
  'weather-g3-underlit-dusk',
  'weather-g5-inside',
  'weather-g6-descent',
]

const angleBetween = (a: number, b: number): number =>
  Math.abs(((((a - b) % 360) + 540) % 360) - 180)

function bodyOf(
  session: ReturnType<typeof openSession>,
  address: string,
): Body {
  const parsed = parseAddress(
    address.startsWith('g:') ? address : `g:milky-way/${address}`,
  )
  if (parsed.kind !== 'body') throw new Error(`${address} is not a body`)
  return findBody(session.world.loadSystem(parsed.system), parsed.body)!
}

function bodyDigest(body: Body): string {
  return digest({
    radius: body.radius,
    rotationPeriod: body.rotationPeriod,
    axialTilt: body.axialTilt,
    elements: body.elements,
    surface: { ...body.surface, seed: formatSeed(body.surface.seed) },
  })
}

/** The point `distance` meters from a place along a bearing east of north. */
function along(
  latitude: number,
  longitude: number,
  bearing: number,
  distance: number,
  radius: number,
): { latitude: number; longitude: number } {
  const d = distance / radius
  const lat = Math.asin(
    Math.sin(latitude) * Math.cos(d) +
      Math.cos(latitude) * Math.sin(d) * Math.cos(bearing),
  )
  return {
    latitude: lat,
    longitude:
      longitude +
      Math.atan2(
        Math.sin(bearing) * Math.sin(d) * Math.cos(latitude),
        Math.cos(d) - Math.sin(latitude) * Math.sin(lat),
      ),
  }
}

describe('the cornerstones', () => {
  it('compose the frame and the sun they were solved for, and take nothing from the world', async () => {
    let held: Lens = LENS_PRESETS.flight
    const session = openSession({
      catalog: loadStarCatalog(),
      workers: null,
      render: {
        framingLens: () => held,
        setFlightLens: (next) => {
          held = next
        },
      },
    })
    try {
      const before = session.world.stateHash()
      const entries: unknown[] = []
      expect(CORNERSTONES.map((one) => one.id).sort()).toEqual(
        Object.keys(RULES).sort(),
      )
      for (const picture of CORNERSTONES) {
        held = LENS_PRESETS.flight
        const taken = session.harness.preset(picture.id)
        const { status } = taken
        expect(status.target?.address, picture.id).toContain(picture.address)
        // Headlessly no weather is drawn, and the picture says so.
        expect(taken.weather, picture.id).toBe('unavailable')
        const body = bodyOf(session, picture.address)
        const surface = status.surface
        const rule = RULES[picture.id]
        let sun: { elevation: number; azimuth: number } | null = null
        if (surface !== null) {
          const { stance } = surface
          sun = sunAt(session.world, picture.address, stance, status.time)
          // The harness's verb reads the same sun, in degrees.
          const read = session.harness.sun(
            picture.address,
            {
              latitude: stance.latitude / DEG,
              longitude: stance.longitude / DEG,
            },
            status.time,
          )
          expect(read.elevation).toBeCloseTo(sun.elevation, 9)
        }
        if (rule !== null && rule !== undefined) {
          expect(sun, picture.id).not.toBeNull()
          holdSun(picture, rule, sun!, (time) =>
            sunAt(session.world, picture.address, surface!.stance, time),
          )
          if (rule.heading !== null)
            expect(
              angleBetween(
                surface!.stance.heading / DEG,
                sun!.azimuth + rule.heading,
              ),
              `${picture.id}: heading`,
            ).toBeLessThan(0.5)
          if (rule.antisolar)
            expect(
              Math.abs(surface!.stance.pitch / DEG + sun!.elevation),
              `${picture.id}: pitch`,
            ).toBeLessThan(0.5)
        }
        if (ON_LAND.includes(picture.id)) {
          const sea = seaDatumElevation(body.surface)!
          expect(sea, picture.id).not.toBeNull()
          // The drawn ground under the eye, which is what the stance stands
          // on, over the sea's surface.
          expect(surface!.groundElevation, picture.id).toBeGreaterThan(sea)
        }

        entries.push({
          id: picture.id,
          address: status.target!.address,
          body: bodyDigest(body),
          time: figure(status.time),
          fovDeg: figure(taken.fovDeg),
          focalLength: figure(held.focalLength),
          weather: picture.weather?.regime ?? null,
          altitude: figure(status.altitude),
          sun:
            sun === null
              ? null
              : {
                  elevation: degrees(sun.elevation),
                  azimuth: degrees(sun.azimuth),
                },
          light: (() => {
            const light = session.harness.light()
            return {
              sun: light.sun === null ? null : degrees(light.sun),
              phase: light.phase === null ? null : degrees(light.phase),
            }
          })(),
          surface:
            surface === null
              ? null
              : {
                  latitude: figure(surface.stance.latitude),
                  longitude: figure(surface.stance.longitude),
                  height: figure(surface.stance.height),
                  heading: figure(surface.stance.heading),
                  pitch: figure(surface.stance.pitch),
                  // To the meter, as the pictures' ledger does: the field's
                  // noise rounds differently on another V8.
                  groundElevation: Math.round(surface.groundElevation),
                },
        })
      }
      // Rule 37: nine pictures, and the world's hash is the one it started with.
      expect(session.world.stateHash()).toBe(before)
      await expect(
        `${JSON.stringify({ cornerstones: entries }, null, 2)}\n`,
      ).toMatchFileSnapshot('./cornerstoneLedger.json')
    } finally {
      session.dispose()
    }
  })

  it('stand G1 on the land stance’s rise, 20 m over the sea, on dry ground', () => {
    const session = openSession({ catalog: loadStarCatalog(), workers: null })
    try {
      const picture = CORNERSTONES.find((one) => one.id === 'weather-g1-fair')!
      if (picture.framing.kind !== 'camera' || picture.framing.surface === null)
        throw new Error('G1 is a stance')
      const { latitude, longitude } = picture.framing.surface
      const body = bodyOf(session, picture.address)
      const sea = seaDatumElevation(body.surface)!
      const ground = groundElevation(
        body.surface,
        geodeticDirection(latitude, longitude),
      )
      expect(ground - sea).toBeGreaterThanOrEqual(20)
      // And it stays over the sea for 10 km along G1's heading, so the rise
      // looks across land.
      const heading = picture.framing.surface.heading
      for (let m = 250; m <= 10_000; m += 250) {
        const at = along(latitude, longitude, heading, m, body.radius)
        expect(
          groundElevation(
            body.surface,
            geodeticDirection(at.latitude, at.longitude),
          ),
          `${m} m along`,
        ).toBeGreaterThan(sea)
      }
    } finally {
      session.dispose()
    }
  })

  it('light G3’s deck from below: its base lit by half a degree, and a clear sky where each base’s ray climbs back in', () => {
    const session = openSession({ catalog: loadStarCatalog(), workers: null })
    try {
      const picture = CORNERSTONES.find(
        (one) => one.id === 'weather-g3-underlit-dusk',
      )!
      if (picture.framing.kind !== 'camera' || picture.framing.surface === null)
        throw new Error('G3 is a stance')
      const stance = picture.framing.surface
      const body = bodyOf(session, picture.address)
      const scenario =
        WEATHER_SCENARIOS[picture.weather!.regime as 'dusk-altocumulus']
      const layer = scenario.layers[0]!
      const sun = sunAt(session.world, picture.address, stance, picture.time)
      // The base's own horizon dips acos(R/(R + h)); the sun has to stand
      // over it by half a degree, or a small error in either flips the
      // picture between lit and dark.
      const dip = Math.acos(body.radius / (body.radius + layer.base)) / DEG
      expect(dip - -sun.elevation).toBeGreaterThanOrEqual(0.5)

      // The body-fixed sun at the picture's instant, from the frame graph,
      // and the same sun rebuilt from the stance's elevation and azimuth:
      // the two agree only if the azimuth is east of north as a heading is.
      const parsed = parseAddress(picture.address)
      if (parsed.kind !== 'body') throw new Error('G3 is on a body')
      const up = geodeticDirection(stance.latitude, stance.longitude)
      const toSun = sunDirection(
        session.world,
        parsed.system,
        bodyFixedFrameId(parsed),
        picture.time,
      )
      const rebuilt = fromCompass(stance, sun)
      for (const axis of ['x', 'y', 'z'] as const)
        expect(rebuilt[axis]).toBeCloseTo(toSun[axis], 9)
      const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
      const cover = (direction: Vec3): number =>
        scenarioCoverage(scenario, 0, direction, picture.time, toSun)
      // The deck stands over the eye.
      expect(cover(up)).toBeCloseTo(layer.coverage, 9)
      /*
       * Walk sunward from the stance a base at a time. Under the full deck
       * each base's ray to the sun dips under the layer and climbs back
       * into it where the local sun stands as far up as it is down here;
       * that point has to be clear, or the base is in the deck's own shadow.
       */
      const radius = body.radius + layer.base
      let full = 0
      for (let km = 0; km <= 400; km += 10) {
        const at = along(
          stance.latitude,
          stance.longitude,
          sun.azimuth * DEG,
          km * 1000,
          body.radius,
        )
        const base = geodeticDirection(at.latitude, at.longitude)
        if (cover(base) < layer.coverage - 1e-9) break
        full = km
        const p = vec3(base.x * radius, base.y * radius, base.z * radius)
        const t = -2 * dot(p, toSun)
        expect(t, `${km} km sunward`).toBeGreaterThan(0)
        const back = vec3(
          p.x + t * toSun.x,
          p.y + t * toSun.y,
          p.z + t * toSun.z,
        )
        expect(cover(back), `${km} km sunward`).toBe(0)
      }
      // The full deck reaches sunward past the eye's own field.
      expect(full).toBeGreaterThanOrEqual(100)
    } finally {
      session.dispose()
    }
  })
})

/** Hold one picture's sun to its rule, with `at(time)` to read neighbors. */
function holdSun(
  picture: Picture,
  rule: SunRule,
  sun: { elevation: number },
  at: (time: number) => { elevation: number },
): void {
  if (rule.elevation === 'noon') {
    // The day's highest sun: ten minutes either side it stands lower.
    for (const offset of [-600, 600])
      expect(at(picture.time + offset).elevation, picture.id).toBeLessThan(
        sun.elevation,
      )
    return
  }
  expect(Math.abs(sun.elevation - rule.elevation), picture.id).toBeLessThan(0.5)
  const later = at(picture.time + 60).elevation
  expect(later > sun.elevation, `${picture.id}: trend`).toBe(
    rule.trend === 'rising',
  )
}

/** A unit direction from its elevation and azimuth over a place, degrees. */
function fromCompass(
  place: { latitude: number; longitude: number },
  sun: { elevation: number; azimuth: number },
): Vec3 {
  const e = sun.elevation * DEG
  const a = sun.azimuth * DEG
  const { latitude: phi, longitude: lambda } = place
  const up = geodeticDirection(phi, lambda)
  const east = vec3(-Math.sin(lambda), 0, -Math.cos(lambda))
  const north = vec3(
    -Math.sin(phi) * Math.cos(lambda),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(lambda),
  )
  const c = Math.cos(e)
  return vec3(
    up.x * Math.sin(e) + c * (north.x * Math.cos(a) + east.x * Math.sin(a)),
    up.y * Math.sin(e) + c * (north.y * Math.cos(a) + east.y * Math.sin(a)),
    up.z * Math.sin(e) + c * (north.z * Math.cos(a) + east.z * Math.sin(a)),
  )
}
