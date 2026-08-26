import type { Meters } from '@inertialref/shared'

/**
 * The radius above which a body is round, and below which it is a rock.
 *
 * Self-gravity beats material strength somewhere around 200 km for rock and a
 * little lower for ice: Mimas is round at 198 km, Proteus is very nearly round
 * at 201, and Hyperion at 133 is a sponge. It is not a sharp edge — Vesta at
 * 265 km has a basin taken out of its south pole deep enough to see in the
 * silhouette — so this is where the *transition* is centered rather than where
 * roundness begins.
 *
 * ## Why it lives in a file of its own
 *
 * It is read by `system.ts` (which draws generated figures) and by
 * `solar/smallBodies.ts` (which classifies measured ones), and those two are on
 * opposite sides of an import cycle: `system.ts` imports `solar/system.ts` for
 * `SOL`, and `solar/system.ts` imports `solar/smallBodies.ts`. A *type* import
 * across that edge is erased and harmless, which is why `solar/bodies.ts` can
 * take `BodyKind` from `system.ts` and nothing notices. A *value* import is
 * not: `SOLAR_SMALL_BODIES` is built eagerly at module scope, so it read this
 * constant while `system.ts`'s own body had not yet run.
 *
 * That threw `ReferenceError: Cannot access 'ROUNDING_RADIUS' before
 * initialization` for anyone importing `system.ts` directly, and was invisible
 * from `index.ts` only because its `export *` list happens to name
 * `./solar/system.ts` before `./system.ts` — an alphabetical accident, one
 * re-sort away from taking down the whole package. `pnpm graph` cannot see it:
 * it checks for cycles between *packages*, and this one is inside a package.
 *
 * A leaf with no imports of its own cannot be on either side of a cycle, which
 * is the only durable fix. `system.ts` re-exports it, so the public name is
 * unchanged.
 */
export const ROUNDING_RADIUS: Meters = 200_000
