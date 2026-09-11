import type { SurfacePlacement } from '@inertialref/simulation'

/** The authored facility is seeded once for a new Sol game and saved as an ordinary placement. */
export const MARS_PAD: SurfacePlacement = Object.freeze({
  id: 'mars-basin-pad',
  assetId: 'mars-pad',
  bodyAddress: 'g:milky-way/s:SOL/b:3',
  latitude: 0.6031917532451286,
  longitude: 1.4844702100937137,
  height: 2,
  heading: 0,
})
