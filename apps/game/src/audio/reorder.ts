/*
 * Where a dragged row lands, and how far the rows it passes step aside.
 *
 * Pure, and in its own module, because the editor draws a drag without
 * reordering anything: the DOM keeps its order until the drop, the rows the
 * dragged one passes are translated by its height, and the dragged row
 * follows the pointer. Reordering the rows live is the obvious way and it
 * does not work — React moves a keyed node to reorder it, a moved node is
 * removed and reinserted, and a node removed while it holds pointer capture
 * loses it, so a drag downward ended after one row. The arithmetic here is
 * what keeps "where it will land" and "what is drawn" the same answer.
 */

/**
 * The index a row dragged from `from` lands at, for a pointer at `y`.
 *
 * `mids` are every row's vertical midpoint where the rows stood when the drag
 * began, in one coordinate space with `y`. The answer is how many of the
 * *other* rows the pointer is below — an index in the list as it will be, the
 * one `moveTrack` takes.
 */
export function landing(
  mids: readonly number[],
  from: number,
  y: number,
): number {
  let over = 0
  mids.forEach((mid, index) => {
    if (index !== from && mid < y) over += 1
  })
  return over
}

/**
 * How far the row at `index` moves while the row from `from` is held over
 * `over`: up by the dragged row's height for the rows it has passed going
 * down, down by it for the rows it has passed going up, nothing otherwise.
 * The dragged row itself follows the pointer instead, and answers zero.
 */
export function shiftOf(
  index: number,
  from: number,
  over: number,
  height: number,
): number {
  if (index === from) return 0
  if (from < over && index > from && index <= over) return -height
  if (over < from && index >= over && index < from) return height
  return 0
}
