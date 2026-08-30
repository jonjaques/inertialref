import { useEffect, useRef, useState } from 'react'
import {
  type Lens,
  LENS_PRESETS,
  lensForFov,
  FOV_MAX,
  FOV_MIN,
} from '@inertialref/rendering'
import {
  type Accept,
  arrayOf,
  isBoolean,
  isString,
  numberWithin,
  oneOf,
  recordOf,
} from './accept.ts'
import {
  type DockLayout,
  EMPTY_LAYOUT,
  isDockLayout,
  type PaneState,
  BOTH_OPEN,
  isPaneState,
} from '../dock/layout.ts'
import {
  type FloatPositions,
  isFloatPositions,
  NO_FLOATS,
} from '../dock/floating.ts'
import { parseChord } from '../input/chord.ts'
import { isLens, reviveLens } from '../hud/controls.ts'
import { isLabelDensity, isOrbitScope } from '../planetarium/layers.ts'
import { ALL_CLASSES, RADII } from '../planetarium/kinds.ts'
import {
  AA_LEVELS,
  type AaLevel,
  type OutputPreference,
  OUTPUT_PREFERENCES,
} from '../render/output.ts'
import { type TimingLevel, TIMING_LEVELS } from '../engine/browserTiming.ts'
import type { OrbitScope } from '../engine/presentation.ts'
import type { LabelDensity } from '../planetarium/layers.ts'

/*
 * Every preference this build keeps, declared once.
 *
 * There were a dozen of them behind an `Accept` guard each and no census, which
 * is a strange shape for a thing to be in: every value was validated on the way
 * in and nothing could list them, so nothing could export them and a second
 * machine started from the defaults. The guards were the hard part and they
 * were already written; what was missing was the sentence that says *these are
 * the preferences*.
 *
 * A key is not a string here. A call site takes a **definition** — the object
 * below, which carries its own key, its default, its guard and its group — so
 * naming a preference that does not exist is not a typo that silently reads
 * `undefined`, it is a name that does not resolve. The dynamic ones (a
 * section's open state, the four records each mode's workspace keeps) are
 * families: a prefix, one guard, and `of(id)` for the member.
 *
 * **This file holds the only `localStorage` call in `apps/game/src`.** Not for
 * tidiness — the export, the import and the live subscription below are all
 * impossible with the calls spread out, because each of them has to know the
 * whole set. The rule is grep-able for exactly that reason.
 */

/**
 * The prefix every key is stored under.
 *
 * `ir.hud.` rather than `ir.pref.`, and the word is narrower than what it now
 * covers. Widening it is a one-line change that resets every preference on the
 * machine of everybody who has one — the layout they arranged, the lens they
 * chose, the layers they turned off — in exchange for a noun in a key nobody
 * reads. The export below is what was actually missing, and it does not care
 * what the prefix says.
 */
const PREFIX = 'ir.hud.'

/**
 * What a preference is *about*, which is what the settings page groups by.
 *
 * `controls` is also the seam a later phase syncs: `docs/design/ux.md` promises
 * bindings in the save, and this is the subset that would go.
 */
export const PREFERENCE_GROUPS = [
  'display',
  'camera',
  'controls',
  'planetarium',
  'workspace',
] as const

export type PreferenceGroup = (typeof PREFERENCE_GROUPS)[number]

export interface Preference<T> {
  readonly key: string
  readonly group: PreferenceGroup
  /** One line, for the import preview and the data page. */
  readonly what: string
  readonly initial: T
  readonly accept: Accept<T>
  /**
   * What a believed stored value is put back through before it is used.
   *
   * JSON has no infinity: `JSON.stringify({focus: Infinity})` is
   * `{"focus":null}`, and a preference whose round trip is not the identity
   * silently changes on reload. The camera's focus is `Infinity` when the lens
   * is racked to the stop, which is where it spends its whole life — so the
   * default lens came back as `{...DEFAULT_LENS, focus: null}`, compared
   * unequal to the default, and left the panel's Reset control enabled forever
   * on a lens that *was* the default.
   *
   * Rejecting the value in `accept` is the wrong fix: it throws away the other
   * six fields for one that can be restored exactly. This runs after `accept`,
   * so it only ever sees a shape the caller has already believed.
   */
  readonly revive?: (value: T) => T
  /**
   * What to do when this key is absent but an older shape of it is not.
   *
   * A preference that changes shape has three possible behaviors and only one
   * of them is honest: silently reset (the choice is gone), read the old key
   * forever (the new one never becomes canonical), or read the old key *once*,
   * which is this. It runs at the moment the default would have been used, and
   * the new key is written the first time the value actually changes — which
   * keeps "never chose" meaning the default.
   *
   * Returning `null` means there was nothing to migrate.
   */
  readonly migrate?: () => T | null
}

/**
 * A definition with its value type erased — what the census, the export and the
 * import see.
 *
 * The erasure is not a cast in disguise: `accept` is covariant in its predicate
 * type and `initial` is a plain value, so a `Preference<boolean>` *is* one of
 * these. `revive` takes `never` for the same reason — a parameter is
 * contravariant, and `(value: unknown) => unknown` would demand a reviver that
 * accepts a lens it has never seen.
 */
export interface AnyPreference {
  readonly key: string
  readonly group: PreferenceGroup
  readonly what: string
  readonly initial: unknown
  readonly accept: Accept<unknown>
  readonly revive?: (value: never) => unknown
  readonly migrate?: () => unknown
}

export interface AnyFamily {
  readonly prefix: string
  readonly group: PreferenceGroup
  readonly what: string
  readonly of: (id: string) => AnyPreference
}

/** A run of preferences sharing a prefix, a guard and a default. */
export interface PreferenceFamily<T> {
  readonly prefix: string
  readonly group: PreferenceGroup
  readonly what: string
  readonly initial: T
  readonly accept: Accept<T>
  /**
   * One member of the family.
   *
   * `initial` may be overridden per member, which is the one thing a family
   * cannot say once: every section in the app opens except the Camera panel's
   * Optics, which is a page of derived readings rather than controls and is the
   * section a first visit should not have to scroll past. A second family for
   * one section would be two prefixes over one key space.
   */
  readonly of: (id: string, initial?: T) => Preference<T>
}

const define = <T>(preference: Preference<T>): Preference<T> => preference

/**
 * The per-member defaults a family has been asked for, by full key.
 *
 * `of` is the only place a member's own default is stated, and `definitionFor`
 * — which rebuilds a member from a *stored key* on the reset and import paths —
 * has no `initial` to pass. Without this it hands back the family's default:
 * the one section in the app that starts closed reopens on "reset to its
 * default" and then closes again on the next reload, which is a reset
 * contradicting both the default and itself.
 *
 * Filled as a side effect of asking, which is enough because the only keys the
 * two paths can reach are ones something stored — and something stored it by
 * mounting the hook that named the default.
 */
const familyDefaults = new Map<string, unknown>()

const family = <T>(
  spec: Omit<PreferenceFamily<T>, 'of'>,
): PreferenceFamily<T> => ({
  ...spec,
  of: (id, initial) => {
    const key = `${spec.prefix}${id}`
    if (initial !== undefined) familyDefaults.set(key, initial)
    return {
      key,
      group: spec.group,
      what: spec.what,
      initial: (initial ?? familyDefaults.get(key) ?? spec.initial) as T,
      accept: spec.accept,
    }
  },
})

/* ------------------------------------------------------------------------ */
/* display                                                                   */
/* ------------------------------------------------------------------------ */

export const RENDER_HDR = define<OutputPreference>({
  key: 'render.hdr',
  group: 'display',
  what: 'the extended-range override',
  initial: 'auto',
  accept: oneOf(OUTPUT_PREFERENCES),
})

export const RENDER_AA = define<AaLevel>({
  key: 'render.aa',
  group: 'display',
  what: 'supersampling',
  initial: '2x',
  accept: oneOf(AA_LEVELS),
})

export const RENDER_LENS_FLARE = define({
  key: 'render.lensFlare',
  group: 'display',
  what: 'lens flare and diffraction spikes',
  initial: true,
  accept: isBoolean,
})

/* ------------------------------------------------------------------------ */
/* camera                                                                    */
/* ------------------------------------------------------------------------ */

export const CAMERA_LENS = define<Lens>({
  key: 'camera.lens',
  group: 'camera',
  what: 'the lens: focal length, zoom, aperture, focus',
  initial: LENS_PRESETS.flight,
  accept: isLens,
  revive: reviveLens,
  /*
   * `camera.fov` held a single angle; this holds the instrument. The old key is
   * read once, through `lensForFov`, so somebody who moved the slider before
   * the lens landed keeps the picture they chose and gains an aperture they did
   * not.
   */
  migrate: () => {
    const held = readObsolete('camera.fov', numberWithin(FOV_MIN, FOV_MAX))
    return held === null ? null : lensForFov(held)
  },
})

/* ------------------------------------------------------------------------ */
/* controls                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The rebindings, as `{[actionId]: chord | null}`.
 *
 * Overrides only, not the whole table: a stored copy of every binding is a
 * table that stops tracking the defaults, so an action whose default moves is
 * frozen at the old one for everybody who has ever opened the editor. `null` is
 * a deliberate unbind, which is why the value is nullable rather than the entry
 * being absent — absent means "the default" and there has to be a way to say
 * "nothing".
 *
 * The chords are stored serialized, so a hand-edited `"Shift+KeyH"` is legible
 * in devtools. `parseChord` drops anything this build would not have written,
 * including the `Ctrl` and `Meta` combinations the editor refuses.
 */
export const CONTROLS_KEYMAP = define<Readonly<Record<string, string | null>>>({
  key: 'controls.keymap',
  group: 'controls',
  what: 'rebound keys',
  initial: {},
  accept: recordOf(
    (value): value is string | null =>
      value === null ||
      (typeof value === 'string' && parseChord(value) !== null),
  ),
})

/* ------------------------------------------------------------------------ */
/* planetarium                                                               */
/* ------------------------------------------------------------------------ */

export const PLANETARIUM_LABELS = define({
  key: 'planetarium.labels',
  group: 'planetarium',
  what: 'names on the sky',
  initial: true,
  accept: isBoolean,
})

export const PLANETARIUM_LABEL_DENSITY = define<LabelDensity>({
  key: 'planetarium.labelDensity',
  group: 'planetarium',
  what: 'how many names at once',
  initial: 'normal',
  accept: isLabelDensity,
})

export const PLANETARIUM_LABEL_MINOR = define({
  key: 'planetarium.labelMinor',
  group: 'planetarium',
  what: 'whether asteroids take a name slot',
  initial: false,
  accept: isBoolean,
})

export const PLANETARIUM_ORBITS = define({
  key: 'planetarium.orbits',
  group: 'planetarium',
  what: 'orbit traces',
  initial: true,
  accept: isBoolean,
})

export const PLANETARIUM_ORBIT_SCOPE = define<OrbitScope>({
  key: 'planetarium.orbitScope',
  group: 'planetarium',
  what: 'which orbits are traced',
  initial: 'context',
  accept: isOrbitScope,
})

export const PLANETARIUM_SHIP = define({
  key: 'planetarium.ship',
  group: 'planetarium',
  what: 'whether the ship is drawn',
  initial: false,
  accept: isBoolean,
})

export const PLANETARIUM_FLARE = define({
  key: 'planetarium.flare',
  group: 'planetarium',
  what: 'how much of the aperture’s artifact stack shows',
  initial: 1,
  accept: numberWithin(0, 1),
})

/**
 * Whether the first-visit gesture hint has been dismissed.
 *
 * A preference rather than session state, because the hint's whole claim is
 * that it goes away and stays gone: one that came back on the next reload would
 * be an advertisement rather than an introduction.
 */
export const PLANETARIUM_HINTED = define({
  key: 'planetarium.hinted',
  group: 'planetarium',
  what: 'whether the first-visit gesture hint has been seen',
  initial: false,
  accept: isBoolean,
})

export const CATALOGUE_RADIUS = define<string>({
  key: 'planetarium.catalogue.radius',
  group: 'planetarium',
  what: 'the catalog’s survey radius',
  initial: '10',
  accept: oneOf(RADII),
})

export const CATALOGUE_CLASSES = define<readonly string[]>({
  key: 'planetarium.catalogue.classes',
  group: 'planetarium',
  what: 'which object classes the catalog lists',
  initial: ALL_CLASSES,
  // Membership in the live set, not merely "an array of strings". The point of
  // a validator here is the value that survives a *rename* — a stored id no
  // chip answers to parses perfectly and quietly hides a whole class.
  accept: arrayOf(
    (value): value is string =>
      typeof value === 'string' && ALL_CLASSES.includes(value),
  ),
})

export const CATALOGUE_FILTERING = define({
  key: 'planetarium.catalogue.filtering',
  group: 'planetarium',
  what: 'whether the catalog’s filter row is showing',
  initial: false,
  accept: isBoolean,
})

/* ------------------------------------------------------------------------ */
/* workspace                                                                 */
/* ------------------------------------------------------------------------ */

export const DEBUG_ON = define({
  key: 'debug.on',
  group: 'workspace',
  what: 'whether the author’s instruments are disclosed',
  initial: false,
  accept: isBoolean,
})

/**
 * How much of itself the session puts on the browser's performance timeline.
 *
 * Persisted because somebody who turned it on is profiling, and profiling
 * involves reloads — the same argument `DEBUG_ON` makes. It is deliberately
 * *not* mirrored onto the switch by an effect: `main.tsx` reads it once at
 * module scope, before React exists, because boot is what this most wants to
 * measure and an effect would miss the atmosphere bake, every texture upload
 * and the whole pipeline warm. After that the live level is
 * `engine/browserTiming.ts`'s, so `ir.timing('full')` mid-session is not
 * fighting a re-assertion from a render.
 */
export const TIMING_LEVEL = define<TimingLevel>({
  key: 'timing.level',
  group: 'workspace',
  what: 'how much of itself the session puts on the performance timeline',
  initial: 'off',
  accept: oneOf(TIMING_LEVELS),
})

export const SECTION_OPEN = family({
  prefix: 'section.',
  group: 'workspace',
  what: 'a panel section’s open state',
  initial: true,
  accept: isBoolean,
})

export const DOCK_LAYOUT = family<DockLayout>({
  prefix: 'dock.layout.',
  group: 'workspace',
  what: 'where a mode’s panels sit',
  initial: EMPTY_LAYOUT,
  accept: isDockLayout,
})

export const DOCK_FLOATS = family<FloatPositions>({
  prefix: 'dock.floats.',
  group: 'workspace',
  what: 'where a mode’s floating panels sit',
  initial: NO_FLOATS,
  accept: isFloatPositions,
})

export const DOCK_COLLAPSED = family<readonly string[]>({
  prefix: 'dock.collapsed.',
  group: 'workspace',
  what: 'which of a mode’s panels show their header alone',
  initial: [],
  accept: arrayOf(isString),
})

export const DOCK_PANES = family<PaneState>({
  prefix: 'dock.panes.',
  group: 'workspace',
  what: 'whether a mode’s panes are open',
  initial: BOTH_OPEN,
  accept: isPaneState,
})

/**
 * The census. Everything declared above, and the reason export can exist.
 *
 * Written out rather than collected by a side effect in `define`, so the list
 * is a thing a reader can see. `preferences.test.ts` walks this module's own
 * exports and fails when one of them is missing here, which is the half a
 * hand-maintained list cannot be trusted for.
 */
export const REGISTRY: readonly AnyPreference[] = [
  RENDER_HDR,
  RENDER_AA,
  RENDER_LENS_FLARE,
  CAMERA_LENS,
  CONTROLS_KEYMAP,
  PLANETARIUM_LABELS,
  PLANETARIUM_LABEL_DENSITY,
  PLANETARIUM_LABEL_MINOR,
  PLANETARIUM_ORBITS,
  PLANETARIUM_ORBIT_SCOPE,
  PLANETARIUM_SHIP,
  PLANETARIUM_FLARE,
  PLANETARIUM_HINTED,
  CATALOGUE_RADIUS,
  CATALOGUE_CLASSES,
  CATALOGUE_FILTERING,
  DEBUG_ON,
  TIMING_LEVEL,
]

export const FAMILIES: readonly AnyFamily[] = [
  SECTION_OPEN,
  DOCK_LAYOUT,
  DOCK_FLOATS,
  DOCK_COLLAPSED,
  DOCK_PANES,
]

/**
 * The definition a stored key belongs to, or null if this build has none.
 *
 * The exact match first and the prefixes after, which is the only order that
 * works: a family prefix is a proper prefix of every member, and nothing stops
 * a future exact key from starting with one.
 */
export function definitionFor(key: string): AnyPreference | null {
  const exact = REGISTRY.find((preference) => preference.key === key)
  if (exact !== undefined) return exact
  const found = FAMILIES.find((one) => key.startsWith(one.prefix))
  return found === undefined ? null : found.of(key.slice(found.prefix.length))
}

/* ------------------------------------------------------------------------ */
/* Storage — the only `localStorage` in the app                              */
/* ------------------------------------------------------------------------ */

/**
 * The sentinel `readRaw` returns when there is nothing stored.
 *
 * A distinct object rather than `undefined`, because `undefined` is a value a
 * caller may legitimately store and `null` is one `JSON.parse` returns.
 */
const MISSING: unique symbol = Symbol('missing')

/** As much of `Storage` as any of this uses. */
interface StorageLike {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Where preferences are kept: the browser's, or a Map when there is no browser.
 *
 * The fallback is not a test affordance. Every panel imports this module, the
 * suite runs in plain Node with no DOM *by design* — that is the check that
 * keeps the core free of the browser — and a module whose import walks
 * `window` cannot be reached from there at all. The Map is per-process and
 * forgotten at exit, which is exactly what "there is no storage here" means,
 * and it is what lets `import(export())` be a property rather than a claim.
 */
const memory = new Map<string, string>()

const fallback: StorageLike = {
  get length() {
    return memory.size
  },
  key: (index) => [...memory.keys()][index] ?? null,
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value)
  },
  removeItem: (key) => {
    memory.delete(key)
  },
}

const store = (): StorageLike =>
  typeof window === 'undefined' || window.localStorage === undefined
    ? fallback
    : window.localStorage

function readRaw(key: string): unknown {
  try {
    const stored = store().getItem(PREFIX + key)
    if (stored === null) return MISSING
    return JSON.parse(stored) as unknown
  } catch {
    // Private windows, disabled storage and a value written by an older shape
    // of a panel all land here. An overlay that cannot remember which section
    // was open is fine; one that refuses to render is not.
    return MISSING
  }
}

function writeRaw(key: string, value: unknown): void {
  try {
    store().setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // See readRaw: the panel still works, it just forgets.
  }
}

function removeRaw(key: string): void {
  try {
    store().removeItem(PREFIX + key)
  } catch {
    // As above.
  }
}

/** Every key this app has stored, whether or not the build still knows it. */
function storedKeys(): readonly string[] {
  try {
    const held = store()
    const keys: string[] = []
    for (let index = 0; index < held.length; index += 1) {
      const key = held.key(index)
      if (key !== null && key.startsWith(PREFIX))
        keys.push(key.slice(PREFIX.length))
    }
    return keys
  } catch {
    return []
  }
}

/**
 * Store a value under a registered key, outside React.
 *
 * For the import and for a test. Not a general setter: a mounted hook holds
 * its own copy, so a write that skipped `announce` would leave the panel on
 * screen showing the value it had before.
 */
export function write(preference: AnyPreference, value: unknown): void {
  writeRaw(preference.key, value)
  announce(preference.key, resolve(preference))
}

/** One stored preference, believed, or its default. */
export const read = <T>(preference: Preference<T>): T =>
  resolve(preference) as T

/** The same, for a definition whose value type the caller does not know. */
export function resolve(definition: AnyPreference): unknown {
  const stored = readRaw(definition.key)
  if (stored !== MISSING && definition.accept(stored)) {
    const revive = definition.revive as
      ((value: unknown) => unknown) | undefined
    return revive === undefined ? stored : revive(stored)
  }
  return definition.migrate?.() ?? definition.initial
}

/**
 * A key that is being *migrated away from*, read once.
 *
 * The one place a raw key name is legitimate, and it is deliberately not
 * `Preference`-shaped: the value is wanted at the moment a new key is found
 * absent and never again, and registering the old key would keep it alive in
 * the census and in the export. `null` means absent or unbelievable, which the
 * caller treats the same.
 */
export function readObsolete<T>(key: string, accept: Accept<T>): T | null {
  const stored = readRaw(key)
  return stored !== MISSING && accept(stored) ? stored : null
}

/* ------------------------------------------------------------------------ */
/* The subscription that makes an import live                                */
/* ------------------------------------------------------------------------ */

/*
 * Every mounted hook, by key.
 *
 * An import writes storage, and storage is not something React watches — so
 * without this, applying one would leave every panel on screen showing the
 * value it had before, and the only way to see the imported settings would be
 * a reload. A reload rebuilds the renderer and loses the camera, which is
 * exactly the cost this app pays to avoid everywhere else.
 *
 * A Set per key rather than one broadcast list: two panels can hold the same
 * section's open state, and a change to `render.hdr` must not re-render the
 * catalog.
 */
const listeners = new Map<string, Set<(value: unknown) => void>>()

function subscribe(
  key: string,
  listener: (value: unknown) => void,
): () => void {
  const held = listeners.get(key) ?? new Set()
  held.add(listener)
  listeners.set(key, held)
  return () => {
    held.delete(listener)
    if (held.size === 0) listeners.delete(key)
  }
}

function announce(key: string, value: unknown): void {
  for (const listener of listeners.get(key) ?? []) listener(value)
}

/* ------------------------------------------------------------------------ */
/* The hook                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * A preference that outlives a reload.
 *
 * The setter is `useState`'s own, so it takes a value *or* an updater — and the
 * updater form is not a convenience, it is required for correctness anywhere a
 * value is derived from the one before it. The dock is the worked example: a
 * single pointer gesture can produce more than one drop, and two `movePanel`
 * calls composed against the same captured snapshot silently discard the first.
 * That failure is invisible in code review and presents as a panel that snaps
 * back to where it was.
 *
 * **The write is an effect on the committed value, not a side effect inside the
 * updater.** It was the latter, on the argument that the string on disk should
 * be derived from what React committed — but an updater is called during
 * render, must be pure, and is not the commit. StrictMode double-invokes it,
 * and React is free to render a value it then discards; the `setItem` for that
 * value has already landed, so the stored preference is one nobody chose. It
 * also made a slider a synchronous `setItem` per input event, on the pointer's
 * thread, for a value that changes forty times a second. An effect runs after
 * the commit, which is the moment the claim was about.
 */
export function usePersistentState<T>(
  preference: Preference<T>,
): [T, (value: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(preference))
  /*
   * What is already on disk, so an unchanged value is not rewritten.
   *
   * Seeded with the mount-time value rather than with nothing, and that is the
   * point rather than an optimization: writing on mount would turn "never
   * chose" into "chose the current default" for every visitor, and a later
   * change of default would then not reach any of them. An absent value means
   * the default, and it has to keep meaning that.
   *
   * Not a "run once" latch — see the invariant about those. It is reconciled
   * against on every run and holds the same answer storage would.
   */
  const persisted = useRef(value)
  const key = preference.key
  useEffect(() => {
    if (Object.is(persisted.current, value)) return
    persisted.current = value
    writeRaw(key, value)
    /*
     * And tell the other hooks on this key, which is not a nicety.
     *
     * A preference is a key, not a component, and two mounted hooks on one key
     * are the ordinary case rather than the exotic one: `controls.keymap` is
     * held by `KeymapProvider`, which is the only thing that feeds the
     * dispatcher, *and* by the editor that rewrites it. Without this the editor
     * updates its own copy and storage, the provider never hears, and a rebind
     * is not live until a reload — which in this app rebuilds the renderer and
     * loses the camera, the exact cost this subscription exists to avoid.
     *
     * Re-entrant on this hook's own listener and harmlessly so: it is handed
     * the value that has just been committed, `persisted` already holds it, and
     * `setValue` with the same reference is a bail-out rather than a render.
     */
    announce(key, value)
  }, [key, value])

  /*
   * An import, arriving at a hook that is already mounted.
   *
   * `persisted` is set alongside, so the effect above does not immediately
   * write the value straight back — which would be harmless and is also a
   * `setItem` on the import's own thread for every mounted preference at once.
   */
  useEffect(
    () =>
      subscribe(key, (next) => {
        persisted.current = next as T
        setValue(next as T)
      }),
    [key],
  )
  return [value, setValue]
}

/* ------------------------------------------------------------------------ */
/* Export, import, reset                                                     */
/* ------------------------------------------------------------------------ */

/** What the downloaded file is. */
export interface PreferenceExport {
  readonly app: string
  readonly version: number
  readonly exported: string
  readonly preferences: Readonly<Record<string, unknown>>
}

export const EXPORT_APP = 'inertialref'
export const EXPORT_VERSION = 1

/**
 * Everything actually stored, which is not everything registered.
 *
 * An absent key means the default and has to keep meaning that, so exporting
 * the defaults for keys nobody has touched would turn a fresh profile's export
 * into a snapshot that pins today's defaults on every machine it is imported
 * to. What is exported is what somebody chose.
 *
 * Keys this build no longer knows are dropped rather than carried: they cannot
 * be validated on the way back in, and an export that round-trips values
 * nothing can check is a save file with a hole in it.
 */
export function exportPreferences(now: string): PreferenceExport {
  const preferences: Record<string, unknown> = {}
  for (const key of storedKeys()) {
    const definition = definitionFor(key)
    if (definition === null) continue
    const stored = readRaw(key)
    if (stored === MISSING || !definition.accept(stored)) continue
    preferences[key] = stored
  }
  return {
    app: EXPORT_APP,
    version: EXPORT_VERSION,
    exported: now,
    preferences,
  }
}

/** One entry of an import, and what this build decided about it. */
export interface ImportEntry {
  readonly key: string
  readonly group: PreferenceGroup | null
  readonly what: string
  readonly applied: boolean
  /** Why it was dropped. Absent when it was applied. */
  readonly reason?: string
}

export interface ImportPlan {
  readonly entries: readonly ImportEntry[]
  readonly applied: number
  readonly dropped: number
}

/**
 * What an import *would* do, without doing it.
 *
 * Separate from applying it because the preview is the whole point: a file from
 * another build carries keys this one has never heard of and values it will not
 * believe, and the honest thing is to say which before anything changes rather
 * than to apply what fits and stay quiet about the rest.
 */
export function planImport(data: unknown): ImportPlan {
  const entries: ImportEntry[] = []
  const preferences = readablePreferences(data)
  if (preferences === null) {
    return { entries: [], applied: 0, dropped: 0 }
  }
  for (const [key, value] of Object.entries(preferences)) {
    const definition = definitionFor(key)
    if (definition === null) {
      entries.push({
        key,
        group: null,
        what: 'not a setting this build has',
        applied: false,
        reason: 'unknown',
      })
      continue
    }
    if (!definition.accept(value)) {
      entries.push({
        key,
        group: definition.group,
        what: definition.what,
        applied: false,
        reason: 'not a value this build accepts',
      })
      continue
    }
    entries.push({
      key,
      group: definition.group,
      what: definition.what,
      applied: true,
    })
  }
  return {
    entries,
    applied: entries.filter((one) => one.applied).length,
    dropped: entries.filter((one) => !one.applied).length,
  }
}

/**
 * Apply an import, and tell every mounted hook.
 *
 * Idempotent and total: what `planImport` says would apply is what applies, and
 * a file with nothing believable in it changes nothing. That is the property —
 * `import(export())` is the identity and a garbage import is a no-op.
 */
export function importPreferences(data: unknown): ImportPlan {
  const plan = planImport(data)
  const preferences = readablePreferences(data)
  if (preferences === null) return plan
  for (const entry of plan.entries) {
    if (!entry.applied) continue
    const value = preferences[entry.key]
    writeRaw(entry.key, value)
    announce(entry.key, believe(entry.key))
  }
  return plan
}

/** Forget everything, and put every mounted hook back to its default. */
export function resetPreferences(): void {
  for (const key of storedKeys()) {
    removeRaw(key)
    announce(key, believe(key))
  }
}

/** The value a hook should hold for a key, given what storage now says. */
function believe(key: string): unknown {
  const definition = definitionFor(key)
  return definition === null ? undefined : resolve(definition)
}

/** The `preferences` map of a file, or null when the file is not one. */
function readablePreferences(
  data: unknown,
): Readonly<Record<string, unknown>> | null {
  if (typeof data !== 'object' || data === null) return null
  const file = data as Partial<PreferenceExport>
  // The app name is checked and the version is not compared, deliberately: this
  // is version 1 and there is nothing to be backward with yet, and every entry
  // is validated individually anyway — which is the guarantee that matters and
  // the one a version number cannot make.
  if (file.app !== EXPORT_APP) return null
  const preferences = file.preferences
  if (typeof preferences !== 'object' || preferences === null) return null
  if (Array.isArray(preferences)) return null
  return preferences as Readonly<Record<string, unknown>>
}
