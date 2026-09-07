import { describe, expect, it } from 'vitest'
import { buildCatalog, buildSkyCatalog, readHyg } from './build.ts'

const header = 'id,hip,dist,mag,ra,dec,comp,comp_primary,proper'
const options = {
  radiusLightYears: 150,
  completeRadiusLightYears: 25,
  version: 'test',
}

describe('systems crossing the sky selection', () => {
  it.each([
    ['primary inside', '1,101,45,5,0,0,1,1,\n2,102,47,5,0,0,2,1,'],
    ['companion inside', '1,101,47,5,0,0,1,1,\n2,102,45,5,0,0,2,1,'],
  ])('keeps one physical system when the %s', (_label, rows) => {
    const table = readHyg(`${header}\n${rows}`)
    const volume = buildCatalog(table, '', options).catalog
    const sky = buildSkyCatalog(table, {
      beyondLightYears: 150,
      apparentMagnitudeLimit: 6.5,
      version: 'sky',
      volumeIds: new Set(volume.stars.map((star) => star.id)),
    })
    expect(volume.stars).toHaveLength(1)
    expect(sky.catalog.stars).toHaveLength(0)
    expect(sky.report.inVolume).toHaveLength(1)
  })
})

it('orders equal-numbered companions by source id when the primary misses selection', () => {
  const rows = [
    '1,101,200,8,0,0,1,1,',
    '2,102,200,5,0,0,2,1,',
    '3,103,200,4,0,0,2,1,',
  ]
  const build = (input: string[]) =>
    buildSkyCatalog(readHyg(`${header}\n${input.join('\n')}`), {
      beyondLightYears: 150,
      apparentMagnitudeLimit: 6.5,
      version: 'sky',
      volumeIds: new Set(),
    }).catalog
  expect(build(rows)).toEqual(build([...rows].reverse()))
})
