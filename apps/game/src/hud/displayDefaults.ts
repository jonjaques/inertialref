import {
  RENDER_GAMMA,
  RENDER_HDR,
  RENDER_LENS_FLARE,
  RENDER_PICTURE,
  RENDER_SENSOR,
  RENDER_SHIP,
  RENDER_SURFACE,
  RENDER_THRUSTER_VARIATION,
  resetPreference,
  restoreFields,
  usePersistentState,
} from '../state/preferences.ts'

/**
 * Which of the display page's rows differ from their defaults, and the verb
 * that puts every one of them back.
 *
 * By row rather than by preference, because a preference here is sometimes a
 * record of several rows — the picture is anti-aliasing, scale and sharpness —
 * and "restore 1 setting" over three changed rows is a count nobody can check.
 *
 * **The sensor is restored by the fields this page draws.** `render.sensor`
 * holds a photograph's processing — its mode, its compensation, its white
 * balance — beside the person's comfort clamps and peak luminance, in one
 * record, and only the second half is on this page. Resetting the record
 * would undo a camera mode chosen in a viewport's own Lens panel from a page
 * that never showed it.
 */
export interface DisplayDefaults {
  readonly rows: {
    readonly hdr: boolean
    readonly peak: boolean
    readonly gamma: boolean
    readonly rate: boolean
    readonly bright: boolean
    readonly dark: boolean
    readonly aa: boolean
    readonly scale: boolean
    readonly sharpness: boolean
    readonly flare: boolean
    readonly terrain: boolean
    readonly ground: boolean
    readonly sea: boolean
    readonly rocks: boolean
    readonly ship: boolean
    readonly thrusters: boolean
  }
  /** How many rows differ. */
  readonly changed: number
  readonly restore: () => void
}

/** Restored whole: every field of these is a row on the display page. */
const WHOLE = [
  RENDER_HDR,
  RENDER_PICTURE,
  RENDER_GAMMA,
  RENDER_LENS_FLARE,
  RENDER_SURFACE,
  RENDER_SHIP,
  RENDER_THRUSTER_VARIATION,
] as const

export function useDisplayDefaults(): DisplayDefaults {
  const [hdr] = usePersistentState(RENDER_HDR)
  const [picture] = usePersistentState(RENDER_PICTURE)
  const [gamma] = usePersistentState(RENDER_GAMMA)
  const [flare] = usePersistentState(RENDER_LENS_FLARE)
  const [surface] = usePersistentState(RENDER_SURFACE)
  const [ship] = usePersistentState(RENDER_SHIP)
  const [thrusters] = usePersistentState(RENDER_THRUSTER_VARIATION)
  const [sensor] = usePersistentState(RENDER_SENSOR)
  const rows = {
    hdr: hdr !== RENDER_HDR.initial,
    peak: sensor.peak !== RENDER_SENSOR.initial.peak,
    gamma: gamma !== RENDER_GAMMA.initial,
    rate: sensor.rate !== RENDER_SENSOR.initial.rate,
    bright: sensor.range.bright !== RENDER_SENSOR.initial.range.bright,
    dark: sensor.range.dark !== RENDER_SENSOR.initial.range.dark,
    aa: picture.aa !== RENDER_PICTURE.initial.aa,
    scale: picture.scale !== RENDER_PICTURE.initial.scale,
    sharpness: picture.sharpness !== RENDER_PICTURE.initial.sharpness,
    flare: flare !== RENDER_LENS_FLARE.initial,
    terrain: surface.terrain !== RENDER_SURFACE.initial.terrain,
    ground: surface.ground !== RENDER_SURFACE.initial.ground,
    sea: surface.sea !== RENDER_SURFACE.initial.sea,
    rocks: surface.rocks !== RENDER_SURFACE.initial.rocks,
    ship: ship !== RENDER_SHIP.initial,
    thrusters: thrusters !== RENDER_THRUSTER_VARIATION.initial,
  }
  return {
    rows,
    changed: Object.values(rows).filter(Boolean).length,
    restore: () => {
      for (const definition of WHOLE) resetPreference(definition)
      restoreFields(RENDER_SENSOR, ['peak', 'rate', 'range'])
    },
  }
}
