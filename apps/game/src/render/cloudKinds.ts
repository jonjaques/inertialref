/*
 * The march's work counts and the step budget they bound, apart from the
 * march. `cloudLevers` refuses a budget past the bound, and `cloudLevers` is
 * in `App`'s static graph: a lever that reads the bound from `cloudMarch`
 * takes the march, the weather field and the mie table into every page, the
 * ones without `?clouds=1` among them. So this module imports nothing, and
 * `pnpm graph` refuses an edge from `App` to the march.
 */

/**
 * Steps a ray may take past its budget: its first, which the jitter
 * shortens, one at each of the twelve boundary crossings, and the iteration
 * that closes the last step, with two to spare.
 */
export const UNCOUNTED_STEPS = 16
/**
 * What a step outside every level and a sun add to `CloudMarchResult.kinds`:
 * ten bits a count of the integer's 32, so each is exact to 1,023. A float
 * holds a whole number exactly to 2²⁴ only, which is three counts of eight
 * bits: 256 steps in cloud carried into the count outside every level.
 */
export const KIND_GAP = 1024
export const KIND_SUN = KIND_GAP * KIND_GAP
/**
 * The largest step budget the kinds count exactly, and so the largest the
 * `maxSteps` lever takes. A ray runs at most its budget and
 * `UNCOUNTED_STEPS` more, and takes a sun at each step in cloud and one
 * more where its last step is closed: 1,006 + 16 + 1 is a field's 1,023.
 * Past it 1,024 steps in cloud read as none, and one outside every level.
 */
export const CLOUD_MAX_STEPS_COUNTED = KIND_GAP - 1 - UNCOUNTED_STEPS - 1
