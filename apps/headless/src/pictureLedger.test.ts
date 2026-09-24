import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  openSession,
  PICTURES,
  PLATE_HEIGHT,
  PLATE_WIDTH,
  type Picture,
} from '@inertialref/devtools'
import { formatSeed } from '@inertialref/procedural'
import {
  type Lens,
  LENS_PRESETS,
  selectTerrain,
  type Viewport,
} from '@inertialref/rendering'
import {
  type Body,
  findBody,
  geodeticDirection,
  parseAddress,
  surfaceDetailFloor,
} from '@inertialref/universe'
import { loadStarCatalog } from './catalog.ts'

/*
 * The ledger: what every shipped picture asks of the world, in numbers.
 *
 * A preset is the one fixture this repository can reproduce exactly — an
 * address, a framing, a lens and a held instant — and `pnpm presets:compare`
 * photographs the thirteen through the renderer to say whether a change moved
 * a frame. That needs a GPU. This is the half that does not: the same thirteen
 * taken headlessly against the real catalog, and everything the camera decided
 * written to `pictureLedger.json` beside this file. Where the camera stands,
 * how far, at what angle and altitude; the lens it composed through; the body
 * it resolved, digested; and for a stance on the ground, the terrain the plate
 * would ask the streamer for at the plate's own pixels.
 *
 * The file is a snapshot, so a change that moves any of it fails here with a
 * diff that names the picture and the number, in `pnpm test`, in the Stop
 * gate and in CI. A deliberate move is `pnpm presets:ledger`, which rewrites
 * the file, and the rewritten lines in the pull request are the claim under
 * review — the same arrangement the plates have, without the browser.
 *
 * Five of the thirteen stand on generated bodies outside Sol, which is where
 * the procedural terrain, the projected record and the detail floor live, and
 * where a change to any of them shows up here before a plate is taken.
 *
 * Ten significant digits, because the numbers are compared as text. An orbit
 * distance at 1e10 m is then held to the meter and an angle to 1e-10 rad,
 * which is below anything a plate could show and above the last bits, where
 * a different Node's `Math.sin` is allowed to disagree.
 */

const PLATE: Viewport = { width: PLATE_WIDTH, height: PLATE_HEIGHT }

const figure = (value: number): number => Number(value.toPrecision(10))

/**
 * An angle of light to a thousandth of a degree, not ten digits.
 *
 * The phase is an arccosine, and at a silhouette the cosine sits within a few
 * ulps of −1, where one ulp is 1e-7 of a degree: `solar-crescent` reads
 * 179.9999991, which is one bit away from 180. Ten digits would fail the
 * ledger on a reordered sum in the ephemeris that no plate could show. The
 * verdict these feed is three degrees wide.
 */
const degrees = (value: number): number => Math.round(value * 1e3) / 1e3

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

/**
 * The facts a body's picture depends on, as one short hash.
 *
 * Hashed rather than written out because a body is a page of numbers and the
 * ledger should be a page of pictures. A change to any of them — a radius, an
 * orbit, the surface grammar the terrain is cut from — moves the digest, and
 * the picture whose digest moved names the body to look at.
 */
function bodyDigest(body: Body): string {
  return digest({
    radius: body.radius,
    polarRadius: body.polarRadius,
    mass: body.mass,
    rotationPeriod: body.rotationPeriod,
    axialTilt: body.axialTilt,
    elements: body.elements,
    atmosphere: body.atmosphere,
    surface: { ...body.surface, seed: formatSeed(body.surface.seed) },
  })
}

interface Entry {
  readonly id: string
  readonly address: string
  readonly body: string | null
  readonly framing: Picture['framing']['kind']
  readonly time: number
  readonly fovDeg: number
  readonly lens: Record<string, number>
  readonly state: { azimuth: number; elevation: number; distance: number }
  readonly look: { yaw: number; pitch: number }
  readonly altitude: number
  readonly fill: number
  readonly tracking: string | null
  /**
   * How lit the picture is: the sun's elevation over a stance, the phase
   * angle from orbit, and the verdict — so a comparison rig can prefer the
   * pictures where a difference is a difference rather than star noise.
   */
  readonly light: { sun: number | null; phase: number | null; lit: boolean }
  readonly surface: {
    latitude: number
    longitude: number
    height: number
    groundElevation: number
    radius: number
  } | null
  readonly terrain: {
    patches: number
    deepest: number
    shallowest: number
    visited: number
    culled: number
  } | null
}

describe('the shipped photographs', () => {
  it('compose the same frame every time, and take nothing from the world', async () => {
    /*
     * The session gets a lens the way a browser does, and it has to: with no
     * render side every picture composes at the flight preset whatever it
     * names, and the `fovDeg` below would be the number echoed out of
     * `PICTURES`. `observatory.test.ts` says why the two lines are the whole
     * host.
     */
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
      const entries: Entry[] = []
      for (const picture of PICTURES) {
        // Every plate is a fresh page, which starts from the flight lens. A
        // recipe solves only the lens geometry and inherits the other
        // channels, so without this a recipe listed after `solar-crescent`
        // would write its zoom of eight into the ledger and no browser would
        // ever photograph it.
        held = LENS_PRESETS.flight
        const taken = session.harness.preset(picture.id)
        const { status } = taken
        expect(status.target?.address, picture.id).toContain(picture.address)
        expect(session.harness.cutsceneStatus(), picture.id).toBeNull()
        expect(taken.fovDeg, picture.id).toBeGreaterThan(0)
        expect(taken.fovDeg, picture.id).toBeLessThanOrEqual(150)

        const parsed = parseAddress(status.target!.address)
        const body =
          parsed.kind === 'body'
            ? findBody(session.world.loadSystem(parsed.system), parsed.body)
            : undefined

        let terrain: Entry['terrain'] = null
        if (status.surface !== null && body !== undefined) {
          const { stance, radius } = status.surface
          const selection = selectTerrain(
            {
              radius: body.radius,
              relief: body.surface.maxElevation,
              distance: radius,
              direction: geodeticDirection(stance.latitude, stance.longitude),
            },
            {
              maxLevel: surfaceDetailFloor(body.surface),
              lens: held,
              viewport: PLATE,
            },
          )
          terrain = {
            patches: selection.patches.length,
            deepest: selection.deepestLevel,
            shallowest: selection.shallowestLevel,
            visited: selection.visited,
            culled: selection.culled,
          }
        }

        entries.push({
          id: picture.id,
          address: status.target!.address,
          body: body === undefined ? null : bodyDigest(body),
          framing: picture.framing.kind,
          time: figure(status.time),
          fovDeg: figure(taken.fovDeg),
          lens: Object.fromEntries(
            Object.entries(held)
              .filter((pair): pair is [string, number] =>
                Number.isFinite(pair[1]),
              )
              .map(([key, value]) => [key, figure(value)]),
          ),
          // The framing the camera arrives at: a composition eases over frames
          // that never run here, so `state` is where the ease started.
          state: {
            azimuth: figure(status.desired.azimuth),
            elevation: figure(status.desired.elevation),
            distance: figure(status.desired.distance),
          },
          look: {
            yaw: figure(status.look.yaw),
            pitch: figure(status.look.pitch),
          },
          altitude: figure(status.altitude),
          fill: figure(status.fill),
          tracking: status.tracking?.address ?? null,
          light: (() => {
            const light = session.harness.light()
            return {
              sun: light.sun === null ? null : degrees(light.sun),
              phase: light.phase === null ? null : degrees(light.phase),
              lit: light.lit,
            }
          })(),
          surface:
            status.surface === null
              ? null
              : {
                  latitude: figure(status.surface.stance.latitude),
                  longitude: figure(status.surface.stance.longitude),
                  height: figure(status.surface.stance.height),
                  /*
                   * To the meter, not ten digits. Both are terrain samples,
                   * and the field's noise runs through transcendental
                   * arithmetic that two V8 builds round differently: the
                   * Linux runner read Alpha Centauri II's ground 0.1 mm from this
                   * machine's and its eye 1 mm further out. A real move is
                   * meters; the meter is three digits above the platform
                   * noise and three below anything the plate can show.
                   */
                  groundElevation: Math.round(status.surface.groundElevation),
                  radius: Math.round(status.surface.radius),
                },
          terrain,
        })
      }
      // Rule 37: the planetarium never writes canonical state. Thirteen
      // pictures, and the world's hash is the one it started with.
      expect(session.world.stateHash()).toBe(before)

      await expect(
        `${JSON.stringify({ viewport: PLATE, pictures: entries }, null, 2)}\n`,
      ).toMatchFileSnapshot('./pictureLedger.json')
    } finally {
      session.dispose()
    }
  })
})
