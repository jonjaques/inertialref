import type { BootProgress } from '../render/preload.ts'

/*
 * The boot overlay's copy, one sentence at a time.
 *
 * Lowercase like the boot placeholder in `index.html` — these two speak in
 * one voice, because the placeholder's last line and this module's first are
 * on screen within a commit of each other and a case change at that seam
 * reads as a glitch. Kept in a sibling `.ts` because `BootOverlay.tsx` may
 * export only a component (Fast Refresh; see AGENTS.md).
 */

/** What boot is doing right now, as the overlay's status line. */
export function bootStatusLine(
  progress: BootProgress | null,
  warmed: boolean,
): string {
  if (warmed) return 'first light…'
  if (progress === null) return 'waking the renderer…'
  switch (progress.step) {
    case 'surfaces':
      return progress.done === 0
        ? 'fetching surface maps…'
        : `warming surface maps ${progress.done}/${progress.total}`
    case 'atmospheres':
      return `baking atmospheres ${progress.done}/${progress.total}`
    case 'pipelines':
      return 'compiling the sky…'
  }
}
