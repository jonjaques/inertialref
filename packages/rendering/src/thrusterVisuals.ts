import { hashString, mix32 } from '@inertialref/procedural'
import { Vec, type Vec3, vec3 } from '@inertialref/spatial'
import type { ThrustDemand } from '@inertialref/simulation'
import {
  nozzleFiring,
  prepareNozzles,
  type Nozzle,
  type NozzleAllocation,
  type ThrusterLayout,
} from './thrusters.ts'

/** A picture of counter-torque, captured before the world's stop clears spin. */
export interface RotationStopCue {
  readonly at: number
  readonly angular: Vec3
  readonly duration: number
}

/** All times are seconds in the same presentation clock as `sample`. */
export function rotationStopCue(
  spin: Vec3,
  torqueAuthority: number,
  at: number,
): RotationStopCue | null {
  const speed = Vec.length(spin)
  if (!(speed > 0) || !Number.isFinite(speed) || !(torqueAuthority > 0))
    return null
  const brakingTime = speed / torqueAuthority
  const duration = Math.max(0.1, Math.min(0.3, brakingTime))
  const strength = Math.max(0.12, Math.min(1, brakingTime / duration))
  return {
    at,
    // Divide before scaling so a subnormal spin cannot overflow its reciprocal.
    angular: vec3(
      -(spin.x / speed) * strength,
      -(spin.y / speed) * strength,
      -(spin.z / speed) * strength,
    ),
    duration,
  }
}

/** A valve keeps its timing when a hull's nozzle list is reordered. */
export function nozzleValveSeed(nozzle: Nozzle): number {
  const { position: p, exhaust: e, radius, kind } = nozzle
  return hashString(
    `${kind}:${p.x},${p.y},${p.z}:${e.x},${e.y},${e.z}:${radius}`,
  )
}

const fraction = (seed: number): number => mix32(seed) / 0x1_0000_0000
const PUFF_SLOT = 1.5
const NEUTRAL: ThrustDemand = { linear: Vec.ZERO, angular: Vec.ZERO, drive: 0 }

/** Presentation demands only. No valve state is fed back to the flight model. */
export class ThrusterVisuals {
  readonly #allocation: NozzleAllocation
  readonly #firing: Float32Array
  readonly #overlay: Float32Array
  readonly #seed: number
  readonly #angular = { x: 0, y: 0, z: 0 }
  readonly #demand: ThrustDemand = {
    linear: Vec.ZERO,
    angular: this.#angular,
    drive: 0,
  }

  constructor(layout: ThrusterLayout) {
    this.#allocation = prepareNozzles(layout)
    this.#firing = new Float32Array(layout.nozzles.length)
    this.#overlay = new Float32Array(layout.nozzles.length)
    this.#seed = layout.nozzles.reduce(
      (seed, nozzle) => seed ^ mix32(nozzleValveSeed(nozzle)),
      hashString('thruster-hold'),
    )
  }

  /** The returned array belongs to this controller and is overwritten each call. */
  sample(
    demand: ThrustDemand | null,
    now: number,
    stop: RotationStopCue | null,
    holding: boolean,
    variation: boolean,
  ): Float32Array {
    const base = demand ?? NEUTRAL
    nozzleFiring(this.#allocation, base, this.#firing)
    const { angular } = base
    if (angular.x !== 0 || angular.y !== 0 || angular.z !== 0)
      return this.#firing

    if (stop !== null && now >= stop.at && now < stop.at + stop.duration) {
      const age = (now - stop.at) / stop.duration
      const fade = 1 - age * age * (3 - 2 * age)
      this.#angular.x = stop.angular.x * fade
      this.#angular.y = stop.angular.y * fade
      this.#angular.z = stop.angular.z * fade
      return this.#addOverlay()
    }

    if (!holding || !variation || !Number.isFinite(now)) return this.#firing
    // Each slot contains one pulse. Absolute time lets a hidden hull skip every
    // frame without replaying an expired correction when it becomes visible.
    const slot = Math.floor(now / PUFF_SLOT)
    const seed = mix32(this.#seed ^ Math.imul(slot, 0x9e37_79b1))
    const start = 0.2 + 0.5 * fraction(seed)
    const width = 0.025 + 0.025 * fraction(seed ^ 0x85eb_ca6b)
    const phase = now - slot * PUFF_SLOT - start
    if (phase < 0 || phase >= width) return this.#firing
    const strength =
      (0.035 + 0.045 * fraction(seed ^ 0xc2b2_ae35)) *
      Math.sin((Math.PI * phase) / width)
    const axis = mix32(seed ^ 0x27d4_eb2f) % 6
    this.#angular.x = axis < 2 ? (axis === 0 ? strength : -strength) : 0
    this.#angular.y =
      axis >= 2 && axis < 4 ? (axis === 2 ? strength : -strength) : 0
    this.#angular.z = axis >= 4 ? (axis === 4 ? strength : -strength) : 0
    return this.#addOverlay()
  }

  #addOverlay(): Float32Array {
    nozzleFiring(this.#allocation, this.#demand, this.#overlay)
    for (let i = 0; i < this.#firing.length; i += 1) {
      // A visual correction cannot extinguish a valve serving a real command.
      this.#firing[i] = Math.max(this.#firing[i]!, this.#overlay[i]!)
    }
    return this.#firing
  }
}

/** Exponential valve response, independent of how a fixed demand splits frames. */
export function valveOpening(
  held: number,
  target: number,
  delta: number,
  seed: number,
  variation: boolean,
): number {
  if (!(delta > 0) || held === target) return held
  const opening = target > held
  let response = opening ? 0.03 : 0.09
  if (variation) {
    response += (fraction(seed) - 0.5) * 0.001
    if (!opening) response += 0.02 * fraction(seed ^ 0x9e37_79b1)
  }
  const value = target + (held - target) * Math.exp(-delta / response)
  // Rounding a very small residual must not put the valve outside its endpoints.
  return opening
    ? Math.max(held, Math.min(target, value))
    : Math.max(target, Math.min(held, value))
}
