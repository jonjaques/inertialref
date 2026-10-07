import type { Meters } from '@inertialref/shared'
import { Vec } from '@inertialref/spatial'
import {
  type Body,
  type BodyFixedDirection,
  drawnSurfaceRadius,
  geodeticDirection,
  type SurfacePlacement,
  surfaceRadius,
} from '@inertialref/universe'
import { supportUnder } from '@inertialref/simulation'

/*
 * The ground under a walker, both of it (rule 53).
 *
 * `support` is canonical: the contact test's answer, terrain or a structure's
 * relief, whichever stands taller under the ray — `supportUnder`, the same
 * function `World.contactRadius` reads, so the camera, the feet and the world
 * cannot stand a walker on three different grounds. `drawn` is the picture's:
 * terrain with its presentational tail, or a deck carried onto the drawn
 * ground at its anchor, because that is where the scene draws the model. The
 * two are read here and nowhere else, and this file says which is which.
 *
 * A port, because the camera's boom and step behavior is geometry about a
 * ground, not about Mars: a test hands it a plane, a step or a ridge.
 */

export interface GroundSample {
  /** Canonical: the radius the contact test stands a foot at. */
  readonly support: Meters
  /** Drawn: the radius the picture shows that ground at. */
  readonly drawn: Meters
}

export interface Ground {
  /** Both grounds along a body-fixed ray, as radii from the body's center. */
  at(direction: BodyFixedDirection): GroundSample
}

/**
 * The radius a structure's model is drawn at: the drawn ground under its
 * anchor. A deck rides the picture's ground, not the canonical one beneath
 * it, or its skirt would float over a hillside the tail has raised.
 */
export function drawnAnchorRadius(
  placement: SurfacePlacement,
  body: Body,
): Meters {
  return drawnSurfaceRadius(
    body,
    geodeticDirection(placement.latitude, placement.longitude),
  )
}

/** The ground of a real body, with every structure the caller has. */
export function bodyGround(
  body: Body,
  structures: readonly SurfacePlacement[],
): Ground {
  return {
    at(direction) {
      const terrain = surfaceRadius(body, direction)
      const { radius, placement } = supportUnder(
        structures,
        body,
        direction,
        terrain,
      )
      if (placement === null)
        return { support: terrain, drawn: drawnSurfaceRadius(body, direction) }
      // The deck is drawn lifted by the anchor's drawn-minus-canonical
      // difference, so its top is too — along the anchor's up, which this ray
      // meets over the cosine between them.
      const anchor = geodeticDirection(placement.latitude, placement.longitude)
      const lift =
        drawnAnchorRadius(placement, body) - surfaceRadius(body, anchor)
      return {
        support: radius,
        drawn: radius + lift / Vec.dot(anchor, direction),
      }
    },
  }
}
