import { expect, it } from 'vitest'
import { TEST_SKY } from '../../../packages/universe/src/catalog/fixture.ts'
import { skyVersion } from './skyVersion.ts'
it.each([
  { beyondLightYears: 149, apparentMagnitudeLimit: 6.5 },
  { beyondLightYears: 150, apparentMagnitudeLimit: 6.6 },
])('versions selection changes even when the rows do not change: %o', (sky) => {
  expect(
    skyVersion({ ...TEST_SKY, metadata: { ...TEST_SKY.metadata, sky } }),
  ).not.toBe(skyVersion(TEST_SKY))
})
