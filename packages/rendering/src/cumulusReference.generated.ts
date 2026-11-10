/*
 * The path-traced cumulus (phase 1 design §5.11): what the float64 tracer
 * renders of the fixture, on the true medium, by every order of scattering.
 *
 * A stand-in: no case of the field and none of the analytic cumulus, under
 * no genus table. A generator writes this file; rerun it rather than
 * editing, then `pnpm exec prettier -w` this file.
 */
import type { CumulusReference } from './cumulusFixture.ts'

export const CUMULUS_REFERENCE: CumulusReference = {
  format: 'inertialref/cumulus-reference',
  version: 1,
  genusHash: '',
  subjects: [],
  cases: [],
  probes: [],
  curves: [],
  medians: [],
  voxels: [],
  analytic: {
    fixture: { size: [40, 32, 40], voxel: 50, sigma: 0.012 },
    cases: [],
    probes: [],
  },
}
