import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CORNERSTONES,
  openSession,
  clockStart,
  type Picture,
  solveStationSun,
  stationSubPoint,
  sunAt,
  sunDirection,
  sunOver,
} from '@inertialref/devtools'
import { formatSeed } from '@inertialref/procedural'
import { deg } from '@inertialref/shared'
import {
  airHeights,
  airTopRatio,
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeTransmittance,
  CLOUD_ADVECTION_PERIOD,
  cloudExtents,
  DEFAULT_SENSOR_SETTINGS,
  type Lens,
  LENS_PRESETS,
  scenarioCoverage,
  starColor,
  verticalFovDegrees,
  WEATHER_SCENARIOS,
  whiteBalance,
  zenithSkyRadiance,
} from '@inertialref/rendering'
import { Quaternion as Q, UV, type Vec3, vec3 } from '@inertialref/spatial'
import {
  type Body,
  bodyFixedFrameId,
  compassBasis,
  drawnDivergence,
  drawnGroundElevation,
  elevationAt,
  findBody,
  geodeticDirection,
  groundElevation,
  parseAddress,
  seaDatumElevation,
} from '@inertialref/universe'
import { loadStarCatalog } from './catalog.ts'

/*
 * The cornerstones' ledger: what each of the ten pictures the weather is
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
 *   layer, and the deck's edge stands low in the frame over a clear slot;
 * - G2's sea is deep enough to draw as sea across its whole frame.
 *
 * And what the capture's checks need of the poses (phase 1 design §3.8):
 *
 * - the overlay guard stands at the station's own place, over E1's sun, with
 *   cloud behind the station and the station a quarter of the frame;
 * - the zoom from G6's start crosses the handover's band only at some
 *   footprints, and the snapshot says which;
 * - G5's path is recorded against C6 on the coverage the CPU holds.
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
  // The guard stands on no surface: its sun is over the station's sub-point,
  // held by its own test against the instant solved there.
  'weather-guard-station': null,
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

/** The body a picture's weather stands on: its own, or a station's parent. */
function bodyUnder(
  session: ReturnType<typeof openSession>,
  address: string,
): Body {
  const parsed = parseAddress(
    address.startsWith('g:') ? address : `g:milky-way/${address}`,
  )
  return bodyOf(
    session,
    parsed.kind === 'satellite'
      ? stationSubPoint(session.world, address).body
      : address,
  )
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
        const body = bodyUnder(session, picture.address)
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
      // Rule 37: ten pictures, and the world's hash is the one it started with.
      expect(session.world.stateHash()).toBe(before)
      const guard = solveGuard(session)
      await expect(
        `${JSON.stringify(
          {
            cornerstones: entries,
            guard: {
              subPoint: {
                latitude: degrees(guard.solved.place.latitude / DEG),
                longitude: degrees(guard.solved.place.longitude / DEG),
              },
              sun: {
                elevation: degrees(guard.solved.elevation),
                azimuth: degrees(guard.solved.azimuth),
              },
              crossings: guard.crossings,
              behind: figure(guard.behind),
            },
            zoom: zoomFootprints(session),
            g5: g5Path(session),
          },
          null,
          2,
        )}\n`,
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

  it('face G2 on a sea deeper than the drawn ground’s tail, across its frame, from 250 m out', () => {
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
       * The sea sheet is drawn at the datum over the seabed the mesh is
       * built from, `drawnGroundElevation`, and the drawn ground sits up to
       * `drawnDivergence` (§1.13 m here, the tail `micro.ts` bounds) from
       * the canonical one. Water shallower than that tail draws as sand
       * flats: G2 at S stood over 0.1 to 0.9 m of sea for 2 km. The seabed
       * is the drawn one on purpose (rule 53): it is what the picture shows.
       */
      const deepest = drawnDivergence(body.surface) + G2_DEPTH.margin
      const half = horizontalHalfField(picture)
      for (let side = -8; side <= 8; side += 1) {
        const bearing = heading + (side / 8) * half
        for (const m of G2_DEPTH.distances) {
          const at = along(latitude, longitude, bearing, m, body.radius)
          const depth =
            sea -
            drawnGroundElevation(
              body.surface,
              geodeticDirection(at.latitude, at.longitude),
            )
          expect(
            depth,
            `${m} m out at ${((side / 8) * half) / DEG}° off the heading`,
          ).toBeGreaterThanOrEqual(deepest)
        }
      }
    } finally {
      session.dispose()
    }
  })

  it('stand the overlay guard at the station, over E1’s sun with cloud behind it, the station a quarter of the frame', () => {
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
      const guard = solveGuard(session)
      const e1 = CORNERSTONES.find(
        (one) => one.id === 'weather-e1-cumulus-orbit',
      )!
      // E1's sun at the sub-point: 50° and falling, as E1's own is held.
      holdSun(
        guard.picture,
        RULES['weather-e1-cumulus-orbit']!,
        guard.solved,
        (time) => sunOver(guard.sub.sun(time), guard.sub.place(time)),
      )
      expect(guard.behind).toBeGreaterThanOrEqual(GUARD.cover)
      // The committed guard is the solved one, to the bit: its instant and
      // its basis are the solver's, not a copy that can drift from it.
      expect(CORNERSTONES.find((one) => one.id === GUARD.id)).toEqual(
        guard.picture,
      )
      // E1's lens, processing and weather; only the place and instant move.
      expect(guard.picture.lens).toEqual(e1.lens)
      expect(guard.picture.processing).toEqual(e1.processing)
      expect(guard.picture.weather).toEqual(e1.weather)

      // The observatory holds the pose: taken whole, the camera stands where
      // the framing puts it and looks down at E1's pitch.
      const taken = session.harness.takePicture(guard.picture)
      expect(taken.status.target?.kind).toBe('station')
      expect(taken.status.surface).toBeNull()
      expect(taken.fovDeg).toBeCloseTo(verticalFovDegrees(lensOf(e1)), 9)
      // The station's bounding sphere wholly in frame, between a twentieth
      // and a third of its height (phase 1 design §3.8).
      expect(taken.status.fill).toBeGreaterThanOrEqual(1 / 20)
      expect(taken.status.fill).toBeLessThanOrEqual(1 / 3)
      const pose = session.harness.observatory.pose()!
      const station = session.world.frames.pose(
        taken.status.target!.frame,
        guard.picture.time,
      )
      const offset = UV.difference(pose.position, station.position)
      expect(Math.hypot(offset.x, offset.y, offset.z)).toBeCloseTo(
        GUARD.distance,
        3,
      )
      // Forward is the camera's −Z; its pitch against the sub-point's up is
      // E1's −88°, to the stance's own rounding.
      const forward = Q.rotate(pose.orientation, vec3(0, 0, -1))
      const up = Q.rotate(guard.bodyOrientation, guard.up)
      const pitch =
        Math.asin(forward.x * up.x + forward.y * up.y + forward.z * up.z) / DEG
      expect(
        Math.abs(
          pitch -
            (e1.framing as { surface: { pitch: number } }).surface.pitch / DEG,
        ),
      ).toBeLessThan(0.05)
    } finally {
      session.dispose()
    }
  })

  it('run E1’s clock from the start C7 is solved at, across a reduction, until it is paused', () => {
    const session = openSession({ catalog: loadStarCatalog(), workers: null })
    try {
      const e1 = CORNERSTONES.find(
        (one) => one.id === 'weather-e1-cumulus-orbit',
      )!
      session.harness.preset(e1.id)
      // 300 frames at 100×: five presented seconds at 60 Hz, 500 simulated,
      // with the drift's reduction at the middle.
      const { start, reduction } = clockStart(e1.time, 100, 300)
      expect(reduction % CLOUD_ADVECTION_PERIOD).toBe(0)
      expect(reduction - start).toBeCloseTo(250, 9)
      expect(reduction).toBeGreaterThanOrEqual(e1.time)
      expect(session.harness.runClock(start, 100)).toEqual({ start, warp: 100 })
      const observatory = session.harness.observatory
      expect(observatory.time).toBe(start)
      expect(observatory.timeScale).toBe(100)
      expect(observatory.timePaused).toBe(false)
      // A presented second is a hundred simulated ones.
      observatory.advanceTime(1)
      expect(observatory.time).toBeCloseTo(start + 100, 6)
      observatory.setTimePaused(true)
      observatory.advanceTime(1)
      expect(observatory.time).toBeCloseTo(start + 100, 6)
    } finally {
      session.dispose()
    }
  })

  it('cross the handover’s band in the zoom from G6’s start only at footprints the snapshot names', () => {
    const session = openSession({ catalog: loadStarCatalog(), workers: null })
    try {
      const zoom = zoomFootprints(session)
      // The landed footprint serves the cast; the 200 m one sees the same
      // side of the band at both ends (the council's reading of C1).
      expect(zoom.serves.from).toBeLessThanOrEqual(800)
      expect(zoom.serves.to).toBeGreaterThanOrEqual(800)
      expect(zoom.serves.from).toBeGreaterThan(200)
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

/** The rubric's rig (§3.2 there): 1440 × 900 CSS pixels at DPR 2. */
const RIG = { width: 1440, height: 900, dpr: 2 } as const

/** A picture's lens, with its focus resolved as the host resolves it. */
const lensOf = (picture: Picture): Lens => ({
  ...picture.lens!,
  focus: picture.lens!.focus ?? Infinity,
})

/** Half the horizontal field of a picture's lens on the rig's frame, radians. */
function horizontalHalfField(picture: Picture): number {
  const vertical = (verticalFovDegrees(lensOf(picture)) * DEG) / 2
  return Math.atan((RIG.width / RIG.height) * Math.tan(vertical))
}

/**
 * G2's depth clause: deeper than the drawn ground's tail by a meter, from
 * 250 m out to 30 km. The margin and the distance are chosen to fail G2 at S,
 * whose sea is 0.04 to 0.9 m deep from 50 m to 2 km along its heading, and
 * to hold at a shore whose sea a viewer reads as open water past the surf.
 */
const G2_DEPTH = {
  margin: 1,
  distances: [
    250, 400, 600, 1000, 1500, 2000, 3000, 5000, 8000, 12_000, 20_000, 30_000,
  ],
} as const

/*
 * The overlay guard (phase 1 design §3.8, rubric §2): E1's picture with the
 * station in it, from the station's own place.
 *
 * - **2.5 km off, not the design's 1 km.** The ledger holds the station's
 *   65.3 m sphere between a twentieth and a third of the frame, and through
 *   E1's 11.4° lens at 1 km it fills 0.65 of it; at 2.5 km it fills 0.26.
 * - **2° off the station's vertical, toward the south,** so the camera looks
 *   down and north at E1's pitch of −88°: the orbit camera's elevation is
 *   clamped off its pole, and a basis turns the pose onto the sub-point.
 * - **It is in `cornerstones.json` as the solver writes it,** and its test
 *   holds the committed picture equal to the solved one.
 * - **The instant is the first crossing of E1's sun whose ground behind the
 *   station holds cloud**, at a blob's half height or over: the ground the
 *   camera's line meets past the station, 14 km north of the sub-point. The
 *   first two crossings stand over a blob's rim (cover 0.07 and 0.24) and
 *   the third over a core; mvp.md §2 lets a guard's instant be chosen for
 *   its cloud as a cornerstone's place is.
 */
const GUARD = {
  id: 'weather-guard-station',
  station: 's:SOL/b:2/a:0',
  distance: 2_500,
  tilt: 2,
  cover: 0.5,
  crossings: 12,
} as const

function solveGuard(session: ReturnType<typeof openSession>) {
  const e1 = CORNERSTONES.find((one) => one.id === 'weather-e1-cumulus-orbit')!
  const sub = stationSubPoint(session.world, GUARD.station)
  const scenario = WEATHER_SCENARIOS[e1.weather!.regime as 'fair-cumulus']
  const body = bodyOf(session, sub.body)
  const crossings: { time: number; behind: number }[] = []
  let after = 0
  for (let n = 0; n < GUARD.crossings; n += 1) {
    const solved = solveStationSun(session.world, GUARD.station, {
      elevation: 50,
      trend: 'falling',
      after,
    })
    if (solved === null) break
    // The station in the body's axes, and the compass at its sub-point.
    const { up, north } = compassBasis(
      solved.place.latitude,
      solved.place.longitude,
      0,
    )
    const tilt = GUARD.tilt * DEG
    const toCamera = vec3(
      up.x * Math.cos(tilt) - north.x * Math.sin(tilt),
      up.y * Math.cos(tilt) - north.y * Math.sin(tilt),
      up.z * Math.cos(tilt) - north.z * Math.sin(tilt),
    )
    const screenUp = vec3(
      north.x * Math.cos(tilt) + up.x * Math.sin(tilt),
      north.y * Math.cos(tilt) + up.y * Math.sin(tilt),
      north.z * Math.cos(tilt) + up.z * Math.sin(tilt),
    )
    const bodyPose = session.world.frames.pose(sub.bodyFrame, solved.time)
    const stationPose = session.world.frames.pose(sub.frame, solved.time)
    const local = Q.rotateInverse(
      bodyPose.orientation,
      UV.difference(stationPose.position, bodyPose.position),
    )
    // The ground behind the station along the camera's line, on the sphere.
    const look = vec3(-toCamera.x, -toCamera.y, -toCamera.z)
    const b = local.x * look.x + local.y * look.y + local.z * look.z
    const c =
      local.x * local.x +
      local.y * local.y +
      local.z * local.z -
      body.radius * body.radius
    const t = -b - Math.sqrt(b * b - c)
    const ground = vec3(
      local.x + t * look.x,
      local.y + t * look.y,
      local.z + t * look.z,
    )
    const behind = scenarioCoverage(
      scenario,
      0,
      ground,
      solved.time,
      sub.sun(solved.time),
    )
    crossings.push({ time: figure(solved.time), behind: figure(behind) })
    if (behind >= GUARD.cover) {
      const world = (v: Vec3): Vec3 => Q.rotate(bodyPose.orientation, v)
      const x = world(toCamera)
      const y = world(screenUp)
      const z = vec3(
        x.y * y.z - x.z * y.y,
        x.z * y.x - x.x * y.z,
        x.x * y.y - x.y * y.x,
      )
      const picture: Picture = {
        ...e1,
        id: GUARD.id,
        label: 'The overlay guard',
        why: 'E1’s picture with the station in it: the composite’s hardest frame, a hull’s silhouette over the cloud field.',
        time: solved.time,
        address: GUARD.station,
        framing: {
          kind: 'camera',
          basis: Q.fromBasis(x, y, z),
          state: { azimuth: 0, elevation: 0, distance: GUARD.distance },
          look: { yaw: 0, pitch: 0 },
          surface: null,
        },
      }
      return {
        picture,
        solved,
        sub,
        behind,
        crossings,
        up,
        bodyOrientation: bodyPose.orientation,
      }
    }
    after = solved.time + 60
  }
  throw new Error(
    `no crossing of E1's sun in ${GUARD.crossings} has cloud behind the station: ${JSON.stringify(crossings)}`,
  )
}

/*
 * C1's zoom (rubric §4, its first amendment): from G6's start, 400 km up, at
 * pitch −45°, 60° to 11.4° in 300 frames. It counts only where frames of it
 * stand on both sides of the handover's band, and that depends on the
 * footprint: the band runs from `farFootprint / pixelAngle` to `band` times
 * that (phase 1 design §5.8), with `pixelAngle` a trace texel's vertical
 * angle at the rig. So the cast's first frame must hold every ray that meets
 * the deck past the band's far edge, its last every such ray inside the
 * band's near edge, and the snapshot names the footprints for which both are
 * true. `band` is the design's 2: the lever lands with the band's package.
 */
const ZOOM = { pitch: -45, from: 60, to: 11.4, band: 2, grid: 9 } as const

function zoomFootprints(session: ReturnType<typeof openSession>) {
  const picture = CORNERSTONES.find((one) => one.id === 'weather-g6-descent')!
  if (picture.framing.kind !== 'camera' || picture.framing.surface === null)
    throw new Error('G6 is a stance')
  const stance = picture.framing.surface
  const body = bodyOf(session, picture.address)
  const deck =
    WEATHER_SCENARIOS[picture.weather!.regime as 'stratocumulus'].layers[0]!
  const { up, east, north } = compassBasis(stance.latitude, stance.longitude, 0)
  const ground = groundElevation(
    body.surface,
    geodeticDirection(stance.latitude, stance.longitude),
  )
  const eye = body.radius + ground + stance.height
  const top = body.radius + deck.top
  const trace = cloudExtents(
    { width: RIG.width * RIG.dpr, height: RIG.height * RIG.dpr },
    { width: RIG.width, height: RIG.height },
  ).trace
  /** Every ray of the frame that meets the deck's top: its nearest and farthest. */
  const span = (fov: number): { near: number; far: number } => {
    const p = ZOOM.pitch * DEG
    const h = stance.heading
    const level = vec3(
      Math.cos(h) * north.x + Math.sin(h) * east.x,
      Math.cos(h) * north.y + Math.sin(h) * east.y,
      Math.cos(h) * north.z + Math.sin(h) * east.z,
    )
    const forward = vec3(
      Math.cos(p) * level.x + Math.sin(p) * up.x,
      Math.cos(p) * level.y + Math.sin(p) * up.y,
      Math.cos(p) * level.z + Math.sin(p) * up.z,
    )
    const right = vec3(
      level.y * up.z - level.z * up.y,
      level.z * up.x - level.x * up.z,
      level.x * up.y - level.y * up.x,
    )
    const camUp = vec3(
      right.y * forward.z - right.z * forward.y,
      right.z * forward.x - right.x * forward.z,
      right.x * forward.y - right.y * forward.x,
    )
    const tanV = Math.tan((fov * DEG) / 2)
    const tanH = (RIG.width / RIG.height) * tanV
    let near = Infinity
    let far = 0
    for (let i = 0; i < ZOOM.grid; i += 1)
      for (let j = 0; j < ZOOM.grid; j += 1) {
        const x = ((2 * i) / (ZOOM.grid - 1) - 1) * tanH
        const y = ((2 * j) / (ZOOM.grid - 1) - 1) * tanV
        const d = vec3(
          forward.x + x * right.x + y * camUp.x,
          forward.y + x * right.y + y * camUp.y,
          forward.z + x * right.z + y * camUp.z,
        )
        const n = Math.hypot(d.x, d.y, d.z)
        // From the eye at `up·eye`: |eye·up + t·d̂|² = top².
        const b = (eye * (up.x * d.x + up.y * d.y + up.z * d.z)) / n
        const disc = b * b - (eye * eye - top * top)
        if (disc < 0) continue
        const t = -b - Math.sqrt(disc)
        if (t <= 0) continue
        near = Math.min(near, t)
        far = Math.max(far, t)
      }
    return { near, far }
  }
  const pixelAngle = (fov: number): number => (fov * DEG) / trace.height
  const first = span(ZOOM.from)
  const last = span(ZOOM.to)
  return {
    trace: [trace.width, trace.height],
    band: ZOOM.band,
    first: { near: Math.round(first.near), far: Math.round(first.far) },
    last: { near: Math.round(last.near), far: Math.round(last.far) },
    // Footprints, meters, for which the first frame is wholly past the band
    // and the last wholly inside it.
    serves: {
      from: Math.ceil(last.far * pixelAngle(ZOOM.to)),
      to: Math.floor((first.near * pixelAngle(ZOOM.from)) / ZOOM.band),
    },
  }
}

/*
 * G5's cast against C6 (rubric §4, phase 1 design §8.5): 1,600 frames at
 * 2.5 m a frame along G5's heading, the range ahead over 2 km at the first
 * frame and the last, and a cloud between. The CPU holds the coverage the
 * maps bake and no finer field: the fine medium's 1.2 km cells are the
 * GPU's alone. So this records what the coverage says along the path, the
 * cover at the eye and the clear distance ahead at each end, and asserts
 * nothing of C6: on the placeholder's 96 km blob cells G5's stance at L
 * stands in a blob's core, and no 4 km path from there runs clear, through a
 * cloud and clear again. The cast is defined in `scripts/weather/descent.mjs`.
 */
const G5_PATH = {
  frames: 1600,
  metersAFrame: 2.5,
  ahead: 3000,
  step: 25,
} as const

function g5Path(session: ReturnType<typeof openSession>) {
  const picture = CORNERSTONES.find((one) => one.id === 'weather-g5-inside')!
  if (picture.framing.kind !== 'camera' || picture.framing.surface === null)
    throw new Error('G5 is a stance')
  const { latitude, longitude, heading } = picture.framing.surface
  const body = bodyOf(session, picture.address)
  const scenario = WEATHER_SCENARIOS[picture.weather!.regime as 'fair-cumulus']
  const cover = (m: number): number => {
    const at = along(latitude, longitude, heading, m, body.radius)
    return scenarioCoverage(
      scenario,
      0,
      geodeticDirection(at.latitude, at.longitude),
      picture.time,
    )
  }
  /** Meters from frame k's eye to the first point ahead with any cover. */
  const clear = (k: number): number | null => {
    const from = k * G5_PATH.metersAFrame
    for (let m = 0; m <= G5_PATH.ahead; m += G5_PATH.step)
      if (cover(from + m) > 0) return m
    return null
  }
  let least = Infinity
  let most = 0
  for (let k = 0; k < G5_PATH.frames; k += 10) {
    const c = cover(k * G5_PATH.metersAFrame)
    least = Math.min(least, c)
    most = Math.max(most, c)
  }
  const first = clear(0)
  const last = clear(G5_PATH.frames - 1)
  const holds = (m: number | null): boolean => m === null || m >= 2000
  return {
    frames: G5_PATH.frames,
    metersAFrame: G5_PATH.metersAFrame,
    coverAtEye: { least: figure(least), most: figure(most) },
    clearAhead: { first, last, within: G5_PATH.ahead },
    c6: holds(first) && holds(last) && most > 0,
  }
}
