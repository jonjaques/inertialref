import {
  type KeyboardEvent,
  type PointerEvent,
  useId,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import {
  MUSIC_DISABLED,
  MUSIC_MUTED_CATEGORIES,
  MUSIC_ORDER,
  usePersistentState,
} from '../state/preferences.ts'
import { SOUNDTRACK } from './catalog.ts'
import { arrange, moveTrack, withMember } from './playlist.ts'
import { PlaylistRow } from './PlaylistRow.tsx'
import { landing, shiftOf } from './reorder.ts'
import { useSoundtrack } from './soundtrackStore.ts'

/*
 * The playlist, in the listener's order, with a switch and a handle per track.
 *
 * **Two ways to move a track, and neither needs the other.** A pointer drags
 * the handle; a keyboard focuses the handle and moves the track with the
 * arrows, a row at a time, or with Home and End, to either end. Both write the
 * same thing — the whole arrangement, through `moveTrack` — and both say where
 * the track landed through the live region, because a list that reorders
 * under a screen reader's cursor is otherwise a list that silently changed.
 *
 * **The drag is pointer capture, not React DnD.** This page opens as a dialog
 * over the Planetarium, whose dock already runs React DnD's HTML5 backend, and
 * that backend refuses a second instance on the same window; it also gives a
 * touch screen nothing without the touch backend's long-press. Capture on the
 * handle is a few lines, works under a finger, and keeps receiving moves when
 * the pointer leaves the row — which a drag down a fifty-row list does on
 * every frame.
 *
 * **Nothing is reordered until the drop.** The rows keep their DOM order for
 * the whole drag: the ones the dragged track passes step aside by its height
 * through `translate`, and the dragged row follows the pointer through a
 * `translate` of its own, written straight to its node so that a move is not
 * a render of fifty rows. Reordering live is the obvious way and it broke
 * every drag downward after one row — React moves a keyed node to reorder it,
 * and a node moved while it holds pointer capture loses it (`reorder.ts`).
 * The order commits once, on release, after capture has ended.
 *
 * Where a dragged track would land is measured against the rows as they stood
 * when the drag began, in the scroller's content coordinates, so scrolling
 * during the drag keeps the row under the pointer.
 */

/** How close to the scroller's edge a drag scrolls it, and by how much a move. */
const EDGE = 40
const STEP = 12

interface Drag {
  readonly id: string
  readonly from: number
  /** Where the track would land: an index in the list as it will be. */
  readonly over: number
  /** Each row's midpoint at the start, in the scroller's content coordinates. */
  readonly mids: readonly number[]
  /** The dragged row's height, which is how far each row it passes moves. */
  readonly height: number
  /** Where the pointer went down, in the same coordinates as `mids`. */
  readonly start: number
  readonly scroller: HTMLElement | null
}

/** The nearest ancestor that scrolls, which is where a drag has to scroll. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (
    let node = element.parentElement;
    node !== null;
    node = node.parentElement
  ) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

const scrolled = (scroller: HTMLElement | null): number =>
  scroller?.scrollTop ?? window.scrollY

export function PlaylistEditor() {
  const [order, setOrder] = usePersistentState(MUSIC_ORDER)
  const [disabled, setDisabled] = usePersistentState(MUSIC_DISABLED)
  const [muted] = usePersistentState(MUSIC_MUTED_CATEGORIES)
  const playing = useSoundtrack((state) => state.playback.trackId)
  const hintId = useId()
  const [said, setSaid] = useState('')
  const [drag, setDrag] = useState<Drag | null>(null)
  const rows = useRef(new Map<string, HTMLLIElement>())
  const handles = useRef(new Map<string, HTMLButtonElement>())

  const tracks = arrange(SOUNDTRACK.tracks, order)
  const ids = tracks.map((track) => track.id)

  // Each row numbered by where it is drawn, which during a drag is where the
  // drop will put it: a list held mid-drag reads 1, 2, 3, not 1, 3, 4, 2.
  const slots = drag === null ? ids : moveTrack(ids, drag.from, drag.over)

  /** The dragged row's own offset, cleared before the drop's render. */
  const follow = (id: string, offset: number | null): void => {
    const node = rows.current.get(id)
    if (node !== undefined)
      node.style.translate = offset === null ? '' : `0 ${offset}px`
  }

  /** Move a track to `to` and say so. Through the updater, never the snapshot. */
  const move = (id: string, to: number): void => {
    const title = tracks.find((track) => track.id === id)?.title ?? id
    const landed = Math.min(ids.length - 1, Math.max(0, to))
    setOrder((held) => {
      const current = arrange(SOUNDTRACK.tracks, held).map((track) => track.id)
      return moveTrack(current, current.indexOf(id), landed)
    })
    setSaid(`“${title}” moved to position ${landed + 1} of ${ids.length}.`)
  }

  const onKey = (id: string, event: KeyboardEvent<HTMLButtonElement>): void => {
    const from = ids.indexOf(id)
    const to =
      event.key === 'ArrowUp'
        ? from - 1
        : event.key === 'ArrowDown'
          ? from + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? ids.length - 1
              : null
    if (to === null) return
    // The arrows are the window's too — the keymap's dispatcher would turn
    // them into a camera move behind the dialog.
    event.preventDefault()
    event.stopPropagation()
    if (to < 0 || to >= ids.length || to === from) return
    /*
     * Synchronously, and then focus the handle again. React reorders keyed
     * rows by moving DOM nodes, and a node that is moved is removed and
     * reinserted, which drops focus to the body: a track moved down by one is
     * exactly the node React moves. Flushing first means the handle the focus
     * goes back to is the one in the reordered list.
     */
    flushSync(() => move(id, to))
    handles.current.get(id)?.focus()
  }

  const onDown = (id: string, event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    const scroller = scrollerOf(event.currentTarget)
    const offset = scrolled(scroller)
    const mids = ids.map((other) => {
      const box = rows.current.get(other)?.getBoundingClientRect()
      return box === undefined ? 0 : (box.top + box.bottom) / 2 + offset
    })
    event.currentTarget.setPointerCapture(event.pointerId)
    const from = ids.indexOf(id)
    const height = rows.current.get(id)?.getBoundingClientRect().height ?? 0
    setDrag({
      id,
      from,
      over: from,
      mids,
      height,
      start: event.clientY + offset,
      scroller,
    })
  }

  const onMove = (event: PointerEvent<HTMLButtonElement>): void => {
    if (drag === null) return
    const box = drag.scroller?.getBoundingClientRect()
    if (box !== undefined) {
      if (event.clientY < box.top + EDGE) drag.scroller?.scrollBy(0, -STEP)
      else if (event.clientY > box.bottom - EDGE)
        drag.scroller?.scrollBy(0, STEP)
    }
    const y = event.clientY + scrolled(drag.scroller)
    // Kept within the list: past either end it is a move to that end, and a
    // row drawn outside the list would be a row the list no longer contains.
    const top = (drag.mids[0] ?? 0) - (drag.mids[drag.from] ?? 0)
    const bottom = (drag.mids.at(-1) ?? 0) - (drag.mids[drag.from] ?? 0)
    follow(drag.id, Math.min(bottom, Math.max(top, y - drag.start)))
    const over = landing(drag.mids, drag.from, y)
    if (over !== drag.over) setDrag({ ...drag, over })
  }

  const onUp = (): void => {
    if (drag === null) return
    // In this one event, so the offset and the reorder reach the same frame.
    follow(drag.id, null)
    if (drag.over !== drag.from) move(drag.id, drag.over)
    setDrag(null)
  }

  const onCancel = (): void => {
    if (drag !== null) follow(drag.id, null)
    setDrag(null)
  }

  return (
    <div className="flex flex-col gap-1">
      <p id={hintId} className="type-ui text-pretty text-slate-400">
        The order plays when shuffle is off. Drag a track by its handle, or
        focus the handle and use the arrow keys; Home and End move it to either
        end.
      </p>
      <ol className="flex flex-col" aria-label="Playlist">
        {tracks.map((track, index) => (
          <PlaylistRow
            key={track.id}
            track={track}
            position={slots.indexOf(track.id) + 1}
            shift={
              drag === null
                ? 0
                : shiftOf(index, drag.from, drag.over, drag.height)
            }
            settling={drag !== null && drag.id !== track.id}
            on={!disabled.includes(track.id)}
            categoryOn={!muted.includes(track.category)}
            playing={track.id === playing}
            dragging={drag?.id === track.id}
            hintId={hintId}
            rowRef={(node) => {
              if (node === null) rows.current.delete(track.id)
              else rows.current.set(track.id, node)
            }}
            handleRef={(node) => {
              if (node === null) handles.current.delete(track.id)
              else handles.current.set(track.id, node)
            }}
            onToggle={(on) =>
              setDisabled((held) => withMember(held, track.id, !on))
            }
            onHandleKey={(event) => onKey(track.id, event)}
            onHandleDown={(event) => onDown(track.id, event)}
            onHandleMove={onMove}
            onHandleUp={onUp}
            onHandleCancel={onCancel}
          />
        ))}
      </ol>
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
    </div>
  )
}
