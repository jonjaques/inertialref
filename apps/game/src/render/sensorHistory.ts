import {
  fromRenderSpace,
  Quaternion,
  REBASE_THRESHOLD,
  UV,
  Vec,
  type Quat,
  type RenderOrigin,
  type UniverseVector,
  type Vec3,
} from '@inertialref/spatial'

/** Camera coordinates are relative to the render origin supplied with them. */
export interface SensorCamera {
  readonly position: Vec3
  readonly orientation: Quat
  readonly origin?: RenderOrigin | null
}

interface CameraSample {
  readonly position: UniverseVector
  readonly orientation: Quat
  readonly origin: RenderOrigin | null
}

function sample(camera: SensorCamera): CameraSample {
  const origin = camera.origin ?? null
  return {
    position:
      origin === null
        ? UV.translate(UV.UNIVERSE_ORIGIN, camera.position)
        : fromRenderSpace(origin, camera.position),
    orientation:
      origin === null
        ? // Field by field, not a spread. A `THREE.Quaternion` carries x/y/z/w
          // as prototype accessors over private `_x`…`_w`, so a spread retains
          // no components, every dot product against the sample is NaN, and a
          // NaN compares false — the orientation cut never fires.
          {
            x: camera.orientation.x,
            y: camera.orientation.y,
            z: camera.orientation.z,
            w: camera.orientation.w,
          }
        : Quaternion.multiply(origin.orientation, camera.orientation),
    origin,
  }
}

/** A readback belongs to the camera and presentation instant that submitted it. */
export class SensorHistory {
  #generation = 0
  #key: string | null = null
  #time: number | null = null
  #retired = false
  #camera: CameraSample | null = null
  #velocity: Vec3 | null = null
  #motionReset = true

  /** Rebased velocity attachments cannot blur, even when exposure remains continuous. */
  get motionReset(): boolean {
    return this.#motionReset
  }

  advance(key: string, time: number, camera?: SensorCamera): number {
    const next = camera === undefined ? null : sample(camera)
    const dt = this.#time === null ? 0 : time - this.#time
    const changed =
      key !== this.#key || this.#time === null || dt < 0 || dt > 0.5
    const cut = next !== null && this.#cameraCut(next, dt)
    if (changed || cut) this.#generation++
    this.#motionReset = changed || cut || next?.origin !== this.#camera?.origin
    this.#velocity =
      changed || cut || next === null || this.#camera === null || dt <= 0
        ? null
        : Vec.scale(UV.difference(next.position, this.#camera.position), 1 / dt)
    this.#key = key
    this.#time = time
    this.#camera = next
    return this.#generation
  }

  #cameraCut(camera: CameraSample, dt: number): boolean {
    if (this.#camera === null) return false
    const a = this.#camera.orientation
    const b = camera.orientation
    if (
      Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) <
      Math.cos(Math.PI / 24)
    )
      return true
    // The first interval establishes motion. Position in the floating frame
    // cannot set a cut threshold: it jumps 4096 m at an ordinary rebase.
    if (this.#velocity === null) return false
    const expected = Vec.scale(this.#velocity, Math.max(0, dt))
    const movement = UV.difference(camera.position, this.#camera.position)
    // Allow acceleration and a curved route; a cut exceeds the recent travel
    // envelope. Explicit target, lens and photographic-time keys handle small cuts.
    return (
      Vec.distance(movement, expected) >
      Math.max(REBASE_THRESHOLD, Vec.length(expected) * 4)
    )
  }

  accepts(
    generation: number,
    key: string,
    time: number,
    held = false,
    camera?: SensorCamera,
  ): boolean {
    return (
      !this.#retired &&
      !held &&
      generation === this.#generation &&
      key === this.#key &&
      this.#time !== null &&
      time >= this.#time &&
      time - this.#time <= 0.5 &&
      (camera === undefined ||
        !this.#cameraCut(sample(camera), time - this.#time))
    )
  }

  retire(): void {
    this.#retired = true
    this.#generation++
  }
}
