import {
  type IceTable,
  iceAggregate,
  type MieTable,
  mieDroplets,
  phaseAtlas,
  toHalves,
} from '@inertialref/rendering'

/*
 * The phase atlas's convolution on the committed tables, as one module that
 * `render.convolvePhase` imports on its first ask and no other module
 * imports at all.
 *
 * The committed droplet and ice tables are about 450 KB of text, 287 KB
 * gzipped, and the worker that serves the task is on every page's boot path,
 * as `atmosphereTask.ts` is on the main thread's (`atmosphereLuts.ts`
 * imports it). Imported statically there, they took the worker chunk from
 * 146 KB to 607 KB and rode in the main chunk too, on pages without
 * `?clouds=1`, which never ask the task. Reached only through `import()`,
 * they are a chunk of their own that a page fetches the first time a cloud
 * system asks for a sun's disk.
 *
 * The module holds code of its own, not only re-exports: a chunk of nothing
 * but re-exports carries no source map, which the build refuses
 * (`requireSourceMaps` in `vite.config.ts`). Nothing here may import
 * `three`: this module is part of the worker bundle.
 */

/** The committed tables, decoded on the first convolution and kept. */
let committed: readonly [MieTable, IceTable] | null = null

/** The committed tables' atlas under a sun of `angularRadius`, radians, in RGBA16F halves (`phaseAtlas`, `toHalves`). */
export function convolveCommitted(angularRadius: number): Uint16Array {
  committed ??= [mieDroplets(), iceAggregate()]
  return toHalves(phaseAtlas(...committed, angularRadius).texels)
}
