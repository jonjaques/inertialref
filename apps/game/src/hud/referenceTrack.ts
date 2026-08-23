import { getLogger } from '@inertialref/shared'
import { indexTrack, type ReferenceTrack } from './trackOverlay.ts'
/*
 * `?url`, and the reason is the cold-load budget rather than taste.
 *
 * The export is 288 KB. The app already awaits a 469 KB star catalog before its
 * first render (`engine/catalogAsset.ts`), which `CONTEXT.md` records as a
 * concern in its own right, and a debug surface that almost no session turns on
 * must not add to it. A plain `import track from '…json'` would compile the
 * whole thing into the main bundle and parse it at module evaluation, whether
 * or not a cutscene ever plays.
 *
 * With `?url` the import is a string. Vite emits the file as a content-hashed
 * asset — 288 KB is far above `assetsInlineLimit`, so it cannot be inlined —
 * and nothing is fetched until `loadReferenceTrack` is called, which happens
 * the first time `ir.trackOverlay(true)` is answered and never again. The
 * service worker caches `/assets/` on demand rather than precaching it
 * (`public/sw.js`), so an offline first run that never turns the overlay on
 * does not pay for it either.
 *
 * Same arrangement as the catalog next door, for one of the same two reasons.
 */
import trackUrl from '../../../../data/reference/tng-subject-track.json?url'

const log = getLogger('game.referenceTrack')

/**
 * The fetch, in flight or settled.
 *
 * Module scope rather than a ref, so remounting the overlay — which a Fast
 * Refresh or a stop and replay both do — re-reads the answer instead of
 * re-fetching it.
 */
let pending: Promise<ReferenceTrack | null> | null = null

/**
 * Fetch and index the reference edit's subject track, once per session.
 *
 * A missing or unparseable file degrades to no ghost boxes rather than to a
 * broken overlay: the render's own box and the two vectors are still worth
 * having, and a checkout that has not pulled the export is a legitimate state.
 */
export function loadReferenceTrack(): Promise<ReferenceTrack | null> {
  pending ??= fetch(trackUrl)
    .then(async (response) => {
      if (!response.ok)
        throw new Error(`${response.status} ${response.statusText}`)
      const track = indexTrack(await response.text())
      log.info('reference subject track loaded', { frames: track.size })
      return track
    })
    .catch((cause: unknown) => {
      log.warn('no reference subject track; drawing the render only', {
        cause: String(cause),
        url: trackUrl,
      })
      return null
    })
  return pending
}
