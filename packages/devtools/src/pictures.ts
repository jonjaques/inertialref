import type { Quat } from '@inertialref/spatial'
import bundledCornerstones from './cornerstones.json' with { type: 'json' }
import bundledPictures from './pictures.json' with { type: 'json' }
import { decodePictures } from './pictureFormat.ts'
import type {
  Lens,
  ObserverState,
  LookOffset,
  SurfaceStance,
} from '@inertialref/rendering'
import { findComposition } from '@inertialref/rendering'
import type { PictureProcessing } from './pictureProcessing.ts'
export {
  DEFAULT_PICTURE_PROCESSING,
  captureCameraProcessing,
  type PictureProcessing,
} from './pictureProcessing.ts'

/** Bundled planetarium shots use the same JSON decoder as personal imports. */

/**
 * The plate for a picture: its file name, and the size it is captured at.
 *
 * Here rather than in the capture script, because three places have to agree
 * about it and only two of them can import a `.mjs`: `scripts/presets/plates.mjs`
 * writes the file, `scripts/presets/check.mjs` gates that it exists, and
 * `PictureCard` requests it over HTTP. Written out in the component instead,
 * changing the format leaves the check green — it validates the files it named
 * — while every card in the panel falls through to its "no plate" state, which
 * is exactly the silent rot the gate exists to make loud.
 *
 * 3:2, because that is the grid the cards are drawn in and a plate cropped by
 * CSS is a composition nobody chose. 480 wide is twice the widest a card is
 * ever drawn at, which covers a 2× display and nothing more — these are
 * committed files and seven of them at 1600 px would be a megabyte of
 * repository for pixels no screen shows.
 */
export const PLATE_WIDTH = 480
export const PLATE_HEIGHT = 320
export const plateName = (id: string): string => `${id}.jpg`

/** What a picture asks the camera to do. */
export type PictureFraming =
  | { readonly kind: 'compose'; readonly composition: string }
  /**
   * A rise: stand on this body with its parent over the horizon.
   *
   * No composition id, because a rise is the one framing that names two bodies
   * and there is nothing for a phase and a standoff to be relative to. The lens
   * is solved rather than stated for the same reason — see `riseFov`.
   */
  | { readonly kind: 'rise' }
  | {
      readonly kind: 'camera'
      /** Orientation of the orbit controls relative to universe axes. */
      readonly basis?: Quat
      /** A second body holds the composition as the pair moves. */
      readonly tracking?: {
        readonly address: string
        readonly referenceTime: number
      }
      readonly state: ObserverState
      readonly look: LookOffset
      readonly surface: SurfaceStance | null
    }

/**
 * What a picture adds to its instant: the clouds drawn at it.
 *
 * A body's weather is a function of its record, the place and the instant,
 * so a picture already holds the climate's weather by holding its time.
 * What it cannot derive is that the volume draws at all while its default
 * is off, and a regime standing in for the climate.
 */
export interface PictureWeather {
  /**
   * `'climate'`, the body's own, or the id of a regime held over the whole
   * body (`SCENARIO_IDS`): the picture stands where the climate would have
   * that weather. A string rather than the union, because a picture naming a
   * regime this build does not know still decodes and reports its weather
   * unavailable.
   */
  readonly regime: string
}

export interface Picture {
  /** Stable across a rename of the label — this is what `ir.preset` takes. */
  readonly generation: Readonly<Record<string, number>>
  readonly seed: string
  /** Seconds from J2000, held independently of the simulation. */
  readonly time: number
  /** Null focus represents infinity in JSON. */
  readonly lens?: Omit<Lens, 'focus'> & { readonly focus: number | null }
  /** Absent in version 1, which restores the Enhanced defaults. */
  readonly processing?: PictureProcessing
  readonly id: string
  readonly label: string
  /** One line: what the picture is, in the universe's voice. */
  readonly why: string
  /** Where the camera goes. A body, always — a picture is of somewhere. */
  readonly address: string
  readonly framing: PictureFraming
  /**
   * The vertical field the picture is composed at, degrees.
   *
   * Stated rather than inherited, because a picture is a promise about a frame
   * and the lens is half of one: `Jupiter and Company` needs the Galileans in
   * shot and `Titan's Haze` needs the shell to fill it, and those are different
   * angles. Absent for a rise, which solves its own — the parent's angular size
   * spans twenty-two to one across the pairs this has to work for.
   */
  readonly fovDeg?: number
  /** Absent before version 3, and on any picture that holds no weather. */
  readonly weather?: PictureWeather
}

export const PICTURES: readonly Picture[] = decodePictures(bundledPictures)

/**
 * The pictures the weather is judged on, in their own list (ADR-0067).
 *
 * Presets in every respect a script can reach — `ir.preset`, `?preset=`,
 * `drive.mjs --preset` — and in none a player can: the planetarium's
 * lists, "Export all", the tour and `presets:check` read `PICTURES` alone.
 * Nine pictures of clouds the volume does not yet draw well belong in no
 * menu, and each is taken before the work that judges it.
 */
export const CORNERSTONES: readonly Picture[] =
  decodePictures(bundledCornerstones)

export const pictureIds = (): readonly string[] => PICTURES.map((one) => one.id)

/** A shipped picture, then a cornerstone; the two id sets are disjoint. */
export function findPicture(id: string): Picture {
  const found =
    PICTURES.find((one) => one.id === id) ??
    CORNERSTONES.find((one) => one.id === id)
  if (found === undefined) {
    throw new Error(
      `Unknown picture "${id}". Try: ${[...pictureIds(), ...CORNERSTONES.map((one) => one.id)].join(', ')}`,
    )
  }
  return found
}

/**
 * Whether every picture names a composition this build has.
 *
 * Read by `pnpm presets:check`, which also proves each one resolves in the
 * catalog and carries a plate — the same three claims `brand:check` makes about
 * the mark, for the same reason: a preset that has quietly stopped resolving is
 * a button that throws out of an onClick, and the phase that depends on these
 * is a review.
 */
export function unresolvedCompositions(): readonly string[] {
  const missing: string[] = []
  for (const picture of PICTURES) {
    if (picture.framing.kind !== 'compose') continue
    try {
      findComposition(picture.framing.composition)
    } catch {
      missing.push(
        `${picture.id} names composition ${picture.framing.composition}`,
      )
    }
  }
  return missing
}
