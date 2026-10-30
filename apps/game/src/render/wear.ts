import { type Object3D, Vector2, Vector3, Vector4 } from 'three/webgpu'
import { NO_MORPH_DISTANCE } from '@inertialref/rendering'

/*
 * What a mesh wears to be drawn as the ground or the sea: the per-mesh inputs
 * the two materials read, as one typed record under one `userData` key.
 *
 * The materials read these through `onObjectUpdate` uniforms, once per drawn
 * object, and a `userData` field is untyped. As five loose keys the protocol
 * lived in comments at every wearer, and a key a wearer forgot read as zero in
 * the frame with nothing to say so. One record makes a forgotten piece a type
 * error where the mesh is dressed — `groundWear.ts` — and one accessor is the
 * whole of what a material has to know about a mesh.
 *
 * Its own module rather than a corner of the dresser because the material
 * imports the reader and the dresser imports the material's `grainWrap`; the
 * record sits between them.
 */

/** The ground material's per-mesh inputs. */
export interface GroundWear {
  /** The eye in the patch's own frame, true meters. `placeEye` writes it every frame. */
  readonly eyeLocal: Vector3
  /**
   * Where the morph to the parent begins and ends, meters from the eye.
   * `NO_MORPH_DISTANCE` twice for a wearer that never morphs — a rock, a bake.
   */
  readonly morphBand: Vector2
  /**
   * The edges whose vertices do not morph, one flag a lane in `PATCH_EDGE`'s
   * order: the selection's `finerEdges`, which `placeEye` unpacks. Zero for a
   * wearer that is not a patch — four zeros written out, because a bare
   * `new Vector4()` has a `w` of one, which holds every first row.
   */
  readonly morphEdges: Vector4
  /** And the corners that hold, in `PATCH_EDGE`'s corner order, the same way. */
  readonly morphCorners: Vector4
  /**
   * The anchor as the float32 uniform receives it, rounded on this side so the
   * altitude beside it describes the vector the shader actually gets.
   */
  readonly anchor: Vector3
  /**
   * How far that rounded anchor sits above the datum, exact in float64. An
   * anchor is a point on the datum by construction, so this is the rounding
   * alone — up to half a meter at Earth's radius, a quarter of the water band.
   */
  anchorAltitude: number
  /**
   * The unrounded anchor reduced modulo the grain period, in grain
   * wavelengths: under 64 rather than 2.5 × 10⁶, so float32 resolves microns.
   */
  readonly grainOrigin: Vector3
  /**
   * The patch's region level, for the row of the deposit slope table its
   * drawn slope is mapped through; `NO_SLOPE_LEVEL` for a wearer whose
   * normal is not a level's — a rock's faces, a warm-up dummy — whose
   * deposits read the slope as drawn.
   */
  readonly level: number
  /**
   * The unrounded anchor split across the macro lattice in float64: the whole
   * cells in `macroCell`, exact integers, and the meters left over in
   * `macroOffset`, under `MACRO_METERS`. The bands that may not repeat read
   * a lattice coordinate from these two and `positionLocal`, never from the
   * body-fixed position (`render/terrain.ts` § the macro band).
   */
  readonly macroCell: Vector3
  readonly macroOffset: Vector3
}

/** A ground wearer that is not a terrain patch: its slope is read as drawn. */
export const NO_SLOPE_LEVEL = -1

/** The sea material's: the same eye, morph and anchor, and the wave field's origin in place of the grain's. */
export interface SeaWear {
  readonly eyeLocal: Vector3
  readonly morphBand: Vector2
  readonly morphEdges: Vector4
  readonly morphCorners: Vector4
  readonly anchor: Vector3
  readonly waveOrigin: Vector3
}

export const GROUND_WEAR = 'groundWear'
export const SEA_WEAR = 'seaWear'

/**
 * What an object nothing dressed reads as: at the origin, unmorphed, on the
 * datum. A default rather than a throw because the reader runs inside the
 * frame, where a throw takes the canvas with it. An undressed wearer is a
 * failure in `groundWear.test.ts`, which is where one can be.
 */
export const UNDRESSED_GROUND: GroundWear = Object.freeze({
  eyeLocal: new Vector3(),
  morphBand: new Vector2(NO_MORPH_DISTANCE, NO_MORPH_DISTANCE),
  morphEdges: new Vector4(0, 0, 0, 0),
  morphCorners: new Vector4(0, 0, 0, 0),
  anchor: new Vector3(),
  anchorAltitude: 0,
  grainOrigin: new Vector3(),
  level: NO_SLOPE_LEVEL,
  macroCell: new Vector3(),
  macroOffset: new Vector3(),
})

export const UNDRESSED_SEA: SeaWear = Object.freeze({
  eyeLocal: new Vector3(),
  morphBand: new Vector2(NO_MORPH_DISTANCE, NO_MORPH_DISTANCE),
  morphEdges: new Vector4(0, 0, 0, 0),
  morphCorners: new Vector4(0, 0, 0, 0),
  anchor: new Vector3(),
  waveOrigin: new Vector3(),
})

/** What the ground material reads off an object it is drawing. */
export const groundWearOf = (object: Object3D | null | undefined): GroundWear =>
  (object?.userData[GROUND_WEAR] as GroundWear | undefined) ?? UNDRESSED_GROUND

/** What the sea material reads off an object it is drawing. */
export const seaWearOf = (object: Object3D | null | undefined): SeaWear =>
  (object?.userData[SEA_WEAR] as SeaWear | undefined) ?? UNDRESSED_SEA
