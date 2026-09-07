import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { LOCAL_CLOUD_RECORDS } from '../../../packages/universe/src/galaxy/localClouds.generated.ts'
import { SKY_REGION_REFERENCES } from '../../../packages/universe/src/galaxy/skyCalibration.generated.ts'
import { extractSky, readDustCube } from './galaxyReference.ts'

it('keeps runtime cloud records identical to the source manifest', () => {
  const source = JSON.parse(
    readFileSync(
      new URL('../../../data/reference/galaxy.json', import.meta.url),
      'utf8',
    ),
  )
  expect(LOCAL_CLOUD_RECORDS).toEqual(source.dust.clouds)
  expect(SKY_REGION_REFERENCES).toEqual(source.sky.regions)
  expect(source.dust.sha256).toHaveLength(64)
  expect(source.sky.sha256).toHaveLength(64)
})

it('refuses a truncated or differently scaled FITS source', () => {
  expect(() => readDustCube(Buffer.alloc(2880))).toThrow('float32')
  const cards = [
    'SIMPLE  = T',
    'BITPIX  = -32',
    'NAXIS   = 3',
    'NAXIS1  = 2',
    'NAXIS2  = 2',
    'NAXIS3  = 2',
    'STEP    = 10',
    'SUN_POSX= 1',
    'SUN_POSY= 1',
    'SUN_POSZ= 1',
    "UNIT    = 'nanomag/pc'",
    'END',
  ]
  const bytes = Buffer.alloc(2880)
  bytes.write(cards.map((c) => c.padEnd(80)).join(''))
  expect(() => readDustCube(bytes)).toThrow('magnitudes per parsec')
  bytes.write("UNIT    = 'A0(550nm)/parsec'".padEnd(80), 10 * 80)
  expect(() => readDustCube(bytes)).toThrow('Truncated')
})

it('averages equal-area HEALPix radiances and includes both hemispheres', () => {
  const rows =
    'header\n0,0,45,1e-7,0,0,2e-7\n1,180,-45,3e-7,0,0,4e-7\n2,0,80,2e-7,0,0,3e-7\n3,45,-2,4e-7,0,0,5e-7'
  expect(
    extractSky(rows).map((r) => [r.pixels, r.vNanowatts, r.photopicNanowatts]),
  ).toEqual([
    [2, 200, 300],
    [1, 200, 300],
    [1, 400, 500],
  ])
  expect(() => extractSky('header\n0,not-a-longitude')).toThrow('Invalid')
})
