import { describe, expect, it } from 'vitest'
import { cloudReportIdle } from '@inertialref/devtools'
import {
  type Body,
  findBody,
  formatAddress,
  galaxySeedOf,
  generateSystem,
  MILKY_WAY,
  resolveSystem,
  SOL_ONLY_CATALOG,
  systemId,
} from '@inertialref/universe'
import { rootSeed } from '@inertialref/procedural'
import {
  type CloudLevers,
  DEFAULT_CLOUD_LEVERS,
} from '../render/cloudLevers.ts'
import {
  type PictureWeatherEngine,
  PictureWeatherHold,
  pictureWeatherLevers,
} from './pictureWeather.ts'

/*
 * A picture's weather against real records: Earth, wet and still wearing its
 * authored deck, and Earth's record with the deck taken away, which is what
 * the served set admits unasked.
 */

const ROOT = rootSeed('inertialref')
const sol = generateSystem(
  ROOT,
  MILKY_WAY,
  resolveSystem(
    galaxySeedOf(ROOT, MILKY_WAY),
    SOL_ONLY_CATALOG,
    systemId('SOL'),
  )!,
)
const earth = findBody(sol, [2])!
const EARTH = formatAddress(earth.address)
const decklessAddress = 'g:milky-way/s:SOL/b:2-deckless'
const deckless: Body = {
  ...earth,
  appearance: { ...earth.appearance, clouds: null },
}

/*
 * The diagnostics are a parameter, not a spread over a built engine: a
 * spread copies `clouds` as a plain value and drops the setter that counts
 * the writes, so a count read from a spread copy is zero whatever happens.
 */
function engine(
  available = true,
  sensorDiagnostics: PictureWeatherEngine['sensorDiagnostics'] = null,
): PictureWeatherEngine & {
  writes: number
} {
  let levers: CloudLevers = DEFAULT_CLOUD_LEVERS
  return {
    writes: 0,
    get clouds() {
      return levers
    },
    set clouds(next) {
      this.writes += 1
      levers = Object.freeze({ ...next })
    },
    cloudsAvailable: available,
    sensorDiagnostics,
    bodyFor: (address) =>
      address === EARTH ? earth : address === decklessAddress ? deckless : null,
  }
}

describe('a picture’s weather as levers', () => {
  const page = { available: true, served: false, address: EARTH }

  it('draws a known regime, and forces a body outside the served set by its address', () => {
    const { levers, outcome } = pictureWeatherLevers(
      DEFAULT_CLOUD_LEVERS,
      { regime: 'cirrus-over-cumulus' },
      page,
    )
    expect(outcome).toBe('drawn')
    expect(levers).toEqual({
      ...DEFAULT_CLOUD_LEVERS,
      on: true,
      scenario: 'cirrus-over-cumulus',
      served: EARTH,
    })
    // Inside the set, nothing is forced.
    expect(
      pictureWeatherLevers(
        DEFAULT_CLOUD_LEVERS,
        { regime: 'overcast' },
        { ...page, served: true },
      ).levers.served,
    ).toBeNull()
  })

  it('turns the volume off for no weather, for weather the page cannot draw, and for a regime it does not know', () => {
    const lit = { ...DEFAULT_CLOUD_LEVERS, on: true, served: EARTH }
    expect(pictureWeatherLevers(lit, null, page)).toEqual({
      levers: { ...lit, on: false, served: null },
      outcome: 'none',
    })
    for (const [weather, available] of [
      [{ regime: 'fair-cumulus' }, false],
      [{ regime: 'squall-line' }, true],
      // A climate needs the contracts' lever; until then it is not drawn.
      [{ regime: 'climate' }, true],
    ] as const)
      expect(
        pictureWeatherLevers(lit, weather, { ...page, available }),
      ).toEqual({
        levers: { ...lit, on: false, served: null },
        outcome: 'unavailable',
      })
  })

  it('writes the three levers a picture owns and leaves every other one as it was', () => {
    const tuned = { ...DEFAULT_CLOUD_LEVERS, stats: true, maxSteps: 64 }
    const { levers } = pictureWeatherLevers(
      tuned,
      { regime: 'fair-cumulus' },
      page,
    )
    expect({
      ...levers,
      on: false,
      scenario: 'fair-cumulus',
      served: null,
    }).toEqual({
      ...tuned,
      on: false,
      scenario: 'fair-cumulus',
      served: null,
    })
  })
})

describe('the hold', () => {
  it('forces Earth for its picture, and puts back what it found when the pictures are left', () => {
    const page = engine()
    page.clouds = { ...page.clouds, stats: true }
    const hold = new PictureWeatherHold()
    expect(hold.apply(page, { regime: 'fair-cumulus' }, EARTH)).toBe('drawn')
    expect(page.clouds).toMatchObject({
      on: true,
      scenario: 'fair-cumulus',
      served: EARTH,
      stats: true,
    })
    expect(hold.outcome).toBe('drawn')
    // Still observing: nothing moves.
    hold.frame(page, true)
    expect(page.clouds.served).toBe(EARTH)
    // The observatory let go: the picture's force goes with it.
    hold.frame(page, false)
    expect(page.clouds).toEqual({ ...DEFAULT_CLOUD_LEVERS, stats: true })
    expect(hold.outcome).toBe('none')
    // And a second release changes nothing.
    const writes = page.writes
    hold.frame(page, false)
    expect(page.writes).toBe(writes)
  })

  it('serves a body inside the set without forcing it, and starts each picture from the levers the first one found', () => {
    const page = engine()
    page.clouds = { ...page.clouds, on: true, scenario: 'anvil' }
    const hold = new PictureWeatherHold()
    hold.apply(page, { regime: 'stratocumulus' }, decklessAddress)
    expect(page.clouds).toMatchObject({
      on: true,
      scenario: 'stratocumulus',
      served: null,
    })
    hold.apply(page, null, EARTH)
    expect(page.clouds).toMatchObject({ on: false, served: null })
    hold.apply(page, { regime: 'overcast' }, EARTH)
    expect(page.clouds).toMatchObject({ on: true, served: EARTH })
    hold.release(page)
    expect(page.clouds).toEqual({
      ...DEFAULT_CLOUD_LEVERS,
      on: true,
      scenario: 'anvil',
    })
  })

  it('draws weather asked for before the page’s clouds arrived, on the first frame they have', () => {
    const page = engine(false)
    const hold = new PictureWeatherHold()
    expect(hold.apply(page, { regime: 'fair-cumulus' }, EARTH)).toBe(
      'unavailable',
    )
    hold.frame(page, true)
    expect(hold.outcome).toBe('unavailable')
    // The chunk lands: the next frame draws the picture's weather.
    const arrived = { ...page, cloudsAvailable: true }
    hold.frame(arrived, true)
    expect(hold.outcome).toBe('drawn')
    expect(arrived.clouds).toMatchObject({ on: true, served: EARTH })
    // Once: a page that cannot draw it is not asked every frame.
    const webgl = engine(true, { clouds: cloudReportIdle('webgl') })
    const once = new PictureWeatherHold()
    once.apply(webgl, { regime: 'overcast' }, EARTH)
    const writes = webgl.writes
    // The count is live: the apply wrote the levers once.
    expect(writes).toBeGreaterThan(0)
    once.frame(webgl, true)
    once.frame(webgl, true)
    expect(webgl.writes).toBe(writes)
  })

  it('reports weather on a page without the clouds, or on WebGL, unavailable', () => {
    const hold = new PictureWeatherHold()
    expect(hold.apply(engine(false), { regime: 'overcast' }, EARTH)).toBe(
      'unavailable',
    )
    const webgl = engine(true, { clouds: cloudReportIdle('webgl') })
    expect(
      new PictureWeatherHold().apply(webgl, { regime: 'overcast' }, EARTH),
    ).toBe('unavailable')
  })
})
