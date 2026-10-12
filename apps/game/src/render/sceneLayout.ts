import {
  FloatType,
  HalfFloatType,
  type PixelFormat,
  RedFormat,
  RGBAFormat,
  RGFormat,
  type TextureDataType,
  UnsignedByteType,
} from 'three/webgpu'
import { pictureSamples, resolvePicture, type Picture } from './picture.ts'

/*
 * What the scene pass draws into, as one table.
 *
 * Every attachment's name, channel count, storage and blend is a row here, and
 * the four things built from them read the rows: the warm-up's stand-in, the
 * live pass's textures, the MRT node and the meter's byte count. Written out at
 * each of those, the descriptions agree only by care, and a pipeline compiled
 * against a stand-in whose formats differ from the pass's is a pipeline the
 * first frame builds again — the hitch the warm-up exists to hide.
 *
 * The rows are a function of the resolved picture and the backend, and of
 * nothing else: a renderer has no layout of its own. The engine answers for
 * the one it draws with (`GameEngine.sceneLayout`), and a GPU test asks the
 * same function for the picture it wants.
 */

/** How an attachment combines a draw with what it already holds. */
export type AttachmentBlend =
  /**
   * Whatever the material's own blend is. `output`'s alone: three takes the
   * material's blend for the attachment named `output` and gives every other
   * one none, so on another row this would describe a blend nothing applies.
   */
  | 'material'
  /** None: the draw replaces what the attachment holds. */
  | 'none'
  /** Source alpha over the destination; the destination keeps its alpha. */
  | 'over'
  /** The larger of the two, per channel. */
  | 'max'
  /** One over one minus source alpha: premultiplied coverage, as a union. */
  | 'union'

export type SceneAttachmentName =
  'output' | 'motion' | 'meterMask' | 'velocity' | 'reactive'

export interface SceneAttachment {
  readonly name: SceneAttachmentName
  readonly channels: 1 | 2 | 4
  /** Half float, or an unsigned byte normalized to 0..1. */
  readonly storage: 'half' | 'byte'
  readonly blend: AttachmentBlend
}

export interface SceneLayout {
  /**
   * The picture this is the layout of, resolved for the backend: the one
   * resolution the sensor, its warm-up and the renderer's description read.
   */
  readonly picture: Picture
  /** 4 or 0. WebGPU has no other count. */
  readonly samples: 0 | 4
  /** Float under reversed depth; the backend's default otherwise. */
  readonly depthType: TextureDataType | undefined
  /** `output` first: it is the pass's own texture, index zero. */
  readonly attachments: readonly SceneAttachment[]
}

/** What a layout needs to know about the renderer it is for. */
export interface SceneBackend {
  readonly kind: 'webgpu' | 'webgl'
  /** `WebGPURenderer.reversedDepthBuffer`. */
  readonly reversedDepth: boolean
}

/*
 * The rows.
 *
 * `motion` and `meterMask` are the optics', and every production layout
 * carries them: the meter's mask and the defocus and motion stages read them
 * whether or not a frame uses the stages. `velocity` and `reactive` are the
 * temporal reconstruction's. `motion` is four channels because its blend reads
 * the source's alpha, which is how an overlay leaves the attachment to what it
 * covers; `reactive` is four for the same reason, and is a byte because it is
 * coverage. `velocity` is two half-floats and has no blend of its own, which is
 * the defect `design/plans/the-upscaler.md` names — whichever fix it takes is
 * this row.
 */
const OUTPUT: SceneAttachment = {
  name: 'output',
  channels: 4,
  storage: 'half',
  blend: 'material',
}
const OPTICS: readonly SceneAttachment[] = [
  { name: 'motion', channels: 4, storage: 'half', blend: 'over' },
  { name: 'meterMask', channels: 1, storage: 'byte', blend: 'max' },
]
const TEMPORAL: readonly SceneAttachment[] = [
  { name: 'velocity', channels: 2, storage: 'half', blend: 'none' },
  { name: 'reactive', channels: 4, storage: 'byte', blend: 'union' },
]

/*
 * One object per resolved picture and depth convention, so two readers of the
 * same picture hold the same rows rather than equal ones. A session meets a
 * handful; the record admits a hundred and twenty.
 */
const LAYOUTS = new Map<string, SceneLayout>()

/** The layout `picture` draws its scene into on `backend`. */
export function sceneLayout(
  picture: Picture,
  backend: SceneBackend,
): SceneLayout {
  const resolved = resolvePicture(picture, backend.kind)
  const samples = pictureSamples(resolved)
  const temporal = resolved.aa === 'temporal'
  const key = [
    resolved.aa,
    resolved.scale,
    resolved.sharpness,
    backend.reversedDepth,
  ].join('|')
  let layout = LAYOUTS.get(key)
  if (layout === undefined) {
    layout = Object.freeze({
      picture: Object.freeze({ ...resolved }),
      samples,
      depthType: backend.reversedDepth ? FloatType : undefined,
      attachments: Object.freeze([
        OUTPUT,
        ...OPTICS,
        ...(temporal ? TEMPORAL : []),
      ]),
    })
    LAYOUTS.set(key, layout)
  }
  return layout
}

/**
 * The backend a renderer is, as a layout reads it.
 *
 * Takes any object because the scene components hold R3F's `gl`, typed as
 * R3F's own renderer union, and the web `<Canvas>` here is always handed a
 * `WebGPURenderer` by `createRenderer` — the cast `warmRenderer` makes, made
 * once more here rather than at every call site.
 */
export function sceneBackend(renderer: object): SceneBackend {
  const { backend, reversedDepthBuffer } = renderer as {
    readonly backend: object
    readonly reversedDepthBuffer: boolean
  }
  return {
    kind: 'isWebGPUBackend' in backend ? 'webgpu' : 'webgl',
    reversedDepth: reversedDepthBuffer,
  }
}

/** Whether a blend's factors read the source's alpha. */
export const blendReadsAlpha = (blend: AttachmentBlend): boolean =>
  blend === 'over' || blend === 'union'

/** Three's format for a row. */
export const attachmentFormat = (attachment: SceneAttachment): PixelFormat =>
  attachment.channels === 1
    ? RedFormat
    : attachment.channels === 2
      ? RGFormat
      : RGBAFormat

/** Three's texel type for a row. */
export const attachmentType = (attachment: SceneAttachment): TextureDataType =>
  attachment.storage === 'half' ? HalfFloatType : UnsignedByteType

/** Bytes a single sample of a row holds. */
export const attachmentBytes = (attachment: SceneAttachment): number =>
  attachment.channels * (attachment.storage === 'half' ? 2 : 1)

/** The row by name, or null where the layout has none. */
export const attachment = (
  layout: SceneLayout,
  name: SceneAttachmentName,
): SceneAttachment | null =>
  layout.attachments.find((row) => row.name === name) ?? null
