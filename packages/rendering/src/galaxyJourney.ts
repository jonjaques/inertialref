import { invariant, PARSEC, type Meters } from '@inertialref/shared'
import { UV, Vec, type UniverseVector } from '@inertialref/spatial'
import { GALAXY_VIEWS } from './galaxyView.ts'
import type { ObserverState } from './observer.ts'

export const GALAXY_JOURNEY_SECONDS = 36
export const GALAXY_JOURNEY_ALTITUDE: Meters = 64_000_000
export const GALAXY_JOURNEY_LENS = GALAXY_VIEWS['face-on'].lens

export interface GalaxyJourneyRoute {
  readonly azimuth: number
  readonly elevation: number
  readonly startDistance: Meters
  readonly endDistance: Meters
}

/** The route uses the orbit camera's own angles and aims back toward Earth throughout. */
export function createGalaxyJourney(
  earth: UniverseVector,
  radius: Meters,
): GalaxyJourneyRoute {
  const displacement = UV.difference(UV.fromMeters(0, 30000 * PARSEC, 0), earth)
  const endDistance = Vec.length(displacement)
  return {
    azimuth: Math.atan2(displacement.z, displacement.x),
    elevation: Math.asin(displacement.y / endDistance),
    startDistance: radius + GALAXY_JOURNEY_ALTITUDE,
    endDistance,
  }
}

export function validateGalaxyJourney(progress: number, seconds: number): void {
  invariant(
    Number.isFinite(progress) && progress >= 0 && progress <= 1,
    'Galaxy journey progress must be between 0 and 1',
  )
  invariant(
    Number.isFinite(seconds) && seconds >= 0,
    'Galaxy journey duration must be finite and nonnegative',
  )
}

export function galaxyJourneyState(
  route: GalaxyJourneyRoute,
  progress: number,
): ObserverState {
  validateGalaxyJourney(progress, 0)
  return {
    azimuth: route.azimuth,
    elevation: route.elevation,
    distance:
      progress === 0
        ? route.startDistance
        : progress === 1
          ? route.endDistance
          : route.startDistance *
            (route.endDistance / route.startDistance) ** progress,
  }
}

export function galaxyJourneyProgress(
  route: GalaxyJourneyRoute,
  distance: Meters,
): number {
  return Math.max(
    0,
    Math.min(
      1,
      Math.log(distance / route.startDistance) /
        Math.log(route.endDistance / route.startDistance),
    ),
  )
}
