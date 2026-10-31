'use no memo'

import { useEffect, useState } from 'react'
import type { PadState } from './padDriver.ts'
import { useKeymap } from './useKeymap.ts'

/**
 * The pad as the driver last read it, redrawn every frame while one is
 * attached.
 *
 * A frame rate rather than the 8 Hz sampler, because this is the controls
 * page's live picture: a stick drawn an eighth of a second behind the thumb
 * reads as a laggy stick, and the deadzone slider is judged by watching the
 * dot settle. It runs only while the page is open, and only while frames do —
 * which is only while a pad is attached.
 *
 * `'use no memo'`: the driver's state is a fresh object per poll, read from a
 * mutable port, which is the case the compiler cannot see change.
 */
export function usePadLive(): PadState | null {
  const store = useKeymap()
  const [state, setState] = useState<PadState | null>(
    () => store.pad?.state ?? null,
  )
  useEffect(() => {
    const read = (): void => setState(store.pad?.state ?? null)
    const stopFrames = store.onFrame(read)
    // Frames stop with the last pad, so the picture is told directly.
    const stopWatch = store.watch(read)
    return () => {
      stopFrames()
      stopWatch()
    }
  }, [store])
  return state
}
