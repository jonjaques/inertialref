/** The reconstruction's live buffers and history, independent of its host API. */
export interface PictureReport {
  readonly path: 'native' | 'bilinear' | 'spatial' | 'temporal'
  readonly renderWidth: number
  readonly renderHeight: number
  readonly displayWidth: number
  readonly displayHeight: number
  readonly phase: number
  readonly phaseCount: number
  readonly frames: number
  readonly resets: number
  readonly workingTextureBytes: number
  readonly initMs: number
  readonly gpuTimings: Readonly<Record<string, number>>
  readonly debug: string
}
