import type { Renderer } from 'three/webgpu'

/*
 * Placement B's split: end the scene pass, put what its encoder holds on the
 * queue, and resume on a fresh encoder, so the ordinary three renders and
 * computes issued in between execute after the first half and before the
 * resumed one (§4.2). The resumed half is named on the timeline by
 * `SPLIT_LABEL`.
 *
 * Here the split declines: it runs nothing and says so.
 */

export const SPLIT_LABEL = 'scene over clouds'

/**
 * End the scene pass, put what its encoder holds on the queue, resume on a
 * fresh encoder; three renders and computes `during` issues execute between
 * the halves. False, and `during` not run, off WebGPU or outside an open
 * render pass.
 */
export function splitScenePass(
  _renderer: Renderer,
  _during: () => void,
): boolean {
  return false
}
