import { describe, expect, it } from 'vitest'
import { type CloudRenderReport, cloudReportIdle } from '@inertialref/devtools'
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
  servedOutcome,
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
  loaded: boolean
  aim: (address: string | null) => void
} {
  let levers: CloudLevers = DEFAULT_CLOUD_LEVERS
  let target: { address: string } | null = null
  return {
    loaded: true,
    aim: (address) => {
      target = address === null ? null : { address }
    },
    harness: {
      observatory: {
        get target() {
          return target
        },
      },
    },
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
    // The deckless body's system loads when the test says so; Earth's is
    // loaded from the start.
    bodyFor(address) {
      if (address === EARTH) return earth
      return address === decklessAddress && this.loaded ? deckless : null
    },
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
      weather: 'cirrus-over-cumulus',
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
      [{ regime: 'climate' }, false],
      [{ regime: 'squall-line' }, true],
    ] as const)
      expect(
        pictureWeatherLevers(lit, weather, { ...page, available }),
      ).toEqual({
        levers: { ...lit, on: false, served: null },
        outcome: 'unavailable',
      })
  })

  it('draws a climate as the lever’s own value: the body’s weather, by no regime’s id', () => {
    const { levers, outcome } = pictureWeatherLevers(
      { ...DEFAULT_CLOUD_LEVERS, weather: 'anvil' },
      { regime: 'climate' },
      page,
    )
    expect(outcome).toBe('drawn')
    expect(levers).toMatchObject({
      on: true,
      weather: 'climate',
      served: EARTH,
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
      weather: 'fair-cumulus',
      served: null,
    }).toEqual({
      ...tuned,
      on: false,
      weather: 'fair-cumulus',
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
      weather: 'fair-cumulus',
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
    page.clouds = { ...page.clouds, on: true, weather: 'anvil' }
    const hold = new PictureWeatherHold()
    hold.apply(page, { regime: 'stratocumulus' }, decklessAddress)
    expect(page.clouds).toMatchObject({
      on: true,
      weather: 'stratocumulus',
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
      weather: 'anvil',
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

  it('lets the picture go when the observatory is aimed at another subject, and not while it stands on the picture’s', () => {
    const page = engine()
    const hold = new PictureWeatherHold()
    hold.apply(page, { regime: 'fair-cumulus' }, EARTH)
    // The picture moves the camera after it sets its weather.
    page.aim(EARTH)
    hold.frame(page, true)
    hold.frame(page, true)
    expect(page.clouds).toMatchObject({ on: true, served: EARTH })
    // Picked another body in the planetarium: still a target, not the picture.
    page.aim('g:milky-way/s:SOL/b:3')
    hold.frame(page, true)
    expect(page.clouds).toEqual(DEFAULT_CLOUD_LEVERS)
    expect(hold.outcome).toBe('none')
    // A station's picture stands on the station and serves Earth's clouds.
    const station = engine()
    const guard = new PictureWeatherHold()
    guard.apply(station, { regime: 'fair-cumulus' }, EARTH)
    station.aim('g:milky-way/s:SOL/b:2/a:0')
    guard.frame(station, true)
    guard.frame(station, true)
    expect(station.clouds.served).toBe(EARTH)
  })

  it('ends on the levers a loaded system gives, whether the picture came before its system or after', () => {
    const loaded = engine()
    new PictureWeatherHold().apply(
      loaded,
      { regime: 'stratocumulus' },
      decklessAddress,
    )
    // Before: nothing knows the body yet, so its address is forced.
    const early = engine()
    early.loaded = false
    const hold = new PictureWeatherHold()
    hold.apply(early, { regime: 'stratocumulus' }, decklessAddress)
    expect(early.clouds.served).toBe(decklessAddress)
    early.aim(decklessAddress)
    hold.frame(early, true)
    expect(early.clouds.served).toBe(decklessAddress)
    // The system loads: the served set decides, as it did for the other.
    early.loaded = true
    hold.frame(early, true)
    expect(early.clouds).toEqual(loaded.clouds)
    expect(early.clouds.served).toBeNull()
  })

  it('reads drawn only once a frame drawn with its levers served the picture’s body', () => {
    // What the system reports after a frame drawn with `levers`, serving
    // `served`: `on` is whether that frame drew anything.
    const reportOf = (
      levers: CloudLevers,
      served: string | null,
    ): CloudRenderReport => ({
      ...cloudReportIdle(),
      on: served !== null,
      levers: { ...levers },
      served,
    })
    const diagnostics: { clouds: CloudRenderReport | null } = { clouds: null }
    const page = engine(true, diagnostics)
    const hold = new PictureWeatherHold()
    const station = 'g:milky-way/s:SOL/a:9'
    expect(hold.apply(page, { regime: 'fair-cumulus' }, station)).toBe('drawn')
    page.aim(station)
    // No frame has drawn these levers yet: the request stands.
    hold.frame(page, true)
    expect(hold.outcome).toBe('drawn')
    diagnostics.clouds = reportOf(DEFAULT_CLOUD_LEVERS, EARTH)
    hold.frame(page, true)
    expect(hold.outcome).toBe('drawn')
    // A frame drew them over an address no body has, and served nothing.
    diagnostics.clouds = reportOf(page.clouds, null)
    hold.frame(page, true)
    expect(hold.outcome).toBe('unavailable')
    expect(page.clouds).toMatchObject({ on: true, served: station })
    // Unforced, the eye in another body's air: served, and not the picture's.
    const levers = { ...page.clouds, served: null }
    expect(servedOutcome(reportOf(levers, EARTH), levers, EARTH)).toBe('drawn')
    expect(
      servedOutcome(reportOf(levers, 'g:milky-way/s:SOL/b:3'), levers, EARTH),
    ).toBe('unavailable')
    // Released, the report's outcome goes with the picture.
    hold.release(page)
    hold.frame(page, true)
    expect(hold.outcome).toBe('none')
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
