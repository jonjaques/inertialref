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
  appliesWeather = true,
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
    cloudSystemFactory: available ? { appliesWeather } : null,
    sensorDiagnostics,
    // The deckless body's system loads when the test says so; Earth's is
    // loaded from the start.
    bodyFor(address) {
      if (address === EARTH) return earth
      return address === decklessAddress && this.loaded ? deckless : null
    },
  }
}

function reportOf(
  levers: CloudLevers,
  served: string | null,
  appliedWeather = served === null ? null : levers.weather,
): CloudRenderReport {
  return {
    ...cloudReportIdle(),
    on: served !== null,
    levers: { ...levers },
    served,
    appliedWeather,
  }
}

describe('a picture’s weather as levers', () => {
  const page = {
    available: true,
    appliesWeather: true,
    served: false,
    address: EARTH,
  }

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

  it('keeps the volume on over the served set for no weather on a page that draws the clouds unasked', () => {
    const lit = { ...DEFAULT_CLOUD_LEVERS, on: true, served: EARTH }
    expect(
      pictureWeatherLevers(lit, null, { ...page, byDefault: true }),
    ).toEqual({
      levers: { ...lit, on: true, served: null },
      outcome: 'none',
    })
    // An unknown regime still turns the volume off.
    expect(
      pictureWeatherLevers(
        lit,
        { regime: 'squall-line' },
        { ...page, byDefault: true },
      ).levers.on,
    ).toBe(false)
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
  it.each(['fair-cumulus', 'climate'])(
    'takes %s on the port with the volume on and the renderer’s weather',
    (regime) => {
      const page = engine(true, null, false)
      const hold = new PictureWeatherHold()
      expect(hold.apply(page, { regime }, EARTH)).toBe('renderer-default')
      expect(page.clouds).toMatchObject({
        on: true,
        weather: regime,
        served: EARTH,
      })
    },
  )

  it('reads the applied weather from the frame even when the requested levers match', () => {
    const diagnostics: { clouds: CloudRenderReport | null } = { clouds: null }
    const page = engine(true, diagnostics)
    const hold = new PictureWeatherHold()
    hold.apply(page, { regime: 'fair-cumulus' }, EARTH)
    page.aim(EARTH)
    diagnostics.clouds = reportOf(page.clouds, EARTH, null)
    hold.frame(page, true)
    expect(hold.outcome).toBe('renderer-default')

    diagnostics.clouds = reportOf(page.clouds, null)
    hold.frame(page, true)
    expect(hold.outcome).toBe('unavailable')
  })

  it('reports unavailable when a linked port falls back to WebGL before presenting', () => {
    const diagnostics: { clouds: CloudRenderReport | null } = { clouds: null }
    const page = engine(true, diagnostics, false)
    const hold = new PictureWeatherHold()
    hold.apply(page, { regime: 'fair-cumulus' }, EARTH)
    page.aim(EARTH)
    diagnostics.clouds = cloudReportIdle('webgl')
    hold.frame(page, true)
    expect(hold.outcome).toBe('unavailable')
  })

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
    const arrived = { ...page, cloudSystemFactory: { appliesWeather: true } }
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

  it('confirms a native take against the body served by a matching frame', () => {
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

  it('turns the volume on and off with the setting while no picture is held, writing only a change', () => {
    const page = engine()
    const hold = new PictureWeatherHold()
    hold.setDefault(page, false)
    expect(page.writes).toBe(0)
    hold.setDefault(page, true)
    expect(page.clouds).toEqual({ ...DEFAULT_CLOUD_LEVERS, on: true })
    hold.setDefault(page, true)
    expect(page.writes).toBe(1)
    hold.setDefault(page, false)
    expect(page.clouds).toEqual(DEFAULT_CLOUD_LEVERS)
  })

  it('keeps the clouds on through a picture without weather while the setting is on', () => {
    const page = engine()
    const hold = new PictureWeatherHold()
    hold.setDefault(page, true)
    hold.apply(page, null, EARTH)
    expect(page.clouds).toMatchObject({ on: true, served: null })
    hold.release(page)
    expect(page.clouds).toEqual({ ...DEFAULT_CLOUD_LEVERS, on: true })
  })

  it('takes a held picture again under a changed setting, so leaving it puts back the new one', () => {
    const page = engine()
    const hold = new PictureWeatherHold()
    // An ordinary picture, taken with the setting off: the volume off.
    hold.apply(page, null, decklessAddress)
    expect(page.clouds.on).toBe(false)
    hold.setDefault(page, true)
    expect(page.clouds).toMatchObject({ on: true, served: null })
    hold.release(page)
    expect(page.clouds.on).toBe(true)
    // A picture's own weather survives the change, and the release still
    // lands on the setting it was changed to.
    hold.apply(page, { regime: 'overcast' }, EARTH)
    hold.setDefault(page, false)
    expect(page.clouds).toMatchObject({
      on: true,
      weather: 'overcast',
      served: EARTH,
    })
    hold.release(page)
    expect(page.clouds).toEqual(DEFAULT_CLOUD_LEVERS)
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
