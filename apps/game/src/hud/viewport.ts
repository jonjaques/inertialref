import { useEffect, useState } from 'react'

/*
 * What shape of screen this is, and whether it can be pointed at precisely.
 *
 * Two facts, and they are genuinely independent: a tablet in landscape is wide
 * and coarse, a laptop with a touchscreen is wide and fine, and a phone is
 * neither. Collapsing them into one "mobile" boolean is how an interface ends
 * up with 44 px hit targets on a desktop or a 19 rem sidebar on a phone.
 *
 * Live rather than read once. A window is resized, a tablet is rotated, and a
 * browser window dragged between displays changes both — the same argument
 * `render/capability.ts` makes about extended range, and the same failure if it
 * is ignored: a layout decided at boot and never revisited.
 */

/**
 * Where the side-by-side layout stops fitting.
 *
 * 900 px, and it is measured rather than picked: a left rail (2.5 rem), one
 * 19 rem column and a 19 rem column on the other side is 41.5 rem — 664 px — and
 * below about 900 the scene left between them is narrower than the panels
 * beside it, at which point the panels are the interface and the universe is a
 * strip. That is the moment to change layout rather than keep shrinking.
 */
export const COMPACT_MAX_WIDTH = 900

const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_WIDTH - 1}px)`
const COARSE_QUERY = '(pointer: coarse)'

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const update = (): void => setMatches(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return matches
}

/** Too narrow for docked columns beside the scene. */
export const useCompact = (): boolean => useMediaQuery(COMPACT_QUERY)

/*
 * There is deliberately no `useCoarsePointer` hook beside this one.
 *
 * There was, and nothing ever called it: the one thing in this build that asks
 * about the pointer is `DockProvider`, choosing a drag-and-drop backend once at
 * mount, and it needs the answer *outside* React — see `coarsePointer` below.
 * A live hook that nothing subscribes to is a media query listener nobody
 * removes and a second way to ask a question that already has one.
 */
/**
 * The same question, answered once and outside React.
 *
 * `DockProvider` needs it at mount and must *not* re-read it — a change of
 * drag-and-drop backend is a remount of every panel — so it takes this rather
 * than the hook. Here beside the hook so the two cannot end up asking different
 * media queries.
 */
export function coarsePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(COARSE_QUERY).matches
  )
}
