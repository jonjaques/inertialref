import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import { LENS_PRESETS } from '@inertialref/rendering'
import { isBoolean, numberWithin, oneOf } from './accept.ts'
import * as preferences from './preferences.ts'
import {
  CAMERA_LENS,
  CATALOGUE_CLASSES,
  CONTROLS_KEYMAP,
  DOCK_PANES,
  EXPORT_APP,
  exportPreferences,
  FAMILIES,
  importPreferences,
  PLANETARIUM_FLARE,
  PLANETARIUM_LABELS,
  planImport,
  PREFERENCE_GROUPS,
  read,
  REGISTRY,
  resetPreferences,
  SECTION_OPEN,
  write,
} from './preferences.ts'

/*
 * The registry, and the two things it exists to make possible.
 *
 * Every key was guarded before this and none of them could be listed, which is
 * why nothing could export them: an export is a census, and there was no
 * census. So the tests worth writing are about the census — that it covers what
 * the module declares — and about the round trip it enables, which is a
 * property rather than an example because the interesting inputs are the ones
 * nobody would think to write down.
 *
 * There is no DOM here, deliberately: the suite runs in plain Node and the
 * module's storage falls back to a Map, which is the same code path a private
 * window takes. That is the whole reason `import(export())` can be asserted at
 * all rather than described.
 */

const stamp = '2026-08-28T00:00:00.000Z'

beforeEach(() => {
  resetPreferences()
})

describe('the guard vocabulary', () => {
  it('accepts only the names the build still has', () => {
    const accept = oneOf(['navigate', 'graphics', 'perf'] as const)
    expect(accept('navigate')).toBe(true)
    // The renamed panel, the one from a branch, and the shapes a hand-edited
    // storage entry produces.
    expect(accept('nav')).toBe(false)
    expect(accept('')).toBe(false)
    expect(accept(0)).toBe(false)
    expect(accept(null)).toBe(false)
    expect(accept(['navigate'])).toBe(false)
  })

  it('rejects a number outside the range the control offers', () => {
    const accept = numberWithin(20, 110)
    expect(accept(65)).toBe(true)
    expect(accept(20)).toBe(true)
    expect(accept(110)).toBe(true)
    expect(accept(19)).toBe(false)
    expect(accept(5_000)).toBe(false)
    // The three that reach a projection matrix and produce a black frame rather
    // than an error: they are all `typeof value === 'number'`.
    expect(accept(Number.NaN)).toBe(false)
    expect(accept(Number.POSITIVE_INFINITY)).toBe(false)
    expect(accept('65')).toBe(false)
  })

  it('does not take a truthy string for a remembered toggle', () => {
    expect(isBoolean(true)).toBe(true)
    expect(isBoolean(false)).toBe(true)
    // `"true"` and `1` are what an older shape of a panel writes, and both are
    // truthy — so an unguarded read turns "off" into "on" exactly once, on the
    // reload after an upgrade.
    expect(isBoolean('true')).toBe(false)
    expect(isBoolean(1)).toBe(false)
    expect(isBoolean(null)).toBe(false)
  })
})

describe('the census', () => {
  it('lists every preference this module declares', () => {
    /*
     * The half a hand-written list cannot be trusted for. `REGISTRY` is written
     * out so a reader can see it, and a definition added above it and forgotten
     * below is a preference the export silently does not carry — which presents
     * as a setting that does not travel, on a machine, weeks later.
     */
    const declared = (Object.values(preferences) as unknown[]).filter(
      (value): value is { key: string } =>
        typeof value === 'object' &&
        value !== null &&
        'key' in value &&
        'accept' in value,
    )
    const listed = new Set(REGISTRY.map((one) => one.key))
    for (const one of declared) {
      expect(listed, `${one.key} is declared and not in REGISTRY`).toContain(
        one.key,
      )
    }
    expect(declared.length).toBe(REGISTRY.length)
  })

  it('lists every family, and no family shadows a key', () => {
    const declared = (Object.values(preferences) as unknown[]).filter(
      (value): value is { prefix: string } =>
        typeof value === 'object' &&
        value !== null &&
        'prefix' in value &&
        'of' in value,
    )
    expect(declared.length).toBe(FAMILIES.length)
    // A family prefix that also names an exact key would make `definitionFor`
    // depend on which it checked first, which is a bug the order hides.
    for (const one of FAMILIES) {
      for (const preference of REGISTRY) {
        expect(preference.key.startsWith(one.prefix)).toBe(false)
      }
    }
  })

  it('gives every key a group the settings page has a section for', () => {
    for (const one of [...REGISTRY, ...FAMILIES]) {
      expect(PREFERENCE_GROUPS).toContain(one.group)
      expect(one.what.length).toBeGreaterThan(0)
    }
  })

  it('believes its own defaults', () => {
    // A default the guard rejects is a preference that resets on the first
    // write and reads as a control that will not stay where it is put.
    for (const one of REGISTRY) {
      expect(one.accept(one.initial), one.key).toBe(true)
    }
    for (const one of FAMILIES) {
      const member = one.of('probe')
      expect(member.accept(member.initial), one.prefix).toBe(true)
    }
  })

  it('resolves a family member to its own family', () => {
    expect(preferences.definitionFor('section.camera.optics')?.group).toBe(
      'workspace',
    )
    expect(preferences.definitionFor('dock.panes.planetarium')?.group).toBe(
      'workspace',
    )
    expect(preferences.definitionFor('nothing.here')).toBeNull()
  })
})

describe('an export', () => {
  it('carries only what somebody chose', () => {
    /*
     * An absent key means the default and has to keep meaning that. Exporting
     * the defaults would turn a fresh profile's file into a snapshot that pins
     * today's defaults on every machine it reaches, so a later change of
     * default would not arrive for anybody who had ever exported.
     */
    expect(exportPreferences(stamp).preferences).toEqual({})
    write(PLANETARIUM_LABELS, false)
    expect(exportPreferences(stamp).preferences).toEqual({
      'planetarium.labels': false,
    })
  })

  it('drops a stored key this build no longer has', () => {
    // It cannot be validated on the way back in, and a file that round-trips
    // values nothing can check is a save with a hole in it.
    write({ ...PLANETARIUM_LABELS, key: 'planetarium.wormholes' }, true)
    expect(Object.keys(exportPreferences(stamp).preferences)).not.toContain(
      'planetarium.wormholes',
    )
  })

  it('is the identity through an import (property)', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.boolean(),
        fc.boolean(),
        (labels, flare, sectionOpen, leftPane) => {
          resetPreferences()
          write(PLANETARIUM_LABELS, labels)
          write(PLANETARIUM_FLARE, flare)
          write(SECTION_OPEN.of('camera.optics'), sectionOpen)
          write(DOCK_PANES.of('planetarium'), {
            left: leftPane,
            right: !leftPane,
          })
          write(CAMERA_LENS, LENS_PRESETS.cinematic)

          const file = exportPreferences(stamp)
          resetPreferences()
          const plan = importPreferences(file)

          expect(plan.dropped).toBe(0)
          expect(plan.applied).toBe(5)
          expect(read(PLANETARIUM_LABELS)).toBe(labels)
          expect(read(PLANETARIUM_FLARE)).toBe(flare)
          expect(read(SECTION_OPEN.of('camera.optics'))).toBe(sectionOpen)
          expect(read(DOCK_PANES.of('planetarium')).left).toBe(leftPane)
          // The lens is the one that cannot survive JSON on its own: `focus` is
          // `Infinity`, `JSON.stringify` writes `null`, and `revive` is what
          // puts it back. Without it the round trip is silently not an identity.
          expect(read(CAMERA_LENS)).toEqual(LENS_PRESETS.cinematic)
        },
      ),
    )
  })
})

describe('an import', () => {
  it('is a no-op for anything that is not one of these files (property)', () => {
    fc.assert(
      fc.property(fc.anything({ maxDepth: 3 }), (garbage) => {
        resetPreferences()
        write(PLANETARIUM_LABELS, false)
        const plan = importPreferences(garbage)
        // Either it is not a file at all — no entries — or it is a file whose
        // every entry failed a guard. Neither may change anything.
        expect(plan.applied).toBe(0)
        expect(read(PLANETARIUM_LABELS)).toBe(false)
      }),
    )
  })

  it('refuses a file that does not say it is ours', () => {
    const file = { ...exportPreferences(stamp), app: 'something-else' }
    expect(planImport(file).entries).toEqual([])
  })

  it('names what it dropped, and why', () => {
    const plan = planImport({
      app: EXPORT_APP,
      version: 1,
      exported: stamp,
      preferences: {
        'planetarium.labels': false,
        'planetarium.flare': 4,
        'planetarium.wormholes': true,
      },
    })
    expect(plan.applied).toBe(1)
    expect(plan.dropped).toBe(2)
    // Out of range and unknown are different answers, and a preview that said
    // "2 dropped" without saying which is a dialog nobody can act on.
    expect(
      plan.entries.find((one) => one.key === 'planetarium.flare')?.reason,
    ).toBe('not a value this build accepts')
    expect(
      plan.entries.find((one) => one.key === 'planetarium.wormholes')?.reason,
    ).toBe('unknown')
  })

  it('will not take a chord this build would refuse to bind', () => {
    // `Tab` is how a browser moves focus and a window-level `preventDefault`
    // always wins, so a keymap carrying it arrives from a build that did not
    // refuse it — or from a hand edit — and it must not be believed.
    const plan = planImport({
      app: EXPORT_APP,
      version: 1,
      exported: stamp,
      preferences: { 'controls.keymap': { 'workspace.panes': 'Tab' } },
    })
    expect(plan.applied).toBe(0)
    expect(CONTROLS_KEYMAP.accept({ 'workspace.panes': 'Shift+KeyH' })).toBe(
      true,
    )
    // Unbound is a value, not an absence: absent means "the default" and there
    // has to be a way to say "nothing".
    expect(CONTROLS_KEYMAP.accept({ 'workspace.panes': null })).toBe(true)
  })

  it('rejects a class list naming something no chip answers to', () => {
    expect(CATALOGUE_CLASSES.accept(['stars'])).toBe(true)
    expect(CATALOGUE_CLASSES.accept(['stars', 'wormholes'])).toBe(false)
  })
})
