import { algorithm, manifest } from '@inertialref/procedural'
import { GALAXY_FIELD_ALGORITHM } from './galaxy/field.ts'

/*
 * The generation manifest: which algorithm, at which revision, built the
 * universe a save or a peer refers to.
 *
 * A leaf on purpose. `system.ts` and `solar/system.ts` both stamp a system with
 * `GENERATION_VERSIONS`, and `system.ts` imports `solar/system.ts` to build Sol;
 * with the versions in `system.ts` the two close a cycle, and a value read
 * across that cycle at module scope throws a TDZ `ReferenceError` on
 * `import('system.ts')`. Nothing here imports a module that
 * imports this one, and `moduleGraph.test.ts` in `apps/headless` imports it
 * first in its own Node process to hold it so.
 */

/*
 * Bumped to 3 when generated systems gained their debris.
 *
 * A version is what invalidates a save's references (`docs/design/galaxy.md`
 * Rule 1), and this changed what is *in* every system in the galaxy: six to
 * eighteen small bodies per system, at addresses past the last planet. Nothing
 * a save could already point at moved — that is the whole point of issue
 * ordinals — but a system now contains things it did not, and a manifest that
 * did not say so would let two builds of the game disagree about the contents
 * of the same address space with nothing to notice.
 */
/*
 * Bumped to 4 when the figure and the spin floor moved canonical fields.
 *
 * `axialTilt` and `rotationPeriod` are not presentation: `spinEvaluator` in
 * `frames.ts` builds the body-fixed frame out of them, so they orient the
 * ground terrain is sampled on and the pose a landed entity is held against.
 * Measured over 400 catalog stars and 6,496 generated bodies, the tilt's
 * stretched tail moves 142 of them, the worst by 41°, and the hydrostatic
 * floor lengthens one rotation period. A pole 41° from where a save left it is
 * a different world under the same address, and nothing else in the game can
 * notice: `stateHash` cannot see it, because a landed entity's numbers are
 * body-frame-relative and identical on both sides.
 *
 * Preserving the draw order does not hold a version, which is the trap to take
 * from this. `planetTilt` consumes exactly one gaussian, as the plain
 * `Math.abs` did, so nothing downstream of it shifts in the stream — and the
 * number it returns is still different. Order protects a body's neighbors and
 * says nothing about the body.
 *
 * `polarRadius` moves on 1,515 bodies and rides along rather than earning it —
 * `datumRadius` in `terrain.ts` reads the equatorial radius whenever `figure`
 * is null, so the flattening reaches the dossier and the silhouette and never
 * the ground's datum or the contact test. ADR-0027 records the argument, which
 * is one bump for whatever moved, not one per field.
 */
export const SYSTEM_ALGORITHM = algorithm('system', 4)
/*
 * Bumped to 2 when the three noise bands became a band stack.
 *
 * Every solid body's ground moved: elevation is now a grammar, a sketch and six
 * fields rather than continents, mountains and detail, and the number a save's
 * landed ship is sitting on is a different number. Doing it once is why the
 * geology is one phase — the phases after this refine presentation and leave
 * the canonical field alone, precisely so the ground moves under saves a single
 * time. The loader already knows how to say "this save was written with terrain
 * v1" (ADR-0005).
 *
 * `SYSTEM_ALGORITHM` deliberately does not move with it. `makeSurface` draws the
 * same three values in the same order from the same stream — the first has
 * changed meaning, not position — so every other property of every body in the
 * galaxy is exactly where it was.
 */
/*
 * Bumped to 3 when the liquid arrived: the valleys, the coast, and a sea read
 * against its ground temperature.
 *
 * Every wet world's ground moved — the drainage carves up to a sixth of the
 * budget out of the landform and the coast remaps a band either side of the
 * datum — and every hot world with a sea lost it, which took its plates with
 * it. The dry airless bodies are untouched to the last bit, and
 * `SYSTEM_ALGORITHM` stays where it is for the reason above: the sea's draw
 * is still taken, only read differently.
 */
/*
 * Bumped to 4 when the crater ladder went from eleven halvings to fourteen.
 *
 * Every cratered body's ground moved: a world whose largest basin is
 * 2,170 km carries canonical craters down to 265 m where it stopped at 2.1 km,
 * and the contact test integrates the difference. Nothing else in the stack
 * moved — the bands, the seeds and the lattice are where they were, so a
 * body with no craters is untouched to the last bit. A cratered patch costs
 * 12 to 18% more; the detail floor holds across the zoo and rises by up to
 * two levels elsewhere, Earth's from 15 to 17. `MAX_CRATER_LEVELS` in
 * `sketch.ts` carries both figures and the bodies they were measured on.
 */
/*
 * Bumped to 5 when the rivers learned which way is downhill.
 *
 * The drainage stage reads a per-body graph — a lattice flooded from the
 * sea, a receiver tree, a channel floor that never rises downstream — where
 * it read the zero strip of a noise, and it runs after the craters rather
 * than before them. Every wet world's ground moved: the valleys are in
 * different places, cut to a datum along the channel rather than by a
 * fraction of the landform, and a below-datum basin a thousand kilometers
 * inland holds water at its own spill rather than at the sea's. A dry body,
 * and a wet body's seabed outside any channel's reach, are untouched to the
 * last bit. `SYSTEM_ALGORITHM` stays: nothing `system.ts` generates reads
 * the graph.
 */
/*
 * Bumped to 6 for a batch of four, spent together because every change to
 * the canonical field moves every landed ship and misses every archived tile,
 * and one bump pays that once where four would pay it four times.
 *
 * - **The surface's identity** (`surfaceIdentity`) moves no ground and every
 *   archive key. The drainage memo, the survey and the archive read one
 *   complete text where two of them listed fields and stringified the
 *   grammar, which spells NaN and both infinities `null`.
 * - **The weakening is the sea a world drew, not the sea it kept**
 *   (`hadOcean`). A world whose ground boiled or froze its sea keeps the
 *   plates the water gave it: 64 plate counts move in the 2,201 bodies within
 *   25 ly, Proxima Centauri II's twenty among them, and eleven more grammars
 *   move their hotspots and band shares under the plate threshold.
 * - **One water body per sample.** A sample within reach of two lakes, or of
 *   a lake and the sea, takes one body's level rather than a blend of both,
 *   so the sheet and the ground clamp stop tilting across the gap. Only a
 *   body with a drainage graph moves.
 * - **Enceladus's tiger stripes take a south-polar extent**, about 130 km
 *   long, where a stripe axis was a whole great circle drawn pole to pole.
 *
 * A body that drew no sea its ground refuses, has no drainage graph and
 * carries no stripe term is untouched to the last bit: in Sol, everything but
 * Earth and Titan, whose graphs are read, and the icy moons with stripes.
 * `SYSTEM_ALGORITHM` stays: the weakening reads a draw already taken, and
 * every generated value outside the grammar is identical across the bump,
 * over every system within 50 ly.
 */
export const TERRAIN_ALGORITHM = algorithm('terrain', 6)
export const GALAXY_ALGORITHM = algorithm('galaxy', 5)
/**
 * The measured-to-physical conversion in `catalog/photometry.ts`.
 *
 * It belongs in the manifest because a system's planets are laid out from its
 * star's luminosity: changing a bolometric correction moves every frost line in
 * the cataloged half of the galaxy. It looks like presentation and it is not.
 */
export const PHOTOMETRY_ALGORITHM = algorithm('photometry', 1)

export const GENERATION_VERSIONS = manifest([
  GALAXY_ALGORITHM,
  GALAXY_FIELD_ALGORITHM,
  SYSTEM_ALGORITHM,
  TERRAIN_ALGORITHM,
  PHOTOMETRY_ALGORITHM,
])
