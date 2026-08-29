import { FLIGHT_FOV, findComposition } from '@inertialref/rendering'

/*
 * Pictures: the same frame, every time it is pressed.
 *
 * A composition is relative to whatever is under the camera — a phase, a tilt
 * and a standoff — and none of the sixteen is a picture of a *particular*
 * place. That is right for what they are and it is not what a review needs:
 * "the same picture, every time" is exactly what a before/after plate is, and
 * the geology phase is judged on those. So a picture is a composition plus the
 * two things a composition deliberately leaves out — an address, and a lens.
 *
 * **Here rather than in the planetarium panel that draws them**, and the reason
 * is `ir.preset`. `window.ir` *is* the harness, so a verb the panel offers and
 * the console cannot reach would break the rule this repository has held since
 * the first nav panel: the browser interface must not be able to do something
 * the headless runner and a test cannot replay. The panel's own presentation —
 * the plate path, the glyph — stays in the app, where a URL is a thing that
 * exists.
 *
 * The list is a judgment, and it is meant to be edited. Each is chosen from
 * what the renderer already does well today rather than from what the geology
 * will do later; a standing picture of terrain joins them when Phase 2 gives it
 * a geology to stand on, and the mechanism is the stance the Surface panel
 * already produces.
 */

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

export interface Picture {
  /** Stable across a rename of the label — this is what `ir.preset` takes. */
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
}

export const PICTURES: readonly Picture[] = [
  {
    id: 'earthrise',
    label: 'Earthrise',
    why: 'Earth over the lunar limb, the horizon in the lower third',
    // Luna. The subject of the picture is Earth and the ground is Luna's, which
    // is the whole reason this one needs a framing of its own.
    address: 's:SOL/b:2.0',
    framing: { kind: 'rise' },
  },
  {
    id: 'blue-marble',
    label: 'Blue Marble',
    why: 'the whole lit face, north a little high — the Apollo framing',
    address: 's:SOL/b:2',
    framing: { kind: 'compose', composition: 'blue-marble' },
    fovDeg: FLIGHT_FOV,
  },
  {
    id: 'night-side',
    label: 'Night Side',
    why: 'the dark disk inside its own airglow, the cities showing',
    address: 's:SOL/b:2',
    framing: { kind: 'compose', composition: 'backlit' },
    fovDeg: FLIGHT_FOV,
  },
  {
    id: 'the-rings',
    label: 'The Rings',
    why: 'up over the plane, gibbous, the rings open across the frame',
    address: 's:SOL/b:5',
    framing: { kind: 'compose', composition: 'high-angle' },
    // Wider than the flight lens, because the ring system is 2.3 times Saturn's
    // own diameter and a framing solved against the planet's radius puts the A
    // ring's outer edge off both sides at 65°.
    fovDeg: 80,
  },
  {
    id: 'titans-haze',
    label: 'Titan’s Haze',
    why: 'a rim-lit crescent — the thickest atmosphere in the model',
    address: 's:SOL/b:5.5',
    framing: { kind: 'compose', composition: 'crescent' },
    fovDeg: FLIGHT_FOV,
  },
  {
    id: 'raking-mars',
    label: 'Raking Mars',
    why: 'light along the surface at its lowest, where relief is longest',
    address: 's:SOL/b:3',
    framing: { kind: 'compose', composition: 'raking' },
    fovDeg: FLIGHT_FOV,
  },
  {
    id: 'jupiter-and-company',
    label: 'Jupiter and Company',
    why: 'the planet small and the Galileans strung out beside it',
    address: 's:SOL/b:4',
    framing: { kind: 'compose', composition: 'wide' },
    fovDeg: FLIGHT_FOV,
  },
]

export const pictureIds = (): readonly string[] => PICTURES.map((one) => one.id)

export function findPicture(id: string): Picture {
  const found = PICTURES.find((one) => one.id === id)
  if (found === undefined) {
    throw new Error(`Unknown picture "${id}". Try: ${pictureIds().join(', ')}`)
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
