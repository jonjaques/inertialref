import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Node, Vector3 } from 'three/webgpu'
import {
  abs,
  dot,
  exp,
  float,
  Fn,
  Loop,
  max,
  mix,
  oneMinus,
  saturate,
  select,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'
import { SOLAR_PLANETS } from '@inertialref/universe'
import {
  type AirUniforms,
  clearedBeam,
  createAirUniforms,
  marchAir,
  ORBIT_AIRLIGHT,
  phasesToward,
  psiTableAt,
  stepShare,
  sunTableAt,
} from './air.ts'
import { scatteringFor } from './atmosphereLuts.ts'
import {
  type AirMediumFn,
  airSegment,
  compositeAir,
  SKY_SEGMENT_SAMPLES,
  SURFACE_SEGMENT_SAMPLES,
} from './cloudCompositeAir.ts'
import { CLOUD_DEPTH_CLAMP_KM } from './cloudDepth.ts'
import landed from './cloudCompositeError.landed.json' with { type: 'json' }
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The composite's error on analytic slabs (§8.6): the identity and the thin
 * form against a joint march of air and cloud.
 *
 * **The identity's residual is held to the landed one.**
 * `cloudCompositeError.landed.json` is the instrument's document on the
 * landed code: `choices-2026-11-10T11-49-33Z-compositeError.json` of phase
 * 0's measurements, taken at `51c96da4` on the Mac mini (Mac18,5, Apple
 * M6). A case's identity residual, and the 95th percentile of it over the
 * cases, may each pass the landed value by a tenth and no more. One slab
 * runs in every `pnpm test:gpu`, the 500 m one seen from above at five
 * angles; all sixty cases run under IR_CLOUD_MEASURE=1, which also writes
 * `.data/clouds/compositeError.json`. The bound is this adapter's: it is
 * asserted where the adapter offers timestamps, which is how the suite
 * tells a workstation from CI's hosted device, and there the figures are
 * still taken and held finite.
 *
 * The bounds tighten and are never loosened. A change that moves a figure
 * replaces the landed document in the commit that moves it, so the diff
 * shows the old figure and the new.
 *
 * One body, Earth's recipe. A slab of 5 km⁻¹ from 2 km up, 100 m, 500 m and
 * 2 km thick, seen at five angles: from 10 km down through it to the ground
 * (the surface class, a gray surface of 0.3 behind), and from 500 m up
 * through it to the air's far wall (the sky class, a background of 0.01),
 * each with Enhanced's clearing at 0 and at 1. Per case, against a
 * 512-sample joint march of air and cloud with the surface behind:
 *
 * - `identity` and `thin`: each form's relative error, on the scene as the
 *   scene's own march draws it (four samples for a surface, the shell's
 *   twelve for the sky) and the composite's segments (four or six each);
 * - `exact`: the identity's error with every air march at 512 samples, which
 *   is its algebra alone: none without the clearing, which does not compose
 *   over segments;
 * - `quadrature`: the identity's quadrature residual, the production
 *   identity against the exact one.
 *
 * The trace's outputs are a 512-step march of the same slab here — the
 * cloud's light relative to t₀ through the span's air, its transmittance,
 * the blocked air with the class's beam and the depth moments' mean — so the
 * case measures the composite and nothing of the trace's own schedule. The
 * air's per-sample terms are `marchAir`'s, reproduced as
 * `cloudCompositeAir.gpu.test.ts` reproduces them, apart from
 * `airMediumAt`. Light is per unit sun irradiance throughout: no day color,
 * no π, no gain.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const OUT = '.data/clouds/compositeError.json'
/** The adapter the landed figures were taken on is a workstation's: it offers timestamps. */
const WORKSTATION = await adapterOffers('timestamp-query')
/** A figure may pass its landed value by a tenth (phase 1 design §6.3). */
const SLACK = 1.1
/**
 * The slab every run of the suite takes: seen from above, the beam
 * uncleared. With the span's air left out of the light to the cloud's end,
 * its residual straight down is 0.0042 against a bound of 0.0014.
 */
const ALWAYS = { class: 'surface', cleared: 0, thickness: 500 } as const

const earth = SOLAR_PLANETS.find((body) => body.name === 'Earth')!
const haze = earth.haze!
const R = earth.radius
const TOP = 1 + haze.height / R
const HEIGHTS = {
  rayleigh: earth.atmosphere!.scaleHeight / R,
  aerosol: haze.aerosolHeight / R,
}
const BASE = 2_000
/** m⁻¹. */
const SIGMA = 0.005
const THICKNESSES = [100, 500, 2_000] as const
const ANGLES = [90, 60, 30, 15, 5] as const
/** The cloud's source per unit extinction, per unit sun irradiance. */
const SOURCE = 0.2
const SURFACE = 0.3
const BACKGROUND = 0.01
const JOINT = 512
/** The sun 40° up, 120° round from the view's azimuth. */
const SUN = new Vector3(
  Math.cos((40 * Math.PI) / 180) * Math.cos((120 * Math.PI) / 180),
  Math.sin((40 * Math.PI) / 180),
  Math.cos((40 * Math.PI) / 180) * Math.sin((120 * Math.PI) / 180),
)

const tent = (
  height: Node<'float'>,
  peak: Node<'float'>,
  halfWidth: Node<'float'>,
): Node<'float'> =>
  max(float(1).sub(abs(height.sub(peak)).div(max(halfWidth, 1e-9))), 0)

/** `marchAir`'s per-sample terms, node for node: what `airMediumAt` is specified to be. */
const marchAirTerms: AirMediumFn = (air, height, muSun, phases, sunT, read) => {
  const height01 = saturate(height.div(max(air.top.sub(1), 1e-6)))
  const fade = oneMinus(height01)
  const densityR = exp(height.div(air.hRayleigh).negate()).mul(fade)
  const densityM = exp(height.div(air.hMie).negate()).mul(fade)
  const densityO = tent(height, air.ozonePeak, air.ozoneHalfWidth)
  const densityD = tent(height, air.detachedPeak, air.detachedHalfWidth)
  const scatterD = air.detachedScatter.mul(densityD)
  const extinction = air.betaRayleigh
    .mul(densityR)
    .add(air.mieExtinction.mul(densityM))
    .add(air.ozone.mul(densityO))
    .add(air.detachedExtinction.mul(densityD))
  const psi = psiTableAt(air, muSun, height01, read)
  const scatterToward = mix(air.mieScatter, air.mieForward, phases.forward)
  const single = air.betaRayleigh
    .mul(densityR)
    .add(scatterD)
    .mul(phases.rayleigh)
    .add(scatterToward.mul(densityM).mul(phases.mie))
    .mul(sunT)
  const multiple = psi.mul(
    air.betaRayleigh
      .mul(densityR)
      .add(air.mieScatter.mul(densityM))
      .add(scatterD),
  )
  return { extinction, single, multiple }
}

/** One case, in the air's sea-level units: the ray, its span through the slab, and where it ends. */
interface Case {
  readonly eye: Vector3
  readonly direction: Vector3
  readonly start: number
  readonly end: number
  /** Where the scene's own march stops: the ground, or the air's far wall. */
  readonly stop: number
  readonly base: number
  readonly top: number
}

/** The crossings of a ray from `eye` along `direction` with the sphere of radius `r`. */
function crossings(
  eye: Vector3,
  direction: Vector3,
  r: number,
): [number, number] {
  const b = eye.dot(direction)
  const c = eye.lengthSq() - r * r
  const root = Math.sqrt(Math.max(b * b - c, 0))
  return [-b - root, -b + root]
}

function caseOf(sky: boolean, thickness: number, angle: number): Case {
  const radians = (angle * Math.PI) / 180
  const eye = new Vector3(0, 1 + (sky ? 500 : 10_000) / R, 0)
  const direction = new Vector3(
    Math.cos(radians),
    (sky ? 1 : -1) * Math.sin(radians),
    0,
  )
  const base = 1 + BASE / R
  const top = 1 + (BASE + thickness) / R
  if (sky) {
    // From under the slab: out through its base, then its top, then the air's.
    return {
      eye,
      direction,
      start: crossings(eye, direction, base)[1],
      end: crossings(eye, direction, top)[1],
      stop: crossings(eye, direction, TOP)[1],
      base,
      top,
    }
  }
  // From over the slab: in through its top, out through its base, onto the ground.
  return {
    eye,
    direction,
    start: crossings(eye, direction, top)[0],
    end: crossings(eye, direction, base)[0],
    stop: crossings(eye, direction, 1)[0],
    base,
    top,
  }
}

let gpu: GpuSession
let air: AirUniforms

beforeAll(async () => {
  gpu = await openGpu(1, 1)
  air = createAirUniforms()
  const tables = scatteringFor(haze, TOP, HEIGHTS)
  air.set(tables.recipe, tables.transmittance, tables.multiScatter)
})

afterAll(() => {
  gpu?.dispose()
})

const at = {
  eye: uniform(new Vector3()),
  direction: uniform(new Vector3()),
  start: uniform(0),
  end: uniform(0),
  stop: uniform(0),
  base: uniform(1),
  top: uniform(1),
  cleared: uniform(0),
}
const SUN_NODE = vec3(SUN.x, SUN.y, SUN.z)
const LEVEL = { level: true } as const
const luma = (v: Node<'vec3'>): Node<'float'> =>
  dot(v, vec3(0.2126, 0.7152, 0.0722))

/**
 * The four errors of one case, for one class: a separate program for each,
 * because the class's beam is a choice of the march's arguments.
 */
function errors(sky: boolean): Node<'vec4'> {
  return Fn(() => {
    const { eye, direction, start, end, stop, cleared } = at
    const clearBeam = sky ? null : cleared.mul(ORBIT_AIRLIGHT)
    const behind = vec3(sky ? BACKGROUND : SURFACE)
    const phases = phasesToward(direction, SUN_NODE)

    // The air in front of the slab and behind it, at 512 samples.
    const front = airSegment(
      air,
      eye,
      direction,
      float(0),
      start,
      SUN_NODE,
      JOINT,
      clearBeam,
      marchAirTerms,
    )
    const past = airSegment(
      air,
      eye,
      direction,
      end,
      stop,
      SUN_NODE,
      JOINT,
      clearBeam,
      marchAirTerms,
    )

    // The span, a step at a time: the joint truth, and the trace's outputs.
    const step = end.sub(start).div(JOINT)
    const air0 = front.transmittance.toVar()
    const airSpan = vec3(1).toVar()
    const cloud = float(1).toVar()
    const airLight = vec3(0).toVar()
    const cloudLight = vec3(0).toVar()
    const traced = vec3(0).toVar()
    const blocked = vec3(0).toVar()
    const plainSpan = vec3(0).toVar()
    const weight = float(0).toVar()
    const moment = float(0).toVar()
    Loop(JOINT, ({ i }) => {
      const t = start.add(float(i).add(0.5).mul(step))
      const point = eye.add(direction.mul(t))
      const radius = point.length()
      const height = max(radius.sub(1), 0)
      const height01 = saturate(height.div(max(air.top.sub(1), 1e-6)))
      const muSun = dot(point, SUN_NODE).div(max(radius, 1e-5))
      const table = sunTableAt(air, muSun, height01, LEVEL)
      const beam =
        clearBeam === null
          ? table
          : clearedBeam(air, table, height01, clearBeam, LEVEL)
      const terms = marchAirTerms(air, height, muSun, phases, beam, LEVEL)
      const inside = radius
        .greaterThanEqual(at.base)
        .and(radius.lessThan(at.top))
      const tauCloud = select(inside, float(SIGMA * R), float(0)).mul(step)
      const tauAir = terms.extinction.mul(step)
      const tau = tauAir.add(vec3(tauCloud))
      const through = exp(tau.negate())
      const share = stepShare(tau, through)
      const airShare = stepShare(tauAir, exp(tauAir.negate()))
      const source = terms.single.add(terms.multiple).mul(step)
      const cloudSource = vec3(tauCloud.mul(SOURCE))
      // Enhanced dims a surface's cloud light by the cleared transmittance,
      // continuously here; the sky's by the physical one.
      const seen = sky ? air0 : mix(air0, vec3(1), cleared)
      airLight.addAssign(air0.mul(cloud).mul(source).mul(share))
      cloudLight.addAssign(seen.mul(cloud).mul(cloudSource).mul(share))
      traced.addAssign(airSpan.mul(cloud).mul(cloudSource).mul(share))
      blocked.addAssign(airSpan.mul(cloud.sub(1)).mul(source).mul(airShare))
      plainSpan.addAssign(airSpan.mul(source).mul(airShare))
      const absorbed = cloud.mul(oneMinus(exp(tauCloud.negate())))
      weight.addAssign(absorbed)
      moment.addAssign(absorbed.mul(t))
      air0.mulAssign(exp(tauAir.negate()))
      airSpan.mulAssign(exp(tauAir.negate()))
      cloud.mulAssign(exp(tauCloud.negate()))
    })
    const throughAll = front.transmittance.mul(airSpan).mul(past.transmittance)
    const surfaceSeen = sky ? throughAll : mix(throughAll, vec3(1), cleared)
    const truth = front.inscatter
      .add(airLight)
      .add(cloudLight)
      .add(air0.mul(cloud).mul(past.inscatter))
      .add(surfaceSeen.mul(cloud).mul(behind))
    const meanDepth = select(
      weight.greaterThan(0),
      moment.div(max(weight, 1e-30)),
      start,
    )

    // The scene as its own march draws it, and at 512 samples.
    const own = (count: number) => {
      const marched = marchAir(
        air,
        eye,
        direction,
        float(0),
        stop,
        SUN_NODE,
        count,
        clearBeam ?? undefined,
      )
      // The shell extinguishes its background by the gray mean.
      const kept = sky
        ? vec3(marched.transmittance.dot(vec3(1 / 3)))
        : mix(marched.transmittance, vec3(1), cleared)
      return marched.inscatter.add(kept.mul(behind))
    }
    const scene = own(sky ? 2 * SKY_SEGMENT_SAMPLES : SURFACE_SEGMENT_SAMPLES)
    const sceneExact = own(JOINT)

    // The composite: its own segments, and the same algebra at 512 samples.
    const depthKm = sky ? float(CLOUD_DEPTH_CLAMP_KM) : stop.mul(R / 1000)
    const units = float(1000 / R)
    const composite = (to: Node<'float'>) =>
      compositeAir(
        air,
        eye,
        direction,
        start,
        to,
        depthKm,
        SUN_NODE,
        cleared,
        units,
        marchAirTerms,
      )
    const identityAir = composite(end)
    const thinAir = composite(meanDepth)
    const opaque = oneMinus(cloud)
    const identity = scene
      .mul(cloud)
      .add(identityAir.toEnd.mul(opaque))
      .add(identityAir.seen.mul(traced))
      .add(identityAir.toStart.transmittance.mul(blocked))
    const thin = scene
      .mul(cloud)
      .add(thinAir.toEnd.mul(opaque))
      .add(thinAir.seen.mul(traced))
    const exactSeen = sky
      ? front.transmittance
      : mix(front.transmittance, vec3(1), cleared)
    const exact = sceneExact
      .mul(cloud)
      .add(front.inscatter.add(front.transmittance.mul(plainSpan)).mul(opaque))
      .add(exactSeen.mul(traced))
      .add(front.transmittance.mul(blocked))
    const reference = max(luma(truth), 1e-12)
    const off = (v: Node<'vec3'>) => abs(luma(v.sub(truth))).div(reference)
    return vec4(
      off(identity),
      off(thin),
      off(exact),
      abs(luma(identity.sub(exact))).div(reference),
    )
  })()
}

interface Measured {
  readonly class: 'surface' | 'sky'
  readonly cleared: number
  readonly thickness: number
  readonly angle: number
  readonly identity: number
  readonly thin: number
  readonly exact: number
  readonly quadrature: number
}

/** The value at or under which 95 in 100 of `values` fall: nearest rank. */
function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0
}

const sameCase = (a: Measured, b: Measured): boolean =>
  a.class === b.class &&
  a.cleared === b.cleared &&
  a.thickness === b.thickness &&
  a.angle === b.angle

/** Hold a case's identity residual to its landed one, and its four figures finite. */
function hold(found: Measured): void {
  const what = `${found.class}, cleared ${found.cleared}, ${found.thickness} m at ${found.angle}°`
  for (const figure of [
    found.identity,
    found.thin,
    found.exact,
    found.quadrature,
  ]) {
    expect(Number.isFinite(figure), what).toBe(true)
    // Relative errors over a lit scene: past 10 is a broken instrument.
    expect(figure, what).toBeLessThan(10)
  }
  const pinned = (landed.cases as readonly Measured[]).find((row) =>
    sameCase(row, found),
  )
  // A case with no landed figure is a case that cannot fail.
  if (pinned === undefined) throw new Error(`no landed figures for ${what}`)
  if (!WORKSTATION) return
  expect(found.identity, `${what}: identity`).toBeLessThanOrEqual(
    pinned.identity * SLACK,
  )
}

describe('the composite’s error on analytic slabs', () => {
  const programs = { surface: errors(false), sky: errors(true) }

  /** The identity and the thin form against a joint march, and the identity's quadrature, a case at a time. */
  async function measure(
    kinds: readonly Measured['class'][],
    clearings: readonly number[],
    thicknesses: readonly number[],
  ): Promise<Measured[]> {
    const measured: Measured[] = []
    for (const kind of kinds)
      for (const cleared of clearings)
        for (const thickness of thicknesses)
          for (const angle of ANGLES) {
            const c = caseOf(kind === 'sky', thickness, angle)
            at.eye.value.copy(c.eye)
            at.direction.value.copy(c.direction)
            at.start.value = c.start
            at.end.value = c.end
            at.stop.value = c.stop
            at.base.value = c.base
            at.top.value = c.top
            at.cleared.value = cleared
            const pixels = await gpu.drawGraph(programs[kind], {
              float: true,
              width: 1,
              height: 1,
            })
            const [identity, thin, exact, quadrature] = pixels.at(0, 0)
            measured.push({
              class: kind,
              cleared,
              thickness,
              angle,
              identity,
              thin,
              exact,
              quadrature,
            })
          }
    return measured
  }

  it('holds the 500 m slab seen from above to its landed residual, in every run of the suite', async () => {
    const found = await measure(
      [ALWAYS.class],
      [ALWAYS.cleared],
      [ALWAYS.thickness],
    )
    expect(found).toHaveLength(ANGLES.length)
    for (const row of found) {
      expect(row).toMatchObject(ALWAYS)
      hold(row)
    }
  }, 120_000)

  it.skipIf(!MEASURE)(
    'holds all sixty cases and their 95th percentile to the landed residual, and writes them',
    async () => {
      const measured = await measure(['surface', 'sky'], [0, 1], THICKNESSES)
      expect(measured).toHaveLength(landed.cases.length)
      for (const row of measured) hold(row)
      if (WORKSTATION)
        expect(
          percentile95(measured.map((row) => row.identity)),
          'the identity’s residual at the 95th percentile',
        ).toBeLessThanOrEqual(
          percentile95(landed.cases.map((row) => row.identity)) * SLACK,
        )
      mkdirSync('.data/clouds', { recursive: true })
      writeFileSync(
        OUT,
        `${JSON.stringify(
          {
            note: 'cloudCompositeError.gpu.test.ts: relative luminance errors against a 512-sample joint march',
            body: 'Earth',
            slab: { baseMeters: BASE, sigmaPerMeter: SIGMA, source: SOURCE },
            cases: measured,
          },
          null,
          2,
        )}\n`,
      )
    },
    120_000,
  )
})
