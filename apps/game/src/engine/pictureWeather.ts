import type {
  CloudRenderReport,
  PictureWeather,
  PictureWeatherOutcome,
} from '@inertialref/devtools'
import { cloudsServed } from '@inertialref/rendering'
import type { Body } from '@inertialref/universe'
import {
  CLOUD_WEATHERS,
  type CloudLevers,
  type CloudWeather,
} from '../render/cloudLevers.ts'
import type { CloudChainFactory } from '../render/cloudSystem.ts'

/*
 * A picture's weather as the clouds' levers, and its release.
 *
 * Kept out of `GameEngine.ts`, which sits near the complexity cap, behind a
 * one-line delegate there. A picture writes three levers — whether the
 * volume draws, the requested weather, and the body it is forced onto — and
 * nothing else a script may have set, so a capture that turned `stats` on
 * keeps it through a preset.
 *
 * It releases what it set, as a stance releases the switch it pushed (rule
 * 7): the three levers found before the first picture are put back when
 * the pictures are left, on the observatory's clear, and every later picture
 * starts from them rather than from the last picture's. A picture that
 * forced Earth into the volume does not leave Earth forced.
 */

/** The three levers a picture writes, as it found them. */
type Held = Pick<CloudLevers, 'on' | 'weather' | 'served'>

/** What the engine lends this: its levers, whether it has clouds, and its records. */
export interface PictureWeatherEngine {
  clouds: CloudLevers
  readonly cloudSystemFactory: Pick<CloudChainFactory, 'appliesWeather'> | null
  readonly sensorDiagnostics: {
    readonly clouds: CloudRenderReport | null
  } | null
  bodyFor(address: string): Body | null
  /** The observatory's subject, which a picture's weather lasts as long as. */
  readonly harness: {
    readonly observatory: {
      readonly target: { readonly address: string } | null
    }
  }
}

/**
 * The regime as the `weather` lever's value, or null for one this build does
 * not draw: `'climate'`, the body's own, or the id of a regime it knows.
 */
const weatherOf = (regime: string): CloudWeather | null =>
  (CLOUD_WEATHERS as readonly string[]).includes(regime)
    ? (regime as CloudWeather)
    : null

/**
 * The levers a picture's weather asks for over `found`, and what became of
 * it. Pure, so the mapping is held in Node without an engine.
 *
 * - A known regime on a clouds page: the volume on, the regime as its weather,
 *   and the picture's body forced when it is outside the served set
 *   (`cloudsServed`), which is how the volume draws at all over Earth, with
 *   its authored deck. Inside the set no force is needed, and none is written.
 *   The native march applies the request. The port draws its own weather.
 * - No clouds on the page, no WebGPU, or an unknown regime: the volume off
 *   and nothing forced.
 * - No weather at all: the page's default. Where the player's setting draws
 *   the clouds unasked (`byDefault`), the volume stays on over the served
 *   set, using the port's own weather. Elsewhere, on a page built by `?clouds=`
 *   for a script, it is off.
 */
export function pictureWeatherLevers(
  found: CloudLevers,
  weather: PictureWeather | null,
  page: {
    readonly available: boolean
    readonly appliesWeather: boolean
    readonly served: boolean
    readonly address: string
    readonly byDefault?: boolean
  },
): { readonly levers: CloudLevers; readonly outcome: PictureWeatherOutcome } {
  const off: CloudLevers = { ...found, on: false, served: null }
  if (weather === null)
    return {
      levers: page.byDefault === true ? { ...off, on: true } : off,
      outcome: 'none',
    }
  const requested = weatherOf(weather.regime)
  if (!page.available || requested === null)
    return { levers: off, outcome: 'unavailable' }
  return {
    levers: {
      ...found,
      on: true,
      weather: requested,
      served: page.served ? null : page.address,
    },
    outcome: page.appliesWeather ? 'drawn' : 'renderer-default',
  }
}

/**
 * What a frame served for a picture's levers, once one has drawn them. The
 * levers ask for a body and a weather regime, and only the clouds' report
 * says which they got. A forced address no body in the scene has serves
 * nothing, and an unforced one serves the body whose air the eye is in,
 * which need not be the picture's. A frame serving `address` reports
 * `'drawn'` if it applies the request, or `'renderer-default'` if it uses
 * its own weather. A frame serving another body or none is `'unavailable'`,
 * as is a renderer that cannot draw the clouds. Null while no frame on the
 * report reads these levers.
 */
export function servedOutcome(
  report: CloudRenderReport | null,
  levers: CloudLevers,
  address: string,
): PictureWeatherOutcome | null {
  if (report?.available === false) return 'unavailable'
  if (report?.levers.on !== true) return null
  if (
    report.levers.served !== levers.served ||
    report.levers.weather !== levers.weather
  )
    return null
  if (!report.on || report.served !== address) return 'unavailable'
  if (report.appliedWeather === null) return 'renderer-default'
  return report.appliedWeather === levers.weather ? 'drawn' : 'unavailable'
}

/** The engine's hold on the levers a picture set. */
export class PictureWeatherHold {
  #found: Held | null = null
  #outcome: PictureWeatherOutcome = 'none'
  /**
   * Weather asked for before the page's clouds arrived. `?clouds=1`'s chunk
   * resolves beside the renderer, and a picture in the address bar is taken
   * when the planetarium mounts, which can be first; without this the
   * picture would hold its weather unavailable on a page that has it a few
   * frames later.
   */
  #early: {
    readonly weather: PictureWeather
    readonly address: string
  } | null = null
  /**
   * The observatory's subject the picture stood on, read on the first frame
   * after it was taken, since the picture sets its weather before it moves
   * the camera; undefined until then. The weather lasts while the subject
   * does: a re-aimed observatory is a picture left, though it still has a
   * target, and the forced body must not follow the camera elsewhere.
   */
  #subject: string | null | undefined = undefined
  /**
   * A picture's body by address while its system is not loaded yet.
   * `bodyFor` answers null for a system nothing has loaded, which forces the
   * address; once it loads, the served set decides as it would have, so two
   * takes of one picture end on one set of levers whichever came first.
   */
  #pending: string | null = null
  /** The body the picture's clouds are asked to serve, while they are on. */
  #address: string | null = null
  /** The held picture's weather and body, to take it again under a new default. */
  #taken: {
    readonly weather: PictureWeather | null
    readonly address: string
  } | null = null
  /** Whether the page draws the clouds unasked: the player's setting. */
  #byDefault = false

  /** What became of the last picture's weather, while it is held. */
  get outcome(): PictureWeatherOutcome {
    return this.#outcome
  }

  /** Whether the page draws the clouds unasked. */
  get byDefault(): boolean {
    return this.#byDefault
  }

  /**
   * The player's setting, as the `on` lever. With no picture held it is
   * written straight through, and only when it changes, so a page that never
   * turns the clouds on never writes a lever. With one held it is what the
   * release puts back, and the picture is taken again under it: leaving a
   * picture never restores the setting it was taken under.
   */
  setDefault(engine: PictureWeatherEngine, on: boolean): void {
    if (on === this.#byDefault) return
    this.#byDefault = on
    if (this.#found === null) {
      engine.clouds = { ...engine.clouds, on }
      return
    }
    this.#found = { ...this.#found, on }
    const taken = this.#taken
    if (taken !== null) this.apply(engine, taken.weather, taken.address)
  }

  apply(
    engine: PictureWeatherEngine,
    weather: PictureWeather | null,
    address: string,
  ): PictureWeatherOutcome {
    this.release(engine)
    const levers = engine.clouds
    this.#found = {
      on: levers.on,
      weather: levers.weather,
      served: levers.served,
    }
    const body = engine.bodyFor(address)
    const renderer = engine.cloudSystemFactory
    const next = pictureWeatherLevers(levers, weather, {
      available:
        renderer !== null &&
        (engine.sensorDiagnostics?.clouds?.available ?? true),
      appliesWeather: renderer?.appliesWeather === true,
      served: body !== null && cloudsServed(body),
      address,
      byDefault: this.#byDefault,
    })
    engine.clouds = next.levers
    this.#taken = { weather, address }
    this.#outcome = next.outcome
    this.#subject = undefined
    this.#address = weather !== null && next.levers.on ? address : null
    this.#pending = body === null ? this.#address : null
    this.#early =
      weather !== null && next.outcome === 'unavailable' && renderer === null
        ? { weather, address }
        : null
    return next.outcome
  }

  /** Put back what the first picture found; nothing when no picture is held. */
  release(engine: PictureWeatherEngine): void {
    if (this.#found === null) return
    engine.clouds = { ...engine.clouds, ...this.#found }
    this.#found = null
    this.#taken = null
    this.#outcome = 'none'
    this.#early = null
    this.#subject = undefined
    this.#pending = null
    this.#address = null
  }

  /**
   * A frame's check. The pictures are left when the observatory holds no
   * target, or holds another than the picture's; weather asked for before
   * the clouds arrived is applied again on the first frame they have, once;
   * the outcome follows the body and weather of the last frame drawn with
   * the picture's levers; and a body whose system was not loaded is decided
   * once it is.
   */
  frame(engine: PictureWeatherEngine, observing: boolean): void {
    if (!observing) return this.release(engine)
    if (this.#early !== null && engine.cloudSystemFactory !== null) {
      this.apply(engine, this.#early.weather, this.#early.address)
      return
    }
    if (this.#found === null) return
    const subject = engine.harness.observatory.target?.address ?? null
    if (this.#subject === undefined) this.#subject = subject
    else if (subject !== this.#subject) return this.release(engine)
    if (this.#address !== null)
      this.#outcome =
        servedOutcome(
          engine.sensorDiagnostics?.clouds ?? null,
          engine.clouds,
          this.#address,
        ) ?? this.#outcome
    if (this.#pending === null) return
    const body = engine.bodyFor(this.#pending)
    if (body === null) return
    const served = cloudsServed(body) ? null : this.#pending
    if (engine.clouds.served !== served)
      engine.clouds = { ...engine.clouds, served }
    this.#pending = null
  }
}
