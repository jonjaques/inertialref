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
import { deg } from '@inertialref/shared'
import {
  airHeights,
  airTopRatio,
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeTransmittance,
  DEFAULT_SENSOR_SETTINGS,
  type Lens,
  LENS_PRESETS,
  scenarioCoverage,
  starColor,
  WEATHER_SCENARIOS,
  whiteBalance,
  zenithSkyRadiance,
} from '@inertialref/rendering'
import { type Vec3, vec3 } from '@inertialref/spatial'
import {
  type Body,
  bodyFixedFrameId,
  elevationAt,
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
 * It also holds what the generated world's pictures need of the world:
 *
 * - its sky, as the camera draws it, is blue: the star's color at the
 *   camera's balance and the air's zenith under it, not the air alone;
 * - its sea stands within 250 m of the datum the regimes' heights are over;
 * - G1, G3, G5 and G6's last frame stand on land, not open water, G1's rise
 *   is the land stance's 20 m over the sea on dry ground, and G2 faces open
 *   sea;
 * - G4 and G5 stand at the design's heights over the datum, which is what
 *   puts G4 3 km over its deck and G5 inside its cumulus;
 * - G3's deck can be lit from below at all: the layer's base is lit by at
 *   least half a degree, every base under the full deck sunward of the
 *   stance has a clear sky where its ray to the sun climbs back into the
 *   layer, and the deck's edge stands low in the frame over a clear slot.
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
              latitude: deg(stance.latitude / DEG),
              longitude: deg(stance.longitude / DEG),
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
      // Dry: no water stands there. Over the sea is not enough on a body
      // whose drainage puts lakes over the sea's level.
      expect(
        ground -
          elevationAt(body.surface, geodeticDirection(latitude, longitude)),
      ).toBeLessThan(0.01)
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
      expect(full).toBeGreaterThan(0)
      /*
       * The deck fills the frame's sky and ends low in it, over a clear
       * slot: its last full base, seen from the eye, stands between half a
       * degree and 3.5° over the horizontal. A distance cannot say this on
       * every world: the same edge 100 km out stands 1.2° up on a world of
       * Earth's radius and 1.75° up on one of 3,900 km, where the
       * curvature takes more of it.
       */
      let edge = 0
      for (let m = 0; m <= 400_000; m += 500) {
        const at = along(
          stance.latitude,
          stance.longitude,
          sun.azimuth * DEG,
          m,
          body.radius,
        )
        if (
          cover(geodeticDirection(at.latitude, at.longitude)) <
          layer.coverage - 1e-9
        )
          break
        edge = m
      }
      const eye =
        body.radius + groundElevation(body.surface, up) + stance.height
      const angle = edge / body.radius
      const elevation =
        Math.atan2(radius * Math.cos(angle) - eye, radius * Math.sin(angle)) /
        DEG
      expect(elevation, 'the edge over the horizontal').toBeGreaterThanOrEqual(
        0.5,
      )
      expect(elevation, 'the edge over the horizontal').toBeLessThanOrEqual(3.5)
    } finally {
      session.dispose()
    }
  })

  it('stand on a world whose sky, as the camera draws it, is blue', () => {
    const session = openSession({ catalog: loadStarCatalog(), workers: null })
    try {
      const picture = CORNERSTONES.find((one) => one.id === 'weather-g1-fair')!
      const parsed = parseAddress(picture.address)
      if (parsed.kind !== 'body') throw new Error('G1 is on a body')
      const star = session.world.loadSystem(parsed.system).star
      const body = bodyOf(session, picture.address)
      /*
       * The camera draws the star's light at its balance. The air's own
       * radiance is per unit of a white sun, so the air alone says nothing
       * about the picture's color: P222_1_0_7's zenith is blue-dominant at
       * 0.092 : 0.123 : 0.169, and under its 2,346 K star (1 : 0.36 : 0.06
       * at 5,800 K) every one of its cornerstones came out orange to brown.
       * The design's rule is the sky from 5° to 29° at both ground suns;
       * these are the two parts of it the library can say without marching
       * a ray: the key light is near white, and the zenith it lights is blue.
       */
      const balance = whiteBalance(
        picture.processing?.balance ?? DEFAULT_SENSOR_SETTINGS.balance,
      )
      const color = starColor(star.temperature)
      const key = [
        color.r * balance[0],
        color.g * balance[1],
        color.b * balance[2],
      ] as const
      expect(
        key[2] / key[0],
        'the key light at the balance',
      ).toBeGreaterThanOrEqual(0.85)
      const haze = body.appearance.haze!
      const recipe = atmosphereRecipe(
        haze,
        airTopRatio(body.radius, haze.height),
        airHeights(
          body.radius,
          haze.height,
          body.atmosphere?.scaleHeight ?? 0,
          haze.aerosolHeight,
        ),
      )
      const zenith = zenithSkyRadiance(
        recipe,
        bakeMultipleScattering(recipe, bakeTransmittance(recipe)),
        1,
        Math.sin(60 * DEG),
      )
      expect(
        (zenith[2] * key[2]) / (zenith[0] * key[0]),
        'the zenith under a 60° sun, as drawn',
      ).toBeGreaterThanOrEqual(1.5)
    } finally {
      session.dispose()
    }
  })

  it('stand the generated world’s sea within 250 m of the datum the regimes’ heights are over', () => {
    const session = openSession({ catalog: loadStarCatalog(), workers: null })
    try {
      const picture = CORNERSTONES.find((one) => one.id === 'weather-g1-fair')!
      const sea = seaDatumElevation(bodyOf(session, picture.address).surface)
      expect(sea).not.toBeNull()
      // A layer's base is over the datum and a photograph's over the sea; a
      // quarter of the lowest regime's kilometer keeps the two one height.
      expect(Math.abs(sea!)).toBeLessThanOrEqual(250)
    } finally {
      session.dispose()
    }
  })

  it('face G2 on open sea to 30 km', () => {
    const session = openSession({ catalog: loadStarCatalog(), workers: null })
    try {
      const picture = CORNERSTONES.find(
        (one) => one.id === 'weather-g2-overcast-shore',
      )!
      if (picture.framing.kind !== 'camera' || picture.framing.surface === null)
        throw new Error('G2 is a stance')
      const { latitude, longitude, heading } = picture.framing.surface
      const body = bodyOf(session, picture.address)
      const sea = seaDatumElevation(body.surface)!
      /*
       * Standing water at the sea's own level at every sample. The `shore`
       * site is scored on the unclamped land nearest the sea's datum, and
       * on a body with a drainage graph the sea stands only where it
       * reaches, so the site can face a dry flat under the sea's level, a
       * lagoon or an islet.
       */
      for (const km of [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 16, 20, 30]) {
        const at = along(latitude, longitude, heading, km * 1000, body.radius)
        const direction = geodeticDirection(at.latitude, at.longitude)
        const ground = groundElevation(body.surface, direction)
        expect(
          ground - elevationAt(body.surface, direction),
          `${km} km out: water stands`,
        ).toBeGreaterThan(0.01)
        expect(Math.abs(ground - sea), `${km} km out: the sea`).toBeLessThan(
          0.5,
        )
      }
    } finally {
      session.dispose()
    }
  })

  it('stand G4 3 km over its deck and G5 inside its cumulus, over the datum the layers are over', () => {
    const session = openSession({ catalog: loadStarCatalog(), workers: null })
    try {
      const overDatum = (id: string): number => {
        const picture = CORNERSTONES.find((one) => one.id === id)!
        if (
          picture.framing.kind !== 'camera' ||
          picture.framing.surface === null
        )
          throw new Error(`${id} is a stance`)
        const { latitude, longitude, height } = picture.framing.surface
        const body = bodyOf(session, picture.address)
        return (
          height +
          groundElevation(body.surface, geodeticDirection(latitude, longitude))
        )
      }
      const deck = WEATHER_SCENARIOS.stratocumulus.layers[0]!
      const cumulus = WEATHER_SCENARIOS['fair-cumulus'].layers[0]!
      // Stance heights are over the ground beneath and a layer's over the
      // datum; the meter is the stance's rounding against the drawn ground.
      expect(
        Math.abs(overDatum('weather-g4-over-deck') - (deck.top + 3000)),
      ).toBeLessThan(1)
      expect(
        Math.abs(
          overDatum('weather-g5-inside') - (cumulus.base + cumulus.top) / 2,
        ),
      ).toBeLessThan(1)
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
