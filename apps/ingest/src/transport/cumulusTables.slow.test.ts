import { describe, expect, it } from 'vitest'
import {
  CUMULUS_LINEAR_SKIES,
  CUMULUS_REFERENCE,
  CUMULUS_VIEWS,
  fixtureMedium,
  mieDroplets,
} from '@inertialref/rendering'
import {
  fieldCase,
  findCumulus,
  probesOf,
  quadratureSkyOf,
  SCALED_SAMPLES,
  scaledOf,
  scaledRows,
  scaledTable,
  SKIES,
  skyOf,
  SUBJECTS,
  subjectFixture,
  traceCase,
  traceScaled,
  traceScaledSky,
  unscaleOf,
} from './cumulusTables.ts'

/*
 * The committed reference, taken again from nothing but its generator: each
 * subject's place searched for on the field as it stands, its fixture cut,
 * and a pixel of each of its cases traced to the case's own count, on the
 * true medium, on the scaled one, and under the sky alone under each of its
 * three skies. It is here and not in the gate because a subject is 2.5
 * million reads of the field, a pixel 49,000 paths and a scaled row of the
 * droplet table a second of Mie series: 29 s and 34 s for the two subjects
 * on the Mac mini (Mac18,5, Apple M6).
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
        const fixture = subjectFixture(subject)
        const medium = fixtureMedium(fixture)
        const table = mieDroplets()
        const scaled = scaledTable(table, scaledRows(fixture, table))
        for (const view of CUMULUS_VIEWS) {
          // The case as the search and the view make it today, but for its
          // `sky`: that is the table's read when `probes`, `scaled` and the
          // table's block were traced, and those are traced again under it
          // below. The reference's sky term is lit by the air's own sky and
          // the linear sky on the quadrature's moments, neither of them the
          // table's (ruling 007), so the case is not held to the table as it
          // reads now: its rows stand in the air's optical depth since
          // `weather/p1-sky-rows`, and its read at 1.7 km moved.
          const fresh = fieldCase(subject, view)
          const spec = CUMULUS_REFERENCE.cases.find(
            ({ id }) => id === fresh.id,
          )!
          expect({ ...fresh, sky: spec.sky }).toEqual(spec)
          // The linear rows' moments are the quadrature's at the case's
          // height and sun, as they are taken today.
          expect(
            CUMULUS_LINEAR_SKIES.moments.find((row) => row.case === spec.id),
          ).toEqual({ case: spec.id, ...quadratureSkyOf(spec) })
          // The thinnest rim pixel: the cheapest of the case to trace.
          const committed = CUMULUS_REFERENCE.probes.find(
            (probe) => probe.case === spec.id && probe.mask === 'rim',
          )!
          const [again] = probesOf(
            spec,
            traceCase(medium, spec, [committed], 0, spec.samples),
          )
          expect(again).toEqual(committed)
          // The same pixel's rows on the scaled medium. The first view
          // scales the table itself, as a `scaled` and a `sky` process do;
          // the others are handed it.
          const index = CUMULUS_REFERENCE.probes.indexOf(committed)
          const handed = view === CUMULUS_VIEWS[0] ? undefined : scaled
          expect(
            scaledOf(
              spec,
              traceScaled(
                fixture,
                spec,
                [committed],
                0,
                SCALED_SAMPLES,
                undefined,
                handed,
              ),
              unscaleOf(fixture),
            )[0],
          ).toEqual(CUMULUS_REFERENCE.scaled[index])
          // And under each of the three skies.
          const blocks = {
            air: CUMULUS_REFERENCE.airScattered,
            linear: CUMULUS_LINEAR_SKIES.linearScattered,
            table: CUMULUS_LINEAR_SKIES.table,
          }
          for (const under of SKIES)
            expect(
              skyOf(
                spec,
                traceScaledSky(
                  fixture,
                  spec,
                  [committed],
                  0,
                  SCALED_SAMPLES,
                  undefined,
                  handed ?? scaled,
                  under,
                ),
              )[0],
              under,
            ).toEqual(blocks[under][index])
        }
      },
      // Thirty times the slower subject's 34 s on the Mac mini (Mac18,5,
      // Apple M6): the hosted runner's slow stage runs over five times slower.
      1_020_000,
    )
  },
)
