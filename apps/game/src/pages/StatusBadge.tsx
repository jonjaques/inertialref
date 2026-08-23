import { Badge } from '@/components/ui/badge'
import { type ModeCard, STATUS_LABEL, STATUS_TONE } from './modes.ts'

/**
 * What a mode's status word looks like. One definition, two call sites.
 *
 * `ModeLink` and `ModeRow` each drew this inline and had already drifted into
 * two different paddings for the same chip on the same page.
 *
 * Three things the registry's `Badge` gets wrong for this system, all fixed
 * here rather than at the call sites:
 *
 *   - it is a `rounded-full` pill, and this system has two radii, neither of
 *     which is a pill;
 *   - it is `font-semibold` on top of a step that already names its weight;
 *   - and its padding is symmetric, which is wrong for **any** tracked
 *     uppercase text. Letter-spacing is added *after* the last glyph, so a
 *     centered label sits one track to the left of where it looks like it should
 *     — the specific thing that made these read as badly kerned. `pr` is short
 *     by exactly the track `type-label` carries.
 */
export function StatusBadge({ status }: { status: ModeCard['status'] }) {
  return (
    <Badge
      variant="outline"
      className={`type-label shrink-0 rounded border py-0.5 pr-[calc(0.375rem-0.1em)] pl-1.5 font-normal ${STATUS_TONE[status]}`}
    >
      {STATUS_LABEL[status]}
    </Badge>
  )
}
