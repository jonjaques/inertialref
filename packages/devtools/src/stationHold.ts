import { formatReading } from '@inertialref/shared'
import {
  type FrameGraph,
  type FrameId,
  type Quat,
  Quaternion as Q,
} from '@inertialref/spatial'
import {
  parseStationFrameId,
  type StarSystem,
  stationFixedFrameId,
  stationFrameId,
  type SystemId,
  type UniverseAddress,
} from '@inertialref/universe'
import { stationAt } from './travel.ts'

/*
 * A station as a camera subject, and the one thing it has that a body does
 * not: a basis of its own the camera can hold.
 *
 * The observatory owns when a hold starts and ends and hands the rotation
 * between it and a tracked companion; what a hold *is* — a frame, an instant,
 * and the turn between two poses of that frame — is here, apart from the
 * camera that applies it.
 */

/** A camera holding a station's own axes: its `af:` frame, and when the hold began. */
export interface StationHold {
  readonly frame: FrameId
  readonly referenceTime: number
}

/**
 * The hold a subject anchored on `anchor` starts at `time`, or null when the
 * anchor is not a station's `a:` frame.
 *
 * From the frame id alone, because the id determines the frame: the `af:`
 * frame beside it is the same station's, and nothing else needs asking.
 */
function holdFor(anchor: FrameId, time: number): StationHold | null {
  const parsed = parseStationFrameId(anchor)
  return parsed === null || parsed.fixed
    ? null
    : { frame: stationFixedFrameId(parsed.station), referenceTime: time }
}

/** The hold on `subject`, or the refusal a camera on anything else gets. */
export function holdOn(
  subject: { readonly frame: FrameId } | null,
  time: number,
): StationHold {
  const hold = subject === null ? null : holdFor(subject.frame, time)
  if (hold === null) throw new Error('Choose a station to hold.')
  return hold
}

/**
 * Which basis the camera holds round its subject, as the status reports it:
 * null unless the subject is a station, whose anchor is the only one a hold
 * can be taken on — and null under a galaxy instrument, which owns the pose
 * and refuses a hold, so the Camera panel never offers a switch that throws.
 */
export const holdReading = (
  target: { readonly frame: FrameId } | null,
  hold: StationHold | null,
  galaxyInstrument: boolean,
): 'space' | 'station' | null =>
  galaxyInstrument || target === null || holdFor(target.frame, 0) === null
    ? null
    : hold === null
      ? 'space'
      : 'station'

/**
 * The basis, turned by as much as the station has turned since the hold
 * began, so the whole orbit pose about its center turns with it.
 *
 * The basis unchanged when the frame is gone — the station's system unloaded
 * under the camera — which is holding a direction in space, the default.
 */
export function heldBasis(
  frames: FrameGraph,
  hold: StationHold,
  time: number,
  basis: Quat,
): Quat {
  if (hold.referenceTime === time || !frames.has(hold.frame)) return basis
  const before = frames.pose(hold.frame, hold.referenceTime).orientation
  const now = frames.pose(hold.frame, time).orientation
  return Q.normalize(Q.multiply(Q.multiply(now, Q.conjugate(before)), basis))
}

/**
 * A station destination as a camera subject: an anchor and a radius, like any
 * other. The anchor is the `a:` frame, centered on the station and not
 * turning, so the camera holds a direction in space until it is told to hold
 * the station's axes; the radius is the bounding sphere, so the orbit arm's
 * floor is 1.5 of it and no surface arm is ever reached.
 */
export function stationSubject(
  system: StarSystem,
  resolved: {
    readonly system: SystemId
    readonly address: UniverseAddress
    readonly text: string
  },
) {
  const station = stationAt(system, resolved.address)
  if (station === undefined) throw new Error(`No station at ${resolved.text}`)
  return {
    address: resolved.text,
    name: station.name,
    kind: 'station' as const,
    system: resolved.system,
    frame: stationFrameId(station.id),
    radius: station.radius,
    detail: `${station.kind} · ${station.provenance} · ${formatReading(
      station.orbit.elements.semiMajorAxis,
    )}`,
  }
}
