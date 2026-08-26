import { Button } from '@/components/ui/button'
import { FOCUS_RING, releaseFocus } from './focus.ts'

/*
 * The dock's push button: shadcn/ui's `Button`, with the two things it cannot
 * know about.
 *
 * It knows about size, disabled state, focus and the `[&_svg]` sizing rules;
 * what it cannot know is that a *pointer* click in this overlay has to hand
 * focus back to the flight loop (see `releaseFocus`), and that this system
 * never fills with the accent. So this is a preset rather than a wrapper for
 * its own sake — one place to state both, instead of remembering them at
 * sixty call sites.
 *
 * **`tone="primary"` is not `variant="default"`.** The default variant is
 * `bg-primary`, a solid sky-400 plate, and `index.css` is explicit that the
 * accent is a material and never a fill behind text — `--accent` is
 * `sky-500/15` for exactly this reason. `outline` plus the accent wash is that
 * rule expressed in the registry's own vocabulary, and it is what the rest of
 * the interface already looks like.
 */

/** The two tones the dock has. `primary` is the one verb a group is *for*. */
const TONE = {
  normal:
    'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-sky-500/60 hover:bg-slate-800/60 hover:text-sky-200',
  primary:
    'border-sky-500/50 bg-sky-500/15 text-sky-200 hover:border-sky-400 hover:bg-sky-500/25 hover:text-sky-200',
} as const

export function Action({
  label,
  onClick,
  disabled = false,
  title,
  tone = 'normal',
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
  tone?: keyof typeof TONE
}) {
  return (
    <Button
      variant="outline"
      size="xs"
      title={title ?? label}
      disabled={disabled}
      onClick={(event) => {
        releaseFocus(event)
        onClick()
      }}
      /*
       * `min-h-6 min-w-6` — 24 px, which is WCAG 2.2's target minimum and not
       * a round number picked for looks. `size="xs"` is `h-6`, which is the
       * same 24 px, but a *fixed* height: the minimums are kept because the
       * narrowest labels here (`−`, `+`) came out 20 px wide, and because a
       * label that wraps must grow the box rather than overflow it.
       *
       * `rounded` rather than the variant's `rounded-md`: `--radius` is
       * 0.375rem so `--radius-md` derives to 0.25rem, which is the same value
       * — but every hand-written control in `hud/` says `rounded`, and one
       * spelling is what makes a grep for the dock's radius answer.
       */
      /*
       * `active:scale-[0.96]`, and the property list is written out.
       *
       * A press with no acknowledgement reads as a control that might not have
       * heard, which in this dock is most of them — the effect of an `Action`
       * is usually somewhere else on screen, and a few of them are no-ops on
       * purpose (the `1×` readout in the time transport asserts a state rather
       * than changing one). 0.96 because anything under 0.95 reads as the
       * button being squashed rather than pressed. Never `transition-all`:
       * `Button` already animates `color` and `box-shadow`, and adding `all` on
       * top of that animates the border, the background and the opacity of
       * every disabled state as well.
       */
      className={`type-ui min-h-6 min-w-6 rounded border px-1.5 py-0.5 font-normal whitespace-nowrap shadow-none transition-transform active:scale-[0.96] disabled:opacity-35 ${FOCUS_RING} ${TONE[tone]}`}
    >
      {label}
    </Button>
  )
}
