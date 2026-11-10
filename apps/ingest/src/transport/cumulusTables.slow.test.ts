import { describe, expect, it } from 'vitest'
import {
  CUMULUS_REFERENCE,
  CUMULUS_VIEWS,
  fixtureMedium,
} from '@inertialref/rendering'
import {
  fieldCase,
  findCumulus,
  probesOf,
  SUBJECTS,
  subjectFixture,
  traceCase,
} from './cumulusTables.ts'

/*
 * The committed reference, taken again from nothing but its generator: each
 * subject's place searched for on the field as it stands, its fixture cut,
 * and a pixel of each of its cases traced to the case's own count. It is
 * here and not in the gate because a subject is 2.5 million reads of the
 * field and a pixel 49,000 paths: about ten seconds a subject on the Mac
 * mini (Mac18,5, Apple M6).
 *
 * The gate holds 500 of each subject's voxels to the field
 * (`cumulusFixture.test.ts`), which says the cloud has not moved. This says
 * the numbers are that cloud's: the same place, the same sky, the same
 * streams.
 */

describe.skipIf(CUMULUS_REFERENCE.cases.length === 0)(
  'the committed reference',
  () => {
    it.each(SUBJECTS)(
      'is the $id the search finds, traced again to the file’s six figures',
      (search) => {
        const subject = findCumulus(search)
        expect(subject).toEqual(
          CUMULUS_REFERENCE.subjects.find(({ id }) => id === search.id),
        )
        const medium = fixtureMedium(subjectFixture(subject))
        for (const view of CUMULUS_VIEWS) {
          const spec = fieldCase(subject, view)
          expect(spec).toEqual(
            CUMULUS_REFERENCE.cases.find(({ id }) => id === spec.id),
          )
          // The thinnest rim pixel: the cheapest of the case to trace.
          const committed = CUMULUS_REFERENCE.probes.find(
            (probe) => probe.case === spec.id && probe.mask === 'rim',
          )!
          const [again] = probesOf(
            spec,
            traceCase(medium, spec, [committed], 0, spec.samples),
          )
          expect(again).toEqual(committed)
        }
      },
      300_000,
    )
  },
)
