import { useEffect, useState } from 'react'
import { useKeymap } from '../input/useKeymap.ts'

/**
 * How long chrome stays up after the pointer stops, while a scene is running.
 */
const IDLE_MS = 2_600

/**
 * Whether the player's chrome should get out of the picture.
 *
 * Lifted out of `CinemaPlayer`, where it used to live, because it was hiding
 * exactly half of what it needed to: the transport faded on idle and the IR
 * menu — a bar with the mark, the mode and the settings on it — sat across the
 * bottom of the frame through the entire title sequence. `DESIGN.md` is
 * explicit that chrome unmounts while a cutscene runs, and cinema is the one
 * mode that cannot unmount it, because the player *is* the way out. So it
 * fades instead, and both bars have to fade together or the rule is worse than
 * not having it.
 *
 * One timer for both, in the mode, rather than the same hook twice: two timers
 * armed by two components drift apart by however long their renders were apart,
 * and two bottom bars fading a frame out of step reads as a glitch.
 *
 * `active` is what arms it — a scene that is paused or ended is one somebody is
 * working with rather than watching, and hiding the controls then is hiding the
 * controls from the person using them.
 */
export function useTransportIdle(active: boolean): boolean {
  const [idle, setIdle] = useState(false)
  const keymap = useKeymap()

  useEffect(() => {
    if (!active) {
      setIdle(false)
      return
    }
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS)
    const wake = (): void => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), IDLE_MS)
    }
    // `pointerdown` as well as move: a stationary touch tap produces no
    // pointermove and a phone has no keys, so without it the faded chrome —
    // the mode's only way out — could never be summoned back on touch.
    //
    // The keyboard comes through the dispatcher rather than a listener of its
    // own: "was there keyboard activity" is a question about the keyboard, and
    // the object that owns the one `keydown` in this app already has the
    // answer. It fires before every refusal, so typing into a field still
    // counts as being here.
    window.addEventListener('pointermove', wake)
    window.addEventListener('pointerdown', wake)
    const release = keymap.watchActivity(wake)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('pointerdown', wake)
      release()
    }
  }, [active, keymap])

  return idle
}
