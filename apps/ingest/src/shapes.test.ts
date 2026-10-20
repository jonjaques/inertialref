import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeShapeField, shapeExtent } from '@inertialref/rendering'
import { SHAPE_SOURCES } from './shapeSources.ts'
import type { ShapeEntry, ShapeManifest } from './shapes.ts'

/*
 * The committed shape models, checked against the manifest that describes
 * them. `buildShapes` writes both; nothing about running the game rebuilds
 * either, so a file edited, renamed or re-encoded without the other is caught
 * here rather than by an asteroid that is quietly the wrong size.
 */

const SHAPES = new URL('../../../data/shapes/', import.meta.url)

const manifest = JSON.parse(
  readFileSync(new URL('manifest.json', SHAPES), 'utf8'),
) as ShapeManifest

describe('the vendored shape models', () => {
  it('ships one model per source, in source order', () => {
    expect(manifest.shapes.map((entry) => entry.key)).toEqual(
      SHAPE_SOURCES.map((source) => source.key),
    )
  })

  it.each(
    manifest.shapes.map((entry): [string, ShapeEntry] => [entry.key, entry]),
  )(
    'holds %s to the bytes, grid and extent its manifest entry records',
    (_key, entry) => {
      const bytes = readFileSync(new URL(entry.file, SHAPES))
      expect(bytes.length).toBe(entry.bytes)
      expect(
        createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      ).toBe(entry.sha256)
      const field = decodeShapeField(bytes)
      expect([field.width, field.height]).toEqual([entry.width, entry.height])
      // The manifest measures the float grid; the file holds it quantized to
      // a uint16 between its extremes, a step of the relief over 65,535.
      const extent = shapeExtent(field)
      const step = (entry.maxRadius - entry.minRadius) / 65_535
      expect(Math.abs(extent.meanRadius - entry.meanRadius)).toBeLessThan(step)
      // `.claude/rules/catalog.md`: every current model lands between 99.8%
      // and 100.6% of its source's volume.
      expect(entry.volumeRatio).toBeGreaterThan(0.997)
      expect(entry.volumeRatio).toBeLessThan(1.007)
    },
  )
})
