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

/*
 * A picture's weather as the clouds' levers, and its release.
 *
 * Kept out of `GameEngine.ts`, which sits near the complexity cap, behind a
 * one-line delegate there. A picture writes three levers — whether the
 * volume draws, the regime it draws, and the body it is forced onto — and
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
  readonly cloudsAvailable: boolean
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
 * - Weather the page can draw: the volume on, the regime as its weather,
 *   and the picture's body forced when it is outside the served set
 *   (`cloudsServed`), which is how Earth, with its authored deck, is drawn
 *   at all. Inside the set no force is needed, and none is written.
 * - Weather it cannot — no `?clouds=1`, no WebGPU, an unknown regime — and
 *   no weather at all: the volume off and nothing forced. A picture never
 *   draws a weather other than the one it names. Phase 2 turns the
 *   no-weather branch to the default set when the default turns on.
 */
export function pictureWeatherLevers(
  found: CloudLevers,
  weather: PictureWeather | null,
  page: {
    readonly available: boolean
    readonly served: boolean
    readonly address: string
  },
): { readonly levers: CloudLevers; readonly outcome: PictureWeatherOutcome } {
  const off: CloudLevers = { ...found, on: false, served: null }
  if (weather === null) return { levers: off, outcome: 'none' }
  const drawn = weatherOf(weather.regime)
  if (!page.available || drawn === null)
    return { levers: off, outcome: 'unavailable' }
  return {
    levers: {
      ...found,
      on: true,
      weather: drawn,
      served: page.served ? null : page.address,
    },
    outcome: 'drawn',
  }
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

  /** What became of the last picture's weather, while it is held. */
  get outcome(): PictureWeatherOutcome {
    return this.#outcome
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
    const next = pictureWeatherLevers(levers, weather, {
      available:
        engine.cloudsAvailable &&
        (engine.sensorDiagnostics?.clouds?.available ?? true),
      served: body !== null && cloudsServed(body),
      address,
    })
    engine.clouds = next.levers
    this.#outcome = next.outcome
    this.#subject = undefined
    this.#pending = next.outcome === 'drawn' && body === null ? address : null
    this.#early =
      weather !== null &&
      next.outcome === 'unavailable' &&
      !engine.cloudsAvailable
        ? { weather, address }
        : null
    return next.outcome
  }

  /** Put back what the first picture found; nothing when no picture is held. */
  release(engine: PictureWeatherEngine): void {
    if (this.#found === null) return
    engine.clouds = { ...engine.clouds, ...this.#found }
    this.#found = null
    this.#outcome = 'none'
    this.#early = null
    this.#subject = undefined
    this.#pending = null
  }

  /**
   * A frame's check. The pictures are left when the observatory holds no
   * target, or holds another than the picture's; weather asked for before
   * the clouds arrived is applied again on the first frame they have, once;
   * and a body whose system was not loaded is decided once it is.
   */
  frame(engine: PictureWeatherEngine, observing: boolean): void {
    if (!observing) return this.release(engine)
    if (this.#early !== null && engine.cloudsAvailable) {
      this.apply(engine, this.#early.weather, this.#early.address)
      return
    }
    if (this.#found === null) return
    const subject = engine.harness.observatory.target?.address ?? null
    if (this.#subject === undefined) this.#subject = subject
    else if (subject !== this.#subject) return this.release(engine)
    if (this.#pending === null) return
    const body = engine.bodyFor(this.#pending)
    if (body === null) return
    const served = cloudsServed(body) ? null : this.#pending
    if (engine.clouds.served !== served)
      engine.clouds = { ...engine.clouds, served }
    this.#pending = null
  }
}
