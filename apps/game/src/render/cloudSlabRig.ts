import { float, length, uniform, vec2, vec3 } from 'three/tsl'
import {
  iceAggregate,
  mieDroplets,
  PHASE_ATLAS,
  SLAB_REFERENCE,
  type SlabReferenceRow,
  sunFactorPair,
} from '@inertialref/rendering'
import { altitudeAt, sunMuAt } from './cloudGeometry.ts'
import {
  marchProbe,
  placeBody,
  placeSun,
  type ProbeOptions,
  type ProbeRay,
  type Triple,
} from './cloudMarchRig.ts'
import {
  CLOUD_STAND_INS,
  type CloudSample,
  type CloudSunDepthNodes,
  type CloudSunFn,
  exactSlabSun,
  slabMedium,
} from './cloudNodes.ts'
import { CloudPhase } from './cloudPhase.ts'
import { type CloudSource, createCloudSource } from './cloudSource.ts'
import { cloudSunFn } from './cloudSunlight.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import type { GpuSession } from './gpuHarness.ts'

/*
 * The slab gates' rig: the march over one plane slab whose extinction,
 * radius and cloudy share are uniforms, so one kernel draws every slab of
 * a domain, lit by the committed source table and, where a test asks, by
 * the committed phase and a sky of one radiance.
 *
 * A ray is the mean of eight, their first steps shortened by eight evenly
 * spaced shares, as a held still's frames are. The slab stands on a body
 * of Earth's radius, and the eye a meter outside the face it looks at, so
 * the sphere bends a 5 km slant through a kilometer of slab by 0.05°.
 */

export const SLAB_BASE = 1000
/** A kilometer of slab, unless a rig asks for another thickness. */
const THICKNESS = 1000
export const SLAB_JITTERS = 8
/** The sun's angular radius the reference's first order is read through: 959.63″. */
const SUN_RADIUS = (959.63 / 3600) * (Math.PI / 180)
export const BANDS = [0, 1, 2] as const

/** The view from the eye whose light leaves a face at `mu` to its normal, `azimuth` degrees from the sun's light's bearing. */
export function viewOf(
  side: SlabReferenceRow['side'],
  mu: number,
  azimuth: number,
): Triple {
  const sine = Math.sqrt(1 - mu * mu)
  const phi = (azimuth * Math.PI) / 180
  // The sun stands toward +X, so its light travels toward −X: light to
  // the eye at an azimuth of zero travels that way too, and the eye looks
  // back along it.
  return [
    sine * Math.cos(phi),
    side === 'reflected' ? -mu : mu,
    -sine * Math.sin(phi),
  ]
}

/** The scattering angle of a view, degrees: between the sun's light and the light to the eye. */
export function scatteringAngle(sunMu: number, view: Triple): number {
  const sun: Triple = [Math.sqrt(1 - sunMu * sunMu), sunMu, 0]
  const cosine = sun[0] * view[0] + sun[1] * view[1] + sun[2] * view[2]
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI
}

export interface SlabRig {
  readonly uniforms: CloudUniforms
  readonly source: CloudSource
  /** Place a slab of an unscaled depth at a radius under a sun, seen from a side. */
  place(
    radius: number,
    depth: number,
    sunMu: number,
    side: SlabReferenceRow['side'],
    /** Meters the eye stands outside the face it looks at: one, unless told. */
    outside?: number,
  ): void
  /** The slab's top, meters over the datum. */
  readonly top: number
  /** The level's cumuliform share, which the factor of the sun is blended by. */
  share(convective: number): void
  /** The cloudy share of the slab's columns: one, a resolved slab, until told. */
  cover(fraction: number): void
  /** Each view's light, the mean of its jitters. */
  light(views: readonly Triple[]): Promise<Triple[]>
  /** Each view's light and what the slab passes, the means of its jitters. */
  marched(
    views: readonly Triple[],
  ): Promise<{ readonly light: Triple; readonly transmittance: number }[]>
  dispose(): void
}

/**
 * A march over one slab whose extinction and radius are uniforms, so one
 * kernel draws every slab of the domain.
 */
export async function slabRig(
  gpu: GpuSession,
  options: {
    /** The shipped sun, its taps over a cache that holds the slab's own depths; the slab's exact sun; or no sun at all. */
    readonly sun: 'shipped' | 'exact' | 'none'
    /** The sky's radiance, alike on every side and in every band: none when absent. */
    readonly sky?: number
    /** The committed phase through the reference's sun, or none: the light after first order alone. */
    readonly phase: boolean
    readonly march?: ProbeOptions['march']
    /** Meters. A thin slab is flat under a grazing sun, whose ray through a kilometer of it climbs 28 m of the sphere. */
    readonly thickness?: number
  },
): Promise<SlabRig> {
  const TOP = SLAB_BASE + (options.thickness ?? THICKNESS)
  const uniforms = createCloudUniforms()
  const body = uniforms.served
  const sigma = uniform(0)
  const radius = uniform(10)
  const fraction = uniform(1)
  const slab = { base: SLAB_BASE, top: TOP, sigma, radius, fraction }
  const exact = exactSlabSun([slab])
  const source = createCloudSource()
  await source.load()
  const droplets = mieDroplets()
  const phase = new CloudPhase(droplets, iceAggregate())
  phase.serve(SUN_RADIUS, null)
  await phase.warm(gpu.renderer)
  const shipped = (field: Parameters<typeof cloudSunFn>[0]['medium']) => {
    const sampleAt = (offset: CloudSample['offset']): CloudSample => ({
      offset,
      distance: length(offset),
      altitude: altitudeAt(body, offset),
      sunMu: sunMuAt(body, offset),
      footprint: uniform(0),
    })
    // The slab's own depths, as a cache that held them exactly would.
    const cache: CloudSunDepthNodes = {
      depths(offset) {
        const at = sampleAt(offset)
        const depth = exact(at, field(at, body), body).depth
        return {
          toSun: depth.x,
          whole: depth.y,
          weight: uniform(1),
          behind: uniform(1),
        }
      },
    }
    return cloudSunFn({ uniforms, medium: field, depth: cache })
  }
  const dark: CloudSunFn = () => ({
    cloud: float(0),
    air: vec3(0),
    depth: vec2(0),
    octave: () => float(0),
  })
  const sun: (field: Parameters<typeof shipped>[0]) => CloudSunFn =
    options.sun === 'shipped'
      ? shipped
      : options.sun === 'exact'
        ? () => exact
        : () => dark
  const probe = marchProbe(gpu, uniforms, slabMedium([slab]), {
    sun,
    phase: options.phase ? phase : CLOUD_STAND_INS.phase(0),
    // A sky of nothing, read from its table: the placeholder's Ψ is one
    // on the rig's stand-in tables, and would light every slab alike.
    light: { source, sky: CLOUD_STAND_INS.sky(options.sky ?? 0) },
    march: { ...options.march, skyTable: true },
  })
  const marched: SlabRig['marched'] = async (views) => {
    const rays: ProbeRay[] = views.flatMap((direction) =>
      Array.from({ length: SLAB_JITTERS }, (_, k) => ({
        direction,
        jitter: (k + 0.5) / SLAB_JITTERS,
      })),
    )
    const means = views.map(() => ({
      light: [0, 0, 0] as [number, number, number],
      transmittance: 0,
    }))
    for (let from = 0; from < rays.length; from += 64) {
      const probed = await probe(rays.slice(from, from + 64))
      probed.forEach(({ light, transmittance }, i) => {
        const mean = means[Math.floor((from + i) / SLAB_JITTERS)]!
        for (const band of BANDS) mean.light[band] += light[band] / SLAB_JITTERS
        mean.transmittance += transmittance / SLAB_JITTERS
      })
    }
    return means
  }
  return {
    uniforms,
    source,
    top: TOP,
    place(r, depth, sunMu, side, outside = 1) {
      placeBody(uniforms, {
        eye: side === 'reflected' ? TOP + outside : SLAB_BASE - outside,
        layers: [[SLAB_BASE, TOP]],
      })
      placeSun(uniforms, sunMu)
      const media = SLAB_REFERENCE.media.find((item) => item.radius === r)!
      // The renderer's medium: the depth with the diffraction out of it.
      const scaled = ((1 - media.share) * depth) / (TOP - SLAB_BASE)
      sigma.value = scaled
      radius.value = r
      const { layers } = body
      layers.sigma.value.set(scaled, scaled, scaled)
      layers.radius.value.set(r, r, r)
      layers.radiusMin.value.set(r, r, r)
      layers.radiusMax.value.set(r, r, r)
      layers.phaseRow.value.set(PHASE_ATLAS.dropletRow, 0, 0)
      layers.phaseRows.value.set(droplets.radii, droplets.radii, droplets.radii)
      layers.phaseRadius.value.set(
        droplets.radiusMin,
        droplets.radiusMin,
        droplets.radiusMin,
      )
      uniforms.trace.lightTaps.value = 4
    },
    share(convective) {
      const { l, a } = sunFactorPair('cumulus')
      source.levels.factor.value.set(l, l, l)
      source.levels.slope.value.set(a, a, a)
      body.climate.convective.value.set(convective, convective, convective)
    },
    cover(share) {
      fraction.value = share
    },
    marched,
    light: async (views) => (await marched(views)).map(({ light }) => light),
    dispose() {
      phase.dispose()
      source.dispose()
      uniforms.dispose()
    },
  }
}
